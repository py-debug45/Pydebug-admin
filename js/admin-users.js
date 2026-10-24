// admin-users.js — user list with campus analytics, 1-tap campus tag moderation, plan/status/role filters, sorting, CSV export.
// Full row-level management (XP, premium with expiry, account moderation, admin role) lives on user-detail.html.

let cachedUsers = [];
let usersPage = 0;
let usersTotal = 0;

onAdminReady(async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await Promise.all([loadUsers(0), loadCampusRollup()]);

  document.getElementById("user-search").addEventListener("input", debounce(() => loadUsers(0), 300));
  const campusFilter = document.getElementById("user-filter-campus");
  if (campusFilter) campusFilter.addEventListener("change", () => loadUsers(0));
  document.getElementById("user-filter-plan").addEventListener("change", () => loadUsers(0));
  document.getElementById("user-filter-status").addEventListener("change", () => loadUsers(0));
  document.getElementById("user-filter-role").addEventListener("change", () => loadUsers(0));
  document.getElementById("user-sort").addEventListener("change", () => loadUsers(0));
  document.getElementById("export-users-btn").addEventListener("click", exportUsers);

  const refreshBtn = document.getElementById("refresh-campuses-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => Promise.all([loadUsers(usersPage), loadCampusRollup()]));
  }

  const campusRoot = document.getElementById("users-campus-root");
  if (campusRoot) {
    campusRoot.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-filter-campus]");
      if (!btn) return;
      const searchInput = document.getElementById("user-search");
      if (searchInput) searchInput.value = btn.dataset.filterCampus || "";
      if (campusFilter) campusFilter.value = "tagged";
      loadUsers(0);
    });
  }
});

async function loadCampusRollup() {
  const root = document.getElementById("users-campus-root");
  if (!root) return;

  const tagged = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, display_name, xp, streak, is_premium")
      .ilike("display_name", "% · %")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      root.innerHTML = `<div class="empty-row" style="padding:12px 0">Could not load campus stats (${escapeHtml(error.message)}).</div>`;
      return;
    }
    const chunk = data || [];
    tagged.push(...chunk);
    if (chunk.length < pageSize) break;
  }

  const campuses = aggregateCampuses(tagged);
  root.innerHTML = renderCampusAnalyticsHtml(campuses, { limit: 25, allowFilter: true });
}

function currentUserFilters() {
  const campusEl = document.getElementById("user-filter-campus");
  return {
    search: sanitizeIlike(document.getElementById("user-search").value),
    campus: campusEl ? campusEl.value : "all",
    plan: document.getElementById("user-filter-plan").value,
    status: document.getElementById("user-filter-status").value,
    role: document.getElementById("user-filter-role").value,
    sort: document.getElementById("user-sort").value,
  };
}

function applyUserFilters(query, filters, includeOrder) {
  if (filters.search) {
    query = query.or(`email.ilike.%${filters.search}%,full_name.ilike.%${filters.search}%,display_name.ilike.%${filters.search}%`);
  }
  if (filters.campus === "tagged") query = query.ilike("display_name", "% · %");
  if (filters.campus === "untagged") query = query.or("display_name.is.null,display_name.not.ilike.% · %");
  if (filters.plan === "premium") query = query.eq("is_premium", true);
  if (filters.plan === "free") query = query.eq("is_premium", false);
  if (filters.status && filters.status !== "all") query = query.eq("status", filters.status);
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

function renderUserNameCell(u, encodedId) {
  const parsed = parseDisplayNameCampus(u.display_name);
  const baseLabel = parsed.baseName || u.full_name || "-";
  if (parsed.hasCampus) {
    return `<div class="user-name-cell">
      <div class="user-name-main">
        <a href="user-detail.html?id=${encodedId}" class="user-name-link">${escapeHtml(baseLabel)}</a>
        <span class="campus-pill" data-keep-emoji="1" title="Campus leaderboard tag">🎓 ${escapeHtml(parsed.campusTag)}</span>
      </div>
      <div class="campus-mod-actions">
        <button type="button" class="campus-mod-btn" data-edit-campus="${encodedId}" title="Edit campus tag">✎ Edit tag</button>
        <button type="button" class="campus-mod-btn campus-mod-btn--clear" data-clear-campus="${encodedId}" title="1-tap clear campus tag (keeps base name)">✕ Clear tag</button>
      </div>
    </div>`;
  }
  return `<div class="user-name-cell">
    <div class="user-name-main">
      <a href="user-detail.html?id=${encodedId}" class="user-name-link">${escapeHtml(baseLabel)}</a>
      <button type="button" class="campus-mod-btn campus-mod-btn--subtle" data-edit-campus="${encodedId}" title="Add college / campus tag">+ 🎓 Tag</button>
    </div>
  </div>`;
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

  tbody.innerHTML = cachedUsers.map((u) => {
    const premium = isPremiumUser(u);
    const id = encodeURIComponent(u.id);
    const roleBit = u.is_admin ? ' <span class="tag tag--info">Admin</span>' : "";
    return `<tr>
      <td>${renderUserNameCell(u, id)}</td>
      <td>${escapeHtml(u.email || "-")}</td>
      <td>${(u.xp ?? 0).toLocaleString("en-IN")}</td>
      <td class="muted">${(u.monthly_xp ?? 0).toLocaleString("en-IN")}</td>
      <td>${u.streak ?? 0} 🔥</td>
      <td>${planTagHtml(u)}</td>
      <td>${accountStatusBadge(u)}${roleBit}</td>
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
      const premBtn = event.target.closest("button[data-toggle-premium]");
      if (premBtn) { togglePremium(premBtn); return; }
      const clearBtn = event.target.closest("button[data-clear-campus]");
      if (clearBtn) { clearUserCampusTag(clearBtn); return; }
      const editBtn = event.target.closest("button[data-edit-campus]");
      if (editBtn) editUserCampusTag(editBtn);
    });
  }

  renderPagination(document.getElementById("users-pagination"), usersPage, usersTotal, (p) => loadUsers(p));
}

async function clearUserCampusTag(btn) {
  const id = decodeURIComponent(btn.dataset.clearCampus);
  const user = cachedUsers.find((u) => u.id === id);
  if (!user) return;
  const cleaned = clearDisplayNameCampus(user.display_name, user.full_name || "");
  btn.disabled = true;

  const { error } = await sb.rpc("admin_panel_update_profile", {
    target_user: id,
    patch: { display_name: cleaned || null },
  });
  if (error) {
    showToast("Could not clear campus tag: " + error.message, "error");
    btn.disabled = false;
    return;
  }
  showToast(`Cleared campus tag → ${cleaned || "default name"}`, "success");
  await Promise.all([loadUsers(usersPage), loadCampusRollup()]);
}

async function editUserCampusTag(btn) {
  const id = decodeURIComponent(btn.dataset.editCampus);
  const user = cachedUsers.find((u) => u.id === id);
  if (!user) return;
  const parsed = parseDisplayNameCampus(user.display_name);
  const baseName = parsed.baseName || user.full_name || (user.email ? user.email.split("@")[0] : "Learner");
  const nextCampus = window.prompt(
    `College / Campus tag for ${baseName} (leave blank to clear):`,
    parsed.campusTag || ""
  );
  if (nextCampus === null) return;

  const composed = composeDisplayNameWithCampus(baseName, nextCampus);
  btn.disabled = true;
  const { error } = await sb.rpc("admin_panel_update_profile", {
    target_user: id,
    patch: { display_name: composed || null },
  });
  if (error) {
    showToast("Could not update campus tag: " + error.message, "error");
    btn.disabled = false;
    return;
  }
  showToast(nextCampus.trim() ? `Updated tag → ${composed}` : `Cleared campus tag for ${baseName}`, "success");
  await Promise.all([loadUsers(usersPage), loadCampusRollup()]);
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
  downloadCSV("pydebug-users.csv", (data || []).map((u) => {
    const parsed = parseDisplayNameCampus(u.display_name);
    return {
      id: u.id,
      display_name: u.display_name || "",
      base_name: parsed.baseName || "",
      campus_tag: parsed.campusTag || "",
      full_name: u.full_name || "",
      email: u.email || "",
      xp: u.xp ?? 0,
      monthly_xp: u.monthly_xp ?? 0,
      streak: u.streak ?? 0,
      streak_freezes: u.streak_freezes ?? 0,
      last_active_date: u.last_active_date || "",
      plan: isPremiumUser(u) ? "premium" : (u.is_premium ? "premium_expired" : "free"),
      premium_expires_at: u.premium_expires_at || "",
      status: u.status || "active",
      status_reason: u.status_reason || "",
      role: u.is_admin ? "admin" : "user",
      joined: u.created_at,
    };
  }));
}

async function togglePremium(btn) {
  const id = decodeURIComponent(btn.dataset.togglePremium);
  const isCurrentlyPremium = btn.dataset.current === "true";
  btn.disabled = true;

  const updates = isCurrentlyPremium
    ? { is_premium: false, premium_expires_at: null }
    : { is_premium: true, premium_expires_at: null };

  const { error } = await sb.rpc("admin_panel_update_profile", { target_user: id, patch: updates });
  if (error) {
    showToast("Could not update: " + error.message, "error");
    btn.disabled = false;
    return;
  }
  showToast(isCurrentlyPremium ? "Premium revoked" : "Premium granted (lifetime)", "success");
  await loadUsers(usersPage);
}
