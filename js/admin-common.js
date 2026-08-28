// admin-common.js — shared across every admin page
// Relies on ./supabaseClient.js and ./utils.js being loaded first
// (same Supabase project as the user panel, so `sb` is already available).

const ADMIN_PAGE_SIZE = 50;

// Redirects to admin login unless the logged-in user has is_admin = true on
// their profiles row. This is a UX gate only — the real security boundary is
// the Supabase RLS policies (is_admin() function) that block reads/writes at
// the database level even if someone bypasses this check.
async function requireAdmin() {
  let session = null;
  try {
    ({ data: { session } } = await sb.auth.getSession());
  } catch (err) {
    // Can't even reach Supabase — treat as "not logged in" rather than
    // leaving the page stuck on its skeleton forever.
    console.error("requireAdmin: getSession failed:", err);
    window.location.href = "index.html?offline=1";
    return null;
  }

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
  // Any other error means the schema/RLS setup itself is broken (missing
  // table/column etc.) — send the user to a dedicated message instead of
  // telling them they're "not an admin".
  if (error && error.code !== "PGRST116") {
    window.location.href = "index.html?setup=1";
    return null;
  }

  if (!profile || !profile.is_admin) {
    await signOutQuietly();
    window.location.href = "index.html?denied=1";
    return null;
  }

  const nameEl = document.getElementById("admin-name");
  if (nameEl) nameEl.textContent = profile.full_name || profile.email || "Admin";

  return profile;
}

// signOut() rejecting (offline) must never block the redirect that follows it.
async function signOutQuietly() {
  try {
    await sb.auth.signOut();
  } catch (err) {
    console.error("signOut failed:", err);
  }
}

async function logoutAdmin() {
  await signOutQuietly();
  window.location.href = "index.html";
}

function markAdminActiveNav() {
  const page =
    decodeURIComponent(window.location.pathname.split("/").pop() || "") || "dashboard.html";
  document.querySelectorAll("[data-admin-nav]").forEach((link) => {
    if (link.getAttribute("data-admin-nav") === page) {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    }
  });
}

// ---------- Shared table/list helpers --------------------------------------
// These used to be copy-pasted into admin-dashboard.js and admin-users.js,
// so a fix in one file silently left the other one broken.

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// Renders a single full-width message row (loading / empty / error state).
// Always uses textContent, never innerHTML, so DB values can't inject markup.
function appendEmptyRow(tbody, message, colSpan = 6) {
  if (!tbody) return;
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colSpan;
  td.className = "empty-row";
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// PostgREST `ilike` treats % and _ as wildcards, and its filter grammar gives
// special meaning to , . : ( ) and \. A search for "50%" or "a,b" previously
// either matched everything or produced a 400. Escape the pattern and quote it.
function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function likeContains(value) {
  return `%${escapeLikePattern(value)}%`;
}

// True when `page` is beyond the end of the result set — i.e. we asked for
// rows starting at `from` but the (filtered) table has fewer rows than that.
// The old check (`count > from`) was inverted and never fired, so deleting the
// last row of the last page left the admin staring at an empty table.
function isPastLastPage(count, from, page) {
  const total = count ?? 0;
  return page > 0 && total > 0 && from >= total;
}

// Human-readable text for a Supabase error / thrown exception.
function errorText(error) {
  if (!error) return "Unknown error";
  return error.message || error.error_description || error.details || String(error);
}

// Renders Prev/Next pagination controls. `page` is 0-based, `total` is the
// full (filtered) row count. Hidden entirely when everything fits on one page.
function renderPagination(container, page, total, onPageChange) {
  if (!container) return;
  const totalPages = Math.max(1, Math.ceil((total || 0) / ADMIN_PAGE_SIZE));
  container.innerHTML = "";
  if (totalPages <= 1) return;

  const safePage = Math.min(Math.max(page, 0), totalPages - 1);

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "btn btn--secondary btn--sm";
  prev.textContent = "← Prev";
  prev.disabled = safePage <= 0;
  prev.addEventListener("click", () => onPageChange(safePage - 1));

  const info = document.createElement("span");
  info.className = "pagination-info";
  info.textContent = `Page ${safePage + 1} of ${totalPages} · ${total} rows`;

  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn btn--secondary btn--sm";
  next.textContent = "Next →";
  next.disabled = safePage >= totalPages - 1;
  next.addEventListener("click", () => onPageChange(safePage + 1));

  container.append(prev, info, next);
}

document.addEventListener("DOMContentLoaded", () => {
  markAdminActiveNav();
  document.querySelectorAll("[data-admin-logout]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      logoutAdmin();
    })
  );
});
