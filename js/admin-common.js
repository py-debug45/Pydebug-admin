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
  let isAdminFlag = !!(profile && profile.is_admin);
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

// Premium plans — synced with pydebug.in/premium live founding prices (in paise).
const PYDEBUG_PLANS = {
  monthly: { label: "Pro Monthly", amount: 14900, days: 30 },
  sixmonth: { label: "Pro 6-Month", amount: 49900, days: 182 },
  yearly: { label: "Pro Yearly", amount: 99900, days: 365 },
  exam_pack: { label: "Exam Pack", amount: 149900, days: 365 },
};

function planLabel(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].label) || key || "—";
}

function planAmountPaise(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].amount) || 0;
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
  const page = window.location.pathname.split("/").pop() || "dashboard.html";
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
  ["coupons.html", "🎟️  Coupons & Promos"],
  ["discussions.html", "◌  Discussions"],
  ["notifications.html", "🔔  Notifications"],
  ["ai.html", "🤖  AI Control"],
  ["audit.html", "🛡  Audit log"],
  ["problem-form.html", "＋  Add Problem"],
  ["users.html", "👥  Users"],
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
  injectAdminMobileNavigation();
  markAdminActiveNav();
  document.querySelectorAll("[data-admin-logout]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      logoutAdmin();
    })
  );
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
