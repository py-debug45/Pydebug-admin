// admin-users.js

let usersPage = 0;
let usersTotal = 0;
// See admin-dashboard.js — guards against a slow response for an old search
// term painting over the results of a newer one.
let usersRequestId = 0;
let currentAdminId = null;

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  currentAdminId = admin.id;

  const searchEl = document.getElementById("user-search");
  if (searchEl) searchEl.addEventListener("input", debounce(() => loadUsers(0), 300));

  await loadUsers(0);
});

function buildUsersQuery(search, from, to, includeOrder) {
  let query = sb.from("profiles").select("*", { count: "exact" });
  if (includeOrder) query = query.order("created_at", { ascending: false });
  if (search) query = query.ilike("email", likeContains(search));
  if (from !== undefined && to !== undefined) query = query.range(from, to);
  return query;
}

async function loadUsers(page = 0) {
  const tbody = document.getElementById("users-tbody");
  if (!tbody) return;

  const searchEl = document.getElementById("user-search");
  const search = searchEl ? searchEl.value.trim() : "";
  const safePage = Math.max(0, Number(page) || 0);
  const from = safePage * ADMIN_PAGE_SIZE;
  const to = from + ADMIN_PAGE_SIZE - 1;

  const requestId = ++usersRequestId;
  tbody.innerHTML = "";
  appendEmptyRow(tbody, "Loading…");

  let users = null;
  let error = null;
  let count = null;
  try {
    ({ data: users, error, count } = await buildUsersQuery(search, from, to, true));
  } catch (err) {
    error = err;
  }

  // 42703 = undefined_column — retry without the created_at ordering if the
  // profiles table has no created_at column.
  if (error && error.code === "42703") {
    try {
      ({ data: users, error, count } = await buildUsersQuery(search, from, to, false));
    } catch (err) {
      error = err;
    }
  }

  if (requestId !== usersRequestId) return; // superseded by a newer request

  tbody.innerHTML = "";

  if (error) {
    appendEmptyRow(tbody, "Error loading users: " + errorText(error));
    renderPagination(document.getElementById("users-pagination"), 0, 0, () => {});
    return;
  }

  if (!users || users.length === 0) {
    // We're past the last page (e.g. removed the only row of page 2) — go back.
    if (isPastLastPage(count, from, safePage)) return loadUsers(safePage - 1);
    usersTotal = count ?? 0;
    usersPage = safePage;
    appendEmptyRow(tbody, search ? "No users match that email." : "No users yet.");
    renderPagination(document.getElementById("users-pagination"), usersPage, usersTotal, loadUsers);
    return;
  }

  usersTotal = count ?? users.length;
  usersPage = safePage;

  const fragment = document.createDocumentFragment();

  users.forEach((u) => {
    // isPremiumUser() is expiry-aware: is_premium with a past expiry date is
    // NOT active premium (it previously showed as "Premium" forever).
    const activePremium = isPremiumUser(u);

    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = u.full_name || "-";

    const tdEmail = document.createElement("td");
    tdEmail.textContent = u.email || "-";

    const tdXp = document.createElement("td");
    tdXp.textContent = String(u.xp ?? 0);

    const tdPlan = document.createElement("td");
    const planTag = document.createElement("span");
    if (activePremium) {
      planTag.className = "tag tag--premium";
      planTag.textContent = "Premium";
    } else if (u.is_premium) {
      planTag.className = "tag tag--expired";
      planTag.textContent = "Premium (expired)";
    } else {
      planTag.className = "tag tag--free";
      planTag.textContent = "Free";
    }
    tdPlan.appendChild(planTag);

    const tdRole = document.createElement("td");
    tdRole.textContent = u.is_admin ? "Admin" : "User";
    if (u.id && u.id === currentAdminId) {
      const you = document.createElement("span");
      you.className = "pagination-info";
      you.textContent = " (you)";
      tdRole.appendChild(you);
    }

    const tdActions = document.createElement("td");
    tdActions.className = "row-actions";
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = activePremium ? "btn btn--danger btn--sm" : "btn btn--secondary btn--sm";
    toggleBtn.textContent = activePremium ? "Revoke Premium" : "Grant Premium";
    toggleBtn.addEventListener("click", () => togglePremium(u, activePremium, toggleBtn));
    tdActions.appendChild(toggleBtn);

    tr.append(tdName, tdEmail, tdXp, tdPlan, tdRole, tdActions);
    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);

  renderPagination(document.getElementById("users-pagination"), usersPage, usersTotal, loadUsers);
}

async function togglePremium(user, isCurrentlyPremium, btn) {
  const who = user.email || user.full_name || "this user";
  const action = isCurrentlyPremium ? "Revoke premium from" : "Grant premium to";
  if (!confirm(`${action} ${who}?`)) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = isCurrentlyPremium ? "Revoking..." : "Granting...";

  const updates = isCurrentlyPremium
    ? { is_premium: false, premium_expires_at: null }
    : { is_premium: true, premium_expires_at: null }; // null = manual/lifetime grant

  try {
    // .select() so an RLS policy that silently matches zero rows is reported
    // as a failure instead of a false "Premium granted".
    const { data, error } = await sb
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error("No row was updated — check the admin RLS policies (README step 1).");
    }
    showToast(isCurrentlyPremium ? "Premium revoked" : "Premium granted", "success");
    await loadUsers(usersPage);
  } catch (err) {
    showToast("Could not update: " + errorText(err), "error");
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
