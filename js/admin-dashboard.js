// admin-dashboard.js

let problemsPage = 0;
let problemsTotal = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadStats();
  await loadProblems(0);

  document.getElementById("admin-search").addEventListener("input", debounce(() => loadProblems(0), 300));
  document.getElementById("admin-filter-type").addEventListener("change", () => loadProblems(0));
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// ---------- Stats -----------------------------------------------------------

// Runs a count(*) query and returns the count, or null if it failed.
// An optional fallback query can be supplied for schemas that lack a newer
// column (e.g. no premium_expires_at).
async function countRows(queryBuilder, fallbackBuilder = null) {
  let { count, error } = await queryBuilder;
  if (error && fallbackBuilder) ({ count, error } = await fallbackBuilder);
  if (error) return null;
  return count ?? 0;
}

async function loadStats() {
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  // Active premium = is_premium true AND (no expiry set OR not yet expired).
  // Expired premium rows are NOT counted. Falls back to the plain is_premium
  // count if this project's profiles table has no premium_expires_at column.
  async function countActivePremium() {
    const [noExpiry, notExpired] = await Promise.all([
      countRows(sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true).is("premium_expires_at", null)),
      countRows(sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true).gte("premium_expires_at", nowIso)),
    ]);
    if (noExpiry === null || notExpired === null) {
      return countRows(sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true));
    }
    return noExpiry + notExpired;
  }

  const [totalUsers, premiumUsers, totalProblems, premiumProblems] = await Promise.all([
    countRows(sb.from("profiles").select("*", { count: "exact", head: true })),
    countActivePremium(),
    countRows(sb.from("problems").select("*", { count: "exact", head: true })),
    countRows(sb.from("problems").select("*", { count: "exact", head: true }).eq("is_premium", true)),
  ]);

  setStat("stat-total-users", totalUsers);
  setStat("stat-premium-users", premiumUsers);
  setStat("stat-total-problems", totalProblems);
  setStat("stat-premium-problems", premiumProblems);

  if ([totalUsers, premiumUsers, totalProblems, premiumProblems].some((v) => v === null)) {
    showToast("Some stats couldn't be loaded — check the Supabase schema/RLS setup (README step 1).", "error");
  }

  await loadRevenue();
}

function setStat(id, value) {
  document.getElementById(id).textContent = value === null || value === undefined ? "—" : value;
}

// Revenue estimate from the payments log. Only *successful* payments count;
// if the schema has no status column we fall back to summing every row.
async function loadRevenue() {
  const SUCCESS_STATUSES = new Set(["paid", "succeeded", "success", "successful", "captured", "completed", "complete"]);

  let { data: payments, error } = await sb.from("payments").select("amount_paise, status");
  if (error) {
    // Older schema without a status column — retry with amount_paise only.
    ({ data: payments, error } = await sb.from("payments").select("amount_paise"));
  }

  const el = document.getElementById("stat-revenue");
  if (error) {
    el.textContent = "₹—";
    showToast("Could not load revenue: " + error.message, "error");
    return;
  }

  const totalPaise = (payments || []).reduce((sum, p) => {
    const status = p.status;
    if (status !== undefined && status !== null && !SUCCESS_STATUSES.has(String(status).toLowerCase())) {
      return sum; // failed/refunded/pending — don't count as revenue
    }
    return sum + (Number(p.amount_paise) || 0);
  }, 0);

  el.textContent = "₹" + (Math.round(totalPaise) / 100).toLocaleString("en-IN");
}

// ---------- Problems table --------------------------------------------------

function buildProblemsQuery(search, type, from, to, includeOrder) {
  let query = sb.from("problems").select("*", { count: "exact" });
  if (includeOrder) query = query.order("created_at", { ascending: false });
  if (type !== "all") query = query.eq("type", type);
  if (search) query = query.ilike("title", `%${search}%`);
  if (from !== undefined && to !== undefined) query = query.range(from, to);
  return query;
}

async function loadProblems(page = 0) {
  const search = document.getElementById("admin-search").value.trim();
  const type = document.getElementById("admin-filter-type").value;
  const from = page * ADMIN_PAGE_SIZE;
  const to = from + ADMIN_PAGE_SIZE - 1;

  let { data: problems, error, count } = await buildProblemsQuery(search, type, from, to, true);
  // 42703 = undefined_column — retry without the created_at ordering if the
  // problems table has no created_at column.
  if (error && error.code === "42703") {
    ({ data: problems, error, count } = await buildProblemsQuery(search, type, from, to, false));
  }

  const tbody = document.getElementById("problems-tbody");
  tbody.innerHTML = "";

  if (error) {
    appendEmptyRow(tbody, "Error loading problems: " + error.message);
    return;
  }

  if (!problems || problems.length === 0) {
    // We're past the last page (e.g. deleted the only row of page 2) — go back.
    if ((count ?? 0) > from && page > 0) return loadProblems(page - 1);
    problemsTotal = count ?? 0;
    problemsPage = page;
    appendEmptyRow(tbody, "No problems yet — add your first one.");
    renderPagination(document.getElementById("problems-pagination"), problemsPage, problemsTotal, (p) => loadProblems(p));
    return;
  }

  problemsTotal = count ?? 0;
  problemsPage = page;

  problems.forEach((p) => {
    // Whitelist type/difficulty so DB values can never inject arbitrary class
    // names or unexpected markup into the row.
    const safeType = p.type === "bug" ? "bug" : "question";
    const safeDiff = ["easy", "medium", "hard"].includes(p.difficulty) ? p.difficulty : "medium";

    const tr = document.createElement("tr");

    const tdTitle = document.createElement("td");
    tdTitle.textContent = p.title || "(untitled)";

    const tdType = document.createElement("td");
    const typeTag = document.createElement("span");
    typeTag.className = `tag tag--${safeType}`;
    typeTag.textContent = safeType === "bug" ? "Bug" : "Question";
    tdType.appendChild(typeTag);

    const tdDiff = document.createElement("td");
    const diffSpan = document.createElement("span");
    diffSpan.className = `diff diff--${safeDiff}`;
    diffSpan.textContent = safeDiff;
    tdDiff.appendChild(diffSpan);

    const tdTopic = document.createElement("td");
    tdTopic.textContent = p.topic || "-";

    const tdAccess = document.createElement("td");
    const accessTag = document.createElement("span");
    accessTag.className = p.is_premium ? "tag tag--premium" : "tag tag--free";
    accessTag.textContent = p.is_premium ? "Premium" : "Free";
    tdAccess.appendChild(accessTag);

    const tdActions = document.createElement("td");
    tdActions.className = "row-actions";
    const editLink = document.createElement("a");
    editLink.className = "btn btn--secondary btn--sm";
    editLink.href = "problem-form.html?id=" + encodeURIComponent(p.id);
    editLink.textContent = "Edit";
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn--danger btn--sm";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteProblem(p.id, deleteBtn));
    tdActions.append(editLink, deleteBtn);

    tr.append(tdTitle, tdType, tdDiff, tdTopic, tdAccess, tdActions);
    tbody.appendChild(tr);
  });

  renderPagination(document.getElementById("problems-pagination"), problemsPage, problemsTotal, (p) => loadProblems(p));
}

// All user/DB content goes through textContent (never innerHTML) so titles,
// topics, etc. can't execute markup in the admin's browser.
function appendEmptyRow(tbody, message) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 6;
  td.className = "empty-row";
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

async function deleteProblem(id, btn) {
  if (!confirm("Delete this problem? This can't be undone.")) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Deleting...";

  try {
    const { error } = await sb.from("problems").delete().eq("id", id);
    if (error) throw error;
    showToast("Problem deleted", "success");
    await loadStats();
    await loadProblems(problemsPage);
  } catch (err) {
    showToast("Could not delete: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
