// admin-users.js — user list with plan/role filters, sorting, CSV export.
// Row-level management (XP, premium with expiry, admin role) lives on user-detail.html.

let cachedUsers = [];

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadUsers();

  document.getElementById("user-search").addEventListener("input", debounce(loadUsers, 300));
  document.getElementById("user-filter-plan").addEventListener("change", loadUsers);
  document.getElementById("user-filter-role").addEventListener("change", loadUsers);
  document.getElementById("user-sort").addEventListener("change", loadUsers);
  document.getElementById("export-users-btn").addEventListener("click", () => {
    downloadCSV("pydebug-users.csv", cachedUsers.map((u) => ({
      id: u.id,
      display_name: u.display_name || "",
      full_name: u.full_name || "",
      email: u.email || "",
      xp: u.xp ?? 0,
      monthly_xp: u.monthly_xp ?? 0,
      streak: u.streak ?? 0,
      streak_freezes: u.streak_freezes ?? 0,
      last_active_date: u.last_active_date || "",
      plan: u.is_premium ? "premium" : "free",
      premium_expires_at: u.premium_expires_at || "",
      role: u.is_admin ? "admin" : "user",
      joined: u.created_at,
    })));
  });
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

async function loadUsers() {
  // Strip % and , so the search term can't break the .or() filter syntax.
  const search = document.getElementById("user-search").value.trim().replace(/[%.,]/g, "");
  const plan = document.getElementById("user-filter-plan").value;
  const role = document.getElementById("user-filter-role").value;
  const sort = document.getElementById("user-sort").value;

  let query = sb.from("profiles").select("*").limit(500);
  if (search) query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%,display_name.ilike.%${search}%`);
  if (plan === "premium") query = query.eq("is_premium", true);
  if (plan === "free") query = query.eq("is_premium", false);
  if (role === "admin") query = query.eq("is_admin", true);
  if (role === "user") query = query.eq("is_admin", false);
  if (sort === "xp") query = query.order("xp", { ascending: false });
  else if (sort === "oldest") query = query.order("created_at", { ascending: true });
  else query = query.order("created_at", { ascending: false });

  const { data: users, error } = await query;
  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = "";
  cachedUsers = users || [];
  document.getElementById("users-count").textContent = cachedUsers.length ? `(${cachedUsers.length})` : "";

  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-row">Error: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!cachedUsers.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-row">No users found.</td></tr>`;
    return;
  }

  cachedUsers.forEach((u) => {
    const tr = document.createElement("tr");
    const premium = isPremiumUser(u);
    tr.innerHTML = `
      <td>${escapeHtml(u.display_name || u.full_name || "-")}</td>
      <td>${escapeHtml(u.email || "-")}</td>
      <td>${(u.xp ?? 0).toLocaleString("en-IN")}</td>
      <td class="muted">${(u.monthly_xp ?? 0).toLocaleString("en-IN")}</td>
      <td>${u.streak ?? 0} 🔥</td>
      <td>${premium ? '<span class="tag tag--premium">Premium</span>' : '<span class="tag tag--free">Free</span>'}</td>
      <td>${u.is_admin ? '<span class="tag tag--info">Admin</span>' : '<span class="muted">User</span>'}</td>
      <td class="muted" title="${escapeHtml(fmtDateTime(u.created_at))}">${escapeHtml(timeAgo(u.created_at))}</td>
      <td class="row-actions">
        <a href="user-detail.html?id=${u.id}" class="btn btn--secondary btn--sm">View / Manage</a>
        <button class="btn btn--secondary btn--sm" data-toggle-premium="${u.id}" data-current="${premium}">
          ${premium ? "Revoke" : "Grant"}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-toggle-premium]").forEach((btn) => {
    btn.addEventListener("click", () => togglePremium(btn));
  });
}

async function togglePremium(btn) {
  const id = btn.dataset.togglePremium;
  const isCurrentlyPremium = btn.dataset.current === "true";
  btn.disabled = true;

  const updates = isCurrentlyPremium
    ? { is_premium: false, premium_expires_at: null }
    : { is_premium: true, premium_expires_at: null }; // null = manual/lifetime grant

  const { error } = await sb.from("profiles").update(updates).eq("id", id);
  if (error) {
    showToast("Could not update: " + error.message, "error");
    btn.disabled = false;
    return;
  }
  showToast(isCurrentlyPremium ? "Premium revoked" : "Premium granted (lifetime)", "success");
  await loadUsers();
}
