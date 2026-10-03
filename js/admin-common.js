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
let resolveUnlock = null;

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
    if (resolveUnlock) { const done = resolveUnlock; resolveUnlock = null; done(true); }
  });

  window.setTimeout(() => input.focus(), 80);
  // Resolve straight from the submit handler. (This used to be a 50ms
  // setInterval poll that kept running for the whole unlock screen.)
  return new Promise((resolve) => { resolveUnlock = resolve; });
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
  const links = document.querySelectorAll(".admin-sidebar nav a");
  links.forEach((link) => {
    const target = link.getAttribute("data-admin-nav") || (link.getAttribute("href") || "").split("#")[0];
    link.classList.toggle("active", target === page);
    if (target) link.dataset.adminNav = target;
  });
}

// Older admin pages intentionally keep their HTML compact. Add the two
// strategic workspace links here so every page has the same navigation depth.
function ensureAdminNavigation() {
  const nav = document.querySelector(".admin-sidebar nav");
  if (!nav) return;
  const has = (page) => !!nav.querySelector(`a[href="${page}"]`);
  const make = (page, label) => {
    const link = document.createElement("a");
    link.href = page;
    link.dataset.adminNav = page;
    link.textContent = label;
    return link;
  };
  const dashboard = nav.querySelector('a[href="dashboard.html"]');
  if (!has("insights.html")) nav.insertBefore(make("insights.html", "◈  Growth insights"), dashboard ? dashboard.nextSibling : nav.firstChild);
  if (!has("audit.html")) nav.insertBefore(make("audit.html", "◌  Audit log"), nav.querySelector('a[href="submissions.html"]') || null);
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
