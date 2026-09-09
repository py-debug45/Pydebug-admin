// admin-submissions.js — monitor every user's code submissions.
//
// Defensive by design: column names are auto-detected from the first row, so
// small schema differences in the user panel won't break this page.

let allSubmissions = [];
let filteredSubmissions = [];
let userMap = {};
let problemMap = {};
let subCols = { status: "status", xp: "xp_earned", code: "code", output: "output" };
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

  // Auto-detect column names from the first row.
  const sample = allSubmissions[0];
  subCols = {
    status: detectCol(sample, ["status", "result", "verdict"]),
    xp: detectCol(sample, ["xp_earned", "xp", "xp_awarded"]),
    code: detectCol(sample, ["code", "submitted_code", "user_code", "answer"]),
    output: detectCol(sample, ["output", "actual_output", "result_output", "stdout"]),
  };

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
    const { data } = await sb.from("profiles").select("id, full_name, email").in("id", userIds);
    (data || []).forEach((u) => { userMap[u.id] = u; });
  }
  if (problemIds.length) {
    const { data } = await sb.from("problems").select("id, title, type, difficulty").in("id", problemIds);
    (data || []).forEach((p) => { problemMap[p.id] = p; });
  }
}

function isSolvedRow(s) {
  const v = String(s[subCols.status] ?? "").toLowerCase();
  if (["solved", "success", "correct", "passed", "true", "1"].includes(v)) return true;
  if (typeof s.is_correct === "boolean") return s.is_correct;
  return false;
}

function renderSubmissionStats() {
  const total = allSubmissions.length;
  const solved = allSubmissions.filter(isSolvedRow).length;
  const xp = allSubmissions.reduce((sum, s) => sum + (Number(s[subCols.xp]) || 0), 0);
  document.getElementById("sub-total").textContent = total >= 1000 ? "1000+" : total;
  document.getElementById("sub-total-sub").textContent = total >= 1000 ? "showing latest 1000" : "";
  document.getElementById("sub-solved").textContent = solved;
  document.getElementById("sub-rate").textContent = total ? Math.round((solved / total) * 100) + "%" : "0%";
  document.getElementById("sub-xp").textContent = xp.toLocaleString("en-IN");
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
      const hay = `${u.email || ""} ${u.full_name || ""} ${p.title || ""}`.toLowerCase();
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
      <td>${escapeHtml(u.email || u.full_name || "—")}</td>
      <td>${escapeHtml(p.title || "—")}</td>
      <td>${statusBadge(isSolvedRow(s) ? "solved" : (s[subCols.status] || "attempted"))}</td>
      <td>${Number(s[subCols.xp]) || 0}</td>
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
    `${statusBadge(isSolvedRow(s) ? "solved" : (s[subCols.status] || "attempted"))}` +
    `<span>${escapeHtml(u.email || u.full_name || "Unknown user")}</span>` +
    `<span>XP: ${Number(s[subCols.xp]) || 0}</span>` +
    `<span>${escapeHtml(fmtDateTime(s.created_at))}</span>`;
  document.getElementById("submission-modal-code").textContent = s[subCols.code] || "(no code stored on this row)";
  document.getElementById("submission-modal-output").textContent = s[subCols.output] || "(no output stored on this row)";
  document.getElementById("submission-modal").classList.add("open");
}

function closeSubmissionModal() {
  document.getElementById("submission-modal").classList.remove("open");
}

async function deleteSubmission(id, btn) {
  if (!confirm("Delete this submission? This can't be undone.")) return;
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
    date: s.created_at,
    user: (userMap[s.user_id] || {}).email || s.user_id,
    problem: (problemMap[s.problem_id] || {}).title || s.problem_id,
    status: isSolvedRow(s) ? "solved" : (s[subCols.status] || "attempted"),
    xp: Number(s[subCols.xp]) || 0,
  }));
  downloadCSV("pydebug-submissions.csv", rows);
}
