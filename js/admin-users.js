// admin-users.js

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadUsers();
  document.getElementById("user-search").addEventListener("input", debounce(loadUsers, 300));
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

async function loadUsers() {
  const search = document.getElementById("user-search").value.trim();
  let query = sb.from("profiles").select("*").order("created_at", { ascending: false });
  if (search) query = query.ilike("email", `%${search}%`);

  const { data: users, error } = await query;
  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = "";

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Error: ${error.message}</td></tr>`;
    return;
  }
  if (!users || users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No users yet.</td></tr>`;
    return;
  }

  users.forEach((u) => {
    const tr = document.createElement("tr");
    const premium = u.is_premium;
    tr.innerHTML = `
      <td>${u.full_name || "-"}</td>
      <td>${u.email || "-"}</td>
      <td>${u.xp ?? 0}</td>
      <td>${premium ? '<span class="tag tag--premium">Premium</span>' : '<span class="tag tag--free">Free</span>'}</td>
      <td>${u.is_admin ? "Admin" : "User"}</td>
      <td class="row-actions">
        <button class="btn btn--secondary btn--sm" data-toggle-premium="${u.id}" data-current="${premium}">
          ${premium ? "Revoke Premium" : "Grant Premium"}
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
  showToast(isCurrentlyPremium ? "Premium revoked" : "Premium granted", "success");
  await loadUsers();
}
