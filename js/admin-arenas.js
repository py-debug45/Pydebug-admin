// admin-arenas.js — Mock Tests, 1v1 Battle Arena & 45-Day Study Plans analytics.

let activeArenaTab = "mocks";
let allMocks = [];
let filteredMocks = [];
let allBattles = [];
let filteredBattles = [];
let allPlans = [];
let arenaUsers = {};

onAdminReady(async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  bindArenaTabs();
  await loadAllArenas();

  document.getElementById("mock-search").addEventListener("input", debounce(applyMockFilters, 250));
  document.getElementById("mock-filter-paper").addEventListener("change", applyMockFilters);
  document.getElementById("mock-filter-status").addEventListener("change", applyMockFilters);

  document.getElementById("battle-search").addEventListener("input", debounce(applyBattleFilters, 250));
  document.getElementById("battle-filter-diff").addEventListener("change", applyBattleFilters);
  document.getElementById("battle-filter-status").addEventListener("change", applyBattleFilters);

  document.getElementById("refresh-arenas-btn").addEventListener("click", loadAllArenas);
  document.getElementById("export-arenas-btn").addEventListener("click", exportCurrentTab);

  document.getElementById("arena-modal-close").addEventListener("click", () => {
    document.getElementById("arena-modal").classList.remove("is-open");
  });
  document.getElementById("arena-modal").addEventListener("click", (e) => {
    if (e.target.id === "arena-modal") document.getElementById("arena-modal").classList.remove("is-open");
  });
});

function bindArenaTabs() {
  document.querySelectorAll("[data-arena-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeArenaTab = btn.dataset.arenaTab;
      document.querySelectorAll("[data-arena-tab]").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".admin-tab-panel").forEach((p) => {
        p.classList.toggle("is-active", p.id === `panel-${activeArenaTab}`);
      });
    });
  });
}

function userLabel(uid) {
  const u = arenaUsers[uid];
  if (!u) return uid ? uid.slice(0, 8) + "…" : "—";
  return u.display_name || u.full_name || u.email || uid.slice(0, 8);
}

async function loadAllArenas() {
  const btn = document.getElementById("refresh-arenas-btn");
  btn.disabled = true;
  document.getElementById("arenas-hint").innerHTML = "";

  const warnings = [];
  const [mocksRes, battlesRes, plansRes] = await Promise.allSettled([
    fetchAdminRows("mock_attempts", "id,user_id,paper_id,status,started_at,deadline_at,submitted_at,correct,total,score,breakdown,percentile,cohort,xp,duration_ms,created_at", "created_at"),
    fetchAdminRows("battles", "*", "created_at"),
    fetchAdminRows("study_plans", "*", "user_id"),
  ]);

  if (mocksRes.status === "fulfilled") {
    allMocks = mocksRes.value.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  } else {
    allMocks = [];
    warnings.push(`mock_attempts: ${mocksRes.reason?.message || "unavailable"}`);
  }

  if (battlesRes.status === "fulfilled") {
    allBattles = battlesRes.value.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  } else {
    allBattles = [];
    warnings.push(`battles: ${battlesRes.reason?.message || "unavailable"}`);
  }

  if (plansRes.status === "fulfilled") {
    allPlans = plansRes.value.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  } else {
    allPlans = [];
    warnings.push(`study_plans: ${plansRes.reason?.message || "unavailable"}`);
  }

  if (warnings.length) {
    document.getElementById("arenas-hint").innerHTML =
      `<div class="admin-hint">Some assessment tables could not be read (${escapeHtml(warnings.join("; "))}).</div>`;
  }

  const uids = new Set();
  allMocks.forEach((m) => { if (m.user_id) uids.add(m.user_id); });
  allBattles.forEach((b) => {
    if (b.challenger_id) uids.add(b.challenger_id);
    if (b.opponent_id) uids.add(b.opponent_id);
    if (b.winner_id) uids.add(b.winner_id);
  });
  allPlans.forEach((p) => { if (p.user_id) uids.add(p.user_id); });

  arenaUsers = {};
  const idList = [...uids];
  for (let i = 0; i < idList.length; i += 200) {
    const chunk = idList.slice(i, i + 200);
    const { data } = await sb.from("profiles").select("id, display_name, full_name, email").in("id", chunk);
    (data || []).forEach((u) => { arenaUsers[u.id] = u; });
  }

  document.getElementById("tab-count-mocks").textContent = allMocks.length;
  document.getElementById("tab-count-battles").textContent = allBattles.length;
  document.getElementById("tab-count-plans").textContent = allPlans.length;

  renderMockStats();
  applyMockFilters();
  renderBattleStats();
  applyBattleFilters();
  renderPlans();
  btn.disabled = false;
}

function mockScorePct(m) {
  if (m.score !== null && m.score !== undefined && Number.isFinite(Number(m.score))) return Number(m.score);
  if (m.correct !== null && m.total) return Math.round((Number(m.correct) / Number(m.total)) * 100);
  return null;
}

function renderMockStats() {
  const graded = allMocks.filter((m) => mockScorePct(m) !== null);
  const passed = graded.filter((m) => mockScorePct(m) >= 70);
  const avg = graded.length
    ? Math.round(graded.reduce((s, m) => s + mockScorePct(m), 0) / graded.length) + "%"
    : "—";
  const learners = new Set(allMocks.map((m) => m.user_id).filter(Boolean)).size;

  document.getElementById("mock-total").textContent = allMocks.length.toLocaleString("en-IN");
  document.getElementById("mock-completed").textContent = graded.length.toLocaleString("en-IN");
  document.getElementById("mock-passed").textContent = passed.length.toLocaleString("en-IN");
  document.getElementById("mock-avg-score").textContent = avg;
  document.getElementById("mock-learners").textContent = learners.toLocaleString("en-IN");
}

function applyMockFilters() {
  const search = document.getElementById("mock-search").value.trim().toLowerCase();
  const paper = document.getElementById("mock-filter-paper").value;
  const status = document.getElementById("mock-filter-status").value;

  filteredMocks = allMocks.filter((m) => {
    if (paper !== "all" && m.paper_id !== paper) return false;
    const st = String(m.status || "").toLowerCase();
    if (status === "graded" && !["graded", "submitted", "completed"].includes(st) && mockScorePct(m) === null) return false;
    if (status === "in_progress" && st !== "in_progress") return false;
    if (status === "expired" && !["expired", "late"].includes(st)) return false;
    if (search) {
      const u = arenaUsers[m.user_id] || {};
      const hay = `${m.paper_id || ""} ${u.display_name || ""} ${u.full_name || ""} ${u.email || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("mocks-tbody");
  if (!filteredMocks.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No mock test sittings found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredMocks.slice(0, 150).map((m) => {
    const pct = mockScorePct(m);
    const durMin = m.duration_ms ? `${Math.max(1, Math.round(m.duration_ms / 60000))}m` : "—";
    const scoreText = pct !== null
      ? `<strong>${pct}%</strong> <span class="muted">(${m.correct ?? "?"}/${m.total ?? 25})</span>`
      : "—";
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(m.started_at || m.created_at))}">${escapeHtml(timeAgo(m.started_at || m.created_at))}</td>
      <td><a href="user-detail.html?id=${encodeURIComponent(m.user_id || "")}">${escapeHtml(userLabel(m.user_id))}</a></td>
      <td><span class="tag tag--info">${escapeHtml(m.paper_id || "—")}</span></td>
      <td>${scoreText}</td>
      <td>${m.percentile !== null && m.percentile !== undefined ? `${m.percentile}th` : "—"}</td>
      <td class="muted">${escapeHtml(durMin)}</td>
      <td>${statusBadge(m.status || "in_progress")}</td>
      <td><button class="btn btn--secondary btn--sm" data-view-mock="${escapeHtml(m.id)}">Breakdown</button></td>
    </tr>`;
  }).join("");

  if (tbody.dataset.bound !== "1") {
    tbody.dataset.bound = "1";
    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-view-mock]");
      if (!btn) return;
      const m = allMocks.find((x) => String(x.id) === btn.dataset.viewMock);
      if (!m) return;
      document.getElementById("arena-modal-title").textContent = `${m.paper_id || "Mock"} — ${userLabel(m.user_id)}`;
      document.getElementById("arena-modal-meta").innerHTML =
        `${statusBadge(m.status)} · Score: <strong>${mockScorePct(m) ?? "—"}%</strong> · Started: ${escapeHtml(fmtDateTime(m.started_at))}`;
      document.getElementById("arena-modal-body").textContent = JSON.stringify(m.breakdown || { status: m.status, note: "No topic breakdown recorded for this sitting." }, null, 2);
      document.getElementById("arena-modal").classList.add("is-open");
    });
  }
}

function renderBattleStats() {
  const finished = allBattles.filter((b) => b.status === "finished").length;
  const draws = allBattles.filter((b) => b.is_draw === true).length;
  const live = allBattles.filter((b) => ["waiting", "active", "in_progress"].includes(String(b.status || "").toLowerCase())).length;

  document.getElementById("battle-total").textContent = allBattles.length.toLocaleString("en-IN");
  document.getElementById("battle-finished").textContent = finished.toLocaleString("en-IN");
  document.getElementById("battle-draws").textContent = draws.toLocaleString("en-IN");
  document.getElementById("battle-live").textContent = live.toLocaleString("en-IN");
}

function applyBattleFilters() {
  const search = document.getElementById("battle-search").value.trim().toLowerCase();
  const diff = document.getElementById("battle-filter-diff").value;
  const status = document.getElementById("battle-filter-status").value;

  filteredBattles = allBattles.filter((b) => {
    if (diff !== "all" && String(b.difficulty || "").toLowerCase() !== diff) return false;
    const st = String(b.status || "").toLowerCase();
    if (status === "finished" && st !== "finished") return false;
    if (status === "active" && !["waiting", "active", "in_progress"].includes(st)) return false;
    if (status === "expired" && !["expired", "cancelled", "canceled"].includes(st)) return false;
    if (search) {
      const hay = `${b.id || ""} ${userLabel(b.challenger_id)} ${userLabel(b.opponent_id)}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("battles-tbody");
  if (!filteredBattles.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No battles match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredBattles.slice(0, 150).map((b) => {
    const outcome = b.is_draw
      ? '<span class="tag tag--info">Draw</span>'
      : b.winner_id
        ? `🏆 ${escapeHtml(userLabel(b.winner_id))}`
        : "—";
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(b.created_at))}">${escapeHtml(timeAgo(b.created_at))}</td>
      <td><a href="user-detail.html?id=${encodeURIComponent(b.challenger_id || "")}">${escapeHtml(userLabel(b.challenger_id))}</a></td>
      <td>${b.opponent_id ? `<a href="user-detail.html?id=${encodeURIComponent(b.opponent_id)}">${escapeHtml(userLabel(b.opponent_id))}</a>` : '<span class="muted">No opponent joined</span>'}</td>
      <td><strong>${b.challenger_score ?? 0}</strong> – <strong>${b.opponent_score ?? 0}</strong> <span class="muted">/ ${b.question_count ?? 8}</span></td>
      <td><span class="tag tag--unknown">${escapeHtml(b.difficulty || "mixed")}</span></td>
      <td>${outcome}</td>
      <td>${statusBadge(b.status || "waiting")}</td>
    </tr>`;
  }).join("");
}

function renderPlans() {
  document.getElementById("plan-total").textContent = allPlans.length.toLocaleString("en-IN");
  document.getElementById("plan-with-exam").textContent = allPlans.filter((p) => !!p.exam_date).length.toLocaleString("en-IN");
  document.getElementById("plan-tz-count").textContent = new Set(allPlans.map((p) => p.time_zone).filter(Boolean)).size.toLocaleString("en-IN");

  const tbody = document.getElementById("plans-tbody");
  if (!allPlans.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No saved 45-day study plans yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = allPlans.map((p) => `<tr>
    <td><a href="user-detail.html?id=${encodeURIComponent(p.user_id || "")}">${escapeHtml(userLabel(p.user_id))}</a></td>
    <td>${escapeHtml(p.start_date || "—")}</td>
    <td>${escapeHtml(p.exam_date || "Not set")}</td>
    <td class="mono muted">${escapeHtml(p.time_zone || "UTC")}</td>
    <td>v${escapeHtml(String(p.curriculum_version ?? 1))} · rev ${escapeHtml(String(p.revision ?? 1))}</td>
    <td class="muted">${escapeHtml(timeAgo(p.updated_at || p.created_at))}</td>
  </tr>`).join("");
}

function exportCurrentTab() {
  if (activeArenaTab === "mocks") {
    downloadCSV("pydebug-mock-attempts.csv", filteredMocks.map((m) => ({
      id: m.id,
      learner: userLabel(m.user_id),
      paper: m.paper_id,
      status: m.status,
      score_pct: mockScorePct(m) ?? "",
      correct: m.correct ?? "",
      total: m.total ?? "",
      percentile: m.percentile ?? "",
      started_at: m.started_at,
      submitted_at: m.submitted_at || "",
    })));
  } else if (activeArenaTab === "battles") {
    downloadCSV("pydebug-battles.csv", filteredBattles.map((b) => ({
      id: b.id,
      created_at: b.created_at,
      challenger: userLabel(b.challenger_id),
      opponent: userLabel(b.opponent_id),
      challenger_score: b.challenger_score ?? 0,
      opponent_score: b.opponent_score ?? 0,
      difficulty: b.difficulty,
      status: b.status,
      winner: b.is_draw ? "draw" : userLabel(b.winner_id),
    })));
  } else {
    downloadCSV("pydebug-study-plans.csv", allPlans.map((p) => ({
      learner: userLabel(p.user_id),
      start_date: p.start_date,
      exam_date: p.exam_date || "",
      time_zone: p.time_zone || "",
      curriculum_version: p.curriculum_version ?? 1,
      updated_at: p.updated_at,
    })));
  }
}
