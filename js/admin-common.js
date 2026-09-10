// admin-common.js — shared across every admin page
// Relies on ../js/supabaseClient.js and ../js/utils.js being loaded first
// (same Supabase project as the user panel, so `sb` is already available).

const ADMIN_PAGE_SIZE = 50;
const ADMIN_UNLOCK_SESSION_KEY = "pydebug_admin_panel_unlocked_v1";

// Keep the unlock only for this browser tab. sessionStorage survives normal
// navigation between the admin's HTML pages, but we explicitly clear it when
// the browser tells us this document was loaded by a refresh. This gives us
// the intended behaviour: one password check per visit, never once per page,
// and a fresh check after reload/reopen.
function isDocumentReload() {
  const navigation = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  if (navigation) return navigation.type === "reload";
  return performance.navigation && performance.navigation.type === 1;
}

function getPanelUnlockState() {
  if (isDocumentReload()) {
    try { sessionStorage.removeItem(ADMIN_UNLOCK_SESSION_KEY); } catch (e) {}
    return false;
  }
  try { return sessionStorage.getItem(ADMIN_UNLOCK_SESSION_KEY) === "true"; } catch (e) { return false; }
}

let adminPanelUnlocked = getPanelUnlockState();

async function requirePanelPassword() {
  if (adminPanelUnlocked) {
    document.body.classList.remove("admin-panel-locked");
    return true;
  }

  const overlay = document.createElement("div");
  overlay.className = "admin-password-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "admin-password-title");
  overlay.innerHTML = `
    <div class="admin-password-card">
      <div class="admin-password-icon">${window.adminIcon ? adminIcon("lock") : ""}</div>
      <div class="admin-password-eyebrow">PRIVATE ADMIN AREA</div>
      <h1 id="admin-password-title">Unlock PyDebug Admin</h1>
      <p>Enter the panel password to continue. This lock returns every time the page is refreshed.</p>
      <form id="admin-password-form" novalidate>
        <label class="admin-password-label" for="admin-panel-password">Panel password</label>
        <div class="admin-password-input-wrap">
          <input id="admin-panel-password" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required autofocus placeholder="Enter your password">
          <button type="button" class="admin-password-toggle" id="admin-password-toggle" aria-label="Show password" title="Show password">${window.adminIcon ? adminIcon("eye") : "Show"}</button>
        </div>
        <div class="admin-password-error" id="admin-password-error" role="alert" aria-live="polite"></div>
        <button type="submit" class="btn btn--primary btn--full admin-password-submit" id="admin-password-submit">
          ${window.adminIcon ? adminIcon("key") : ""}<span>Unlock panel</span>
        </button>
      </form>
      <div class="admin-password-meta">${window.adminIcon ? adminIcon("shield") : ""}<span>Protected by your Supabase admin account</span></div>
    </div>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("#admin-password-form");
  const input = overlay.querySelector("#admin-panel-password");
  const errorEl = overlay.querySelector("#admin-password-error");
  const submit = overlay.querySelector("#admin-password-submit");
  const toggle = overlay.querySelector("#admin-password-toggle");
  const setError = (message) => {
    errorEl.textContent = message || "";
    input.setAttribute("aria-invalid", message ? "true" : "false");
    overlay.querySelector(".admin-password-card").classList.toggle("has-error", !!message);
  };

  toggle.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    toggle.innerHTML = window.adminIcon ? adminIcon(hidden ? "eyeOff" : "eye") : (hidden ? "Hide" : "Show");
    toggle.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = input.value;
    if (!password) {
      setError("Enter the panel password to continue.");
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.classList.add("is-loading");
    submit.querySelector("span").textContent = "Checking access…";
    setError("");

    let data = false;
    let error = null;
    try {
      ({ data, error } = await sb.rpc("verify_admin_panel_password", { input_password: password }));
    } catch (err) {
      error = err;
    }

    if (error) {
      console.error("Panel password check:", error);
      setError("Password service is not ready. Run the latest supabase-admin-setup.sql migration first.");
      submit.disabled = false;
      submit.classList.remove("is-loading");
      submit.querySelector("span").textContent = "Unlock panel";
      return;
    }
    if (!data) {
      setError("That password is incorrect. Try again.");
      input.select();
      submit.disabled = false;
      submit.classList.remove("is-loading");
      submit.querySelector("span").textContent = "Unlock panel";
      return;
    }

    adminPanelUnlocked = true;
    try { sessionStorage.setItem(ADMIN_UNLOCK_SESSION_KEY, "true"); } catch (e) {}
    document.body.classList.remove("admin-panel-locked");
    overlay.classList.add("is-unlocked");
    window.setTimeout(() => overlay.remove(), 240);
  });

  window.setTimeout(() => input.focus(), 80);
  return new Promise((resolve) => {
    const check = window.setInterval(() => {
      if (adminPanelUnlocked) {
        window.clearInterval(check);
        resolve(true);
      } else if (!document.body.contains(overlay)) {
        window.clearInterval(check);
        resolve(false);
      }
    }, 50);
  });
}

const ADMIN_AI_FILES = [
  "js/ai-brain.js",
  "js/ai-growth.js",
  "js/ai-content.js",
  "js/ai-safety.js",
  "js/ai-watch.js",
];
let adminAILoadPromise = null;

// AI automation is intentionally loaded only after the admin has unlocked the
// panel. This keeps the first paint and the password screen light; it also
// means a public visitor never downloads the large automation bundle.
function loadAdminAI() {
  if (adminAILoadPromise) return adminAILoadPromise;
  adminAILoadPromise = ADMIN_AI_FILES.reduce((chain, src) => chain.then(() => new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-admin-ai="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.dataset.adminAi = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.body.appendChild(script);
  })), Promise.resolve());
  return adminAILoadPromise;
}

function injectAdminMobileNavigation() {
  const sidebar = document.querySelector(".admin-sidebar");
  if (!sidebar || document.querySelector(".admin-mobile-menu")) return;
  const menu = document.createElement("button");
  menu.className = "admin-mobile-menu";
  menu.type = "button";
  menu.setAttribute("aria-label", "Open admin navigation");
  menu.innerHTML = window.adminIcon ? adminIcon("menu") : "☰";
  const backdrop = document.createElement("div");
  backdrop.className = "admin-sidebar-backdrop";
  document.body.append(menu, backdrop);
  const close = () => { sidebar.classList.remove("is-open"); backdrop.classList.remove("is-open"); };
  menu.addEventListener("click", () => { sidebar.classList.add("is-open"); backdrop.classList.add("is-open"); });
  backdrop.addEventListener("click", close);
  sidebar.querySelectorAll("nav a").forEach((link) => link.addEventListener("click", close));
}

// Redirects to admin login unless the logged-in user has is_admin = true on
// their profiles row. This is a UX gate only — the real security boundary is
// the Supabase RLS policies (is_admin() function) that block writes at the
// database level even if someone bypasses this check.
async function requireAdmin() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }

  let profile = null;
  let error = null;
  try {
    ({ data: profile, error } = await sb
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .single());
  } catch (err) {
    error = err;
  }

  // PGRST116 = no row found (user not in profiles, or RLS blocked the read).
  // Any other error means the schema/RLS setup itself is broken — send the
  // user to a dedicated message instead of telling them they're "not an admin".
  if (error && error.code !== "PGRST116") {
    window.location.href = "index.html?setup=1";
    return null;
  }

  if (!profile || !profile.is_admin) {
    await sb.auth.signOut();
    window.location.href = "index.html?denied=1";
    return null;
  }

  const nameEl = document.getElementById("admin-name");
  if (nameEl) nameEl.textContent = profile.display_name || profile.full_name || profile.email;

  document.body.classList.add("admin-panel-locked");
  const unlocked = await requirePanelPassword();
  if (!unlocked) return null;
  // Always finish loading the AI bundle on every admin page, irrespective of
  // the master switch. The switch controls what the AI does, not whether its
  // feature set is available; awaiting it also prevents page actions (such as
  // AI variations) racing the script load.
  try {
    await loadAdminAI();
  } catch (error) {
    console.warn("Admin automation bundle:", error.message);
  }
  return profile;
}

async function logoutAdmin() {
  adminPanelUnlocked = false;
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

// Coloured badge for submission / payment statuses (tolerates unknown values).
function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  let cls = "tag--unknown";
  if (["solved", "success", "succeeded", "captured", "paid", "completed"].includes(s)) cls = "tag--solved";
  else if (["attempted", "pending", "created", "authorized"].includes(s)) cls = "tag--attempted";
  else if (["failed", "error", "cancelled", "canceled", "refunded"].includes(s)) cls = "tag--failed";
  return `<span class="tag ${cls}">${escapeHtml(status || "—")}</span>`;
}

// Premium plans — MUST stay in sync with the user panel's api/_plans.js
// (amount in paise). Used to derive revenue from the payment_grants ledger.
const PYDEBUG_PLANS = {
  monthly: { label: "Monthly Premium", amount: 9900, days: 30 },
  sixmonth: { label: "6-Month Premium", amount: 49900, days: 182 },
  yearly: { label: "Yearly Premium", amount: 79900, days: 365 },
};

function planLabel(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].label) || key || "—";
}

function planAmountPaise(key) {
  return (PYDEBUG_PLANS[key] && PYDEBUG_PLANS[key].amount) || 0;
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
  document.querySelectorAll("[data-admin-nav]").forEach((link) => {
    if (link.getAttribute("data-admin-nav") === page) link.classList.add("active");
  });
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

document.addEventListener("DOMContentLoaded", () => {
  injectAdminMobileNavigation();
  markAdminActiveNav();
  document.querySelectorAll("[data-admin-logout]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      logoutAdmin();
    })
  );
});
