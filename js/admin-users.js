// admin-users.js

let usersPage = 0;
let usersTotal = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadUsers(0);
  document.getElementById("user-search").addEventListener("input", debounce(() => loadUsers(0), 300));
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function buildUsersQuery(search, from, to, includeOrder) {
  let query = sb.from("profiles").select("*", { count: "exact" });
  if (includeOrder) query = query.order("created_at", { ascending: false });
  if (search) query = query.ilike("email", `%${search}%`);
  if (from !== undefined && to !== undefined) query = query.range(from, to);
  return query;
}

async function loadUsers(page = 0) {
  const search = document.getElementById("user-search").value.trim();
  const from = page * ADMIN_PAGE_SIZE;
  const to = from + ADMIN_PAGE_SIZE - 1;

  let { data: users, error, count } = await buildUsersQuery(search, from, to, true);
  // 42703 = undefined_column — retry without the created_at ordering if the
  // profiles table has no created_at column.
  if (error && error.code === "42703") {
    ({ data: users, error, count } = await buildUsersQuery(search, from, to, false));
  }

  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = "";

  if (error) {
    appendEmptyRow(tbody, "Error: " + error.message);
    return;
  }

  if (!users || users.length === 0) {
    // We're past the last page (e.g. removed the only row of page 2) — go back.
    if ((count ?? 0) > from && page > 0) return loadUsers(page - 1);
    usersTotal = count ?? 0;
    usersPage = page;
    appendEmptyRow(tbody, "No users yet.");
    renderPagination(document.getElementById("users-pagination"), usersPage, usersTotal, (p) => loadUsers(p));
    return;
  }

  usersTotal = count ?? 0;
  usersPage = page;

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

    const tdActions = document.createElement("td");
    tdActions.className = "row-actions";
    const toggleBtn = document.createElement("button");
    toggleBtn.className = activePremium ? "btn btn--danger btn--sm" : "btn btn--secondary btn--sm";
    toggleBtn.textContent = activePremium ? "Revoke Premium" : "Grant Premium";
    toggleBtn.addEventListener("click", () => togglePremium(u.id, activePremium, toggleBtn));
    tdActions.appendChild(toggleBtn);

    tr.append(tdName, tdEmail, tdXp, tdPlan, tdRole, tdActions);
    tbody.appendChild(tr);
  });

  renderPagination(document.getElementById("users-pagination"), usersPage, usersTotal, (p) => loadUsers(p));
}

// All user/DB content goes through textContent (never innerHTML) so names and
// emails can't execute markup in the admin's browser.
function appendEmptyRow(tbody, message) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 6;
  td.className = "empty-row";
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

async function togglePremium(id, isCurrentlyPremium, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;

  const updates = isCurrentlyPremium
    ? { is_premium: false, premium_expires_at: null }
    : { is_premium: true, premium_expires_at: null }; // null = manual/lifetime grant

  try {
    const { error } = await sb.from("profiles").update(updates).eq("id", id);
    if (error) throw error;
    showToast(isCurrentlyPremium ? "Premium revoked" : "Premium granted", "success");
    await loadUsers(usersPage);
  } catch (err) {
    showToast("Could not update: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
