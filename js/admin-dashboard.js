// admin-dashboard.js

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadStats();
  await loadProblems();

  document.getElementById("admin-search").addEventListener("input", debounce(loadProblems, 300));
  document.getElementById("admin-filter-type").addEventListener("change", loadProblems);
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

async function loadStats() {
  const [{ count: totalUsers }, { count: premiumUsers }, { count: totalProblems }, { count: premiumProblems }] =
    await Promise.all([
      sb.from("profiles").select("*", { count: "exact", head: true }),
      sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true),
      sb.from("problems").select("*", { count: "exact", head: true }),
      sb.from("problems").select("*", { count: "exact", head: true }).eq("is_premium", true),
    ]);

  document.getElementById("stat-total-users").textContent = totalUsers ?? 0;
  document.getElementById("stat-premium-users").textContent = premiumUsers ?? 0;
  document.getElementById("stat-total-problems").textContent = totalProblems ?? 0;
  document.getElementById("stat-premium-problems").textContent = premiumProblems ?? 0;

  // Rough revenue estimate from the payments log
  const { data: payments } = await sb.from("payments").select("amount_paise");
  const totalPaise = (payments || []).reduce((sum, p) => sum + (p.amount_paise || 0), 0);
  document.getElementById("stat-revenue").textContent = "₹" + (totalPaise / 100).toLocaleString("en-IN");
}

async function loadProblems() {
  const search = document.getElementById("admin-search").value.trim();
  const type = document.getElementById("admin-filter-type").value;

  let query = sb.from("problems").select("*").order("created_at", { ascending: false });
  if (type !== "all") query = query.eq("type", type);
  if (search) query = query.ilike("title", `%${search}%`);

  const { data: problems, error } = await query;
  const tbody = document.getElementById("problems-tbody");
  tbody.innerHTML = "";

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Error loading problems: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!problems || problems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No problems yet — add your first one.</td></tr>`;
    return;
  }

  problems.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.title)}</td>
      <td><span class="tag tag--${escapeHtml(p.type)}">${p.type === "bug" ? "Bug" : "Question"}</span></td>
      <td><span class="diff diff--${escapeHtml(p.difficulty)}">${escapeHtml(p.difficulty)}</span></td>
      <td>${escapeHtml(p.topic || "-")}</td>
      <td>${p.is_premium ? '<span class="tag tag--premium">Premium</span>' : '<span class="tag tag--free">Free</span>'}</td>
      <td class="row-actions">
        <a href="problem-form.html?id=${p.id}" class="btn btn--secondary btn--sm">Edit</a>
        <button class="btn btn--danger btn--sm" data-delete-id="${p.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteProblem(btn.dataset.deleteId, btn));
  });
}

async function deleteProblem(id, btn) {
  if (!confirm("Delete this problem? This can't be undone.")) return;
  btn.disabled = true;
  btn.textContent = "Deleting...";

  const { error } = await sb.from("problems").delete().eq("id", id);
  if (error) {
    showToast("Could not delete: " + error.message, "error");
    btn.disabled = false;
    btn.textContent = "Delete";
    return;
  }
  showToast("Problem deleted", "success");
  await loadStats();
  await loadProblems();
}
