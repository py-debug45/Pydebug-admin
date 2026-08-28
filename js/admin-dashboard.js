// admin-dashboard.js

let problemsPage = 0;
let problemsTotal = 0;
// Monotonic token: only the newest in-flight request is allowed to paint.
// Without this, typing fast in the search box could let an older (slower)
// response land last and show results for a query you already changed.
let problemsRequestId = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  const searchEl = document.getElementById("admin-search");
  const filterEl = document.getElementById("admin-filter-type");

  if (searchEl) searchEl.addEventListener("input", debounce(() => loadProblems(0), 300));
  if (filterEl) filterEl.addEventListener("change", () => loadProblems(0));

  await loadStats();
  await loadProblems(0);
});

// ---------- Stats -----------------------------------------------------------

// Runs a count(*) query and returns the count, or null if it failed.
// An optional fallback query can be supplied for schemas that lack a newer
// column (e.g. no premium_expires_at).
async function countRows(queryBuilder, fallbackBuilder = null) {
  let count = null;
  let error = null;
  try {
    ({ count, error } = await queryBuilder);
  } catch (err) {
    error = err;
  }
  if (error && fallbackBuilder) {
    try {
      ({ count, error } = await fallbackBuilder);
    } catch (err) {
      error = err;
    }
  }
  if (error) return null;
  return count ?? 0;
}

async function loadStats() {
  const nowIso = new Date().toISOString();

  // Active premium = is_premium true AND (no expiry set OR not yet expired).
  // Expired premium rows are NOT counted. Falls back to the plain is_premium
  // count if this project's profiles table has no premium_expires_at column.
  async function countActivePremium() {
    const [noExpiry, notExpired] = await Promise.all([
      countRows(
        sb.from("profiles").select("*", { count: "exact", head: true })
          .eq("is_premium", true).is("premium_expires_at", null)
      ),
      countRows(
        sb.from("profiles").select("*", { count: "exact", head: true })
          .eq("is_premium", true).gte("premium_expires_at", nowIso)
      ),
    ]);
    if (noExpiry === null || notExpired === null) {
      return countRows(
        sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true)
      );
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
  const el = document.getElementById(id);
  if (!el) return; // page doesn't show this stat
  el.textContent =
    value === null || value === undefined ? "—" : Number(value).toLocaleString("en-IN");
}

// Revenue estimate from the payments log. Only *successful* payments count;
// if the schema has no status column we fall back to summing every row.
async function loadRevenue() {
  const SUCCESS_STATUSES = new Set([
    "paid", "succeeded", "success", "successful", "captured", "completed", "complete",
  ]);

  const el = document.getElementById("stat-revenue");
  if (!el) return;

  let payments = null;
  let error = null;
  try {
    ({ data: payments, error } = await sb.from("payments").select("amount_paise, status"));
  } catch (err) {
    error = err;
  }

  if (error) {
    // Older schema without a status column — retry with amount_paise only.
    try {
      ({ data: payments, error } = await sb.from("payments").select("amount_paise"));
    } catch (err) {
      error = err;
    }
  }

  if (error) {
    el.textContent = "₹—";
    showToast("Could not load revenue: " + errorText(error), "error");
    return;
  }

  const totalPaise = (payments || []).reduce((sum, p) => {
    const status = p.status;
    if (status !== undefined && status !== null && !SUCCESS_STATUSES.has(String(status).toLowerCase())) {
      return sum; // failed/refunded/pending — don't count as revenue
    }
    const paise = Number(p.amount_paise);
    // Ignore null / non-numeric amounts instead of turning the total into NaN.
    return Number.isFinite(paise) ? sum + paise : sum;
  }, 0);

  el.textContent = "₹" + (Math.round(totalPaise) / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// ---------- Problems table --------------------------------------------------

function buildProblemsQuery(search, type, from, to, includeOrder) {
  let query = sb.from("problems").select("*", { count: "exact" });
  if (includeOrder) query = query.order("created_at", { ascending: false });
  if (type !== "all") query = query.eq("type", type);
  if (search) query = query.ilike("title", likeContains(search));
  if (from !== undefined && to !== undefined) query = query.range(from, to);
  return query;
}

async function loadProblems(page = 0) {
  const searchEl = document.getElementById("admin-search");
  const filterEl = document.getElementById("admin-filter-type");
  const tbody = document.getElementById("problems-tbody");
  if (!tbody) return;

  const search = searchEl ? searchEl.value.trim() : "";
  const type = filterEl ? filterEl.value : "all";
  const safePage = Math.max(0, Number(page) || 0);
  const from = safePage * ADMIN_PAGE_SIZE;
  const to = from + ADMIN_PAGE_SIZE - 1;

  const requestId = ++problemsRequestId;
  tbody.innerHTML = "";
  appendEmptyRow(tbody, "Loading…");

  let problems = null;
  let error = null;
  let count = null;
  try {
    ({ data: problems, error, count } = await buildProblemsQuery(search, type, from, to, true));
  } catch (err) {
    error = err;
  }

  // 42703 = undefined_column — retry without the created_at ordering if the
  // problems table has no created_at column.
  if (error && error.code === "42703") {
    try {
      ({ data: problems, error, count } = await buildProblemsQuery(search, type, from, to, false));
    } catch (err) {
      error = err;
    }
  }

  // A newer request started while we were awaiting — discard this result.
  if (requestId !== problemsRequestId) return;

  tbody.innerHTML = "";

  if (error) {
    appendEmptyRow(tbody, "Error loading problems: " + errorText(error));
    renderPagination(document.getElementById("problems-pagination"), 0, 0, () => {});
    return;
  }

  if (!problems || problems.length === 0) {
    // We're past the last page (e.g. deleted the only row of page 2) — go back.
    if (isPastLastPage(count, from, safePage)) return loadProblems(safePage - 1);
    problemsTotal = count ?? 0;
    problemsPage = safePage;
    appendEmptyRow(
      tbody,
      search || type !== "all" ? "No problems match this search/filter." : "No problems yet — add your first one."
    );
    renderPagination(document.getElementById("problems-pagination"), problemsPage, problemsTotal, loadProblems);
    return;
  }

  problemsTotal = count ?? problems.length;
  problemsPage = safePage;

  const fragment = document.createDocumentFragment();

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
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn--danger btn--sm";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteProblem(p.id, p.title, deleteBtn));
    tdActions.append(editLink, deleteBtn);

    tr.append(tdTitle, tdType, tdDiff, tdTopic, tdAccess, tdActions);
    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);

  renderPagination(document.getElementById("problems-pagination"), problemsPage, problemsTotal, loadProblems);
}

async function deleteProblem(id, title, btn) {
  const label = title ? `"${title}"` : "this problem";
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Deleting...";

  try {
    // .select() makes PostgREST return the deleted rows, so we can tell the
    // difference between "deleted" and "RLS silently matched zero rows"
    // (which previously reported a cheerful "Problem deleted").
    const { data, error } = await sb.from("problems").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error("Nothing was deleted — the row may be protected by RLS policies.");
    }
    showToast("Problem deleted", "success");
    await loadStats();
    await loadProblems(problemsPage);
  } catch (err) {
    showToast("Could not delete: " + errorText(err), "error");
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
