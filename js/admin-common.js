// admin-common.js — shared across every admin page
// Relies on ../js/supabaseClient.js and ../js/utils.js being loaded first
// (same Supabase project as the user panel, so `sb` is already available).

const ADMIN_PAGE_SIZE = 50;

// Second factor (restored from the earlier secure panel): the login page
// verifies a Google Authenticator (TOTP) code against the database
// (verify_admin_totp(), supabase-admin-totp-setup.sql) and marks this tab.
// Panel pages only check the mark and bounce to the login page without it.
const ADMIN_TOTP_SESSION_KEY = "pydebug_admin_totp_v1";
// Retired panel-password lock — cleared on logout so stale keys can't linger.
const ADMIN_UNLOCK_SESSION_KEY = "pydebug_admin_panel_unlocked_v1";

function hasTotpPass() {
  try { return sessionStorage.getItem(ADMIN_TOTP_SESSION_KEY) === "true"; } catch (e) { return false; }
}

const ADMIN_AI_FILES = [
  "js/ai-brain.js",
  "js/ai-growth.js",
  "js/ai-content.js",
  "js/ai-safety.js",
  "js/ai-watch.js",
];
let adminAILoadPromise = null;

// AI automation is loaded only after the admin has unlocked the panel, and
// the five files are fetched IN PARALLEL (script.async = false keeps them
// executing in order). The old version chained them with
// `promise.then(next)`, so the ~250 KB bundle downloaded one file at a time
// and every page waited for all five before it rendered any data — that was
// the single biggest cause of the panel feeling slow.
function loadAdminAI() {
  if (adminAILoadPromise) return adminAILoadPromise;
  adminAILoadPromise = Promise.all(ADMIN_AI_FILES.map((src) => new Promise((resolve) => {
    if (document.querySelector(`script[data-admin-ai="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = false; // download in parallel, execute in document order
    script.dataset.adminAi = src;
    script.onload = resolve;
    script.onerror = () => {
      console.warn(`[admin] AI module unavailable: ${src}`);
      resolve(); // never let one optional module block the page
    };
    document.head.appendChild(script);
  })));
  return adminAILoadPromise;
}

// Pages that need an AI helper (e.g. the dashboard's ✨ variations button)
// await this instead of the whole page waiting for the bundle up front.
function whenAdminAIReady() {
  return adminAILoadPromise || loadAdminAI();
}

/* ---------------------------------------------------------------------
   Mobile navigation drawer
   The old version only ever ADDED .is-open (no toggle, no Esc, no state),
   and the CSS it relied on was being overridden, so on phones the button
   looked completely dead. This is a small, self-contained controller.
   --------------------------------------------------------------------- */
const AdminNav = (() => {
  let sidebar = null;
  let button = null;
  let backdrop = null;
  let open = false;

  function setOpen(next) {
    if (!sidebar || !backdrop || !button || next === open) return;
    open = next;
    sidebar.classList.toggle("is-open", open);
    backdrop.classList.toggle("is-open", open);
    document.body.classList.toggle("admin-nav-open", open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.setAttribute("aria-label", open ? "Close admin navigation" : "Open admin navigation");
    button.innerHTML = window.adminIcon ? adminIcon(open ? "close" : "menu") : (open ? "✕" : "☰");
    if (open) {
      const first = sidebar.querySelector("nav a");
      if (first) window.setTimeout(() => first.focus({ preventScroll: true }), 180);
    } else {
      button.focus({ preventScroll: true });
    }
  }

  function mount() {
    sidebar = document.querySelector(".admin-sidebar");
    if (!sidebar || document.querySelector(".admin-mobile-menu")) return;

    button = document.createElement("button");
    button.className = "admin-mobile-menu";
    button.type = "button";
    button.setAttribute("aria-label", "Open admin navigation");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "admin-sidebar");
    button.innerHTML = window.adminIcon ? adminIcon("menu") : "☰";

    backdrop = document.createElement("div");
    backdrop.className = "admin-sidebar-backdrop";
    backdrop.hidden = false;

    if (!sidebar.id) sidebar.id = "admin-sidebar";
    document.body.append(button, backdrop);

    // `click` fires for taps, keyboard Enter/Space and mouse alike.
    button.addEventListener("click", (event) => {
      event.preventDefault();
      setOpen(!open);
    });
    backdrop.addEventListener("click", () => setOpen(false));

    // One delegated listener for every nav link (now and any added later).
    sidebar.addEventListener("click", (event) => {
      if (event.target.closest("nav a")) setOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && open) setOpen(false);
    });

    // Returning to desktop width must not leave a stuck scroll lock.
    if (typeof window.matchMedia === "function") {
      const desktop = window.matchMedia("(min-width: 861px)");
      const onChange = (event) => { if (event.matches) setOpen(false); };
      if (desktop.addEventListener) desktop.addEventListener("change", onChange);
      else if (desktop.addListener) desktop.addListener(onChange);
    }
  }

  return { mount, close: () => setOpen(false), isOpen: () => open };
})();

function injectAdminMobileNavigation() {
  AdminNav.mount();
}

// Redirects to admin login unless the logged-in user has is_admin = true on
// their profiles row. This is a UX gate only — the real security boundary is
// the Supabase RLS policies (is_admin() function) that block writes at the
// database level even if someone bypasses this check.
async function requireAdmin() {
  if (typeof sb === "undefined" || !sb) {
    console.error("[admin] Supabase client unavailable — cannot verify admin access.");
    return null;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }

  let profile = null;
  let error = null;
  try {
    // maybeSingle(): 0 rows is a normal answer, not an exception, so a user
    // whose profiles row is missing no longer surfaces as "PGRST116 error".
    ({ data: profile, error } = await sb
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .maybeSingle());
  } catch (err) {
    error = err;
  }

  // `.select("*")` can be refused by RLS even for a real admin (profiles may
  // only expose a whitelist of columns, or the own-row policy is missing).
  // public.is_admin() is SECURITY DEFINER, so ask it directly before deciding
  // the account isn't allowed in — otherwise a policy gap logs a genuine
  // admin straight back out to the login page.
  let isAdminFlag = Boolean(profile && profile.is_admin === true);
  let rpcChecked = false;
  let rpcError = null;
  if (!isAdminFlag) {
    try {
      const { data: rpcData, error: rpcErr } = await sb.rpc("is_admin");
      if (!rpcErr) {
        rpcChecked = true;
        isAdminFlag = rpcData === true;
      } else {
        rpcError = rpcErr;
      }
    } catch (err) {
      rpcError = err;
    }
  }

  if (isAdminFlag && !profile) {
    // RLS hid the row: fetch just the label we display, ignoring failures.
    try {
      const { data: nameRow } = await sb
        .from("profiles")
        .select("display_name, full_name, email")
        .eq("id", session.user.id)
        .maybeSingle();
      if (nameRow) profile = nameRow;
    } catch (e) {}
  }

  if (isAdminFlag) {
    // ok — continue below
  } else if (rpcChecked) {
    // Confirmed: this account really is not an admin.
    await sb.auth.signOut();
    window.location.href = "index.html?denied=1";
    return null;
  } else {
    // Could not verify at all (broken schema, missing is_admin column, RLS).
    const brokenSchema = !!error || !!rpcError;
    if (brokenSchema) {
      console.error("[admin] admin check failed:", error || rpcError);
      window.location.href = "index.html?setup=1";
      return null;
    }
    await sb.auth.signOut();
    window.location.href = "index.html?denied=1";
    return null;
  }

  // `is_admin` may have been true only via the RPC, so normalise the flag.
  if (profile) profile.is_admin = true;

  // Callers rely on the returned value being non-null (and on `.id`), so when
  // RLS hid the row build the minimum object from the session instead.
  if (!profile) {
    profile = { id: session.user.id, email: session.user.email, is_admin: true };
  }

  const nameEl = document.getElementById("admin-name");
  if (nameEl) {
    nameEl.textContent = profile.display_name || profile.full_name || profile.email || "admin";
  }

  // Second factor: this tab must have passed the Google Authenticator code
  // on the login page. Without it, go back there — the login page jumps
  // straight to the code step when a session already exists.
  if (!hasTotpPass()) {
    document.body.classList.add("admin-panel-locked"); // stay hidden during the redirect
    window.location.href = "index.html?2fa=1";
    return null;
  }
  document.body.classList.remove("admin-panel-locked");

  // The AI bundle is still loaded on every admin page (the master switch
  // controls what it DOES, not whether it is available) — but it is now
  // kicked off in the background instead of being awaited here. Page data
  // no longer queues behind ~250 KB of optional automation code; anything
  // that genuinely needs it awaits whenAdminAIReady().
  const startAI = () => loadAdminAI();
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(startAI, { timeout: 1500 });
  } else {
    window.setTimeout(startAI, 200);
  }
  return profile;
}

async function logoutAdmin() {
  try { sessionStorage.removeItem(ADMIN_TOTP_SESSION_KEY); } catch (e) {}
  try { sessionStorage.removeItem(ADMIN_UNLOCK_SESSION_KEY); } catch (e) {}
  await sb.auth.signOut();
  window.location.href = "index.html";
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// Strip PostgREST filter metacharacters so a typed search can't break .or()
// / .ilike() syntax (%, _, commas, parentheses, periods).
function sanitizeIlike(value) {
  return String(value || "").trim().replace(/[%_,.\\()]/g, "");
}

// "5m ago" style relative time for activity feeds and tables.
function timeAgo(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "—";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d ago";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Rupees → "₹1,234" (callers pass rupees; divide paise by 100 first)
function fmtINR(rupees) {
  return "₹" + Math.round(rupees || 0).toLocaleString("en-IN");
}

// Paise → "₹49" or "₹39.20" (keeps paise decimals only when non-zero)
function formatPaiseINR(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return "₹0";
  const rupees = n / 100;
  const hasPaise = Math.round(rupees * 100) % 100 !== 0;
  return "₹" + rupees.toLocaleString("en-IN", hasPaise
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
}

// Shared 1-tap clipboard helper with Android/non-HTTPS fallback.
async function copyAdminText(text, toastLabel) {
  const str = String(text == null ? "" : text);
  let copied = false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof window !== "undefined" && window.isSecureContext) {
      await navigator.clipboard.writeText(str);
      copied = true;
    }
  } catch (e) { /* fall through */ }
  if (!copied && typeof document !== "undefined" && document.body) {
    try {
      const area = document.createElement("textarea");
      area.value = str;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand("copy");
      area.remove();
    } catch (e) {
      copied = false;
    }
  }
  if (typeof showToast === "function") {
    if (copied) showToast(toastLabel || "Copied to clipboard", "success");
    else showToast(`Copy manually: ${str}`, "error");
  }
  return copied;
}

// Coloured badge for submission / payment / moderation / feature statuses.
function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  let cls = "tag--unknown";
  if (["solved", "success", "succeeded", "captured", "paid", "completed", "active", "graded", "finished", "qualified", "rewarded", "approved", "pilot_active"].includes(s)) cls = "tag--solved";
  else if (["attempted", "pending", "created", "authorized", "in_progress", "waiting", "submitted", "new", "contacted", "muted"].includes(s)) cls = "tag--attempted";
  else if (["failed", "error", "cancelled", "canceled", "refunded", "revoked", "expired", "late", "rejected", "invalid", "suspended", "banned", "closed"].includes(s)) cls = "tag--failed";
  return `<span class="tag ${cls}">${escapeHtml(status || "—")}</span>`;
}

// Account moderation badge (muted / suspended / banned, expiry-aware).
function accountStatusBadge(profile) {
  if (!profile) return "";
  const st = String(profile.status || "active").toLowerCase();
  if (st === "active") return "";
  if (profile.status_until && new Date(profile.status_until) <= new Date()) {
    return '<span class="tag tag--unknown" title="Restriction expired">Restriction ended</span>';
  }
  const tip = [
    profile.status_reason ? `Reason: ${profile.status_reason}` : "",
    profile.status_until ? `Until: ${fmtDateTime(profile.status_until)}` : "Permanent",
  ].filter(Boolean).join(" · ");
  const cls = st === "muted" ? "tag--attempted" : "tag--failed";
  return `<span class="tag ${cls}" title="${escapeHtml(tip)}">${escapeHtml(st)}</span>`;
}

// Certificate tier badge (bronze / silver / gold / diamond).
function tierBadge(tier) {
  const t = String(tier || "").toLowerCase();
  const labels = {
    bronze: "🥉 Bronze",
    silver: "🥈 Silver",
    gold: "🥇 Gold",
    diamond: "💎 Diamond",
  };
  return `<span class="tag tag--tier tag--tier-${escapeHtml(t)}">${escapeHtml(labels[t] || tier || "—")}</span>`;
}

// Premium plans — synced with pydebug.in api/_plans.js (amounts in paise).
const PYDEBUG_PLANS = {
  weekly: {
    label: "Pro 7-Day Pass (7d)",
    shortLabel: "Pro 7-Day Pass",
    amount: 4900,        // ₹49 founding price
    welcomeAmount: 3900, // ₹39 48h new-user welcome offer
    listAmount: 7900,    // ₹79 list price
    days: 7,
    productKey: "pro",
  },
  monthly: {
    label: "Pro Monthly",
    shortLabel: "Pro Monthly",
    amount: 14900,       // ₹149 founding price
    welcomeAmount: 11900, // ₹119 welcome offer
    listAmount: 19900,    // ₹199 list price
    days: 30,
    productKey: "pro",
  },
  yearly: {
    label: "Pro Yearly",
    shortLabel: "Pro Yearly",
    amount: 99900,       // ₹999 founding price
    welcomeAmount: 79900, // ₹799 welcome offer
    listAmount: 149900,   // ₹1,499 list price
    days: 365,
    productKey: "pro",
  },
  sixmonth: {
    label: "Pro 6 Months (Legacy)",
    shortLabel: "Pro 6 Months (Legacy)",
    amount: 49900,
    days: 182,
    productKey: "pro",
    legacy: true,
  },
  exam_pack: {
    label: "Exam Pack",
    shortLabel: "Exam Pack",
    amount: 149900,
    days: 365,
    productKey: "exam_pack",
  },
};

function planLabel(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].label) || key || "—";
}

function planAmountPaise(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].amount) || 0;
}

function planBadge(key, fallbackCls = "tag--premium") {
  const k = String(key || "").toLowerCase();
  let cls = fallbackCls;
  if (k === "weekly") cls = "tag--weekly";
  else if (k === "sixmonth") cls = "tag--unknown";
  return `<span class="tag ${cls}">${escapeHtml(planLabel(key))}</span>`;
}

/* ---------------------------------------------------------------------
   Sachet Conversion & Pro Plan Split Analytics (weekly vs monthly vs yearly)
   --------------------------------------------------------------------- */
const SACHET_SPLIT_PLANS = ["weekly", "monthly", "yearly"];
const PRO_DURATION_PLANS = new Set(["weekly", "monthly", "yearly", "sixmonth"]);

function emptyPlanSplitBucket() {
  return {
    weekly: { count: 0, revenuePaise: 0 },
    monthly: { count: 0, revenuePaise: 0 },
    yearly: { count: 0, revenuePaise: 0 },
    totalCount: 0,
    totalRevenuePaise: 0,
  };
}

// Computes Today & Last 7 Days count + ₹ revenue split across weekly / monthly /
// yearly, plus repeat upgrades: users who bought `weekly` first and later bought
// `monthly` or `yearly` (repeat payment_grants rows for the same user_id).
function computeSachetMetrics(grants, now) {
  const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const weekStartMs = nowMs - 7 * 86400000;

  const today = emptyPlanSplitBucket();
  const last7d = emptyPlanSplitBucket();
  const byUser = new Map();

  (grants || []).forEach((g, idx) => {
    if (!g) return;
    const plan = String(g.plan_key || "").toLowerCase();
    const paise = Math.max(0, Number(grantAmountPaise(g)) || 0);
    const createdMs = g.created_at ? new Date(g.created_at).getTime() : NaN;

    if (SACHET_SPLIT_PLANS.includes(plan) && Number.isFinite(createdMs) && createdMs <= nowMs + 86400000) {
      if (createdMs >= todayStartMs) {
        today[plan].count += 1;
        today[plan].revenuePaise += paise;
        today.totalCount += 1;
        today.totalRevenuePaise += paise;
      }
      if (createdMs >= weekStartMs) {
        last7d[plan].count += 1;
        last7d[plan].revenuePaise += paise;
        last7d.totalCount += 1;
        last7d.totalRevenuePaise += paise;
      }
    }

    if (g.user_id && PRO_DURATION_PLANS.has(plan)) {
      const uid = String(g.user_id);
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push({
        plan,
        paise,
        at: Number.isFinite(createdMs) ? createdMs : 0,
        idx,
      });
    }
  });

  let weeklyFirstUsers = 0;
  let upgradedUsers = 0;
  let toMonthlyUsers = 0;
  let toYearlyUsers = 0;
  let upgradeRevenuePaise = 0;

  byUser.forEach((list) => {
    list.sort((a, b) => (a.at - b.at) || (a.idx - b.idx));
    if (!list.length || list[0].plan !== "weekly") return;
    weeklyFirstUsers += 1;
    const later = list.slice(1).filter((item) => item.plan === "monthly" || item.plan === "yearly");
    if (!later.length) return;
    upgradedUsers += 1;
    if (later.some((item) => item.plan === "monthly")) toMonthlyUsers += 1;
    if (later.some((item) => item.plan === "yearly")) toYearlyUsers += 1;
    later.forEach((item) => { upgradeRevenuePaise += item.paise; });
  });

  const conversionPercent = weeklyFirstUsers > 0
    ? Math.round((upgradedUsers / weeklyFirstUsers) * 100)
    : 0;

  return {
    today,
    last7d,
    upgrades: {
      weeklyFirstUsers,
      upgradedUsers,
      toMonthlyUsers,
      toYearlyUsers,
      conversionPercent,
      upgradeRevenuePaise,
    },
  };
}

function renderSachetWindowRows(bucket) {
  const rows = [
    ["weekly", "Pro 7-Day Pass (7d)", "tag--weekly"],
    ["monthly", "Pro Monthly", "tag--premium"],
    ["yearly", "Pro Yearly", "tag--info"],
  ];
  return rows.map(([key, label, cls]) => {
    const item = (bucket && bucket[key]) || { count: 0, revenuePaise: 0 };
    return `<div class="sachet-split-row">
      <span class="tag ${cls}">${escapeHtml(label)}</span>
      <span class="sachet-split-count">${item.count.toLocaleString("en-IN")} paid</span>
      <strong class="sachet-split-rev">${escapeHtml(formatPaiseINR(item.revenuePaise))}</strong>
    </div>`;
  }).join("");
}

function renderSachetCardHtml(metrics) {
  const m = metrics || computeSachetMetrics([]);
  const u = m.upgrades;
  const upgradeSub = u.weeklyFirstUsers > 0
    ? `${u.upgradedUsers.toLocaleString("en-IN")} of ${u.weeklyFirstUsers.toLocaleString("en-IN")} 7-Day Pass starters (${u.conversionPercent}%)`
    : "Waiting for first 7-Day Pass cohort";
  const breakdown = (u.toMonthlyUsers || u.toYearlyUsers)
    ? `${u.toMonthlyUsers} → Monthly · ${u.toYearlyUsers} → Yearly · ${formatPaiseINR(u.upgradeRevenuePaise)} repeat ₹`
    : "Tracks repeat payment_grants for the same user_id";

  return `<div class="section-card sachet-card">
    <div class="section-card__head sachet-card__head">
      <div>
        <div class="admin-eyebrow" style="margin-bottom:4px">SACHET MONETIZATION · 7D PASS → FULL PRO</div>
        <h3>Pro 7-Day Pass Conversion &amp; Revenue Split</h3>
      </div>
      <span class="tag tag--weekly" data-keep-emoji>⚡ ${u.upgradedUsers.toLocaleString("en-IN")} Sachet → Pro Upgrades</span>
    </div>
    <div class="sachet-grid">
      <div class="sachet-panel">
        <div class="sachet-panel__head">
          <span>Today</span>
          <strong>${escapeHtml(formatPaiseINR(m.today.totalRevenuePaise))} · ${m.today.totalCount} orders</strong>
        </div>
        ${renderSachetWindowRows(m.today)}
      </div>
      <div class="sachet-panel">
        <div class="sachet-panel__head">
          <span>Last 7 Days</span>
          <strong>${escapeHtml(formatPaiseINR(m.last7d.totalRevenuePaise))} · ${m.last7d.totalCount} orders</strong>
        </div>
        ${renderSachetWindowRows(m.last7d)}
      </div>
      <div class="sachet-panel sachet-panel--upgrade">
        <div class="sachet-panel__head">
          <span>Weekly → Monthly / Yearly</span>
          <strong>${u.conversionPercent}% upgrade</strong>
        </div>
        <div class="sachet-upgrade-kpi">${u.upgradedUsers.toLocaleString("en-IN")} <small>repeat upgraders</small></div>
        <div class="sachet-upgrade-sub">${escapeHtml(upgradeSub)}</div>
        <div class="sachet-upgrade-meta">${escapeHtml(breakdown)}</div>
      </div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------
   Campus / College Leaderboard Parsing & Moderation ("Base Name · Campus Tag")
   --------------------------------------------------------------------- */
const CAMPUS_DELIMITER = " · ";
const DISPLAY_NAME_MAX_LEN = 60;
const CAMPUS_LEADERBOARD_BASE = "https://pydebug.in/leaderboard?campus=";

function parseDisplayNameCampus(displayName) {
  const raw = String(displayName == null ? "" : displayName).trim();
  if (!raw) return { raw: "", baseName: "", campusTag: null, hasCampus: false };
  const idx = raw.indexOf(CAMPUS_DELIMITER);
  if (idx < 0) return { raw, baseName: raw, campusTag: null, hasCampus: false };
  const baseName = raw.slice(0, idx).trim();
  const campusTag = raw.slice(idx + CAMPUS_DELIMITER.length).replace(/\s+/g, " ").trim();
  if (!campusTag) {
    return { raw, baseName: baseName || raw, campusTag: null, hasCampus: false };
  }
  return { raw, baseName, campusTag, hasCampus: true };
}

function composeDisplayNameWithCampus(baseName, campusTag) {
  const cleanBase = String(baseName == null ? "" : baseName)
    .replace(/\s*·\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleanCampus = String(campusTag == null ? "" : campusTag)
    .replace(/\s*·\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanCampus) return cleanBase.slice(0, DISPLAY_NAME_MAX_LEN);
  if (!cleanBase) return cleanCampus.slice(0, DISPLAY_NAME_MAX_LEN);
  const full = `${cleanBase}${CAMPUS_DELIMITER}${cleanCampus}`;
  if (full.length <= DISPLAY_NAME_MAX_LEN) return full;
  const maxBase = Math.min(cleanBase.length, 38);
  const basePart = cleanBase.slice(0, maxBase).trim();
  const maxCampus = Math.max(1, DISPLAY_NAME_MAX_LEN - basePart.length - CAMPUS_DELIMITER.length);
  return `${basePart}${CAMPUS_DELIMITER}${cleanCampus.slice(0, maxCampus).trim()}`.slice(0, DISPLAY_NAME_MAX_LEN);
}

function clearDisplayNameCampus(displayName, fallbackName) {
  const parsed = parseDisplayNameCampus(displayName);
  if (parsed.baseName) return parsed.baseName.slice(0, DISPLAY_NAME_MAX_LEN);
  const fb = String(fallbackName == null ? "" : fallbackName)
    .replace(/\s*·\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return fb.slice(0, DISPLAY_NAME_MAX_LEN);
}

function campusLeaderboardLink(campusTag) {
  return CAMPUS_LEADERBOARD_BASE + encodeURIComponent(String(campusTag == null ? "" : campusTag).trim());
}

// Groups profiles with `' · '` campus tags case-insensitively and computes
// Total Students, Active Streak Users (streak > 0), Total XP, Pro Subscribers (is_premium = true).
function aggregateCampuses(profiles) {
  const groups = new Map();

  (profiles || []).forEach((p) => {
    if (!p) return;
    const parsed = parseDisplayNameCampus(p.display_name);
    if (!parsed.hasCampus || !parsed.campusTag) return;

    const key = parsed.campusTag.toLowerCase();
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        key,
        campus: parsed.campusTag,
        labelCounts: new Map(),
        totalStudents: 0,
        activeStreakUsers: 0,
        totalXp: 0,
        proSubscribers: 0,
      };
      groups.set(key, entry);
    }

    const prevCount = entry.labelCounts.get(parsed.campusTag) || 0;
    entry.labelCounts.set(parsed.campusTag, prevCount + 1);

    entry.totalStudents += 1;
    if ((Number(p.streak) || 0) > 0) entry.activeStreakUsers += 1;
    entry.totalXp += Math.max(0, Number(p.xp) || 0);
    if (p.is_premium === true) entry.proSubscribers += 1;
  });

  const list = [];
  groups.forEach((entry) => {
    // Pick the most popular display casing; break ties in favour of capitalised forms.
    let bestLabel = entry.campus;
    let bestScore = -1;
    entry.labelCounts.forEach((cnt, label) => {
      const hasUpper = /[A-Z]/.test(label) ? 0.25 : 0;
      const score = cnt + hasUpper;
      if (score > bestScore) {
        bestScore = score;
        bestLabel = label;
      }
    });
    list.push({
      key: entry.key,
      campus: bestLabel,
      totalStudents: entry.totalStudents,
      activeStreakUsers: entry.activeStreakUsers,
      totalXp: entry.totalXp,
      proSubscribers: entry.proSubscribers,
      leaderboardUrl: campusLeaderboardLink(bestLabel),
    });
  });

  return list.sort((a, b) =>
    (b.totalStudents - a.totalStudents) ||
    (b.totalXp - a.totalXp) ||
    a.campus.localeCompare(b.campus)
  );
}

function renderCampusAnalyticsHtml(campuses, opts) {
  const options = opts || {};
  const list = Array.isArray(campuses) ? campuses : [];
  const limit = options.limit || 25;
  const shown = list.slice(0, limit);
  const totalStudents = list.reduce((sum, c) => sum + c.totalStudents, 0);

  if (!shown.length) {
    return `<div class="empty-row" style="padding:14px 4px">No learners have attached a <code>Base Name · Campus Tag</code> badge yet.</div>`;
  }

  return `<div class="campus-summary-strip">
      <span><strong>${list.length.toLocaleString("en-IN")}</strong> campus${list.length === 1 ? "" : "es"}</span>
      <span><strong>${totalStudents.toLocaleString("en-IN")}</strong> tagged students</span>
    </div>
    <div class="admin-table-wrap campus-table-wrap">
      <table class="admin-table campus-table">
        <thead>
          <tr>
            <th>#</th>
            <th>College / Campus</th>
            <th>Students</th>
            <th>Active Streak</th>
            <th>Total XP</th>
            <th>Pro Subscribers</th>
            <th>Share / Actions</th>
          </tr>
        </thead>
        <tbody>
          ${shown.map((c, idx) => `<tr>
            <td class="mono muted">${idx + 1}</td>
            <td><span class="campus-pill" data-keep-emoji>🎓 ${escapeHtml(c.campus)}</span></td>
            <td><strong>${c.totalStudents.toLocaleString("en-IN")}</strong></td>
            <td><span class="tag ${c.activeStreakUsers > 0 ? "tag--solved" : "tag--unknown"}">${c.activeStreakUsers.toLocaleString("en-IN")} 🔥</span></td>
            <td>${c.totalXp.toLocaleString("en-IN")} XP</td>
            <td>${c.proSubscribers > 0 ? `<span class="tag tag--premium">${c.proSubscribers.toLocaleString("en-IN")} Pro</span>` : '<span class="muted">0</span>'}</td>
            <td>
              <div class="campus-row-actions">
                <button type="button" class="btn btn--secondary btn--sm" data-copy-campus-link="${escapeHtml(c.leaderboardUrl)}" data-campus-name="${escapeHtml(c.campus)}" title="Copy ${escapeHtml(c.leaderboardUrl)}">🔗 Copy Campus Leaderboard Link</button>
                ${options.allowFilter ? `<button type="button" class="btn btn--secondary btn--sm" data-filter-campus="${escapeHtml(c.campus)}">Filter</button>` : ""}
              </div>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function slugifyProblemTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "python-problem";
}

async function writeAdminAudit(action, entityType, entityId, metadata = {}) {
  try {
    if (typeof sb === "undefined" || !sb || !sb.auth) return;
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    await sb.from("admin_audit_log").insert({
      admin_id: user.id,
      action,
      entity_type: entityType,
      entity_id: String(entityId || ""),
      target_id: String(entityId || ""),
      metadata: metadata || {},
    });
  } catch (e) {
    console.warn("[admin] audit log:", e.message);
  }
}

// Pick the first key from `candidates` that exists on the sample row.
// Lets admin pages survive small schema differences in the user panel.
function detectCol(sample, candidates) {
  if (!sample) return candidates[0];
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(sample, c)) return c;
  }
  return candidates[0];
}

function markAdminActiveNav() {
  const rawPage = window.location.pathname.split("/").pop() || "dashboard.html";
  const page = rawPage.endsWith(".html") ? rawPage : `${rawPage}.html`;
  const links = document.querySelectorAll(".admin-sidebar nav a");
  links.forEach((link) => {
    const target = link.getAttribute("data-admin-nav") || (link.getAttribute("href") || "").split("#")[0];
    link.classList.toggle("active", target === page);
    if (target) link.dataset.adminNav = target;
  });
}

// Older admin pages intentionally keep their HTML compact. Ensure every
// page has the complete, consistently ordered workspace navigation.
const ADMIN_NAV_ITEMS = [
  ["dashboard.html", "▥  Dashboard"],
  ["insights.html", "◈  Growth insights"],
  ["certificates.html", "✦  Certificates"],
  ["arenas.html", "⚔  Mocks & Battles"],
  ["community.html", "💬  Community & Hub"],
  ["submissions.html", "</> Submissions"],
  ["payments.html", "₹  Payments"],
  ["coupons.html", "🎟️  Coupons & Creators"],
  ["discussions.html", "◌  Discussions"],
  ["notifications.html", "🔔  Notifications"],
  ["ai.html", "🤖  AI Control"],
  ["audit.html", "🛡  Audit log"],
  ["problem-form.html", "＋  Add Problem"],
  ["users.html", "👥  Users"],
];

// 1-tap external Founder Quick Tools — optimized for mobile solo operations.
const FOUNDER_QUICK_TOOLS = [
  { href: "https://pydebug.in/reel-studio", label: "🎬 Open 9:16 Reel & DM Studio", shortLabel: "🎬 Reel & DM Studio" },
  { href: "https://pydebug.in/today", label: "🟩 Today's Wordle Challenge", shortLabel: "🟩 Today's Wordle" },
  { href: "https://pydebug.in/mock-test", label: "📝 Live Mock Test", shortLabel: "📝 Live Mock Test" },
  { href: "https://pydebug.in/leaderboard", label: "🏆 Campus Leaderboard", shortLabel: "🏆 Campus Leaderboard" },
];

function ensureAdminNavigation() {
  const nav = document.querySelector(".admin-sidebar nav");
  if (!nav) return;
  const existing = new Map();
  nav.querySelectorAll("a[href]").forEach((a) => {
    const href = (a.getAttribute("href") || "").split("#")[0];
    if (href) existing.set(href, a);
  });
  const frag = document.createDocumentFragment();
  ADMIN_NAV_ITEMS.forEach(([href, label]) => {
    let link = existing.get(href);
    if (!link) {
      link = document.createElement("a");
      link.href = href;
      link.textContent = label;
    }
    link.dataset.adminNav = href;
    existing.delete(href);
    frag.appendChild(link);
  });
  // Preserve any custom links not in the canonical list at the end.
  existing.forEach((link) => frag.appendChild(link));
  nav.innerHTML = "";
  nav.appendChild(frag);
}

function ensureFounderQuickTools() {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return;

  // 1. Mobile-first horizontal 1-tap quick-launch bar below .admin-topbar
  const main = document.querySelector(".admin-main");
  if (main && !main.querySelector(".founder-quick-bar")) {
    const bar = document.createElement("nav");
    bar.className = "founder-quick-bar";
    bar.setAttribute("aria-label", "Founder Quick Tools");
    bar.setAttribute("data-keep-emoji", "1");
    bar.innerHTML =
      `<span class="founder-quick-bar__label">Founder Quick Tools</span>` +
      `<div class="founder-quick-bar__links">` +
      FOUNDER_QUICK_TOOLS.map((item) =>
        `<a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer" class="founder-quick-pill">${escapeHtml(item.label)} <span aria-hidden="true">↗</span></a>`
      ).join("") +
      `</div>`;
    const topbar = main.querySelector(".admin-topbar");
    if (topbar && topbar.nextSibling) main.insertBefore(bar, topbar.nextSibling);
    else if (topbar) main.appendChild(bar);
    else main.prepend(bar);
  }

  // 2. Sidebar drawer quick links above the account footer
  const sidebar = document.querySelector(".admin-sidebar");
  if (sidebar && !sidebar.querySelector(".admin-sidebar__quick")) {
    const box = document.createElement("div");
    box.className = "admin-sidebar__quick";
    box.setAttribute("data-keep-emoji", "1");
    box.innerHTML =
      `<div class="admin-sidebar__quick-title">FOUNDER QUICK TOOLS</div>` +
      FOUNDER_QUICK_TOOLS.map((item) =>
        `<a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer" class="admin-sidebar__quick-link">${escapeHtml(item.shortLabel)} <span aria-hidden="true">↗</span></a>`
      ).join("");
    const account = sidebar.querySelector(".admin-sidebar__account");
    if (account) sidebar.insertBefore(box, account);
    else sidebar.appendChild(box);
  }
}


// Renders Prev/Next pagination controls. `page` is 0-based, `total` is the
// full (filtered) row count. Hidden entirely when everything fits on one page.
function renderPagination(container, page, total, onPageChange) {
  if (!container) return;
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  container.innerHTML = "";
  if (totalPages <= 1) return;

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "btn btn--secondary btn--sm";
  prev.textContent = "← Prev";
  prev.disabled = page <= 0;
  prev.addEventListener("click", () => onPageChange(page - 1));

  const info = document.createElement("span");
  info.className = "pagination-info";
  info.textContent = `Page ${page + 1} of ${totalPages} · ${total} rows`;

  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn btn--secondary btn--sm";
  next.textContent = "Next →";
  next.disabled = page >= totalPages - 1;
  next.addEventListener("click", () => onPageChange(page + 1));

  container.append(prev, info, next);
}

// Navigation is pure DOM work: mount it as soon as the markup exists so the
// menu button is usable even if Supabase is still connecting.
function bootAdminChrome() {
  ensureAdminNavigation();
  ensureFounderQuickTools();
  injectAdminMobileNavigation();
  markAdminActiveNav();
  document.querySelectorAll("[data-admin-logout]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      logoutAdmin();
    })
  );
  // Delegated 1-tap copy handler for Campus Leaderboard links anywhere in the panel
  if (document.body && document.body.dataset.campusCopyBound !== "1") {
    document.body.dataset.campusCopyBound = "1";
    document.body.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-copy-campus-link]") : null;
      if (!btn) return;
      const url = btn.dataset.copyCampusLink;
      const name = btn.dataset.campusName || "Campus";
      copyAdminText(url, `Copied ${name} leaderboard link`);
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootAdminChrome, { once: true });
} else {
  bootAdminChrome();
}

// PostgREST caps each response (usually 1,000 rows), even with .limit(20000).
// Page deterministically so analytics never silently reports only the first page.
async function fetchAdminRows(table, columns, orderColumn = "id") {
  const rows = [];
  const size = 500;
  for (let offset = 0; ; offset += size) {
    const { data, error } = await sb.from(table).select(columns)
      .order(orderColumn, { ascending: true }).range(offset, offset + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) return rows;
  }
}

// Payment ledger helpers ---------------------------------------------------
// A grant's `amount_paise` is what Razorpay actually captured, so coupons,
// founding-offer prices and old prices are all reflected. Older grants were
// written before the column was populated (see
// db/migrations/20261024_payment_actual_amounts.sql), so we can also use the
// linked checkout order's amount. Only when neither exists do we fall back to
// the plan catalog price — and the UI marks that value as an estimate instead
// of pretending it is the real charged amount.
function grantPaidPaise(grant) {
  if (!grant) return null;
  const amount = grant.amount_paise;
  if (amount !== null && amount !== undefined && amount !== "" && Number.isFinite(Number(amount))) {
    return Number(amount);
  }
  const orderAmount = grant.order_amount_paise;
  if (orderAmount !== null && orderAmount !== undefined && orderAmount !== "" && Number.isFinite(Number(orderAmount))) {
    return Number(orderAmount);
  }
  return null;
}

function grantAmountIsEstimated(grant) {
  return grantPaidPaise(grant) === null;
}

function grantAmountPaise(grant) {
  const paid = grantPaidPaise(grant);
  return paid !== null ? paid : planAmountPaise(grant && grant.plan_key);
}

// Coupon percent when the ledger has it; otherwise inferred from the amount
// actually paid versus the plan price (covers old grants without coupon data).
function grantDiscountPercent(grant) {
  const explicit = Number(grant && grant.discount_percent);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(99, Math.round(explicit));
  const paid = grantPaidPaise(grant);
  const list = planAmountPaise(grant && grant.plan_key);
  if (paid !== null && list > 0 && paid < list) {
    return Math.min(99, Math.round((1 - paid / list) * 100));
  }
  return 0;
}

// What the learner would have paid without the coupon.
function grantListAmountPaise(grant) {
  const paid = grantPaidPaise(grant);
  const plan = planAmountPaise(grant && grant.plan_key);
  const pct = grantDiscountPercent(grant);
  if (paid !== null && pct > 0) {
    // Reverse the coupon: paid = list * (100 - pct) / 100 (rounded to paise).
    return Math.round((paid * 100) / (100 - pct));
  }
  return plan || paid || 0;
}

function grantDiscountPaise(grant) {
  const paid = grantPaidPaise(grant);
  if (paid === null) return 0; // never claim a saving we cannot verify
  return Math.max(0, grantListAmountPaise(grant) - paid);
}

// Human label for an entitlement end date: "23 days left" / "Expired".
function premiumTimeLeft(iso) {
  if (!iso) return { expired: false, days: null, label: "No expiry" };
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return { expired: false, days: null, label: "" };
  if (ms <= 0) return { expired: true, days: 0, label: "Expired" };
  const days = Math.ceil(ms / 86400000);
  if (ms < 86400000) {
    const hours = Math.max(1, Math.ceil(ms / 3600000));
    return { expired: false, days, label: `Ends in ${hours}h` };
  }
  return { expired: false, days, label: `${days} day${days === 1 ? "" : "s"} left` };
}
