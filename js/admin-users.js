// admin-users.js — user list with plan/role filters, sorting, CSV export.
// Row-level management (XP, premium with expiry, admin role) lives on user-detail.html.

let cachedUsers = [];
let usersPage = 0;
let usersTotal = 0;

onAdminReady(async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadUsers(0);

  document.getElementById("user-search").addEventListener("input", debounce(() => loadUsers(0), 300));
  document.getElementById("user-filter-plan").addEventListener("change", () => loadUsers(0));
  document.getElementById("user-filter-role").addEventListener("change", () => loadUsers(0));
  document.getElementById("user-sort").addEventListener("change", () => loadUsers(0));
  document.getElementById("export-users-btn").addEventListener("click", exportUsers);
});

function currentUserFilters() {
  return {
    search: sanitizeIlike(document.getElementById("user-search").value),
    plan: document.getElementById("user-filter-plan").value,
    role: document.getElementById("user-filter-role").value,
    sort: document.getElementById("user-sort").value,
  };
}

function applyUserFilters(query, filters, includeOrder) {
  if (filters.search) {
    query = query.or(`email.ilike.%${filters.search}%,full_name.ilike.%${filters.search}%,display_name.ilike.%${filters.search}%`);
  }
  if (filters.plan === "premium") query = query.eq("is_premium", true);
  if (filters.plan === "free") query = query.eq("is_premium", false);
  if (filters.role === "admin") query = query.eq("is_admin", true);
  if (filters.role === "user") query = query.eq("is_admin", false);
  if (includeOrder) {
    if (filters.sort === "xp") query = query.order("xp", { ascending: false });
    else if (filters.sort === "oldest") query = query.order("created_at", { ascending: true });
    else query = query.order("created_at", { ascending: false });
  }
  return query;
}

function planTagHtml(u) {
  const premium = isPremiumUser(u);
  if (premium) return '<span class="tag tag--premium">Premium</span>';
  if (u.is_premium) return '<span class="tag tag--expired">Premium (expired)</span>';
  return '<span class="tag tag--free">Free</span>';
}

async function loadUsers(page = 0) {
  const filters = currentUserFilters();
  const from = page * ADMIN_PAGE_SIZE;
  const to = from + ADMIN_PAGE_SIZE - 1;

  async function run(includeOrder) {
    let query = sb.from("profiles").select("*", { count: "exact" });
    query = applyUserFilters(query, filters, includeOrder);
    return query.range(from, to);
  }

  let { data: users, error, count } = await run(true);
  // 42703 = undefined_column — retry without created_at / xp ordering.
  if (error && error.code === "42703") {
    ({ data: users, error, count } = await run(false));
  }

  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = "";
  cachedUsers = users || [];
  usersTotal = count ?? cachedUsers.length;
  usersPage = page;
  document.getElementById("users-count").textContent = usersTotal ? `(${usersTotal})` : "";

  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-row">Error: ${escapeHtml(error.message)}</td></tr>`;
    renderPagination(document.getElementById("users-pagination"), 0, 0, () => {});
    return;
  }
  if (!cachedUsers.length) {
    if ((count ?? 0) > from && page > 0) return loadUsers(page - 1);
    tbody.innerHTML = `<tr><td colspan="9" class="empty-row">No users found.</td></tr>`;
    renderPagination(document.getElementById("users-pagination"), usersPage, usersTotal, (p) => loadUsers(p));
    return;
  }

  // Single DOM write + one delegated listener (was: a createElement and a
  // click listener per row, 50 of each on every filter keystroke).
  tbody.innerHTML = cachedUsers.map((u) => {
    const premium = isPremiumUser(u);
    const id = encodeURIComponent(u.id);
    return `<tr>
      <td>${escapeHtml(u.display_name || u.full_name || "-")}</td>
      <td>${escapeHtml(u.email || "-")}</td>
      <td>${(u.xp ?? 0).toLocaleString("en-IN")}</td>
      <td class="muted">${(u.monthly_xp ?? 0).toLocaleString("en-IN")}</td>
      <td>${u.streak ?? 0} 🔥</td>
      <td>${planTagHtml(u)}</td>
      <td>${u.is_admin ? '<span class="tag tag--info">Admin</span>' : '<span class="muted">User</span>'}</td>
      <td class="muted" title="${escapeHtml(fmtDateTime(u.created_at))}">${escapeHtml(timeAgo(u.created_at))}</td>
      <td class="row-actions">
        <a href="user-detail.html?id=${id}" class="btn btn--secondary btn--sm">View / Manage</a>
        <button class="btn btn--secondary btn--sm" data-toggle-premium="${id}" data-current="${premium}">
          ${premium ? "Revoke" : "Grant"}
        </button>
      </td>
    </tr>`;
  }).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-toggle-premium]");
      if (button) togglePremium(button);
    });
  }

  renderPagination(document.getElementById("users-pagination"), usersPage, usersTotal, (p) => loadUsers(p));
}

async function exportUsers() {
  const filters = currentUserFilters();
  let query = sb.from("profiles").select("*").limit(5000);
  query = applyUserFilters(query, filters, true);
  const { data, error } = await query;
  if (error) {
    showToast("Could not export: " + error.message, "error");
    return;
  }
  downloadCSV("pydebug-users.csv", (data || []).map((u) => ({
    id: u.id,
    display_name: u.display_name || "",
    full_name: u.full_name || "",
    email: u.email || "",
    xp: u.xp ?? 0,
    monthly_xp: u.monthly_xp ?? 0,
    streak: u.streak ?? 0,
    streak_freezes: u.streak_freezes ?? 0,
    last_active_date: u.last_active_date || "",
    plan: isPremiumUser(u) ? "premium" : (u.is_premium ? "premium_expired" : "free"),
    premium_expires_at: u.premium_expires_at || "",
    role: u.is_admin ? "admin" : "user",
    joined: u.created_at,
  })));
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
  await writeAudit(isCurrentlyPremium ? "premium_revoked" : "premium_granted", "profile", id, { lifetime: true });
  showToast(isCurrentlyPremium ? "Premium revoked" : "Premium granted (lifetime)", "success");
  await loadUsers(usersPage);
}
