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

/* ---------------------------------------------------------------------
   Query weight
   The dashboard used to pull `submissions.select("*")` with limits of
   1 000 / 2 000 / 10 000 rows — every column of every row, including the
   stored code blobs. On a real database that is megabytes of JSON per page
   load, parsed on the main thread, which is exactly what made the panel
   feel stuck. We probe the table shape ONCE and then ask only for the four
   or five columns the dashboard actually reads.
   --------------------------------------------------------------------- */
let submissionShape = null;

async function getSubmissionShape() {
  if (submissionShape) return submissionShape;
  let sample = null;
  try {
    const { data } = await sb.from("submissions").select("*").limit(1);
    sample = (data || [])[0] || null;
  } catch (e) { /* fall through to the safe default */ }
  const statusCol = detectCol(sample, ["status", "result", "verdict"]);
  const has = (col) => !!sample && Object.prototype.hasOwnProperty.call(sample, col);
  const cols = ["created_at", "user_id", "problem_id", statusCol];
  if (has("is_correct")) cols.push("is_correct");
  submissionShape = {
    statusCol,
    // No sample row (empty table) → keep "*" so we never guess wrong.
    cols: sample ? [...new Set(cols)].join(", ") : "*",
  };
  return submissionShape;
}

// Runs `build(columns)`; if the narrow column list is rejected by PostgREST
// (42703 undefined_column / 42P10), retries once with "*".
async function selectSubmissions(build) {
  const shape = await getSubmissionShape();
  let result = await build(shape.cols);
  if (result.error && shape.cols !== "*") {
    submissionShape = { statusCol: shape.statusCol, cols: "*" };
    result = await build("*");
  }
  return { ...result, statusCol: shape.statusCol };
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

onAdminReady(async () => {
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

  // Above-the-fold data first, then the heavier sections once the browser
  // is idle. Previously everything fired at once and the main thread spent
  // several seconds parsing JSON before the page would even scroll.
  await Promise.all([loadStats(), loadProblems(0)]);
  loadAnalytics();
  const later = () => { loadActivity(); loadTopProblems(); loadAIBrief(); };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(later, { timeout: 1200 });
  else window.setTimeout(later, 120);

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

  // Revenue from the payment_grants ledger (cross-referenced with payment_orders
  // when grant.amount_paise is null).
  try {
    const [grantRows, orderRows] = await Promise.all([
      fetchAdminRows("payment_grants", "payment_id, order_id, plan_key, amount_paise, created_at", "payment_id"),
      fetchAdminRows("payment_orders", "order_id, amount", "created_at").catch(() => []),
    ]);
    const orderMap = {};
    (orderRows || []).forEach((o) => {
      if (o.order_id && Number.isFinite(Number(o.amount))) orderMap[o.order_id] = Number(o.amount);
    });
    const rows = (grantRows || []).map((g) => ({ ...g, order_amount_paise: orderMap[g.order_id] ?? null }));
    const total = rows.reduce((s, g) => s + grantAmountPaise(g), 0);
    const now = Date.now();
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const previousMonthAgo = now - 60 * 24 * 60 * 60 * 1000;
    const monthTotal = rows
      .filter((g) => new Date(g.created_at).getTime() >= monthAgo)
      .reduce((s, g) => s + grantAmountPaise(g), 0);
    const previousMonthTotal = rows
      .filter((g) => {
        const t = new Date(g.created_at).getTime();
        return t >= previousMonthAgo && t < monthAgo;
      })
      .reduce((s, g) => s + grantAmountPaise(g), 0);
    document.getElementById("stat-revenue").textContent = fmtINR(total / 100);
    document.getElementById("stat-month-revenue").textContent = fmtINR(monthTotal / 100);
    setTrend("stat-month-revenue-trend", monthTotal / 100, previousMonthTotal / 100, "₹");
  } catch (e) {
    console.warn("loadStats revenue:", e.message);
    document.getElementById("stat-revenue").textContent = "₹—";
    document.getElementById("stat-month-revenue").textContent = "₹—";
  }

  // Submissions + solve rate.
  try {
    const { count: totalSubs } = await sb.from("submissions").select("*", { count: "exact", head: true });
    document.getElementById("stat-submissions").textContent = (totalSubs ?? 0).toLocaleString("en-IN");
    const { data: sample, statusCol } = await selectSubmissions((cols) =>
      sb.from("submissions").select(cols).order("created_at", { ascending: false }).limit(500)
    );
    const rows = sample || [];
    const solved = rows.filter((s) => isSolvedSubmission(s, statusCol)).length;
    document.getElementById("stat-solve-rate").textContent = rows.length ? Math.round((solved / rows.length) * 100) + "%" : "—";
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

// Painted analytics are cached per range, so flipping 7D / 14D / 30D is
// instant (the fresh numbers then replace them when the query returns).
const analyticsCache = new Map();

function paintAnalytics(view, days) {
  const { labels, signupValues, submissionValues, difficulty, outcomes, errors } = view;

  document.getElementById("chart-signups").innerHTML = errors.profiles
    ? `<div class="chart-empty">Unavailable — check profiles access</div>`
    : svgBarChart(labels, signupValues, { color: CHART_COLORS.mint, name: "New learners" });

  document.getElementById("chart-submissions").innerHTML = errors.submissions
    ? `<div class="chart-empty">Unavailable — check submissions access</div>`
    : svgBarChart(labels, submissionValues, { color: CHART_COLORS.amber, name: "Submissions" });

  document.getElementById("chart-overview").innerHTML = (errors.profiles || errors.submissions)
    ? `<div class="chart-empty">Analytics needs a readable profiles and submissions table.</div>`
    : svgLineChart(labels, [
      { name: "New learners", values: signupValues, color: CHART_COLORS.mint },
      { name: "Submissions", values: submissionValues, color: CHART_COLORS.amber },
    ], { ariaLabel: `New learners and submissions over the last ${days} days` });

  const summary = document.getElementById("chart-overview-summary");
  if (summary) {
    const learners = signupValues.reduce((a, b) => a + b, 0);
    const attempts = submissionValues.reduce((a, b) => a + b, 0);
    const busiest = submissionValues.indexOf(Math.max(...submissionValues));
    summary.textContent = attempts
      ? `${learners.toLocaleString("en-IN")} learners · ${attempts.toLocaleString("en-IN")} attempts · peak ${labels[busiest]}`
      : `${learners.toLocaleString("en-IN")} learners · ${attempts.toLocaleString("en-IN")} attempts`;
  }

  document.getElementById("chart-status").innerHTML = errors.submissions
    ? `<div class="chart-empty">Unavailable</div>`
    : svgDonut([
      { label: "Solved", value: outcomes.solved, color: CHART_COLORS.green },
      { label: "Attempted", value: outcomes.attempted, color: CHART_COLORS.amber },
    ], { centerLabel: "attempts" });

  document.getElementById("chart-difficulty").innerHTML = errors.problems
    ? `<div class="chart-empty">Unavailable</div>`
    : svgDonut([
      { label: "Easy", value: difficulty.easy, color: CHART_COLORS.green },
      { label: "Medium", value: difficulty.medium, color: CHART_COLORS.amber },
      { label: "Hard", value: difficulty.hard, color: CHART_COLORS.red },
    ], { centerLabel: "problems" });
}

async function loadAnalytics() {
  const requestId = ++analyticsRequest;
  const days = analyticsDays;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const cached = analyticsCache.get(days);
  if (cached) paintAnalytics(cached, days);

  try {
    const [profilesResult, submissionsResult, problemsResult] = await Promise.all([
      sb.from("profiles").select("created_at").gte("created_at", since).limit(10000),
      selectSubmissions((cols) => sb.from("submissions").select(cols).gte("created_at", since).limit(10000)),
      sb.from("problems").select("difficulty").limit(5000),
    ]);
    if (requestId !== analyticsRequest) return;

    const signupRows = profilesResult.data || [];
    const submissionRows = submissionsResult.data || [];
    const signupBuckets = bucketByDay(signupRows, "created_at", days);
    const submissionBuckets = bucketByDay(submissionRows, "created_at", days);

    const statusCol = submissionsResult.statusCol;
    let solved = 0, attempted = 0;
    submissionRows.forEach((row) => (isSolvedSubmission(row, statusCol) ? solved++ : attempted++));

    const difficulty = { easy: 0, medium: 0, hard: 0 };
    (problemsResult.data || []).forEach((problem) => {
      const key = String(problem.difficulty || "").toLowerCase();
      if (difficulty[key] !== undefined) difficulty[key]++;
    });

    const view = {
      labels: signupBuckets.map((b) => b.label),
      signupValues: signupBuckets.map((b) => b.value),
      submissionValues: submissionBuckets.map((b) => b.value),
      outcomes: { solved, attempted },
      difficulty,
      errors: {
        profiles: !!profilesResult.error,
        submissions: !!submissionsResult.error,
        problems: !!problemsResult.error,
      },
    };
    analyticsCache.set(days, view);
    paintAnalytics(view, days);
  } catch (e) {
    if (requestId !== analyticsRequest || cached) return;
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
    const { data: subs, statusCol: stCol } = await selectSubmissions((cols) =>
      sb.from("submissions").select(cols).order("created_at", { ascending: false }).limit(8)
    );
    const rows = subs || [];
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
    const { data, statusCol: stCol } = await selectSubmissions((cols) =>
      sb.from("submissions").select(cols).order("created_at", { ascending: false }).limit(1200)
    );
    const rows = data || [];
    if (!rows.length) {
      list.innerHTML = `<li class="empty-row">No submissions yet.</li>`;
      return;
    }
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
    // The AI bundle now loads in the background, so wait for it here
    // instead of making the whole page wait for it up front.
    if (typeof whenAdminAIReady === "function") await whenAdminAIReady();
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

  // One string + one DOM write for the whole page of rows. The old loop did
  // 50 × (createElement + innerHTML + appendChild), i.e. 50 separate layout
  // invalidations and 150 individual click listeners per render.
  tbody.innerHTML = dashboardProblems.map((p) => {
    const safeType = p.type === "bug" ? "bug" : p.type === "coding" ? "info" : "question";
    const typeLabel = p.type === "bug" ? "Bug" : p.type === "coding" ? "Write Code" : "Question";
    const safeDiff = ["easy", "medium", "hard"].includes(p.difficulty) ? p.difficulty : "medium";
    const statusBit = p.status && p.status !== "published" ? ` <span class="tag tag--attempted">${escapeHtml(p.status)}</span>` : "";
    const id = encodeURIComponent(p.id);
    return `<tr>
      <td class="mono muted">${p.problem_number ?? "—"}</td>
      <td>${escapeHtml(p.title)}${statusBit}${p.slug ? `<div class="mono muted" style="font-size:0.72rem">/${escapeHtml(p.slug)}</div>` : ""}</td>
      <td><span class="tag tag--${safeType}">${typeLabel}</span></td>
      <td><span class="diff diff--${safeDiff}">${escapeHtml(p.difficulty || safeDiff)}</span></td>
      <td>${escapeHtml(p.topic || "-")}</td>
      <td>${p.is_premium ? '<span class="tag tag--premium">Premium</span>' : '<span class="tag tag--free">Free</span>'}</td>
      <td class="row-actions">
        <a href="problem-form.html?id=${id}" class="btn btn--secondary btn--sm">Edit</a>
        <button class="btn btn--secondary btn--sm" data-duplicate-id="${id}" title="Create a copy of this problem">Duplicate</button>
        <button class="btn btn--secondary btn--sm" data-vary-id="${id}" title="AI: create 3 fresh variations of this problem">✨</button>
        <button class="btn btn--danger btn--sm" data-delete-id="${id}">Delete</button>
      </td>
    </tr>`;
  }).join("");

  bindProblemRowActions(tbody);
  renderPagination(document.getElementById("problems-pagination"), problemsPage, problemsTotal, (p) => loadProblems(p));
}

// A single delegated listener survives every re-render, so row actions keep
// working without re-attaching handlers each time the table reloads.
function bindProblemRowActions(tbody) {
  if (!tbody || tbody.dataset.bound === "1") return;
  tbody.dataset.bound = "1";
  tbody.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-delete-id], button[data-duplicate-id], button[data-vary-id]");
    if (!button) return;
    if (button.dataset.deleteId) deleteProblem(button.dataset.deleteId, button);
    else if (button.dataset.duplicateId) duplicateProblem(button.dataset.duplicateId, button);
    else if (button.dataset.varyId) varyProblem(button.dataset.varyId, button);
  });
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
  const { id: _id, created_at: _c, updated_at: _u, ...copy } = p;
  copy.title = `${p.title} (Copy)`;
  // Give the copy the next free number + unique slug, and skip notification blast.
  const { data: top } = await sb.from("problems").select("problem_number").order("problem_number", { ascending: false }).limit(1);
  copy.problem_number = (Number(top?.[0]?.problem_number) || 0) + 1;
  copy.slug = `${slugifyProblemTitle(copy.title)}-${copy.problem_number}`;
  copy.admin_skip_notification = true;

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
  if (typeof AI_generateVariations !== "function" && typeof whenAdminAIReady === "function") {
    btn.disabled = true;
    await whenAdminAIReady();
    btn.disabled = false;
  }
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
