// admin-dashboard.js — stats, analytics, activity feed, top problems, problems table.

let dashboardProblems = [];

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await Promise.all([loadStats(), loadProblems()]);
  loadAnalytics();
  loadActivity();
  loadTopProblems();

  document.getElementById("admin-search").addEventListener("input", debounce(loadProblems, 300));
  document.getElementById("admin-filter-type").addEventListener("change", loadProblems);
  document.getElementById("admin-filter-difficulty").addEventListener("change", loadProblems);
  document.getElementById("admin-filter-access").addEventListener("change", loadProblems);
  document.getElementById("export-problems-btn").addEventListener("click", () => {
    downloadCSV("pydebug-problems.csv", dashboardProblems.map((p) => ({
      id: p.id, problem_number: p.problem_number ?? "", title: p.title, type: p.type,
      difficulty: p.difficulty, topic: p.topic || "", access: p.is_premium ? "premium" : "free",
      created_at: p.created_at,
    })));
  });
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

async function loadStats() {
  try {
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
  } catch (e) {
    console.warn("loadStats basic:", e.message);
  }

  // Revenue from the payment_grants ledger (the user app's real payment
  // record — every row is a verified successful payment).
  try {
    const { data, error } = await sb.from("payment_grants").select("plan_key, created_at").limit(5000);
    if (error) throw error;
    const rows = data || [];
    const total = rows.reduce((s, g) => s + planAmountPaise(g.plan_key), 0);
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const monthTotal = rows
      .filter((g) => new Date(g.created_at).getTime() >= monthAgo)
      .reduce((s, g) => s + planAmountPaise(g.plan_key), 0);
    document.getElementById("stat-revenue").textContent = fmtINR(total / 100);
    document.getElementById("stat-month-revenue").textContent = fmtINR(monthTotal / 100);
  } catch (e) {
    console.warn("loadStats revenue:", e.message);
  }

  // Submissions + solve rate.
  try {
    const { count: totalSubs } = await sb.from("submissions").select("*", { count: "exact", head: true });
    document.getElementById("stat-submissions").textContent = (totalSubs ?? 0).toLocaleString("en-IN");
    const { data: sample } = await sb.from("submissions").select("*").order("created_at", { ascending: false }).limit(1000);
    const stCol = detectCol((sample || [])[0], ["status", "result", "verdict"]);
    const solved = (sample || []).filter((s) =>
      ["solved", "success", "correct", "passed", "true", "1"].includes(String(s[stCol] ?? "").toLowerCase()) || s.is_correct === true
    ).length;
    document.getElementById("stat-solve-rate").textContent = sample && sample.length ? Math.round((solved / sample.length) * 100) + "%" : "—";
  } catch (e) {
    console.warn("loadStats submissions:", e.message);
  }

  // New users in last 7 days.
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: newUsers } = await sb.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", weekAgo);
    document.getElementById("stat-new-users").textContent = newUsers ?? 0;
  } catch (e) {
    console.warn("loadStats new users:", e.message);
  }
}

async function loadAnalytics() {
  // Signups chart.
  try {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await sb.from("profiles").select("created_at").gte("created_at", twoWeeksAgo).limit(10000);
    const buckets = bucketByDay(data || [], "created_at", 14);
    document.getElementById("chart-signups").innerHTML =
      svgBarChart(buckets.map((b) => b.label), buckets.map((b) => b.value), { color: CHART_COLORS.mint });
  } catch (e) {
    document.getElementById("chart-signups").innerHTML = `<div class="chart-empty">Unavailable</div>`;
  }

  // Submissions chart + status donut.
  try {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await sb.from("submissions").select("*").gte("created_at", twoWeeksAgo).limit(10000);
    const rows = data || [];
    const buckets = bucketByDay(rows, "created_at", 14);
    document.getElementById("chart-submissions").innerHTML =
      svgBarChart(buckets.map((b) => b.label), buckets.map((b) => b.value), { color: CHART_COLORS.amber });

    const stCol = detectCol(rows[0], ["status", "result", "verdict"]);
    let solved = 0, attempted = 0;
    rows.forEach((s) => {
      const ok = ["solved", "success", "correct", "passed", "true", "1"].includes(String(s[stCol] ?? "").toLowerCase()) || s.is_correct === true;
      ok ? solved++ : attempted++;
    });
    document.getElementById("chart-status").innerHTML = svgDonut([
      { label: "Solved", value: solved, color: CHART_COLORS.green },
      { label: "Attempted", value: attempted, color: CHART_COLORS.amber },
    ]);
  } catch (e) {
    document.getElementById("chart-submissions").innerHTML = `<div class="chart-empty">Run supabase-admin-setup.sql to enable</div>`;
    document.getElementById("chart-status").innerHTML = `<div class="chart-empty">Run supabase-admin-setup.sql to enable</div>`;
  }

  // Difficulty donut.
  try {
    const { data } = await sb.from("problems").select("difficulty").limit(5000);
    const counts = { easy: 0, medium: 0, hard: 0 };
    (data || []).forEach((p) => {
      const d = String(p.difficulty || "").toLowerCase();
      if (counts[d] !== undefined) counts[d]++;
    });
    document.getElementById("chart-difficulty").innerHTML = svgDonut([
      { label: "Easy", value: counts.easy, color: CHART_COLORS.green },
      { label: "Medium", value: counts.medium, color: CHART_COLORS.amber },
      { label: "Hard", value: counts.hard, color: CHART_COLORS.red },
    ]);
  } catch (e) {
    document.getElementById("chart-difficulty").innerHTML = `<div class="chart-empty">Unavailable</div>`;
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

async function loadProblems() {
  const search = document.getElementById("admin-search").value.trim();
  const type = document.getElementById("admin-filter-type").value;
  const difficulty = document.getElementById("admin-filter-difficulty").value;
  const access = document.getElementById("admin-filter-access").value;

  let query = sb.from("problems").select("*").order("created_at", { ascending: false });
  if (type !== "all") query = query.eq("type", type);
  if (difficulty !== "all") query = query.eq("difficulty", difficulty);
  if (access === "free") query = query.eq("is_premium", false);
  if (access === "premium") query = query.eq("is_premium", true);
  if (search) query = query.ilike("title", `%${search}%`);

  const { data: problems, error } = await query;
  const tbody = document.getElementById("problems-tbody");
  tbody.innerHTML = "";
  dashboardProblems = problems || [];
  document.getElementById("problems-count").textContent = `${dashboardProblems.length}`;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Error loading problems: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!dashboardProblems.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No problems yet — add your first one.</td></tr>`;
    return;
  }

  dashboardProblems.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono muted">${p.problem_number ?? "—"}</td>
      <td>${escapeHtml(p.title)}</td>
      <td><span class="tag tag--${escapeHtml(p.type)}">${p.type === "bug" ? "Bug" : "Question"}</span></td>
      <td><span class="diff diff--${escapeHtml(p.difficulty)}">${escapeHtml(p.difficulty)}</span></td>
      <td>${escapeHtml(p.topic || "-")}</td>
      <td>${p.is_premium ? '<span class="tag tag--premium">Premium</span>' : '<span class="tag tag--free">Free</span>'}</td>
      <td class="row-actions">
        <a href="problem-form.html?id=${p.id}" class="btn btn--secondary btn--sm">Edit</a>
        <button class="btn btn--secondary btn--sm" data-duplicate-id="${p.id}" title="Create a copy of this problem">Duplicate</button>
        <button class="btn btn--danger btn--sm" data-delete-id="${p.id}">Delete</button>
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
  await loadProblems();
}
