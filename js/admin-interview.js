// admin-interview.js — UI controller for the AI Control Center Interview Studio.
// The heavy challenge engine is lazy-loaded with the other Own-AI modules.

const AdminInterviewStudio = (() => {
  let bound = false;
  const byId = (id) => document.getElementById(id);
  const esc = (value) => escapeHtml(value ?? "");

  function options() {
    return {
      track: byId("ai-interview-track")?.value || "mixed",
      pattern: byId("ai-interview-pattern")?.value || "all",
      difficulty: byId("ai-interview-difficulty")?.value || "mixed",
      status: byId("ai-interview-status")?.value === "published" ? "published" : "draft",
      count: Math.max(1, Math.min(10, Number(byId("ai-interview-count")?.value) || 3)),
    };
  }

  function updateTrackNote() {
    const select = byId("ai-interview-track");
    const note = byId("ai-interview-track-note");
    if (!select || !note || typeof AI_ivTrack !== "function") return;
    const track = AI_ivTrack(select.value);
    note.textContent = track.note + " " + track.coaching;
  }

  function render(settings) {
    const s = settings || {};
    const values = {
      "ai-interview-track": s.interview_track || "mixed",
      "ai-interview-pattern": s.interview_pattern || "all",
      "ai-interview-difficulty": s.interview_difficulty || "mixed",
      "ai-interview-count": String(s.interview_count || 3),
      "ai-interview-status": s.interview_status === "published" ? "published" : "draft",
    };
    Object.entries(values).forEach(([id, value]) => {
      const el = byId(id);
      if (el && [...el.options].some((option) => option.value === value)) el.value = value;
    });
    if (typeof AI_getInterviewLibraryStats === "function") {
      const stats = AI_getInterviewLibraryStats();
      const badge = byId("ai-interview-library");
      if (badge) badge.textContent = `${stats.templates} blueprints · ${stats.patterns} patterns · ${stats.byDifficulty.hard} advanced`;
    }
    updateTrackNote();
  }

  function bind() {
    if (bound || !byId("ai-interview-studio")) return;
    bound = true;
    const savedControls = [
      ["ai-interview-track", "interview_track"],
      ["ai-interview-pattern", "interview_pattern"],
      ["ai-interview-difficulty", "interview_difficulty"],
      ["ai-interview-status", "interview_status"],
    ];
    savedControls.forEach(([id, key]) => {
      byId(id)?.addEventListener("change", (event) => {
        AI_saveSettings({ [key]: event.target.value });
        if (id === "ai-interview-track") updateTrackNote();
      });
    });
    byId("ai-interview-count")?.addEventListener("change", (event) => {
      AI_saveSettings({ interview_count: Math.max(1, Math.min(10, Number(event.target.value) || 3)) });
    });
    byId("ai-btn-interview-preview")?.addEventListener("click", previewNow);
    byId("ai-btn-interview-generate")?.addEventListener("click", generateNow);
    updateTrackNote();
  }

  function friendlyError(error) {
    const message = String((error && error.message) || error || "Unknown error");
    if (/solution_code|test_cases/i.test(message) && /column|schema|could not find/i.test(message)) {
      return "The database is missing Write-Code judge columns. Run db/migrations/20261102_interview_studio.sql in Supabase, then retry. " + message;
    }
    return message;
  }

  async function previewNow() {
    if (typeof AI_previewInterviewProblem !== "function") {
      showToast("Interview engine did not load. Refresh and try again.", "error");
      return;
    }
    setBusy("ai-btn-interview-preview", true);
    try {
      const result = await AI_previewInterviewProblem(options());
      if (!result || !result.problem) throw new Error("No valid challenge could be prepared. Try a broader pattern or difficulty.");
      renderPreview(result);
      const failed = (result.checks || []).filter((check) => !check.pass).length;
      showToast(failed ? `Preview has ${failed} failed quality check(s); it will not be published.` : "Full challenge preview ready — all quality checks passed.", failed ? "error" : "success");
    } catch (error) {
      showToast("Preview failed: " + friendlyError(error), "error");
    } finally {
      setBusy("ai-btn-interview-preview", false, "👁️ Preview full challenge");
    }
  }

  async function generateNow() {
    if (typeof AI_generateInterviewProblems !== "function") {
      showToast("Interview engine did not load. Refresh and try again.", "error");
      return;
    }
    const opts = options();
    const mode = opts.status === "published" ? "PUBLISH for users" : "save as DRAFT";
    if (!confirm(`Generate ${opts.count} validated interview challenge(s) and ${mode}?\n\nEvery accepted challenge includes a reference solution and at least 8 functional tests.`)) return;
    setBusy("ai-btn-interview-generate", true);
    const resultBox = byId("ai-interview-result");
    if (resultBox) resultBox.innerHTML = "";
    try {
      const result = await AI_generateInterviewProblems(opts.count, opts);
      const added = result.added || [];
      const insertErrors = result.errors || [];
      const noAddReason = insertErrors.length
        ? `Database insert failed: ${friendlyError(insertErrors[0].message)}`
        : `${result.skipped || 0} candidate(s) were duplicates or failed validation. Try another pattern/difficulty or preview first.`;
      if (resultBox) {
        resultBox.innerHTML = added.length ? `
          <div class="ai-interview-result__summary"><strong>✅ ${added.length} challenge(s) saved${result.skipped ? ` · ${result.skipped} skipped` : ""}</strong><span>${opts.status === "published" ? "Published and ready for learner practice." : "Drafts are private until you review and publish them."}</span></div>
          <ul>${added.map((p) => `<li><span>#${esc(p.problem_number)} ${esc(p.title)}</span><small>${esc(p.test_cases?.length || 0)} tests · ${esc(p.difficulty)} · ${esc(p.status)}${p.is_premium ? " · ⭐ Premium" : ""}</small></li>`).join("")}</ul>
          ${insertErrors.length ? `<p class="ai-interview-disclaimer">Some inserts failed: ${esc(friendlyError(insertErrors[0].message))}</p>` : ""}
        ` : `<div class="ai-interview-result__summary ai-interview-result__summary--warn"><strong>No new challenge inserted</strong><span>${esc(noAddReason)}</span></div>`;
      }
      if (insertErrors.length) showToast("Interview insert error: " + friendlyError(insertErrors[0].message), "error");
      else showToast(`Interview set: ${added.length} added${result.skipped ? `, ${result.skipped} skipped` : ""}`, added.length ? "success" : "info");
      renderLogs();
      refreshStats();
    } catch (error) {
      showToast("Interview generation failed: " + friendlyError(error), "error");
    } finally {
      setBusy("ai-btn-interview-generate", false, "🚀 Generate interview set");
    }
  }

  function renderPreview(result) {
    const p = result.problem;
    const box = byId("ai-interview-preview");
    if (!box) return;
    const tests = Array.isArray(p.test_cases) ? p.test_cases : [];
    const checks = result.checks || [];
    box.innerHTML = `
      <div class="ai-interview-preview__top">
        <div><span class="ai-interview-kicker">ADMIN PREVIEW · NOT SAVED</span><h3>${esc(p.title)}</h3></div>
        <div class="ai-interview-quality ${result.score === 100 ? "is-perfect" : ""}"><strong>${esc(result.score)}%</strong><span>quality contract</span></div>
      </div>
      <div class="ai-preview__head">
        <span class="tag tag--info">Write Code</span>
        <span class="diff diff--${esc(p.difficulty)}">${esc(p.difficulty)}</span>
        <span class="tag tag--unknown">${esc(p.pattern_label)}</span>
        <span class="tag tag--unknown">${esc(p.track_label)}</span>
      </div>
      <pre class="ai-interview-statement">${esc(p.description)}</pre>

      <div class="ai-interview-code-grid">
        <div><div class="ai-preview__label">Learner scaffold</div><pre class="code-block">${esc(p.starter_code)}</pre></div>
        <div><div class="ai-preview__label">Sample expected value</div><pre class="code-block">${esc(p.expected_output)}</pre><div class="ai-interview-target"><span>Time <strong>${esc(p.time_target)}</strong></span><span>Space <strong>${esc(p.space_target)}</strong></span></div></div>
      </div>

      <div class="ai-interview-preview__section"><div class="ai-preview__label">Progressive hints · reveal one at a time</div><ol class="ai-hints">${p.hints.map((hint) => `<li>${esc(hint)}</li>`).join("")}</ol></div>

      <details class="ai-interview-details" open>
        <summary>Functional judge suite <span>${tests.length} tests · first ${esc(p.public_test_count)} are statement samples</span></summary>
        <div class="admin-table-wrap ai-interview-test-wrap"><table class="admin-table"><thead><tr><th>Case</th><th>Function call</th><th>Expected</th></tr></thead><tbody>
          ${tests.map((test, index) => `<tr><td><span class="ai-interview-case ${index < p.public_test_count ? "is-sample" : ""}">${index < p.public_test_count ? `Sample ${index + 1}` : `Hidden ${index - p.public_test_count + 1}`}</span></td><td><code>${esc(test.call)}</code></td><td><code>${esc(test.expected === "" ? "'' (empty string)" : test.expected)}</code></td></tr>`).join("")}
        </tbody></table></div>
        <div class="ai-interview-edge-list"><strong>Explicit edge coverage:</strong>${p.edge_cases.map((edge) => `<span>✓ ${esc(edge)}</span>`).join("")}</div>
      </details>

      <details class="ai-interview-details">
        <summary>Reference solution &amp; interviewer rubric <span>admin only</span></summary>
        <div class="ai-preview__label">Independent Python reference</div><pre class="code-block">${esc(p.solution_code)}</pre>
        <div class="ai-interview-rubric">${p.rubric.map((item) => `<div><strong>${esc(item.label)} <span>${esc(item.weight)} pts</span></strong><p>${esc(item.detail)}</p></div>`).join("")}</div>
        <div class="ai-preview__label">Interviewer follow-ups</div><ol class="ai-hints">${p.followups.map((item) => `<li>${esc(item)}</li>`).join("")}</ol>
      </details>

      <div class="ai-interview-preview__section"><div class="ai-preview__label">Pre-insert quality checklist</div><ul class="ai-checks ai-interview-checks">${checks.map((check) => `<li class="${check.pass ? "pass" : "fail"}">${check.pass ? "✅" : "❌"} ${esc(check.label)}</li>`).join("")}</ul></div>
      <p class="ai-interview-proof">Blueprint <code>${esc(result.templateId)}</code> · ${esc(p.proof)} Preview does not insert anything.</p>
    `;
    box.style.display = "";
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return { render, bind };
})();
