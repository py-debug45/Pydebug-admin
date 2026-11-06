// admin-coupons.js — Coupon & Promo Codes Manager.
//
// Data comes ONLY from the SECURITY DEFINER RPCs created by
// db/migrations/20261023_premium_coupons.sql:
//   admin_list_coupons()   — every coupon + live usage/revenue stats
//   admin_upsert_coupon()  — create or update (keyed by code)
//   admin_toggle_coupon()  — pause / re-activate
//   admin_delete_coupon()  — delete, or deactivate when paid redemptions exist
//
// The `coupons` table has RLS enabled without a client policy on purpose, so
// a direct PostgREST read of it would come back empty (or error). Every
// read/write on this page therefore goes through `sb.rpc(...)` only.
//
// The pure helpers at the top are grouped in `CouponCore` so they can be
// unit-tested without a browser (tests/coupons.test.cjs).

/* ------------------------------------------------------------------ *
 * Pure helpers (no DOM, no network) — unit-tested
 * ------------------------------------------------------------------ */

const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,24}$/;
const COUPON_MIN_DISCOUNT = 1;
const COUPON_MAX_DISCOUNT = 80;
const COUPON_DESCRIPTION_MAX = 160;
const COUPON_LINK_BASE = "https://pydebug.in/premium?coupon=";
const COUPON_TODAY_LINK_BASE = "https://pydebug.in/today?coupon=";
const COUPON_MOCK_LINK_BASE = "https://pydebug.in/mock-test?coupon=";

// Live founding prices, in paise — keep in sync with PYDEBUG_PLANS in admin-common.js.
const COUPON_BASE_PRICES = { weekly: 4900, monthly: 14900, yearly: 99900 };
const COUPON_PLAN_LABELS = {
  all: "All plans",
  yearly: "Pro Yearly only",
  monthly: "Pro Monthly only",
};
const COUPON_PLAN_SHORT = { all: "All plans (7d+M+Y)", yearly: "Yearly", monthly: "Monthly" };
const COUPON_EXPIRY_PRESETS = {
  "24h": 24 * 60 * 60 * 1000,
  "48h": 48 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// 1-Tap Quick Campaign Presets for Creator Partners, Campus CRs, and Flash Sales.
const COUPON_CAMPAIGN_PRESETS = {
  creator: {
    key: "creator",
    label: "📹 Creator Partner",
    discountPercent: 20,
    applicablePlan: "all",
    firstPurchaseOnly: false,
    description: "Creator: @handle (30% share)",
    expiryPreset: "none",
    defaultCommission: 30,
  },
  campus_cr: {
    key: "campus_cr",
    label: "🎓 Campus CR",
    discountPercent: 25,
    applicablePlan: "all",
    firstPurchaseOnly: true,
    description: "Campus CR: College Name",
    expiryPreset: "30d",
    defaultCommission: 25,
  },
  exam_flash: {
    key: "exam_flash",
    label: "⚡ Exam Week Flash",
    discountPercent: 30,
    applicablePlan: "all",
    firstPurchaseOnly: true,
    description: "48h Flash Sale",
    expiryPreset: "48h",
    defaultCommission: 20,
  },
};

// Uppercase + strip anything outside [A-Z0-9_-] (3–24 chars enforced at submit).
function normalizeCouponCode(raw) {
  return String(raw == null ? "" : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 24);
}

function isValidCouponCode(code) {
  return COUPON_CODE_PATTERN.test(String(code == null ? "" : code));
}

// Random, human-readable code. Ambiguous glyphs (0/O, 1/I) are left out so a
// code read out loud or typed from a screenshot still works.
const COUPON_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateCouponCode(random) {
  const rnd = typeof random === "function" ? random : Math.random;
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    const index = Math.min(
      COUPON_CODE_ALPHABET.length - 1,
      Math.max(0, Math.floor(Number(rnd()) * COUPON_CODE_ALPHABET.length) || 0)
    );
    suffix += COUPON_CODE_ALPHABET[index];
  }
  return `PYD-${suffix}`;
}

// What the learner actually pays at each plan price after the discount.
function couponPricePreview(discountPercent) {
  const raw = Number(discountPercent);
  const percent = Number.isFinite(raw) ? Math.min(COUPON_MAX_DISCOUNT, Math.max(0, raw)) : 0;
  const out = {};
  Object.keys(COUPON_BASE_PRICES).forEach((plan) => {
    const basePaise = COUPON_BASE_PRICES[plan];
    const finalPaise = Math.round((basePaise * (100 - percent)) / 100);
    out[plan] = {
      discountPercent: percent,
      basePaise,
      finalPaise,
      savePaise: basePaise - finalPaise,
    };
  });
  return out;
}

// "₹1,049" / "₹104.30" — paise in, rupees out.
function formatCouponRupees(paise) {
  const value = Number(paise);
  if (!Number.isFinite(value)) return "₹0";
  const rupees = value / 100;
  const hasPaise = Math.round(rupees * 100) % 100 !== 0;
  return "₹" + rupees.toLocaleString("en-IN", hasPaise
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
}

function couponUsage(coupon) {
  const c = coupon || {};
  const used = Math.max(0, Number(c.usedCount) || 0);
  const max = c.maxUses == null ? null : Math.max(0, Number(c.maxUses));
  const unlimited = max == null;
  const percent = unlimited ? 0 : (max === 0 ? 100 : Math.min(100, Math.round((used / max) * 100)));
  return {
    used,
    max,
    unlimited,
    percent,
    remaining: unlimited ? null : Math.max(0, max - used),
    full: !unlimited && used >= max,
  };
}

// Badge shown in the table. Expired wins over paused, because an expired code
// cannot be redeemed even after re-activating it.
function couponStatus(coupon, now) {
  const c = coupon || {};
  const at = now == null ? Date.now() : now;
  const expires = c.expiresAt ? new Date(c.expiresAt).getTime() : NaN;
  const usage = couponUsage(c);
  const expired = c.isExpired === true || (!isNaN(expires) && expires <= at);

  if (expired) return { key: "expired", label: "Expired", cls: "tag--expired" };
  if (c.isActive === false) return { key: "paused", label: "Paused", cls: "tag--unknown" };
  if (usage.full) return { key: "quota", label: "Quota full", cls: "tag--attempted" };
  return { key: "active", label: "Active", cls: "tag--solved" };
}

function formatCouponSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "under 1 min";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 31) return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  return `${Math.floor(d / 30)} mo`;
}

// Countdown for the expiry column: "Ends in 6d 3h", "Expired 2d ago"…
function couponCountdown(iso, now) {
  const at = now == null ? Date.now() : now;
  if (!iso) return { state: "none", text: "No expiry", tone: "muted" };
  const t = new Date(iso).getTime();
  if (isNaN(t)) return { state: "none", text: "No expiry", tone: "muted" };
  if (t <= at) return { state: "expired", text: `Expired ${formatCouponSpan(at - t)} ago`, tone: "danger" };
  return {
    state: t - at < 24 * 60 * 60 * 1000 ? "soon" : "running",
    text: `Ends in ${formatCouponSpan(t - at)}`,
    tone: t - at < 24 * 60 * 60 * 1000 ? "warn" : "muted",
  };
}

function couponShareLink(code) {
  return COUPON_LINK_BASE + encodeURIComponent(String(code == null ? "" : code));
}

function couponTrackingLinks(code) {
  const enc = encodeURIComponent(String(code == null ? "" : code));
  return {
    premium: COUPON_LINK_BASE + enc,
    today: COUPON_TODAY_LINK_BASE + enc,
    mockTest: COUPON_MOCK_LINK_BASE + enc,
  };
}

function formatCouponTrackingLinks(code) {
  const cleanCode = String(code == null ? "" : code).toUpperCase();
  const links = couponTrackingLinks(cleanCode);
  return [
    `PyDebug Tracking Links (${cleanCode}):`,
    `• Premium Checkout: ${links.premium}`,
    `• Today's Wordle: ${links.today}`,
    `• Live Mock Test: ${links.mockTest}`,
  ].join("\n");
}

function getCampaignPresetValues(presetKey, now) {
  const preset = COUPON_CAMPAIGN_PRESETS[presetKey];
  if (!preset) return null;
  const expiryIso = preset.expiryPreset === "none" ? null : couponPresetExpiryIso(preset.expiryPreset, now);
  return {
    ...preset,
    expiresAtIso: expiryIso,
    expiresAtLocal: expiryIso ? isoToLocalInputValue(expiryIso) : "",
  };
}

function inferCommissionPercent(description) {
  const desc = String(description == null ? "" : description);
  const explicit = desc.match(/(\d{1,2}(?:\.\d+)?)\s*%\s*(?:share|comm|commission|payout)/i);
  if (explicit) {
    const n = Number(explicit[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  if (/campus\s*cr/i.test(desc)) return 25;
  if (/creator|influencer|affiliate|partner|@[\w.-]+/i.test(desc)) return 30;
  return 20;
}

function calculateAffiliatePayout(revenuePaise, commissionPercent) {
  const revPaise = Math.max(0, Math.round(Number(revenuePaise) || 0));
  const rawPct = Number(commissionPercent);
  const pct = Number.isFinite(rawPct) ? Math.min(100, Math.max(0, rawPct)) : 0;
  const payoutPaise = Math.round((revPaise * pct) / 100);
  return {
    revenuePaise: revPaise,
    revenueInr: revPaise / 100,
    commissionPercent: pct,
    payoutPaise,
    payoutInr: payoutPaise / 100,
  };
}

function buildCreatorWhatsAppKit(coupon) {
  const c = coupon || {};
  const code = String(c.code || "PYDEBUG20").toUpperCase();
  const pct = Math.max(1, Math.min(80, Number(c.discountPercent) || 20));
  const links = couponTrackingLinks(code);
  const prices = couponPricePreview(pct);
  const weeklyAfter = formatCouponRupees(prices.weekly.finalPaise);
  const monthlyAfter = formatCouponRupees(prices.monthly.finalPaise);

  return [
    `🚀 *PyDebug Creator / Campus Partner Kit*`,
    ``,
    `Hey! Tumhara exclusive PyDebug promo code live ho gaya hai 🎉`,
    `🎟️ *Code:* ${code} (${pct}% OFF)`,
    ``,
    `🔗 *Direct Auto-Apply Tracking Links (bio / story / pinned comment):*`,
    `• Pro Plans Checkout: ${links.premium}`,
    `• Today's Python Wordle: ${links.today}`,
    `• Live Python Mock Test: ${links.mockTest}`,
    ``,
    `📲 *Ready-to-post Reel / WhatsApp Caption:*`,
    `"Python debugging & placement tests crack karne hain? 🐍🔥 PyDebug par daily Python Wordle + AI debugger + timed Mock Tests try karo!`,
    `Pro 7-Day Pass sirf ₹39–₹49 mein start hota hai (${weeklyAfter} with code *${code}*) aur full Pro ₹149/month (${monthlyAfter} with *${code}*)!`,
    `Extra ${pct}% OFF auto-apply link 👉 ${links.premium}"`,
  ].join("\n");
}

function couponPresetExpiryIso(preset, now) {
  const ms = COUPON_EXPIRY_PRESETS[preset];
  if (!ms) return null;
  return new Date((now == null ? Date.now() : now) + ms).toISOString();
}

// datetime-local <-> ISO. The picker works in the admin's local time zone, so
// the value is parsed as local and stored as UTC.
function isoToLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputValueToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// admin_delete_coupon() returns { deleted, deactivated } — possibly wrapped in
// an array, or void on older installs. Normalise all three shapes.
function parseCouponDeleteResult(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return { deleted: true, deactivated: false };
  return {
    deleted: row.deleted !== false,
    deactivated: row.deactivated === true || row.deleted === false,
  };
}

// Validates the form and returns the exact argument shape used by
// admin_upsert_coupon(). `now` is injectable so tests are timezone/time stable.
function validateCouponForm(raw, now) {
  const at = now == null ? Date.now() : now;
  const values = raw || {};
  const errors = {};

  const code = normalizeCouponCode(values.code);
  if (!code) errors.code = "Coupon code is required.";
  else if (!isValidCouponCode(code)) errors.code = "Use 3–24 characters: A–Z, 0–9, _ or -.";

  const discountRaw = values.discountPercent;
  const discount = Number(discountRaw);
  if (discountRaw === "" || discountRaw == null || !Number.isFinite(discount)) {
    errors.discountPercent = "Enter a discount between 1% and 80%.";
  } else if (!Number.isInteger(discount)) {
    errors.discountPercent = "Discount must be a whole number (no decimals).";
  } else if (discount < COUPON_MIN_DISCOUNT || discount > COUPON_MAX_DISCOUNT) {
    errors.discountPercent = "Discount must be between 1% and 80% (the cap is 80%).";
  }

  const plan = String(values.applicablePlan || "all");
  if (!COUPON_PLAN_LABELS[plan]) errors.applicablePlan = "Choose which plans this code applies to.";

  let maxUses = null;
  if (values.maxUses !== "" && values.maxUses != null) {
    const n = Number(values.maxUses);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      errors.maxUses = "Total uses must be 1 or more, or blank for unlimited.";
    } else {
      maxUses = n;
    }
  }

  let maxUsesPerUser = 1;
  if (values.maxUsesPerUser !== "" && values.maxUsesPerUser != null) {
    const n = Number(values.maxUsesPerUser);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10) {
      errors.maxUsesPerUser = "Per-user limit must be a whole number between 1 and 10.";
    } else {
      maxUsesPerUser = n;
    }
  }

  let expiresAtIso = null;
  if (values.expiresAt) {
    const d = new Date(values.expiresAt);
    if (isNaN(d.getTime())) errors.expiresAt = "Pick a valid date & time.";
    else if (d.getTime() <= at) errors.expiresAt = "Expiry must be in the future — or choose “No expiry”.";
    else expiresAtIso = d.toISOString();
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      code,
      discountPercent: Number.isFinite(discount) ? Math.trunc(discount) : 0,
      applicablePlan: plan,
      maxUses,
      maxUsesPerUser,
      expiresAtIso,
      firstPurchaseOnly: values.firstPurchaseOnly === true,
      description: String(values.description == null ? "" : values.description).trim().slice(0, COUPON_DESCRIPTION_MAX),
    },
  };
}

// Header cards: how many codes are live, how often they are used, revenue.
function summarizeCoupons(coupons, now) {
  const at = now == null ? Date.now() : now;
  const summary = { total: 0, active: 0, paused: 0, expired: 0, quotaFull: 0, redemptions: 0, revenuePaise: 0 };
  (coupons || []).forEach((coupon) => {
    summary.total += 1;
    const status = couponStatus(coupon, at);
    if (status.key === "active") summary.active += 1;
    else if (status.key === "paused") summary.paused += 1;
    else if (status.key === "expired") summary.expired += 1;
    else if (status.key === "quota") summary.quotaFull += 1;
    summary.redemptions += Math.max(0, Number(coupon.usedCount) || 0);
    summary.revenuePaise += Math.max(0, Number(coupon.revenuePaise) || 0);
  });
  return summary;
}

const CouponCore = {
  COUPON_CODE_PATTERN,
  COUPON_MIN_DISCOUNT,
  COUPON_MAX_DISCOUNT,
  COUPON_DESCRIPTION_MAX,
  COUPON_LINK_BASE,
  COUPON_TODAY_LINK_BASE,
  COUPON_MOCK_LINK_BASE,
  COUPON_BASE_PRICES,
  COUPON_PLAN_LABELS,
  COUPON_PLAN_SHORT,
  COUPON_CAMPAIGN_PRESETS,
  normalizeCouponCode,
  isValidCouponCode,
  generateCouponCode,
  couponPricePreview,
  formatCouponRupees,
  couponUsage,
  couponStatus,
  formatCouponSpan,
  couponCountdown,
  couponShareLink,
  couponTrackingLinks,
  formatCouponTrackingLinks,
  getCampaignPresetValues,
  inferCommissionPercent,
  calculateAffiliatePayout,
  buildCreatorWhatsAppKit,
  couponPresetExpiryIso,
  isoToLocalInputValue,
  localInputValueToIso,
  parseCouponDeleteResult,
  validateCouponForm,
  summarizeCoupons,
};
// Exposed for tests; also handy in the console when debugging a live campaign.
globalThis.CouponCore = CouponCore;

/* ------------------------------------------------------------------ *
 * Page state + boot
 * ------------------------------------------------------------------ */

const COUPON_ERROR_FIELDS = {
  code: "coupon-error-code",
  discountPercent: "coupon-error-discount",
  maxUses: "coupon-error-max-uses",
  maxUsesPerUser: "coupon-error-per-user",
  expiresAt: "coupon-error-expires",
  applicablePlan: "coupon-error-plan",
};

const COUPON_COMM_STORAGE_KEY = "pydebug_admin_coupon_comm_v1";

function loadSavedCommissions() {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(COUPON_COMM_STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveCommissionMap(map) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(COUPON_COMM_STORAGE_KEY, JSON.stringify(map || {}));
    }
  } catch (e) { /* storage quota or private mode */ }
}

const couponState = {
  rows: [],
  editing: null, // coupon object currently loaded into the form
  loading: false,
  commissions: loadSavedCommissions(), // { [CODE]: { mode: "20"|"25"|"30"|"custom", pct: number } }
};

function getRowCommission(row) {
  const code = row && row.code ? row.code : "";
  const saved = code ? couponState.commissions[code] : null;
  if (saved && Number.isFinite(Number(saved.pct))) {
    const pct = Math.min(100, Math.max(0, Number(saved.pct)));
    const mode = saved.mode || ([20, 25, 30].includes(pct) ? String(pct) : "custom");
    return { mode, pct };
  }
  const inferred = inferCommissionPercent(row ? row.description : "");
  const mode = [20, 25, 30].includes(inferred) ? String(inferred) : "custom";
  return { mode, pct: inferred };
}

function setRowCommission(code, mode, pct) {
  if (!code) return;
  const cleanPct = Math.min(100, Math.max(0, Number(pct) || 0));
  couponState.commissions[code] = { mode, pct: cleanPct };
  saveCommissionMap(couponState.commissions);
}

onAdminReady(async () => {
  const admin = await requirePerm("coupons.read");
  if (!admin) return;
  initCouponManager();
});

function initCouponManager() {
  bindCouponForm();
  bindCouponTable();
  bindCouponToolbar();
  resetCouponForm();
  loadCoupons();
}

/* ------------------------------------------------------------------ *
 * Data access — RPC only
 * ------------------------------------------------------------------ */

// Turns PostgREST/Postgres errors into something an admin can act on.
function friendlyCouponError(error) {
  const message = String((error && error.message) || error || "").trim();
  if (/could not find the function|schema cache|PGRST202/i.test(message)) {
    return "Coupon RPCs are not installed in this Supabase project. Run db/migrations/20261023_premium_coupons.sql in the SQL editor, then reload this page.";
  }
  if (/admin access required|permission denied|42501/i.test(message)) {
    return "This session is not allowed to manage coupons. Sign in as the verified admin (profiles.is_admin = true for avenjr80@gmail.com).";
  }
  if (/invalid coupon code/i.test(message)) {
    return "That coupon code was rejected — use 3–24 characters of A–Z, 0–9, _ or -.";
  }
  if (/discount/i.test(message) && /(range|between|cap|invalid)/i.test(message)) {
    return "Discount must be a whole number between 1% and 80%.";
  }
  return message || "Something went wrong — please try again.";
}

// The RPC returns camelCase JSON, but normalising means a future snake_case
// variant (or a setof row shape) still renders instead of showing blanks.
function normalizeCouponRow(row) {
  const r = row || {};
  const read = (camel, snake, fallback) => {
    if (r[camel] !== undefined && r[camel] !== null) return r[camel];
    if (snake && r[snake] !== undefined && r[snake] !== null) return r[snake];
    return fallback;
  };
  const nullableNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return {
    code: String(read("code", "code", "") || "").toUpperCase(),
    discountPercent: Number(read("discountPercent", "discount_percent", 0)) || 0,
    applicablePlan: String(read("applicablePlan", "applicable_plan", "all") || "all"),
    maxUses: nullableNumber(read("maxUses", "max_uses", null)),
    usedCount: Math.max(0, Number(read("usedCount", "used_count", 0)) || 0),
    remainingUses: nullableNumber(read("remainingUses", "remaining_uses", null)),
    maxUsesPerUser: Number(read("maxUsesPerUser", "max_uses_per_user", 1)) || 1,
    firstPurchaseOnly: read("firstPurchaseOnly", "first_purchase_only", false) === true,
    description: String(read("description", "description", "") || ""),
    startsAt: read("startsAt", "starts_at", null),
    expiresAt: read("expiresAt", "expires_at", null),
    isActive: read("isActive", "is_active", true) !== false,
    isExpired: read("isExpired", "is_expired", false) === true,
    revenuePaise: Math.max(0, Number(read("revenuePaise", "revenue_paise", 0)) || 0),
    createdAt: read("createdAt", "created_at", null),
    updatedAt: read("updatedAt", "updated_at", null),
  };
}

async function loadCoupons(options) {
  const opts = options || {};
  const refreshBtn = document.getElementById("refresh-coupons-btn");
  const hint = document.getElementById("coupons-hint");
  if (hint) hint.innerHTML = "";
  if (refreshBtn) refreshBtn.disabled = true;

  couponState.loading = true;
  if (!opts.silent) renderCouponRows();

  const { data, error } = await sb.rpc("admin_list_coupons");

  couponState.loading = false;
  if (refreshBtn) refreshBtn.disabled = false;

  if (error) {
    const message = friendlyCouponError(error);
    couponState.rows = [];
    renderCoupons();
    if (hint) hint.innerHTML = `<div class="admin-hint">${escapeHtml(message)}</div>`;
    showToast("Could not load coupons", "error");
    return;
  }

  const list = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.coupons) ? data.coupons : []);
  couponState.rows = list.map(normalizeCouponRow).filter((row) => !!row.code);

  // Keep an open edit form pointing at the freshest row (usage/revenue move
  // between loads) without wiping whatever the admin is typing.
  if (couponState.editing) {
    const fresh = couponState.rows.find((row) => row.code === couponState.editing.code);
    if (fresh) couponState.editing = fresh;
  }

  renderCoupons();
}

/* ------------------------------------------------------------------ *
 * Summary cards + table
 * ------------------------------------------------------------------ */

function renderCoupons() {
  renderCouponStats();
  renderCouponRows();
}

function renderCouponStats() {
  const summary = summarizeCoupons(couponState.rows);
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText("coupon-stat-active", summary.active.toLocaleString("en-IN"));
  const down = summary.paused + summary.expired + summary.quotaFull;
  setText(
    "coupon-stat-active-sub",
    summary.total === 0
      ? "no codes yet"
      : down > 0
        ? `${summary.paused} paused · ${summary.expired} expired · ${summary.quotaFull} full`
        : `all ${summary.total} codes are live`
  );

  setText("coupon-stat-redemptions", summary.redemptions.toLocaleString("en-IN"));
  const usedCodes = couponState.rows.filter((row) => row.usedCount > 0).length;
  setText(
    "coupon-stat-redemptions-sub",
    couponState.rows.length === 0
      ? "paid orders that used a code"
      : `across ${usedCodes} of ${couponState.rows.length} codes`
  );

  setText("coupon-stat-revenue", formatCouponRupees(summary.revenuePaise));
  const top = couponState.rows
    .filter((row) => row.revenuePaise > 0)
    .sort((a, b) => b.revenuePaise - a.revenuePaise)[0];
  setText(
    "coupon-stat-revenue-sub",
    top ? `top: ${top.code} · ${formatCouponRupees(top.revenuePaise)}` : "no attributed revenue yet"
  );

  const totalPayoutPaise = couponState.rows.reduce((sum, row) => {
    const comm = getRowCommission(row);
    return sum + calculateAffiliatePayout(row.revenuePaise, comm.pct).payoutPaise;
  }, 0);
  setText("coupon-stat-payout", formatCouponRupees(totalPayoutPaise));
  setText(
    "coupon-stat-payout-sub",
    totalPayoutPaise > 0
      ? `across ${usedCodes} earning code${usedCodes === 1 ? "" : "s"}`
      : "based on verified paid orders"
  );

  const pill = document.getElementById("coupons-count");
  if (pill) pill.textContent = String(couponState.rows.length);
}

function filteredCouponRows() {
  const search = String(couponVal("coupon-search") || "").trim().toLowerCase();
  const status = couponVal("coupon-filter-status") || "all";
  const sort = couponVal("coupon-sort") || "newest";
  const now = Date.now();

  const rows = couponState.rows.filter((row) => {
    if (status !== "all" && couponStatus(row, now).key !== status) return false;
    if (search) {
      const hay = `${row.code} ${row.description} ${row.applicablePlan} ${COUPON_PLAN_LABELS[row.applicablePlan] || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const sorters = {
    newest: (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || a.code.localeCompare(b.code),
    used: (a, b) => b.usedCount - a.usedCount || a.code.localeCompare(b.code),
    revenue: (a, b) => b.revenuePaise - a.revenuePaise || a.code.localeCompare(b.code),
    discount: (a, b) => b.discountPercent - a.discountPercent || a.code.localeCompare(b.code),
    expiring: (a, b) => {
      const ta = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const tb = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      return ta - tb || a.code.localeCompare(b.code);
    },
  };
  return rows.sort(sorters[sort] || sorters.newest);
}

function renderCouponRows() {
  const tbody = document.getElementById("coupons-tbody");
  if (!tbody) return;

  if (couponState.loading) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-row">Loading coupons…</td></tr>`;
    return;
  }

  const rows = filteredCouponRows();
  if (!rows.length) {
    tbody.innerHTML = couponState.rows.length
      ? `<tr><td colspan="9" class="empty-row">No coupons match these filters.</td></tr>`
      : `<tr><td colspan="9" class="empty-row">No promo codes yet — tap a Quick Preset or create your first coupon above.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(couponRowHtml).join("");
}

function couponRowHtml(row) {
  const now = Date.now();
  const status = couponStatus(row, now);
  const usage = couponUsage(row);
  const expiry = couponCountdown(row.expiresAt, now);
  const planLabel = row.applicablePlan === "all"
    ? "All (7d + M + Y)"
    : (COUPON_PLAN_LABELS[row.applicablePlan] || row.applicablePlan);
  const code = escapeHtml(row.code);
  const startsSoon = row.startsAt && new Date(row.startsAt).getTime() > now;

  const comm = getRowCommission(row);
  const payout = calculateAffiliatePayout(row.revenuePaise, comm.pct);

  const flags = [];
  if (row.firstPurchaseOnly) flags.push(`<span class="coupon-flag">1st purchase only</span>`);
  if (row.maxUsesPerUser > 1) flags.push(`<span class="coupon-flag">${row.maxUsesPerUser}× per learner</span>`);
  if (startsSoon) flags.push(`<span class="coupon-flag coupon-flag--info">Starts ${escapeHtml(fmtDateTime(row.startsAt))}</span>`);

  return `<tr data-coupon-row="${code}">
    <td class="coupon-cell-code" data-label="Coupon / Creator">
      <code class="coupon-code" title="${code}">${code}</code>
      ${row.description ? `<div class="coupon-desc">${escapeHtml(row.description)}</div>` : ""}
      ${flags.length ? `<div class="coupon-flags">${flags.join("")}</div>` : ""}
    </td>
    <td data-label="Discount"><strong class="coupon-discount">${row.discountPercent}%</strong><div class="coupon-cell-sub">off base price</div></td>
    <td data-label="Applies to"><span class="tag tag--info">${escapeHtml(planLabel)}</span></td>
    <td data-label="Usage">${couponUsageHtml(usage)}</td>
    <td data-label="Expiry">
      <span class="coupon-expiry coupon-expiry--${expiry.tone}">${escapeHtml(expiry.text)}</span>
      <div class="coupon-cell-sub" title="${escapeHtml(fmtDateTime(row.expiresAt))}">${row.expiresAt ? escapeHtml(fmtDateTime(row.expiresAt)) : "Never expires"}</div>
    </td>
    <td data-label="Verified Revenue">
      <strong class="coupon-revenue">${escapeHtml(formatCouponRupees(row.revenuePaise))}</strong>
      <div class="coupon-cell-sub">${usage.used ? `${usage.used} paid order${usage.used === 1 ? "" : "s"}` : "no redemptions yet"}</div>
    </td>
    <td class="coupon-cell-payout" data-label="Affiliate Payout">
      <div class="payout-calc">
        <strong class="coupon-payout-val" data-coupon-payout-val="${code}">${escapeHtml(formatCouponRupees(payout.payoutPaise))}</strong>
        <div class="payout-calc__controls">
          <select class="coupon-comm-select" data-coupon-comm-select="${code}" aria-label="Commission percent for ${code}">
            <option value="20"${comm.mode === "20" ? " selected" : ""}>20%</option>
            <option value="25"${comm.mode === "25" ? " selected" : ""}>25%</option>
            <option value="30"${comm.mode === "30" ? " selected" : ""}>30%</option>
            <option value="custom"${comm.mode === "custom" ? " selected" : ""}>Custom %</option>
          </select>
          <input type="number" class="coupon-comm-custom" data-coupon-comm-custom="${code}"
                 min="0" max="100" step="0.5" value="${comm.pct}"
                 aria-label="Custom commission percent for ${code}"
                 ${comm.mode === "custom" ? "" : "hidden"}>
        </div>
        <div class="coupon-cell-sub" data-coupon-payout-sub="${code}">${comm.pct}% of ${escapeHtml(formatCouponRupees(row.revenuePaise))}</div>
      </div>
    </td>
    <td data-label="Status"><span class="tag ${status.cls}">${escapeHtml(status.label)}</span></td>
    <td class="coupon-cell-actions" data-label="Share & Actions">
      <div class="coupon-share-kit" data-keep-emoji="1">
        <div class="coupon-tracking-group">
          <button type="button" class="btn btn--secondary btn--sm" data-coupon-copy-links="${code}" title="Copy all 3 tracking URLs (/premium, /today, /mock-test)">🔗 Copy Tracking Links</button>
          <div class="coupon-tracking-pills">
            <button type="button" class="coupon-track-pill" data-coupon-copy-code="${code}" data-coupon-copy-target="premium" title="Copy https://pydebug.in/premium?coupon=${code}">/premium</button>
            <button type="button" class="coupon-track-pill" data-coupon-copy-code="${code}" data-coupon-copy-target="today" title="Copy https://pydebug.in/today?coupon=${code}">/today</button>
            <button type="button" class="coupon-track-pill" data-coupon-copy-code="${code}" data-coupon-copy-target="mockTest" title="Copy https://pydebug.in/mock-test?coupon=${code}">/mock-test</button>
          </div>
        </div>
        <button type="button" class="btn btn--primary btn--sm coupon-whatsapp-btn" data-coupon-copy-kit="${code}" title="Copy ready-to-send Hinglish Creator WhatsApp Kit">📲 Copy Creator WhatsApp Kit</button>
      </div>
      <div class="coupon-actions">
        <button type="button" class="btn btn--secondary btn--sm" data-coupon-edit="${code}" title="Edit this coupon" aria-label="Edit coupon ${code}">${couponIcon("file")}<span>Edit</span></button>
        <button type="button" class="btn btn--secondary btn--sm" data-coupon-toggle="${code}" title="${row.isActive ? "Pause this coupon" : "Activate this coupon"}" aria-label="${row.isActive ? "Pause" : "Activate"} coupon ${code}">${couponIcon(row.isActive ? "snow" : "check")}<span>${row.isActive ? "Pause" : "Activate"}</span></button>
        <button type="button" class="btn btn--danger btn--sm" data-coupon-delete="${code}" title="Delete this coupon" aria-label="Delete coupon ${code}">${couponIcon("trash")}<span>Delete</span></button>
      </div>
    </td>
  </tr>`;
}

function couponUsageHtml(usage) {
  const tone = usage.unlimited ? "is-unlimited" : usage.full ? "is-full" : usage.percent >= 80 ? "is-warn" : "";
  const width = usage.unlimited ? 100 : Math.min(100, usage.percent);
  const label = usage.unlimited ? `${usage.used} / ∞` : `${usage.used} / ${usage.max}`;
  const title = usage.unlimited
    ? `${usage.used} redemptions · unlimited`
    : `${usage.used} of ${usage.max} redemptions used (${usage.percent}%)`;
  return `<div class="coupon-usage" title="${escapeHtml(title)}">
      <div class="coupon-usage__bar ${tone}"><i style="width:${width}%"></i></div>
      <span class="coupon-usage__text">${escapeHtml(label)}</span>
    </div>`;
}

function couponIcon(name) {
  return typeof window.adminIcon === "function" ? window.adminIcon(name) : "";
}

/* ------------------------------------------------------------------ *
 * Table actions: copy links / WhatsApp kit / payout calc / edit / toggle / delete
 * ------------------------------------------------------------------ */

function updateRowPayoutDom(code) {
  const row = couponState.rows.find((item) => item.code === code);
  if (!row) return;
  const comm = getRowCommission(row);
  const payout = calculateAffiliatePayout(row.revenuePaise, comm.pct);
  const valEl = document.querySelector(`[data-coupon-payout-val="${cssEscape(code)}"]`);
  const subEl = document.querySelector(`[data-coupon-payout-sub="${cssEscape(code)}"]`);
  if (valEl) valEl.textContent = formatCouponRupees(payout.payoutPaise);
  if (subEl) subEl.textContent = `${comm.pct}% of ${formatCouponRupees(row.revenuePaise)}`;
  renderCouponStats();
}

function bindCouponTable() {
  const tbody = document.getElementById("coupons-tbody");
  if (!tbody || tbody.dataset.bound === "1") return;
  tbody.dataset.bound = "1";

  // Commission % calculator (select + custom input)
  tbody.addEventListener("change", (event) => {
    const sel = event.target.closest("select[data-coupon-comm-select]");
    if (!sel) return;
    const code = sel.dataset.couponCommSelect;
    const customInput = tbody.querySelector(`input[data-coupon-comm-custom="${cssEscape(code)}"]`);
    if (sel.value === "custom") {
      if (customInput) {
        customInput.hidden = false;
        customInput.focus();
      }
      const pct = customInput ? Number(customInput.value) || 0 : 30;
      setRowCommission(code, "custom", pct);
    } else {
      if (customInput) {
        customInput.hidden = true;
        customInput.value = sel.value;
      }
      setRowCommission(code, sel.value, Number(sel.value));
    }
    updateRowPayoutDom(code);
  });

  tbody.addEventListener("input", (event) => {
    const inp = event.target.closest("input[data-coupon-comm-custom]");
    if (!inp) return;
    const code = inp.dataset.couponCommCustom;
    setRowCommission(code, "custom", Number(inp.value) || 0);
    updateRowPayoutDom(code);
  });

  // One delegated click listener for the whole table (rows are re-rendered often).
  tbody.addEventListener("click", async (event) => {
    const button = event.target.closest(
      "button[data-coupon-copy], button[data-coupon-copy-links], button[data-coupon-copy-target], button[data-coupon-copy-kit], button[data-coupon-edit], button[data-coupon-toggle], button[data-coupon-delete]"
    );
    if (!button) return;

    if (button.dataset.couponCopy) {
      await copyTextWithToast(couponShareLink(button.dataset.couponCopy), `Promo link copied — ${button.dataset.couponCopy}`);
      return;
    }
    if (button.dataset.couponCopyLinks) {
      const code = button.dataset.couponCopyLinks;
      await copyTextWithToast(formatCouponTrackingLinks(code), `All 3 tracking links copied — ${code}`);
      return;
    }
    if (button.dataset.couponCopyTarget) {
      const code = button.dataset.couponCopyCode;
      const target = button.dataset.couponCopyTarget;
      const links = couponTrackingLinks(code);
      const url = links[target] || links.premium;
      const labelMap = { premium: "/premium", today: "/today", mockTest: "/mock-test" };
      await copyTextWithToast(url, `Copied ${labelMap[target] || ""} link — ${code}`);
      return;
    }
    if (button.dataset.couponCopyKit) {
      const code = button.dataset.couponCopyKit;
      const row = couponState.rows.find((item) => item.code === code) || { code, discountPercent: 20 };
      await copyTextWithToast(buildCreatorWhatsAppKit(row), `Creator WhatsApp Kit copied — ${code}`);
      return;
    }
    if (button.dataset.couponEdit) {
      startCouponEdit(button.dataset.couponEdit);
      return;
    }
    if (button.dataset.couponToggle) {
      await toggleCoupon(button.dataset.couponToggle);
      return;
    }
    if (button.dataset.couponDelete) {
      await deleteCoupon(button.dataset.couponDelete);
    }
  });
}

async function copyTextWithToast(text, successMessage) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyToClipboard(text);
    }
    showToast(successMessage, "success");
  } catch (err) {
    showToast(`Copy manually: ${text}`, "error");
  }
}

// execCommand fallback for non-secure contexts / older browsers.
function fallbackCopyToClipboard(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } finally { area.remove(); }
  if (!ok) throw new Error("copy-blocked");
}

async function toggleCoupon(code) {
  const row = couponState.rows.find((item) => item.code === code);
  if (!row) return;
  const nextActive = !row.isActive;

  const button = document.querySelector(`button[data-coupon-toggle="${cssEscape(code)}"]`);
  if (button) button.disabled = true;

  const { error } = await sb.rpc("admin_toggle_coupon", { p_code: code, p_is_active: nextActive });

  if (button) button.disabled = false;
  if (error) {
    showToast(friendlyCouponError(error), "error");
    return;
  }
  showToast(`${code} ${nextActive ? "activated" : "paused"}`, "success");
  await loadCoupons({ silent: true });
}

async function deleteCoupon(code) {
  const row = couponState.rows.find((item) => item.code === code);
  const used = row ? row.usedCount : 0;
  const warning = used > 0
    ? `\n\nThis coupon already has ${used} paid redemption${used === 1 ? "" : "s"}, so it will be PAUSED instead of deleted to keep the audit history intact.`
    : "\n\nThis cannot be undone.";
  if (!window.confirm(`Delete coupon ${code}?${warning}`)) return;

  const button = document.querySelector(`button[data-coupon-delete="${cssEscape(code)}"]`);
  if (button) button.disabled = true;

  const { data, error } = await sb.rpc("admin_delete_coupon", { p_code: code });

  if (button) button.disabled = false;
  if (error) {
    showToast(friendlyCouponError(error), "error");
    return;
  }

  const result = parseCouponDeleteResult(data);
  if (result.deactivated && !result.deleted) {
    showToast(`${code} has paid redemptions — it was paused instead of deleted`, "info");
  } else {
    showToast(`${code} deleted`, "success");
  }

  if (couponState.editing && couponState.editing.code === code) resetCouponForm();
  await loadCoupons({ silent: true });
}

// Codes are [A-Z0-9_-], so a quoted attribute selector is always safe; this
// guards the one unusual case anyway.
function cssEscape(value) {
  return String(value == null ? "" : value).replace(/["\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ *
 * Create / edit form
 * ------------------------------------------------------------------ */

function bindCouponForm() {
  const form = document.getElementById("coupon-form");
  if (!form) return;

  const codeInput = document.getElementById("coupon-code");
  codeInput.addEventListener("input", () => {
    // Auto-uppercase + drop characters the RPC would reject, without ever
    // leaving a partially-typed value that can't be submitted later.
    const normalized = normalizeCouponCode(codeInput.value);
    if (codeInput.value !== normalized) {
      codeInput.value = normalized;
      try { codeInput.setSelectionRange(normalized.length, normalized.length); } catch (e) {}
    }
    clearCouponFieldError("code");
  });

  const generateBtn = document.getElementById("coupon-generate-code");
  generateBtn.addEventListener("click", () => {
    if (codeInput.readOnly) return;
    codeInput.value = generateCouponCode();
    clearCouponFieldError("code");
    codeInput.focus();
    try { codeInput.setSelectionRange(codeInput.value.length, codeInput.value.length); } catch (e) {}
  });

  const discount = document.getElementById("coupon-discount");
  const slider = document.getElementById("coupon-discount-range");
  discount.addEventListener("input", () => {
    const raw = Number(discount.value);
    if (Number.isFinite(raw)) slider.value = String(Math.max(1, Math.min(80, Math.round(raw))));
    clearCouponFieldError("discountPercent");
    updateCouponPreview();
  });
  slider.addEventListener("input", () => {
    discount.value = slider.value;
    clearCouponFieldError("discountPercent");
    updateCouponPreview();
  });

  ["coupon-plan", "coupon-max-uses", "coupon-per-user", "coupon-expires", "coupon-description"]
    .forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        clearCouponFieldError(fieldKeyForId(id));
        // Hand-edited dates no longer match a preset chip.
        if (id === "coupon-expires") {
          document.querySelectorAll("[data-coupon-preset]").forEach((btn) => btn.classList.remove("is-active"));
        }
        updateCouponPreview();
        updateCouponDescriptionCount();
      });
      el.addEventListener("change", updateCouponPreview);
    });

  document.getElementById("coupon-first-purchase").addEventListener("change", updateCouponPreview);

  document.querySelectorAll("[data-coupon-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.couponPreset;
      const input = document.getElementById("coupon-expires");
      const iso = couponPresetExpiryIso(preset);
      input.value = iso ? isoToLocalInputValue(iso) : "";
      clearCouponFieldError("expiresAt");
      document.querySelectorAll("[data-coupon-preset]").forEach((other) => {
        other.classList.toggle("is-active", other === btn);
      });
      updateCouponPreview();
    });
  });

  // 1-Tap Quick Campaign Presets (Creator Partner / Campus CR / Exam Week Flash)
  document.querySelectorAll("[data-campaign-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const values = getCampaignPresetValues(btn.dataset.campaignPreset);
      if (!values) return;

      document.getElementById("coupon-discount").value = String(values.discountPercent);
      document.getElementById("coupon-discount-range").value = String(values.discountPercent);
      document.getElementById("coupon-plan").value = values.applicablePlan;
      document.getElementById("coupon-first-purchase").checked = values.firstPurchaseOnly;
      document.getElementById("coupon-description").value = values.description;
      document.getElementById("coupon-expires").value = values.expiresAtLocal;

      document.querySelectorAll("[data-campaign-preset]").forEach((other) => {
        other.classList.toggle("is-active", other === btn);
      });
      document.querySelectorAll("[data-coupon-preset]").forEach((chip) => {
        chip.classList.toggle("is-active", chip.dataset.couponPreset === values.expiryPreset);
      });

      clearCouponFormErrors();
      updateCouponPreview();
      showToast(`Applied ${values.label} preset`, "info");

      if (!codeInput.readOnly && !codeInput.value.trim()) {
        codeInput.focus();
      }
    });
  });

  form.addEventListener("submit", submitCouponForm);
  document.getElementById("coupon-reset").addEventListener("click", () => {
    resetCouponForm();
    showToast("Form cleared", "info");
  });
  document.getElementById("coupon-cancel-edit").addEventListener("click", () => {
    resetCouponForm();
    showToast("Edit cancelled", "info");
  });
}

function bindCouponToolbar() {
  const search = document.getElementById("coupon-search");
  const status = document.getElementById("coupon-filter-status");
  const sort = document.getElementById("coupon-sort");
  if (search) search.addEventListener("input", debounce(renderCouponRows, 200));
  if (status) status.addEventListener("change", renderCouponRows);
  if (sort) sort.addEventListener("change", renderCouponRows);

  const refresh = document.getElementById("refresh-coupons-btn");
  if (refresh) refresh.addEventListener("click", () => loadCoupons());

  const exportBtn = document.getElementById("export-coupons-btn");
  if (exportBtn) exportBtn.addEventListener("click", exportCoupons);
}

function couponVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

function couponChecked(id) {
  const el = document.getElementById(id);
  return !!(el && el.checked);
}

function fieldKeyForId(id) {
  return {
    "coupon-code": "code",
    "coupon-discount": "discountPercent",
    "coupon-max-uses": "maxUses",
    "coupon-per-user": "maxUsesPerUser",
    "coupon-expires": "expiresAt",
    "coupon-plan": "applicablePlan",
  }[id] || null;
}

function currentCouponFormValues() {
  return {
    code: couponVal("coupon-code"),
    discountPercent: couponVal("coupon-discount"),
    applicablePlan: couponVal("coupon-plan"),
    maxUses: couponVal("coupon-max-uses"),
    maxUsesPerUser: couponVal("coupon-per-user"),
    expiresAt: couponVal("coupon-expires"),
    firstPurchaseOnly: couponChecked("coupon-first-purchase"),
    description: couponVal("coupon-description"),
  };
}

function updateCouponDescriptionCount() {
  const counter = document.getElementById("coupon-desc-count");
  if (!counter) return;
  const length = String(couponVal("coupon-description") || "").length;
  counter.textContent = `${length} / ${COUPON_DESCRIPTION_MAX}`;
  counter.classList.toggle("is-near-limit", length >= COUPON_DESCRIPTION_MAX - 10);
}

function updateCouponPreview() {
  const raw = currentCouponFormValues();
  const numeric = Number(raw.discountPercent);
  const percent = Number.isFinite(numeric) ? Math.max(0, Math.min(COUPON_MAX_DISCOUNT, numeric)) : 0;
  const prices = couponPricePreview(percent);
  const plan = COUPON_PLAN_LABELS[raw.applicablePlan] ? raw.applicablePlan : "all";

  applyCouponPreviewPlan("weekly", prices.weekly, plan);
  applyCouponPreviewPlan("monthly", prices.monthly, plan);
  applyCouponPreviewPlan("yearly", prices.yearly, plan);

  const badge = document.getElementById("coupon-preview-percent");
  if (badge) {
    badge.textContent = percent > 0 ? `${percent}% OFF` : "NO DISCOUNT";
    badge.classList.toggle("is-zero", percent <= 0);
  }

  const note = document.getElementById("coupon-preview-note");
  if (note) {
    note.textContent = plan === "all"
      ? "Applies to Pro 7-Day Pass (₹49), Pro Monthly (₹149), and Pro Yearly (₹999) at checkout."
      : `Applies only to ${COUPON_PLAN_LABELS[plan].toLowerCase()} — other plans charge full price.`;
  }

  updateCouponDescriptionCount();
}

function applyCouponPreviewPlan(plan, price, applicablePlan) {
  const card = document.getElementById(`coupon-price-${plan}`);
  if (!card) return;
  const dimmed = applicablePlan !== "all" && applicablePlan !== plan;
  card.classList.toggle("is-dim", dimmed);

  const finalEl = document.getElementById(`coupon-price-${plan}-final`);
  const baseEl = document.getElementById(`coupon-price-${plan}-base`);
  const saveEl = document.getElementById(`coupon-price-${plan}-save`);
  const noteEl = card.querySelector("[data-plan-note]");

  if (finalEl) finalEl.textContent = formatCouponRupees(price.finalPaise);
  if (baseEl) baseEl.textContent = formatCouponRupees(price.basePaise);
  if (saveEl) {
    saveEl.textContent = dimmed
      ? "Not applicable to this plan"
      : price.savePaise > 0
        ? `Learner saves ${formatCouponRupees(price.savePaise)}`
        : "No discount yet";
  }
  if (noteEl) noteEl.textContent = dimmed ? "Excluded" : "Included";
}

function showCouponFormErrors(errors) {
  Object.keys(COUPON_ERROR_FIELDS).forEach((key) => {
    const el = document.getElementById(COUPON_ERROR_FIELDS[key]);
    if (!el) return;
    const message = errors[key] || "";
    el.textContent = message;
    el.classList.toggle("is-visible", !!message);
    const input = inputForErrorKey(key);
    if (input) {
      input.classList.toggle("is-invalid", !!message);
      input.setAttribute("aria-invalid", message ? "true" : "false");
    }
  });
}

function clearCouponFieldError(key) {
  const id = COUPON_ERROR_FIELDS[key];
  if (!id) return;
  const el = document.getElementById(id);
  if (el) { el.textContent = ""; el.classList.remove("is-visible"); }
  const input = inputForErrorKey(key);
  if (input) { input.classList.remove("is-invalid"); input.removeAttribute("aria-invalid"); }
}

function clearCouponFormErrors() {
  Object.keys(COUPON_ERROR_FIELDS).forEach(clearCouponFieldError);
}

function inputForErrorKey(key) {
  return document.getElementById({
    code: "coupon-code",
    discountPercent: "coupon-discount",
    maxUses: "coupon-max-uses",
    maxUsesPerUser: "coupon-per-user",
    expiresAt: "coupon-expires",
    applicablePlan: "coupon-plan",
  }[key] || "");
}

async function submitCouponForm(event) {
  event.preventDefault();
  clearCouponFormErrors();

  const result = validateCouponForm(currentCouponFormValues());
  if (!result.ok) {
    showCouponFormErrors(result.errors);
    const firstKey = Object.keys(result.errors)[0];
    const firstInput = inputForErrorKey(firstKey);
    if (firstInput) firstInput.focus({ preventScroll: false });
    showToast(result.errors[firstKey], "error");
    return;
  }

  const editing = couponState.editing;
  // On create the code goes live immediately; on edit the current paused /
  // active state is preserved so saving a description can't silently
  // re-activate a code the admin deliberately paused.
  const isActive = editing
    ? (couponState.rows.find((row) => row.code === editing.code) || editing).isActive
    : true;

  const submit = document.getElementById("coupon-submit");
  const idleLabel = editing ? "Save changes" : "Create coupon";
  submit.disabled = true;
  submit.textContent = editing ? "Saving…" : "Creating…";

  const { error } = await sb.rpc("admin_upsert_coupon", {
    p_code: result.value.code,
    p_discount_percent: result.value.discountPercent,
    p_applicable_plan: result.value.applicablePlan,
    p_max_uses: result.value.maxUses,
    p_max_uses_per_user: result.value.maxUsesPerUser,
    p_expires_at: result.value.expiresAtIso,
    p_first_purchase_only: result.value.firstPurchaseOnly,
    p_description: result.value.description,
    p_is_active: isActive,
  });

  submit.disabled = false;
  submit.textContent = idleLabel;

  if (error) {
    const message = friendlyCouponError(error);
    showCouponFormErrors({ code: message });
    showToast(message, "error");
    return;
  }

  showToast(editing ? `${result.value.code} updated` : `${result.value.code} created`, "success");
  resetCouponForm();
  await loadCoupons({ silent: true });
}

function startCouponEdit(code) {
  const row = couponState.rows.find((item) => item.code === code);
  if (!row) return;

  couponState.editing = row;

  const codeInput = document.getElementById("coupon-code");
  codeInput.value = row.code;
  codeInput.readOnly = true;
  codeInput.classList.add("is-locked");
  document.getElementById("coupon-generate-code").disabled = true;

  document.getElementById("coupon-discount").value = String(row.discountPercent || "");
  document.getElementById("coupon-discount-range").value = String(Math.max(1, Math.min(80, row.discountPercent || 1)));
  document.getElementById("coupon-plan").value = COUPON_PLAN_LABELS[row.applicablePlan] ? row.applicablePlan : "all";
  document.getElementById("coupon-max-uses").value = row.maxUses == null ? "" : String(row.maxUses);
  document.getElementById("coupon-per-user").value = String(row.maxUsesPerUser || 1);
  document.getElementById("coupon-expires").value = isoToLocalInputValue(row.expiresAt);
  document.getElementById("coupon-first-purchase").checked = !!row.firstPurchaseOnly;
  document.getElementById("coupon-description").value = row.description || "";

  clearCouponFormErrors();
  document.getElementById("coupon-form-title").textContent = "Edit coupon";
  document.getElementById("coupon-form-sub").textContent = "Update the campaign rules — usage and revenue stay attached to this code.";
  const pill = document.getElementById("coupon-edit-pill");
  pill.hidden = false;
  pill.textContent = `Editing ${row.code}`;
  document.getElementById("coupon-submit").textContent = "Save changes";
  document.getElementById("coupon-cancel-edit").hidden = false;
  document.getElementById("coupon-code-hint").innerHTML =
    "Codes are permanent — to rename, delete this coupon and create a new one.";

  document.querySelectorAll("[data-coupon-preset]").forEach((btn) => btn.classList.remove("is-active"));
  updateCouponPreview();

  const card = document.getElementById("coupon-form-card");
  if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetCouponForm() {
  couponState.editing = null;
  const form = document.getElementById("coupon-form");
  if (!form) return;
  form.reset();

  const codeInput = document.getElementById("coupon-code");
  codeInput.readOnly = false;
  codeInput.classList.remove("is-locked");
  document.getElementById("coupon-generate-code").disabled = false;

  // Safe default: a new code expires in 30 days instead of living forever.
  document.getElementById("coupon-expires").value =
    isoToLocalInputValue(couponPresetExpiryIso("30d"));
  document.getElementById("coupon-per-user").value = "1";

  document.getElementById("coupon-form-title").textContent = "Create a coupon or creator code";
  document.getElementById("coupon-form-sub").textContent = "Tap a quick preset or customize below — works across 7-Day Pass, Monthly & Yearly checkout instantly.";
  const pill = document.getElementById("coupon-edit-pill");
  pill.hidden = true;
  pill.textContent = "";
  document.getElementById("coupon-submit").textContent = "Create coupon";
  document.getElementById("coupon-cancel-edit").hidden = true;
  document.getElementById("coupon-code-hint").innerHTML =
    '3–24 characters · A–Z, 0–9, _ and -. Share as <code>pydebug.in/premium?coupon=CODE</code>.';

  document.querySelectorAll("[data-campaign-preset]").forEach((btn) => btn.classList.remove("is-active"));
  document.querySelectorAll("[data-coupon-preset]").forEach((btn) => btn.classList.remove("is-active"));
  const defaultPreset = document.querySelector('[data-coupon-preset="30d"]');
  if (defaultPreset) defaultPreset.classList.add("is-active");

  clearCouponFormErrors();
  updateCouponPreview();
}

/* ------------------------------------------------------------------ *
 * CSV export
 * ------------------------------------------------------------------ */

function exportCoupons() {
  const rows = filteredCouponRows().map((row) => {
    const usage = couponUsage(row);
    const comm = getRowCommission(row);
    const payout = calculateAffiliatePayout(row.revenuePaise, comm.pct);
    const links = couponTrackingLinks(row.code);
    return {
      code: row.code,
      discount_percent: row.discountPercent,
      applicable_plan: row.applicablePlan,
      status: couponStatus(row).label,
      used_count: usage.used,
      max_uses: usage.unlimited ? "unlimited" : usage.max,
      per_user_limit: row.maxUsesPerUser,
      first_purchase_only: row.firstPurchaseOnly ? "yes" : "no",
      revenue_inr: (row.revenuePaise / 100).toFixed(2),
      commission_percent: comm.pct,
      affiliate_payout_inr: payout.payoutInr.toFixed(2),
      starts_at: row.startsAt || "",
      expires_at: row.expiresAt || "",
      description: row.description,
      premium_link: links.premium,
      today_link: links.today,
      mock_test_link: links.mockTest,
    };
  });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCSV(`pydebug-coupons-${stamp}.csv`, rows);
}
