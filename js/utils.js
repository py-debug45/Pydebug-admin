// utils.js — small helpers shared across pages

// Redirect to login if no active session. Call at the top of protected pages.
async function requireAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }
  return session.user;
}

// Fetch the full profile row (premium status, xp, streak) for a user id.
// Self-healing: if no row exists yet (e.g. the signup-time insert failed
// because email confirmation delayed the session), create it now that the
// user is actually authenticated, instead of leaving the UI blank forever.
async function getProfile(userId) {
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (!error) return data;

  // PGRST116 = no row found for .single()
  if (error.code === "PGRST116") {
    const { data: { user } } = await sb.auth.getUser();
    const { data: created, error: insertError } = await sb
      .from("profiles")
      .insert({
        id: userId,
        full_name: user?.user_metadata?.full_name || (user?.email ? user.email.split("@")[0] : "User"),
        email: user?.email,
        is_premium: false,
        xp: 0,
        streak: 0,
      })
      .select()
      .single();

    if (insertError) {
      console.error("getProfile: auto-create failed:", insertError.message);
      return null;
    }
    return created;
  }

  console.error("getProfile error:", error.message);
  return null;
}

function isPremiumUser(profile) {
  if (!profile || !profile.is_premium) return false;
  if (!profile.premium_expires_at) return true; // lifetime premium
  return new Date(profile.premium_expires_at) > new Date();
}

function showToast(message, type = "info") {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `app-toast app-toast--${type} show`;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Escape a string for safe insertion into HTML (prevents stored XSS when we
// render user/admin-supplied values — problem titles, names, emails, etc. —
// via innerHTML).
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function logout() {
  await sb.auth.signOut();
  window.location.href = "index.html";
}

// Highlights the current page in the sidebar/nav based on file name.
function markActiveNav() {
  const page = window.location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.getAttribute("data-nav") === page) link.classList.add("active");
  });
}

// Global logout binding — works on every page that has a [data-logout] element,
// not just the auth pages. (Previously this only lived in auth.js, which isn't
// loaded on dashboard/profile/etc., so the button silently did nothing there.)
function bindLogoutButtons() {
  document.querySelectorAll("[data-logout]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      logout();
    });
  });
}

// Password show/hide toggle — works on any input wrapped with
// <div class="password-field"><input type="password">...<button data-toggle-password></button></div>
function bindPasswordToggles() {
  document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.closest(".password-field").querySelector("input");
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      btn.innerHTML = window.adminIcon ? adminIcon(isHidden ? "eyeOff" : "eye") : (isHidden ? "Hide" : "Show");
      btn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    });
  });
}

// Fills the sidebar's bottom account block (avatar initial, name, plan badge)
// on any page that includes it. Runs on its own — no page-specific JS needed.
async function fillSidebarAccount() {
  const nameEl = document.getElementById("sidebar-name");
  if (!nameEl) return; // this page has no sidebar account block
  // The Supabase client may not exist yet (or at all, if the SDK was blocked).
  // Never let that throw — it would kill everything after it on the page.
  if (typeof sb === "undefined" || !sb || !sb.auth) return;

  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;

  const profile = await getProfile(session.user.id);
  if (!profile) return;

  const displayName = profile.full_name || profile.email || "User";
  nameEl.textContent = displayName;

  const avatarEl = document.getElementById("sidebar-avatar");
  if (avatarEl) avatarEl.textContent = displayName.trim().charAt(0).toUpperCase();

  const planEl = document.getElementById("sidebar-plan");
  if (planEl) planEl.textContent = isPremiumUser(profile) ? "Premium" : "Free plan";
}

// Mobile sidebar drawer — tap hamburger to open, tap overlay or a nav link to close
function bindMobileDrawer() {
  const menuBtn = document.getElementById("mobile-menu-btn");
  const sidebar = document.getElementById("app-sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  if (!menuBtn || !sidebar || !overlay) return;

  const openDrawer = () => {
    sidebar.classList.add("open");
    overlay.classList.add("open");
  };
  const closeDrawer = () => {
    sidebar.classList.remove("open");
    overlay.classList.remove("open");
  };

  menuBtn.addEventListener("click", openDrawer);
  overlay.addEventListener("click", closeDrawer);
  // Tapping any nav link closes the drawer right away (page navigation follows naturally)
  sidebar.querySelectorAll("nav a, .sidebar__logout-btn").forEach((el) => {
    el.addEventListener("click", closeDrawer);
  });
}

onAdminReady(() => {
  markActiveNav();
  bindLogoutButtons();
  bindPasswordToggles();
  fillSidebarAccount();
  bindMobileDrawer();
});
