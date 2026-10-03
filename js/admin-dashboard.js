// admin-dashboard.js — stats, analytics, activity feed, top problems, problems table.

let dashboardProblems = [];
let problemsPage = 0;
let problemsTotal = 0;
let analyticsDays = 14;
let analyticsRequest = 0;

const SOLVED_STATUSES = ["solved", "success", "correct", "passed", "true", "1", "succeeded", "captured", "paid", "completed"];
function isSolvedSubmission(row, statusColumn) {
  return row && (row.is_correct === true || SOLVED_STATUSES.includes(String(row[statusColumn] ?? "").toLowerCase()));
}

function setTrend(id, current, previous, suffix = "") {
  const el = document.getElementById(id);
  if (!el) return;
  if (previous === null || previous === undefined) {
    el.textContent = "live comparison unavailable";
    el.className = "sub trend trend--neutral";
    return;
  }
  const delta = Number(current || 0) - Number(previous || 0);
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const displayDelta = suffix === "₹" ? `${sign}₹${Math.abs(Math.round(delta)).toLocaleString("en-IN")}` : `${sign}${Math.abs(delta).toLocaleString("en-IN")}${suffix}`;
  el.textContent = `${displayDelta} vs previous period`;
  el.className = `sub trend ${delta > 0 ? "trend--up" : delta < 0 ? "trend--down" : "trend--neutral"}`;
}

function updateSyncStamp() {
  const el = document.getElementById("dashboard-last-sync");
  if (el) el.textContent = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  const name = admin.display_name || admin.full_name || admin.email || "admin";
  const greeting = document.getElementById("dashboard-admin-greeting");
  if (greeting) greeting.textContent = name.split(" ")[0];

  // Live activity first — the "Active now" list and "Practiced today" are
  // the headline of the dashboard; both are fire-and-forget so they never
  // block the rest of the page.
  initLivePresence();
  loadDailyPractice();

  await Promise.all([loadStats(), loadProblems(0)]);
  loadAnalytics();
  loadActivity();
  loadTopProblems();
  loadAIBrief();

  document.querySelectorAll("#analytics-range [data-days]").forEach((button) => {
    button.addEventListener("click", () => {
      analyticsDays = Number(button.dataset.days) || 14;
      document.querySelectorAll("#analytics-range [data-days]").forEach((b) => b.classList.toggle("is-active", b === button));
      loadAnalytics();
    });
  });

  document.getElementById("admin-search").addEventListener("input", debounce(() => loadProblems(0), 300));
  document.getElementById("admin-filter-type").addEventListener("change", () => loadProblems(0));
  document.getElementById("admin-filter-difficulty").addEventListener("change", () => loadProblems(0));
  document.getElementById("admin-filter-access").addEventListener("change", () => loadProblems(0));
  document.getElementById("export-problems-btn").addEventListener("click", exportProblems);
  document.getElementById("refresh-dashboard-btn")?.addEventListener("click", refreshDashboard);
});

// Keep the admin's view in sync with activity on pydebug.in without forcing a
// full page reload (which would unnecessarily re-run the panel unlock flow).
async function refreshDashboard() {
  const button = document.getElementById("refresh-dashboard-btn");
  if (!button || button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "↻ Refreshing…";
  try {
    await Promise.all([
      loadStats(),
      loadProblems(problemsPage),
      loadAnalytics(),
      loadActivity(),
      loadTopProblems(),
      loadDailyPractice(),
      loadAIBrief(),
    ]);
    updateSyncStamp();
    showToast("Dashboard refreshed", "success");
  } catch (error) {
    console.warn("dashboard refresh:", error);
    showToast("Some dashboard data could not be refreshed", "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function countRows(queryBuilder, fallbackBuilder = null) {
  let { count, error } = await queryBuilder;
  if (error && fallbackBuilder) ({ count, error } = await fallbackBuilder);
  if (error) return null;
  return count ?? 0;
}

function setStat(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value === null || value === undefined ? "—" : value;
}

async function countActivePremium() {
  // Active premium = is_premium true AND (no expiry set OR not yet expired).
  // Expired premium rows are NOT counted. Falls back to the plain is_premium
  // count if this project's profiles table has no premium_expires_at column.
  const nowIso = new Date().toISOString();
  const [noExpiry, notExpired] = await Promise.all([
    countRows(sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true).is("premium_expires_at", null)),
    countRows(sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true).gte("premium_expires_at", nowIso)),
  ]);
  if (noExpiry === null || notExpired === null) {
    return countRows(sb.from("profiles").select("*", { count: "exact", head: true }).eq("is_premium", true));
  }
  return noExpiry + notExpired;
}

async function loadStats() {
  try {
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
  } catch (e) {
    console.warn("loadStats basic:", e.message);
    showToast("Some stats couldn't be loaded — check the Supabase schema/RLS setup (README step 1).", "error");
  }

  // Revenue from the payment_grants ledger (the user app's real payment
  // record — every row is a verified successful payment).
  try {
    const { data, error } = await sb.from("payment_grants").select("plan_key, created_at").limit(5000);
    if (error) throw error;
    const rows = data || [];
    const total = rows.reduce((s, g) => s + planAmountPaise(g.plan_key), 0);
    const now = Date.now();
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const previousMonthAgo = now - 60 * 24 * 60 * 60 * 1000;
    const monthTotal = rows
      .filter((g) => new Date(g.created_at).getTime() >= monthAgo)
      .reduce((s, g) => s + planAmountPaise(g.plan_key), 0);
    const previousMonthTotal = rows
      .filter((g) => {
        const t = new Date(g.created_at).getTime();
        return t >= previousMonthAgo && t < monthAgo;
      })
      .reduce((s, g) => s + planAmountPaise(g.plan_key), 0);
    document.getElementById("stat-revenue").textContent = fmtINR(total / 100);
    document.getElementById("stat-month-revenue").textContent = fmtINR(monthTotal / 100);
    setTrend("stat-month-revenue-trend", monthTotal / 100, previousMonthTotal, "₹");
  } catch (e) {
    console.warn("loadStats revenue:", e.message);
    document.getElementById("stat-revenue").textContent = "₹—";
    document.getElementById("stat-month-revenue").textContent = "₹—";
  }

  // Submissions + solve rate.
  try {
    const { count: totalSubs } = await sb.from("submissions").select("*", { count: "exact", head: true });
    document.getElementById("stat-submissions").textContent = (totalSubs ?? 0).toLocaleString("en-IN");
    const { data: sample } = await sb.from("submissions").select("*").order("created_at", { ascending: false }).limit(1000);
    const stCol = detectCol((sample || [])[0], ["status", "result", "verdict"]);
    const solved = (sample || []).filter((s) => isSolvedSubmission(s, stCol)).length;
    document.getElementById("stat-solve-rate").textContent = sample && sample.length ? Math.round((solved / sample.length) * 100) + "%" : "—";
  } catch (e) {
    console.warn("loadStats submissions:", e.message);
  }

  // New users in last 7 days, with a real previous-period comparison.
  try {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const [{ count: newUsers, error: currentError }, { count: previousUsers, error: previousError }] = await Promise.all([
      sb.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
      sb.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", twoWeeksAgo).lt("created_at", weekAgo),
    ]);
    document.getElementById("stat-new-users").textContent = currentError ? "—" : (newUsers ?? 0).toLocaleString("en-IN");
    setTrend("stat-new-users-trend", newUsers ?? 0, previousError ? null : (previousUsers ?? 0));
  } catch (e) {
    console.warn("loadStats new users:", e.message);
  }
  updateSyncStamp();
}

async function loadAnalytics() {
  const requestId = ++analyticsRequest;
  const days = analyticsDays;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [profilesResult, submissionsResult, problemsResult] = await Promise.all([
      sb.from("profiles").select("created_at").gte("created_at", since).limit(10000),
      sb.from("submissions").select("*").gte("created_at", since).limit(10000),
      sb.from("problems").select("difficulty").limit(5000),
    ]);
    if (requestId !== analyticsRequest) return;

    const signupRows = profilesResult.data || [];
    const submissionRows = submissionsResult.data || [];
    const signupBuckets = bucketByDay(signupRows, "created_at", days);
    const submissionBuckets = bucketByDay(submissionRows, "created_at", days);
    const labels = signupBuckets.map((b) => b.label);
    const signupValues = signupBuckets.map((b) => b.value);
    const submissionValues = submissionBuckets.map((b) => b.value);

    document.getElementById("chart-signups").innerHTML = profilesResult.error
      ? `<div class="chart-empty">Unavailable — check profiles access</div>`
      : svgBarChart(labels, signupValues, { color: CHART_COLORS.mint });
    document.getElementById("chart-submissions").innerHTML = submissionsResult.error
      ? `<div class="chart-empty">Unavailable — check submissions access</div>`
      : svgBarChart(labels, submissionValues, { color: CHART_COLORS.amber });
    document.getElementById("chart-overview").innerHTML = (profilesResult.error || submissionsResult.error)
      ? `<div class="chart-empty">Analytics needs a readable profiles and submissions table.</div>`
      : svgLineChart(labels, [
        { name: "New learners", values: signupValues, color: CHART_COLORS.mint },
        { name: "Submissions", values: submissionValues, color: CHART_COLORS.amber },
      ], { ariaLabel: `New learners and submissions over the last ${days} days` });
    const summary = document.getElementById("chart-overview-summary");
    if (summary) summary.textContent = `${signupValues.reduce((a, b) => a + b, 0).toLocaleString("en-IN")} learners · ${submissionValues.reduce((a, b) => a + b, 0).toLocaleString("en-IN")} attempts`;

    const stCol = detectCol(submissionRows[0], ["status", "result", "verdict"]);
    let solved = 0, attempted = 0;
    submissionRows.forEach((row) => isSolvedSubmission(row, stCol) ? solved++ : attempted++);
    document.getElementById("chart-status").innerHTML = submissionsResult.error
      ? `<div class="chart-empty">Unavailable</div>`
      : svgDonut([
        { label: "Solved", value: solved, color: CHART_COLORS.green },
        { label: "Attempted", value: attempted, color: CHART_COLORS.amber },
      ]);

    const counts = { easy: 0, medium: 0, hard: 0 };
    (problemsResult.data || []).forEach((problem) => {
      const difficulty = String(problem.difficulty || "").toLowerCase();
      if (counts[difficulty] !== undefined) counts[difficulty]++;
    });
    document.getElementById("chart-difficulty").innerHTML = problemsResult.error
      ? `<div class="chart-empty">Unavailable</div>`
      : svgDonut([
        { label: "Easy", value: counts.easy, color: CHART_COLORS.green },
        { label: "Medium", value: counts.medium, color: CHART_COLORS.amber },
        { label: "Hard", value: counts.hard, color: CHART_COLORS.red },
      ]);
  } catch (e) {
    if (requestId !== analyticsRequest) return;
    ["chart-overview", "chart-signups", "chart-submissions", "chart-status", "chart-difficulty"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<div class="chart-empty">Analytics unavailable right now.</div>`;
    });
    console.warn("loadAnalytics:", e.message);
  }
}

async function loadActivity() {
  const feed = document.getElementById("activity-feed");
  const items = [];

  try {
    const { data: subs } = await sb.from("submissions").select("*").order("created_at", { ascending: false }).limit(8);
    const rows = subs || [];
    const stCol = detectCol(rows[0], ["status", "result", "verdict"]);
    const userIds = [...new Set(rows.map((s) => s.user_id).filter(Boolean))];
    const problemIds = [...new Set(rows.map((s) => s.problem_id).filter(Boolean))];
    let users = {}, problems = {};
    if (userIds.length) {
      const { data } = await sb.from("profiles").select("id, email, full_name").in("id", userIds);
      (data || []).forEach((u) => { users[u.id] = u.email || u.full_name; });
    }
    if (problemIds.length) {
      const { data } = await sb.from("problems").select("id, title").in("id", problemIds);
      (data || []).forEach((p) => { problems[p.id] = p.title; });
    }
    rows.forEach((s) => {
      const ok = ["solved", "success", "correct", "passed", "true", "1"].includes(String(s[stCol] ?? "").toLowerCase()) || s.is_correct === true;
      items.push({
        at: s.created_at,
        dot: ok ? "dot--solved" : "dot--attempted",
        html: `<span><strong>${escapeHtml(users[s.user_id] || "Someone")}</strong> ${ok ? "solved" : "attempted"} <strong>${escapeHtml(problems[s.problem_id] || "a problem")}</strong></span>`,
      });
    });
  } catch (e) {
    console.warn("activity submissions:", e.message);
  }

  try {
    const { data: newUsers } = await sb.from("profiles").select("email, full_name, created_at").order("created_at", { ascending: false }).limit(4);
    (newUsers || []).forEach((u) => {
      items.push({
        at: u.created_at,
        dot: "dot--user",
        html: `<span><strong>${escapeHtml(u.email || u.full_name || "Someone")}</strong> <span class="who">signed up</span></span>`,
      });
    });
  } catch (e) {
    console.warn("activity users:", e.message);
  }

  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!items.length) {
    feed.innerHTML = `<li class="empty-row">No activity yet.</li>`;
    return;
  }
  feed.innerHTML = items.slice(0, 10).map((i) =>
    `<li><span class="dot ${i.dot}"></span>${i.html}<time>${escapeHtml(timeAgo(i.at))}</time></li>`
  ).join("");
}

async function loadTopProblems() {
  const list = document.getElementById("top-problems");
  try {
    const { data } = await sb.from("submissions").select("*").order("created_at", { ascending: false }).limit(2000);
    const rows = data || [];
    if (!rows.length) {
      list.innerHTML = `<li class="empty-row">No submissions yet.</li>`;
      return;
    }
    const stCol = detectCol(rows[0], ["status", "result", "verdict"]);
    const agg = {};
    rows.forEach((s) => {
      if (!s.problem_id) return;
      agg[s.problem_id] = agg[s.problem_id] || { attempts: 0, solves: 0 };
      agg[s.problem_id].attempts++;
      const ok = ["solved", "success", "correct", "passed", "true", "1"].includes(String(s[stCol] ?? "").toLowerCase()) || s.is_correct === true;
      if (ok) agg[s.problem_id].solves++;
    });
    const top = Object.entries(agg).sort((a, b) => b[1].attempts - a[1].attempts).slice(0, 5);
    const { data: problems } = await sb.from("problems").select("id, title").in("id", top.map((t) => t[0]));
    const titles = {};
    (problems || []).forEach((p) => { titles[p.id] = p.title; });
    list.innerHTML = top.map(([id, v], i) =>
      `<li><span class="rank">#${i + 1}</span><span>${escapeHtml(titles[id] || "Unknown problem")}</span><span class="meta">${v.attempts} attempts · ${v.solves} solved</span></li>`
    ).join("");
  } catch (e) {
    list.innerHTML = `<li class="empty-row">Run supabase-admin-setup.sql to enable.</li>`;
  }
}

async function loadAIBrief() {
  const scoreEl = document.getElementById("dashboard-ai-score");
  const stateEl = document.getElementById("dashboard-ai-state");
  const metaEl = document.getElementById("dashboard-ai-meta");
  const list = document.getElementById("dashboard-ai-checks");
  if (!scoreEl || !list) return;
  try {
    const settings = typeof AI_getSettings === "function" ? AI_getSettings() : { master: false };
    const pill = document.querySelector("[data-ai-guard-pill]");
    if (pill) {
      pill.textContent = settings.master ? "🤖 AI Guard ON" : "🤖 AI Guard OFF";
      pill.classList.toggle("ai-guard-pill--on", !!settings.master);
      pill.classList.toggle("ai-guard-pill--off", !settings.master);
    }
    if (typeof AI_healthCheck !== "function") throw new Error("AI quality engine unavailable");
    const health = await AI_healthCheck();
    scoreEl.textContent = String(health.score);
    scoreEl.dataset.score = health.score;
    stateEl.textContent = health.score >= 90 ? "Content looks sharp" : health.score >= 70 ? "A few fixes worth reviewing" : "Attention needed";
    metaEl.textContent = `${health.checks.length} checks · ${settings.master ? "AI Guard is watching" : "AI Guard is paused"}`;
    const findings = health.checks.filter((check) => check.status !== "ok").slice(0, 3);
    list.innerHTML = findings.length
      ? findings.map((check) => `<li><span class="ai-brief-list__icon ai-brief-list__icon--${check.status}">${check.status === "bad" ? "!" : "•"}</span><span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></span></li>`).join("")
      : `<li class="ai-brief-good"><span>✓</span><span><strong>No small issues found</strong><small>Problems, hints and discussions passed the local checks.</small></span></li>`;
  } catch (error) {
    scoreEl.textContent = "—";
    stateEl.textContent = "Quality scan paused";
    metaEl.textContent = "Open AI Control to run a full check";
    list.innerHTML = `<li class="ai-brief-good"><span>i</span><span><strong>AI is ready without an API key</strong><small>${escapeHtml(error.message || "Run the quality report from AI Control.")}</small></span></li>`;
  }
}

function currentProblemFilters() {
  return {
    search: sanitizeIlike(document.getElementById("admin-search").value),
    type: document.getElementById("admin-filter-type").value,
    difficulty: document.getElementById("admin-filter-difficulty").value,
    access: document.getElementById("admin-filter-access").value,
  };
}

function applyProblemFilters(query, filters) {
  if (filters.type !== "all") query = query.eq("type", filters.type);
  if (filters.difficulty !== "all") query = query.eq("difficulty", filters.difficulty);
  if (filters.access === "free") query = query.eq("is_premium", false);
  if (filters.access === "premium") query = query.eq("is_premium", true);
  if (filters.search) query = query.ilike("title", `%${filters.search}%`);
  return query;
}

async function loadProblems(page = 0) {
  const filters = currentProblemFilters();
  const from = page * ADMIN_PAGE_SIZE;
  const to = from + ADMIN_PAGE_SIZE - 1;

  async function run(includeOrder) {
    let query = sb.from("problems").select("*", { count: "exact" });
    if (includeOrder) query = query.order("created_at", { ascending: false });
    query = applyProblemFilters(query, filters);
    return query.range(from, to);
  }

  let { data: problems, error, count } = await run(true);
  // 42703 = undefined_column — retry without created_at ordering.
  if (error && error.code === "42703") {
    ({ data: problems, error, count } = await run(false));
  }

  const tbody = document.getElementById("problems-tbody");
  tbody.innerHTML = "";
  dashboardProblems = problems || [];
  problemsTotal = count ?? dashboardProblems.length;
  problemsPage = page;
  document.getElementById("problems-count").textContent = `${problemsTotal}`;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Error loading problems: ${escapeHtml(error.message)}</td></tr>`;
    renderPagination(document.getElementById("problems-pagination"), 0, 0, () => {});
    return;
  }
  if (!dashboardProblems.length) {
    if ((count ?? 0) > from && page > 0) return loadProblems(page - 1);
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No problems yet — add your first one.</td></tr>`;
    renderPagination(document.getElementById("problems-pagination"), problemsPage, problemsTotal, (p) => loadProblems(p));
    return;
  }

  dashboardProblems.forEach((p) => {
    const safeType = p.type === "bug" ? "bug" : "question";
    const safeDiff = ["easy", "medium", "hard"].includes(p.difficulty) ? p.difficulty : "medium";
    const id = encodeURIComponent(p.id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono muted">${p.problem_number ?? "—"}</td>
      <td>${escapeHtml(p.title)}</td>
      <td><span class="tag tag--${safeType}">${safeType === "bug" ? "Bug" : "Question"}</span></td>
      <td><span class="diff diff--${safeDiff}">${escapeHtml(p.difficulty || safeDiff)}</span></td>
      <td>${escapeHtml(p.topic || "-")}</td>
      <td>${p.is_premium ? '<span class="tag tag--premium">Premium</span>' : '<span class="tag tag--free">Free</span>'}</td>
      <td class="row-actions">
        <a href="problem-form.html?id=${id}" class="btn btn--secondary btn--sm">Edit</a>
        <button class="btn btn--secondary btn--sm" data-duplicate-id="${id}" title="Create a copy of this problem">Duplicate</button>
        <button class="btn btn--secondary btn--sm" data-vary-id="${id}" title="AI: create 3 fresh variations of this problem">✨</button>
        <button class="btn btn--danger btn--sm" data-delete-id="${id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", () => deleteProblem(btn.dataset.deleteId, btn));
  });
  tbody.querySelectorAll("[data-duplicate-id]").forEach((btn) => {
    btn.addEventListener("click", () => duplicateProblem(btn.dataset.duplicateId, btn));
  });
  tbody.querySelectorAll("[data-vary-id]").forEach((btn) => {
    btn.addEventListener("click", () => varyProblem(btn.dataset.varyId, btn));
  });

  renderPagination(document.getElementById("problems-pagination"), problemsPage, problemsTotal, (p) => loadProblems(p));
}

async function exportProblems() {
  const filters = currentProblemFilters();
  let query = sb.from("problems").select("*").order("created_at", { ascending: false }).limit(5000);
  query = applyProblemFilters(query, filters);
  const { data, error } = await query;
  if (error) {
    showToast("Could not export: " + error.message, "error");
    return;
  }
  downloadCSV("pydebug-problems.csv", (data || []).map((p) => ({
    id: p.id, problem_number: p.problem_number ?? "", title: p.title, type: p.type,
    difficulty: p.difficulty, topic: p.topic || "", access: p.is_premium ? "premium" : "free",
    created_at: p.created_at,
  })));
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
  await writeAudit("problem_deleted", "problem", id, {});
  showToast("Problem deleted", "success");
  await loadStats();
  await loadProblems(problemsPage);
}

async function duplicateProblem(id, btn) {
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = "Copying...";

  const { data: p, error: fetchError } = await sb.from("problems").select("*").eq("id", id).single();
  if (fetchError || !p) {
    showToast("Could not load problem to duplicate", "error");
    btn.disabled = false;
    btn.textContent = origText;
    return;
  }
  const { id: _id, created_at: _c, ...copy } = p;
  copy.title = `${p.title} (Copy)`;
  // Give the copy the next free number so grid order stays unique.
  const { data: top } = await sb.from("problems").select("problem_number").order("problem_number", { ascending: false }).limit(1);
  copy.problem_number = (Number(top?.[0]?.problem_number) || 0) + 1;

  const { error } = await sb.from("problems").insert(copy);
  if (error) {
    showToast("Could not duplicate: " + error.message, "error");
    btn.disabled = false;
    btn.textContent = origText;
    return;
  }
  showToast("Problem duplicated", "success");
  await loadStats();
  await loadProblems(problemsPage);
}

// AI Variations: spawns 3 fresh verified problems modelled on this one
// (same topic/type/difficulty, new values, never duplicates).
async function varyProblem(id, btn) {
  if (typeof AI_generateVariations !== "function") {
    showToast("AI engine not loaded — reload the page.", "error");
    return;
  }
  if (!confirm("Create 3 AI variations of this problem?")) return;
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = "✨...";
  try {
    const r = await AI_generateVariations(id, 3);
    showToast(
      r.added.length ? `Added ${r.added.length} variation(s)` : "All variations were duplicates — nothing added",
      r.added.length ? "success" : "info"
    );
    await loadStats();
    await loadProblems(problemsPage);
  } catch (e) {
    showToast("Variations failed: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = origText;
  }
}
