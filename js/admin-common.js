// admin-common.js — shared across every admin page
// Relies on ../js/supabaseClient.js and ../js/utils.js being loaded first
// (same Supabase project as the user panel, so `sb` is already available).

const ADMIN_PAGE_SIZE = 50;

// Redirects to admin login unless the logged-in user has is_admin = true on
// their profiles row. This is a UX gate only — the real security boundary is
// the Supabase RLS policies (is_admin() function) that block reads/writes at
// the database level even if someone bypasses this check.
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
  // Any other error means the schema/RLS setup itself is broken (missing
  // table/column etc.) — send the user to a dedicated message instead of
  // telling them they're "not an admin".
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
  if (nameEl) nameEl.textContent = profile.full_name || profile.email;

  return profile;
}

async function logoutAdmin() {
  await sb.auth.signOut();
  window.location.href = "index.html";
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
  markAdminActiveNav();
  document.querySelectorAll("[data-admin-logout]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      logoutAdmin();
    })
  );
});
