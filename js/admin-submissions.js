// admin-submissions.js — monitor every user's progress.
//
// Exact user-panel schema: one row per (user, problem) with
// status ('attempted' | 'solved'), the saved solved `code`, solved_at,
// created_at. There is NO per-submission XP column — XP lives on profiles.

let allSubmissions = [];
let filteredSubmissions = [];
let userMap = {};
let problemMap = {};
const PAGE_SIZE = 100;
let visibleCount = PAGE_SIZE;

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  await loadSubmissions();

  document.getElementById("submission-search").addEventListener("input", debounce(applySubmissionFilters, 300));
  document.getElementById("submission-filter-status").addEventListener("change", applySubmissionFilters);
  document.getElementById("submissions-load-more").addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    renderSubmissions();
  });
  document.getElementById("export-submissions-btn").addEventListener("click", exportSubmissions);

  document.getElementById("submission-modal-close").addEventListener("click", closeSubmissionModal);
  document.getElementById("submission-modal").addEventListener("click", (e) => {
    if (e.target.id === "submission-modal") closeSubmissionModal();
  });
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function displayNameOf(u) {
  return u.display_name || u.full_name || u.email || "—";
}

function isSolvedRow(s) {
  return String(s.status || "").toLowerCase() === "solved";
}

async function loadSubmissions() {
  const tbody = document.getElementById("submissions-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Loading submissions...</td></tr>`;

  const { data, error } = await sb
    .from("submissions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Could not load submissions.</td></tr>`;
    document.getElementById("submissions-hint").innerHTML =
      `<div class="admin-hint">Couldn't read the <code>submissions</code> table (${escapeHtml(error.message)}). ` +
      `Run <code>supabase-admin-setup.sql</code> in Supabase → SQL Editor so admins can read all submissions, then reload.</div>`;
    return;
  }

  allSubmissions = data || [];
  await buildLookupMaps();
  renderSubmissionStats();
  applySubmissionFilters();
}

async function buildLookupMaps() {
  userMap = {};
  problemMap = {};
  const userIds = [...new Set(allSubmissions.map((s) => s.user_id).filter(Boolean))];
  const problemIds = [...new Set(allSubmissions.map((s) => s.problem_id).filter(Boolean))];

  if (userIds.length) {
    const { data } = await sb.from("profiles").select("id, display_name, full_name, email").in("id", userIds);
    (data || []).forEach((u) => { userMap[u.id] = u; });
  }
  if (problemIds.length) {
    const { data } = await sb.from("problems").select("id, title, type, difficulty").in("id", problemIds);
    (data || []).forEach((p) => { problemMap[p.id] = p; });
  }
}

function renderSubmissionStats() {
  const total = allSubmissions.length;
  const solved = allSubmissions.filter(isSolvedRow).length;
  const today = new Date().toISOString().slice(0, 10);
  const solvedToday = allSubmissions.filter((s) => isSolvedRow(s) && (s.solved_at || "").slice(0, 10) === today).length;
  document.getElementById("sub-total").textContent = total >= 1000 ? "1000+" : total;
  document.getElementById("sub-total-sub").textContent = total >= 1000 ? "showing latest 1000" : "one row per user × problem";
  document.getElementById("sub-solved").textContent = solved;
  document.getElementById("sub-rate").textContent = total ? Math.round((solved / total) * 100) + "%" : "0%";
  document.getElementById("sub-today").textContent = solvedToday;
}

function applySubmissionFilters() {
  const search = document.getElementById("submission-search").value.trim().toLowerCase();
  const status = document.getElementById("submission-filter-status").value;

  filteredSubmissions = allSubmissions.filter((s) => {
    if (status === "solved" && !isSolvedRow(s)) return false;
    if (status === "attempted" && isSolvedRow(s)) return false;
    if (search) {
      const u = userMap[s.user_id] || {};
      const p = problemMap[s.problem_id] || {};
      const hay = `${u.email || ""} ${u.display_name || ""} ${u.full_name || ""} ${p.title || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  visibleCount = PAGE_SIZE;
  renderSubmissions();
}

function renderSubmissions() {
  const tbody = document.getElementById("submissions-tbody");
  tbody.innerHTML = "";

  if (!filteredSubmissions.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No submissions found.</td></tr>`;
    document.getElementById("submissions-load-more").style.display = "none";
    return;
  }

  filteredSubmissions.slice(0, visibleCount).forEach((s) => {
    const u = userMap[s.user_id] || {};
    const p = problemMap[s.problem_id] || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="muted" title="${escapeHtml(fmtDateTime(s.created_at))}">${escapeHtml(timeAgo(s.created_at))}</td>
      <td>${escapeHtml(displayNameOf(u))}</td>
      <td>${escapeHtml(p.title || "—")}</td>
      <td>${statusBadge(s.status || "attempted")}</td>
      <td class="muted" title="${escapeHtml(fmtDateTime(s.solved_at))}">${s.solved_at ? escapeHtml(timeAgo(s.solved_at)) : "—"}</td>
      <td class="row-actions">
        <button class="btn btn--secondary btn--sm" data-view-sub="${s.id}">View</button>
        <button class="btn btn--danger btn--sm" data-del-sub="${s.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-view-sub]").forEach((btn) =>
    btn.addEventListener("click", () => openSubmissionModal(btn.dataset.viewSub))
  );
  tbody.querySelectorAll("[data-del-sub]").forEach((btn) =>
    btn.addEventListener("click", () => deleteSubmission(btn.dataset.delSub, btn))
  );

  document.getElementById("submissions-load-more").style.display =
    filteredSubmissions.length > visibleCount ? "" : "none";
}

function openSubmissionModal(id) {
  const s = allSubmissions.find((x) => String(x.id) === String(id));
  if (!s) return;
  const u = userMap[s.user_id] || {};
  const p = problemMap[s.problem_id] || {};
  document.getElementById("submission-modal-title").textContent = p.title || "Submission";
  document.getElementById("submission-modal-meta").innerHTML =
    `${statusBadge(s.status || "attempted")}` +
    `<span>${escapeHtml(u.email || displayNameOf(u))}</span>` +
    (s.solved_at ? `<span>Solved ${escapeHtml(timeAgo(s.solved_at))}</span>` : `<span>Started ${escapeHtml(timeAgo(s.created_at))}</span>`);
  document.getElementById("submission-modal-code").textContent = s.code || "(no saved code — only solved bug-fixes store code)";
  document.getElementById("submission-modal").classList.add("open");
}

function closeSubmissionModal() {
  document.getElementById("submission-modal").classList.remove("open");
}

async function deleteSubmission(id, btn) {
  if (!confirm("Delete this submission? The user will lose this progress row (their XP stays).")) return;
  btn.disabled = true;
  const { error } = await sb.from("submissions").delete().eq("id", id);
  if (error) {
    showToast("Could not delete: " + error.message + " (run supabase-admin-setup.sql?)", "error");
    btn.disabled = false;
    return;
  }
  showToast("Submission deleted", "success");
  allSubmissions = allSubmissions.filter((s) => String(s.id) !== String(id));
  renderSubmissionStats();
  applySubmissionFilters();
}

function exportSubmissions() {
  const rows = filteredSubmissions.map((s) => ({
    id: s.id,
    started: s.created_at,
    solved_at: s.solved_at || "",
    user: (userMap[s.user_id] || {}).email || s.user_id,
    problem: (problemMap[s.problem_id] || {}).title || s.problem_id,
    status: s.status || "attempted",
  }));
  downloadCSV("pydebug-submissions.csv", rows);
}
