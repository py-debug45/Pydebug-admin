// admin-ai.js — controller for ai.html (AI Control Center).

document.addEventListener("DOMContentLoaded", async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  const settings = await AI_pullSettings();
  renderAll(settings);
  bindControls();
  refreshStats();
  renderLogs();
  initReports();
});

function renderAll(s) {
  // Master switch
  const master = document.getElementById("ai-master");
  master.checked = !!s.master;
  paintMasterState(s.master);

  // Module toggles
  setToggle("ai-mod", s.moderation);
  setToggle("ai-warn", s.warn_user);
  setToggle("ai-autoproblems", s.auto_problems);
  setToggle("ai-dedup", s.dedup);
  setToggle("ai-announce", s.announce);
  setToggle("ai-welcome", s.welcome);

  // Factory settings
  document.getElementById("ai-per-run").value = String(s.per_run || 3);
  document.getElementById("ai-hours").value = String(s.auto_hours || 12);
  document.getElementById("ai-mix").value = s.mix || "both";
  document.getElementById("ai-difficulty").value = s.difficulty || "mixed";
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  if (el) el.checked = !!on;
}

function paintMasterState(on) {
  const card = document.getElementById("ai-master-card");
  const label = document.getElementById("ai-master-label");
  if (card) card.classList.toggle("ai-master--on", !!on);
  if (label) {
    label.textContent = on ? "ON — AI is watching your panel" : "OFF — AI is sleeping";
    label.className = "ai-master-state " + (on ? "ai-master-state--on" : "ai-master-state--off");
  }
}

function bindControls() {
  document.getElementById("ai-master").addEventListener("change", (e) => {
    const s = AI_saveSettings({ master: e.target.checked });
    paintMasterState(s.master);
    AI_log(s.master ? "ai_enabled" : "ai_disabled", s.master ? "Master switch turned ON." : "Master switch turned OFF.", s.master ? "success" : "warn");
    renderLogs();
    refreshStats();
    showToast(s.master ? "🤖 Own-AI is now ON" : "Own-AI is now OFF", s.master ? "success" : "info");
  });

  const toggles = [
    ["ai-mod", "moderation", "Discussion moderation"],
    ["ai-warn", "warn_user", "Offender warnings"],
    ["ai-autoproblems", "auto_problems", "Auto problem factory"],
    ["ai-dedup", "dedup", "Duplicate guard"],
    ["ai-announce", "announce", "New-problem announcements"],
    ["ai-welcome", "welcome", "Welcome messages"],
  ];
  toggles.forEach(([id, key, label]) => {
    document.getElementById(id).addEventListener("change", (e) => {
      AI_saveSettings({ [key]: e.target.checked });
      AI_log("setting_changed", `${label} → ${e.target.checked ? "ON" : "OFF"}.`, "info");
      renderLogs();
      showToast(`${label} ${e.target.checked ? "enabled" : "disabled"}`, "info");
    });
  });

  document.getElementById("ai-per-run").addEventListener("change", (e) => {
    AI_saveSettings({ per_run: Math.max(1, Math.min(20, Number(e.target.value) || 3)) });
    showToast("Problems per run saved", "success");
  });
  document.getElementById("ai-hours").addEventListener("change", (e) => {
    AI_saveSettings({ auto_hours: Math.max(1, Math.min(72, Number(e.target.value) || 12)) });
    showToast("Auto-generate interval saved", "success");
  });
  document.getElementById("ai-mix").addEventListener("change", (e) => {
    AI_saveSettings({ mix: e.target.value });
    showToast("Problem mix saved", "success");
  });
  document.getElementById("ai-difficulty").addEventListener("change", (e) => {
    AI_saveSettings({ difficulty: e.target.value });
    showToast("Difficulty saved", "success");
  });

  // Action buttons
  document.getElementById("ai-btn-scan").addEventListener("click", runModerationNow);
  document.getElementById("ai-btn-generate").addEventListener("click", generateNow);
  document.getElementById("ai-btn-preview").addEventListener("click", previewNow);
  document.getElementById("ai-btn-dedup").addEventListener("click", dedupNow);
  document.getElementById("ai-btn-welcome").addEventListener("click", welcomeNow);
  document.getElementById("ai-btn-test").addEventListener("click", testModeration);
  document.getElementById("ai-btn-clear-log").addEventListener("click", () => {
    if (!confirm("Clear the AI activity log on this device?")) return;
    AI_clearLogs();
    renderLogs();
    refreshStats();
  });
}

function setBusy(btnId, busy, idleText) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (busy) {
    btn.dataset.idle = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Working...";
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.idle || idleText || btn.textContent;
  }
}

async function runModerationNow() {
  setBusy("ai-btn-scan", true);
  try {
    const r = await AI_runModeration({ auto: false });
    showToast(`Scan done: ${r.scanned} checked, ${r.removed} removed, ${r.warned} warned`, r.removed ? "info" : "success");
  } catch (e) {
    showToast("Scan failed: " + e.message, "error");
  }
  setBusy("ai-btn-scan", false, "🔍 Scan discussions now");
  renderLogs();
  refreshStats();
}

async function generateNow() {
  const n = Math.max(1, Math.min(20, Number(document.getElementById("ai-per-run").value) || 3));
  if (!confirm(`Generate ${n} new verified problem(s) now?`)) return;
  setBusy("ai-btn-generate", true);
  try {
    const r = await AI_generateProblems(n, { auto: false });
    showToast(`Added ${r.added.length} problem(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ""}`, r.added.length ? "success" : "info");
  } catch (e) {
    showToast("Generation failed: " + e.message, "error");
  }
  setBusy("ai-btn-generate", false, "⚙️ Generate problems now");
  renderLogs();
  refreshStats();
}

async function previewNow() {
  setBusy("ai-btn-preview", true);
  try {
    const { problem: p, templateId, checks } = await AI_previewProblem();
    const box = document.getElementById("ai-preview");
    const esc = (v) => escapeHtml(v);
    box.innerHTML = `
      <div class="ai-preview__head">
        <strong>${esc(p.title)}</strong>
        <span class="tag tag--${p.type === "bug" ? "bug" : "question"}">${p.type === "bug" ? "Fix the Bug" : "Predict Output"}</span>
        <span class="diff diff--${esc(p.difficulty)}">${esc(p.difficulty)}</span>
        <span class="tag tag--unknown">${esc(p.topic)}</span>
      </div>
      <p class="muted">${esc(p.description)}</p>
      <div class="ai-preview__grid">
        <div>
          <div class="ai-preview__label">${p.type === "bug" ? "🐞 Buggy code (shown to user)" : "📄 Code (shown to user)"}</div>
          <pre class="code-block">${esc(p.starter_code)}</pre>
        </div>
        <div>
          <div class="ai-preview__label">✅ Expected output (computed, exact)</div>
          <pre class="code-block">${esc(p.expected_output)}</pre>
        </div>
      </div>
      ${p.type === "bug" && p.fixed_code ? `
      <div class="ai-preview__label">🔧 Fixed reference code (admin only — proves the bug is real)</div>
      <pre class="code-block">${esc(p.fixed_code)}</pre>
      <p class="muted" style="font-size:0.82rem">Bug type: <strong>${esc(p.bug || "verified")}</strong> · Wrong snippet: <code>${esc(p.marker || "")}</code> · Proof: ${esc(p.proof || "")}</p>
      ` : `<p class="muted" style="font-size:0.82rem">Proof: ${esc(p.proof || "")}</p>`}
      <div class="ai-preview__label">💡 Hints (exactly 3)</div>
      <ol class="ai-hints">${p.hints.map((h) => `<li>${esc(h)}</li>`).join("")}</ol>
      <div class="ai-preview__label">✔️ Validation checklist</div>
      <ul class="ai-checks">${checks.map((c) => `<li class="${c.pass ? "pass" : "fail"}">${c.pass ? "✅" : "❌"} ${esc(c.label)}</li>`).join("")}</ul>
      <p class="muted" style="font-size:0.8rem">Template: <code>${esc(templateId)}</code> · Not saved — press "Generate problems now" to insert verified problems.</p>
    `;
    box.style.display = "";
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    showToast("Preview failed: " + e.message, "error");
  }
  setBusy("ai-btn-preview", false, "👁️ Preview a problem");
}

async function dedupNow() {
  if (!confirm("Find and delete duplicate problems? The oldest copy of each is always kept.")) return;
  setBusy("ai-btn-dedup", true);
  try {
    const r = await AI_runDedup({ auto: false });
    showToast(`Checked ${r.scanned}: ${r.groups} duplicate group(s), removed ${r.removed.length}`, r.removed.length ? "info" : "success");
  } catch (e) {
    showToast("Dedup failed: " + e.message, "error");
  }
  setBusy("ai-btn-dedup", false, "🧹 Remove duplicates now");
  renderLogs();
  refreshStats();
}

async function welcomeNow() {
  setBusy("ai-btn-welcome", true);
  try {
    const r = await AI_runWelcome({ auto: false });
    showToast(`${r.found} new user(s) found, ${r.welcomed} welcomed`, "success");
  } catch (e) {
    showToast("Welcome run failed: " + e.message, "error");
  }
  setBusy("ai-btn-welcome", false, "👋 Welcome new users now");
  renderLogs();
  refreshStats();
}

function testModeration() {
  const text = document.getElementById("ai-test-input").value;
  const out = document.getElementById("ai-test-result");
  if (!text.trim()) {
    out.innerHTML = `<span class="muted">Type something first.</span>`;
    return;
  }
  const r = AI_scanText(text);
  if (!r.flagged) {
    out.innerHTML = `<span class="tag tag--solved">✅ Clean</span> <span class="muted">No abusive, rude or spam content detected.</span>`;
  } else {
    const label = r.severity === "spam" ? "SPAM — would delete + warn" : r.severity === "severe" ? "ABUSIVE — would delete + warn" : "RUDE — would delete + soft-warn";
    out.innerHTML = `<span class="tag tag--failed">⚠️ ${escapeHtml(label)}</span>
      <div class="muted" style="margin-top:6px">Matched: <code>${escapeHtml(r.hits.join(", "))}</code></div>`;
  }
}

function refreshStats() {
  const st = AI_getStats();
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("ai-stat-removed", st.commentsRemoved);
  set("ai-stat-warned", st.warningsSent);
  set("ai-stat-added", st.problemsAdded);
  set("ai-stat-dups", st.duplicatesRemoved);
  const fmt = (ts) => (ts ? timeAgo(new Date(ts).toISOString()) : "never");
  set("ai-last-mod", "every minute while ON");
  set("ai-last-dedup", fmt(st.lastRuns.dedup));
  set("ai-last-gen", fmt(st.lastRuns.problems));
  set("ai-last-welcome", fmt(st.lastRuns.welcome));
}

function renderLogs() {
  const tbody = document.getElementById("ai-log-tbody");
  if (!tbody) return;
  const logs = AI_getLogs();
  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-row">No AI activity yet — turn the master switch ON or run an action above.</td></tr>`;
    return;
  }
  const lvlBadge = (lvl) => {
    if (lvl === "success") return '<span class="tag tag--solved">ok</span>';
    if (lvl === "warn") return '<span class="tag tag--attempted">action</span>';
    if (lvl === "error") return '<span class="tag tag--failed">error</span>';
    return '<span class="tag tag--unknown">info</span>';
  };
  tbody.innerHTML = logs.slice(0, 100).map((l) => `
    <tr>
      <td class="muted" style="white-space:nowrap" title="${escapeHtml(fmtDateTime(l.t))}">${escapeHtml(timeAgo(l.t))}</td>
      <td>${lvlBadge(l.level)}</td>
      <td><strong>${escapeHtml(l.action)}</strong> — ${escapeHtml(l.detail)}</td>
    </tr>
  `).join("");
}

/* ================= Reports bundle UI ================= */

let AIUI_calibCache = [];

function initReports() {
  renderDigestCached();
  const bD = document.getElementById("ai-btn-digest");
  if (bD) bD.addEventListener("click", buildDigestNow);
  const bH = document.getElementById("ai-btn-health");
  if (bH) bH.addEventListener("click", () => refreshHealth(true));
  const bC = document.getElementById("ai-btn-calib");
  if (bC) bC.addEventListener("click", () => refreshCalibration(true));

  const hList = document.getElementById("ai-health-list");
  if (hList) hList.addEventListener("click", onHealthFix);
  const cBody = document.getElementById("ai-calib-body");
  if (cBody) cBody.addEventListener("click", onCalibClick);

  refreshHealth(false);
  refreshCalibration(false);
}

/* ---- Daily digest ---- */

async function renderDigestCached() {
  const body = document.getElementById("ai-digest-body");
  if (!body) return;
  try {
    const d = await AI_getDigest();
    if (d && d.stats) renderDigest(d, true);
    else body.innerHTML = `<p class="muted">No digest yet — press "↻ Generate fresh" to build one.</p>`;
  } catch (e) {
    body.innerHTML = `<p class="muted">No digest yet — press "↻ Generate fresh" to build one.</p>`;
  }
}

function renderDigest(d, cached) {
  const body = document.getElementById("ai-digest-body");
  if (!body) return;
  const s = d.stats || {};
  const num = (v) => (v === null || v === undefined ? "—" : v);
  const chip = (label, v) => `<span class="ai-chip">${label}: <strong>${num(v)}</strong></span>`;
  body.innerHTML = `
    <div class="ai-digest-chips">
      ${chip("👥 Users", s.totalUsers)}
      ${chip("🎉 New (24h)", s.newUsers)}
      ${chip("📝 Problems", s.totalProblems)}
      ${chip("⚡ Submissions (24h)", s.subs24)}
      ${chip("✅ Solve rate", s.solveRate === null || s.solveRate === undefined ? "—" : s.solveRate + "%")}
      ${chip("💬 Comments (24h)", s.comments24)}
      ${chip("🛡️ Removed (24h)", s.removed24)}
      ${chip("🤖 AI-added (24h)", s.added24)}
    </div>
    <ul class="ai-highlights">${(d.highlights || []).map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>
    <p class="muted" style="font-size:0.8rem;margin-bottom:0">Generated ${escapeHtml(timeAgo(d.generated_at))}${cached ? " (refresh for latest)" : ""} · Auto-rebuilds daily while the Guard is ON.</p>
  `;
}

async function buildDigestNow() {
  const body = document.getElementById("ai-digest-body");
  const btn = document.getElementById("ai-btn-digest");
  if (btn) { btn.disabled = true; btn.textContent = "Building..."; }
  if (body) body.innerHTML = `<p class="muted">Gathering stats...</p>`;
  try {
    const d = await AI_buildDigest();
    renderDigest(d, false);
    renderLogs();
    showToast("Digest built", "success");
  } catch (e) {
    if (body) body.innerHTML = `<p class="muted">Could not build digest: ${escapeHtml(e.message)}</p>`;
    showToast("Digest failed: " + e.message, "error");
  }
  if (btn) { btn.disabled = false; btn.textContent = "↻ Generate fresh"; }
}

/* ---- Health score ---- */

async function refreshHealth(manual) {
  const wrap = document.getElementById("ai-health-body");
  const list = document.getElementById("ai-health-list");
  const btn = document.getElementById("ai-btn-health");
  if (btn) { btn.disabled = true; btn.textContent = "Checking..."; }
  if (wrap) wrap.innerHTML = `<p class="muted">Running health checks...</p>`;
  if (list) list.innerHTML = "";
  try {
    const h = await AI_healthCheck();
    const color = h.score >= 85 ? "#2ecc71" : h.score >= 65 ? "#e3b341" : "#e74c3c";
    const verdict = h.score >= 85 ? "Excellent" : h.score >= 65 ? "Fair" : "Needs attention";
    if (wrap) {
      wrap.innerHTML = `
        <div style="font-size:1.6rem;font-weight:800">${h.score}<span class="muted" style="font-size:0.9rem">/100 · ${verdict}</span></div>
        <div class="ai-health-scorebar"><div style="width:${h.score}%;background:${color}"></div></div>
        <div class="muted" style="font-size:0.8rem">Checked ${escapeHtml(timeAgo(h.generated_at))}</div>
      `;
    }
    if (list) {
      const icon = { ok: "✅", warn: "⚠️", bad: "🔴" };
      const fixLabel = { dedup: "Fix: remove", moderation: "Fix: scan", factory: "Fix: generate 3", "factory-hard": "Fix: 3 hard", discussions: "Open", hints: "Review", broadcast: "Open" };
      list.innerHTML = h.checks.map((c) => `
        <li class="${c.status === "ok" ? "pass" : c.status === "bad" ? "fail" : ""}">
          <span>${icon[c.status] || "•"} <strong>${escapeHtml(c.label)}</strong> — ${escapeHtml(c.detail)}</span>
          ${c.fix ? `<button class="btn btn--secondary btn--sm ai-fix-btn" data-fix="${escapeHtml(c.fix.id)}">${escapeHtml(fixLabel[c.fix.id] || "Fix")}</button>` : ""}
        </li>
      `).join("");
    }
    if (manual) showToast(`Health score: ${h.score}/100`, "success");
  } catch (e) {
    if (wrap) wrap.innerHTML = `<p class="muted">Health check failed: ${escapeHtml(e.message)}</p>`;
    if (manual) showToast("Health check failed: " + e.message, "error");
  }
  if (btn) { btn.disabled = false; btn.textContent = "↻ Recheck"; }
}

async function onHealthFix(e) {
  const btn = e.target.closest("[data-fix]");
  if (!btn) return;
  const fix = btn.dataset.fix;
  btn.disabled = true;
  try {
    if (fix === "dedup") {
      const r = await AI_runDedup({ auto: false });
      showToast(`Removed ${r.removed.length} duplicate(s)`, "success");
    } else if (fix === "moderation") {
      const r = await AI_runModeration({ auto: false });
      showToast(`Removed ${r.removed} comment(s), warned ${r.warned}`, "success");
    } else if (fix === "factory") {
      const r = await AI_generateProblems(3, { auto: false });
      showToast(`Added ${r.added.length} problem(s)`, "success");
    } else if (fix === "factory-hard") {
      const r = await AI_generateProblems(3, { auto: false, difficulty: "hard" });
      showToast(`Added ${r.added.length} hard problem(s)`, "success");
    } else if (fix === "discussions") {
      window.location.href = "discussions.html";
      return;
    } else if (fix === "hints") {
      window.location.href = "dashboard.html";
      return;
    } else if (fix === "broadcast") {
      window.location.href = "notifications.html";
      return;
    }
  } catch (err) {
    showToast("Fix failed: " + err.message, "error");
  }
  renderLogs();
  refreshStats();
  refreshHealth(true);
}

/* ---- Difficulty calibration ---- */

async function refreshCalibration(manual) {
  const body = document.getElementById("ai-calib-body");
  const btn = document.getElementById("ai-btn-calib");
  if (btn) { btn.disabled = true; btn.textContent = "Analysing..."; }
  if (body) body.innerHTML = `<p class="muted">Analysing solve rates...</p>`;
  try {
    const { suggestions, judged } = await AI_calibration();
    AIUI_calibCache = suggestions;
    if (!suggestions.length) {
      if (body) body.innerHTML = `<p class="muted">${judged ? `Checked ${judged} problem(s) with 8+ attempts — all difficulties look right. ✅` : "Not enough submission data yet (needs 8+ attempts per problem)."}</p>`;
    } else if (body) {
      body.innerHTML = `
        <p class="muted" style="font-size:0.85rem">${suggestions.length} suggestion(s) from ${judged} judged problem(s):</p>
        <table class="ai-calib-table">
          <thead><tr><th></th><th>Problem</th><th>Now → Suggested</th><th>Rate</th><th></th></tr></thead>
          <tbody>
            ${suggestions.map((s, i) => `
              <tr>
                <td><input type="checkbox" data-calib-check="${i}" checked></td>
                <td>${escapeHtml(s.title)}<div class="muted" style="font-size:0.75rem">${s.attempts} attempts · ${escapeHtml(s.reason)}</div></td>
                <td><span class="diff diff--${escapeHtml(s.current)}">${escapeHtml(s.current)}</span> → <span class="diff diff--${escapeHtml(s.suggested)}">${escapeHtml(s.suggested)}</span></td>
                <td>${s.rate}%</td>
                <td><button class="btn btn--secondary btn--sm" data-calib-one="${i}">Apply</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="ai-calib-actions">
          <button class="btn btn--primary btn--sm" id="ai-btn-calib-apply">Apply selected</button>
          <button class="btn btn--secondary btn--sm" id="ai-btn-calib-apply-all">Apply all</button>
        </div>
      `;
    }
    if (manual) showToast("Calibration refreshed", "success");
  } catch (e) {
    if (body) body.innerHTML = `<p class="muted">Calibration failed: ${escapeHtml(e.message)}</p>`;
    if (manual) showToast("Calibration failed: " + e.message, "error");
  }
  if (btn) { btn.disabled = false; btn.textContent = "↻ Re-analyse"; }
}

async function onCalibClick(e) {
  const one = e.target.closest("[data-calib-one]");
  if (one) {
    const s = AIUI_calibCache[Number(one.dataset.calibOne)];
    if (!s) return;
    one.disabled = true;
    const n = await AI_applyDifficulty([s]);
    showToast(n ? `Updated "${s.title}" → ${s.suggested}` : "Update failed", n ? "success" : "error");
    renderLogs();
    refreshCalibration(false);
    return;
  }
  if (e.target.closest("#ai-btn-calib-apply-all")) {
    if (!AIUI_calibCache.length) return;
    if (!confirm(`Apply all ${AIUI_calibCache.length} difficulty change(s)?`)) return;
    const n = await AI_applyDifficulty(AIUI_calibCache);
    showToast(`Updated ${n} problem(s)`, "success");
    renderLogs();
    refreshCalibration(false);
    return;
  }
  if (e.target.closest("#ai-btn-calib-apply")) {
    const idx = [...document.querySelectorAll("[data-calib-check]:checked")].map((c) => Number(c.dataset.calibCheck));
    const items = idx.map((i) => AIUI_calibCache[i]).filter(Boolean);
    if (!items.length) { showToast("Nothing selected", "error"); return; }
    const n = await AI_applyDifficulty(items);
    showToast(`Updated ${n} problem(s)`, "success");
    renderLogs();
    refreshCalibration(false);
  }
}
