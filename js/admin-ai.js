// admin-ai.js — controller for ai.html (AI Control Center).

onAdminReady(async () => {
  const admin = await requireAdmin();
  if (!admin) return;

  // The automation bundle is loaded in the background now (so every other
  // admin page paints immediately). This is the one page that cannot work
  // without it, so wait for it here.
  if (typeof whenAdminAIReady === "function") await whenAdminAIReady();
  if (typeof AI_pullSettings !== "function") {
    showToast("AI engine files could not be loaded — check js/ai-*.js are deployed.", "error");
    return;
  }

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
  setToggle("ai-premiummix", s.premium_mix);
  setToggle("ai-errguard", s.error_guard);
  setToggle("ai-dedup", s.dedup);
  setToggle("ai-announce", s.announce);
  setToggle("ai-welcome", s.welcome);

  // Factory settings
  document.getElementById("ai-per-run").value = String(s.per_run || 3);
  document.getElementById("ai-hours").value = String(s.auto_hours || 12);
  document.getElementById("ai-mix").value = s.mix || "both";
  document.getElementById("ai-difficulty").value = s.difficulty || "mixed";
  const pctEl = document.getElementById("ai-premium-pct");
  if (pctEl) pctEl.value = String(s.premium_percent || 25);
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
    ["ai-premiummix", "premium_mix", "Premium mix"],
    ["ai-errguard", "error_guard", "Bug error guard"],
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
  const pctEl = document.getElementById("ai-premium-pct");
  if (pctEl) pctEl.addEventListener("change", (e) => {
    AI_saveSettings({ premium_percent: Math.max(0, Math.min(90, Number(e.target.value) || 25)) });
    showToast("Premium share saved", "success");
  });

  // Action buttons
  document.getElementById("ai-btn-diagnose")?.addEventListener("click", diagnoseCodeNow);
  document.getElementById("ai-btn-scan").addEventListener("click", runModerationNow);
  document.getElementById("ai-btn-generate").addEventListener("click", generateNow);
  document.getElementById("ai-btn-preview").addEventListener("click", previewNow);
  document.getElementById("ai-btn-dedup").addEventListener("click", dedupNow);
  document.getElementById("ai-btn-errguard").addEventListener("click", errguardNow);
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

function diagnoseCodeNow() {
  const input = document.getElementById("ai-code-input");
  const result = document.getElementById("ai-diagnose-result");
  if (!input || !result || typeof AI_diagnoseCode !== "function") return;
  const report = AI_diagnoseCode(input.value);
  if (!report.diagnostics.length) {
    result.innerHTML = `<div class="ai-diagnose-ok"><span>✓</span><div><strong>No high-signal issues found</strong><small>The snippet passed the local structural checks. Still test the intended output before publishing.</small></div></div>`;
    return;
  }
  result.innerHTML = `<div class="ai-diagnose-list">${report.diagnostics.map((item) => `
    <div class="ai-diagnose-item ai-diagnose-item--${item.severity}">
      <span class="ai-diagnose-item__badge">${item.severity === "error" ? "!" : item.severity === "warning" ? "i" : "•"}</span>
      <div><strong>${escapeHtml(item.message)}${item.line ? ` <em>line ${item.line}</em>` : ""}</strong><small>${escapeHtml(item.detail || "Review this line before shipping.")}</small></div>
    </div>`).join("")}</div>`;
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
      <p class="muted" style="font-size:0.8rem">Template: <code>${esc(templateId)}</code> · Not saved — press "Generate problems now" to insert verified problems.${(() => { try { const s = AI_getSettings(); return s.premium_mix ? ` · ⭐ Premium mix is ON — ~${s.premium_percent || 25}% of factory batches are marked Premium.` : ""; } catch (e) { return ""; } })()}</p>
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

async function errguardNow() {
  setBusy("ai-btn-errguard", true);
  try {
    const scan = await AI_runErrorGuard({ auto: false, dryRun: true });
    if (!scan.candidates.length) {
      showToast(`Checked ${scan.scanned} Fix-the-Bug problem(s) — every snippet raises a real error ✅`, "success");
    } else {
      const names = scan.candidates.slice(0, 8).map((p) => `• #${p.problem_number ?? "?"} ${p.title}`).join("\n");
      const more = scan.candidates.length > 8 ? `\n…+${scan.candidates.length - 8} more` : "";
      if (!confirm(`Found ${scan.candidates.length} Fix-the-Bug problem(s) whose code runs WITHOUT any error:\n\n${names}${more}\n\nDelete them all (with their submissions + discussions)?`)) {
        setBusy("ai-btn-errguard", false, "🧹 Delete error-free bugs now");
        return;
      }
      const r = await AI_runErrorGuard({ auto: false });
      showToast(`Checked ${r.scanned}: removed ${r.removed.length} error-free bug problem(s)`, r.removed.length ? "info" : "success");
    }
  } catch (e) {
    showToast("Error-guard failed: " + e.message, "error");
  }
  setBusy("ai-btn-errguard", false, "🧹 Delete error-free bugs now");
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
  set("ai-stat-premium", st.premiumAdded || 0);
  set("ai-stat-errguard", st.bugGuardRemoved || 0);
  const fmt = (ts) => (ts ? timeAgo(new Date(ts).toISOString()) : "never");
  set("ai-last-mod", "every minute while ON");
  set("ai-last-dedup", fmt(st.lastRuns.dedup));
  set("ai-last-errguard", fmt(st.lastRuns.errguard));
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
  initGrowth();
  initSafety();
  initContent();
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
      const fixLabel = { dedup: "Fix: remove", errguard: "Fix: delete", moderation: "Fix: scan", factory: "Fix: generate 3", "factory-hard": "Fix: 3 hard", discussions: "Open", hints: "Review", broadcast: "Open" };
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
    } else if (fix === "errguard") {
      const scan = await AI_runErrorGuard({ auto: false, dryRun: true });
      if (!scan.candidates.length) {
        showToast("No error-free bug code found", "success");
      } else if (confirm(`Delete ${scan.candidates.length} error-free Fix-the-Bug problem(s)?`)) {
        const r = await AI_runErrorGuard({ auto: false });
        showToast(`Removed ${r.removed.length} error-free bug problem(s)`, "success");
      }
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

/* ================= Growth / Safety / Content UI ================= */

function growthToggle(id, key, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = !!AI_getSettings()[key];
  el.addEventListener("change", () => {
    AI_saveSettings({ [key]: el.checked });
    AI_log("setting_changed", `${label} → ${el.checked ? "ON" : "OFF"}.`, "info");
    renderLogs();
    showToast(`${label} ${el.checked ? "enabled" : "disabled"}`, "info");
  });
}

function paintGrowthLast() {
  const last = AI_getStats().lastRuns || {};
  const fmt = (ts) => (ts ? "Last run: " + timeAgo(new Date(ts).toISOString()) : "Last run: never");
  const map = { "ai-last-exp": "expiry", "ai-last-winback": "winback", "ai-last-stuck": "stuck", "ai-last-lead": "lead", "ai-last-faq": "faq" };
  Object.entries(map).forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = fmt(last[k]);
  });
}

function initGrowth() {
  growthToggle("ai-exp", "expiry", "Expiry reminders");
  growthToggle("ai-winback", "winback", "Win-back");
  growthToggle("ai-stuck", "stuck", "Stuck-user help");
  growthToggle("ai-lead", "leaderboard", "Leaderboard alerts");
  paintGrowthLast();
  const runs = [
    ["ai-btn-exp", "expiry", async () => {
      const r = await AI_runExpiryReminders({ auto: false });
      return `${r.expiring} expiring, ${r.expired} expired, ${r.notified} notified`;
    }],
    ["ai-btn-winback", "winback", async () => {
      const r = await AI_runWinback({ auto: false });
      return r.skipped ? "skipped (no activity column)" : `${r.found} inactive, ${r.notified} nudged`;
    }],
    ["ai-btn-stuck", "stuck", async () => {
      const r = await AI_runStuckHelp({ auto: false });
      return `${r.stuck} stuck, ${r.notified} encouraged`;
    }],
    ["ai-btn-lead", "lead", async () => {
      const r = await AI_runLeaderboardAlerts({ auto: false });
      return r.skipped ? "skipped (no XP column)" : r.baseline ? "snapshot saved — alerts from next run" : `${r.alerts} alert(s) sent`;
    }],
  ];
  runs.forEach(([btnId, key, fn]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const idle = btn.textContent;
      btn.textContent = "Working...";
      try {
        const msg = await fn();
        AI_setLastRun(key);
        showToast(msg, "success");
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      }
      btn.disabled = false;
      btn.textContent = idle;
      renderLogs();
      refreshStats();
      paintGrowthLast();
    });
  });
}

function initSafety() {
  growthToggle("ai-faq", "faq", "FAQ auto-helper");
  growthToggle("ai-hindi", "hindi", "Hindi filter");
  const faqBtn = document.getElementById("ai-btn-faq");
  if (faqBtn) faqBtn.addEventListener("click", async () => {
    faqBtn.disabled = true;
    const idle = faqBtn.textContent;
    faqBtn.textContent = "Working...";
    try {
      const r = await AI_runFaqReplies(10, { auto: false });
      AI_setLastRun("faq");
      showToast(`${r.waiting} waiting, ${r.replied} answered`, "success");
    } catch (e) {
      showToast("FAQ run failed: " + e.message, "error");
    }
    faqBtn.disabled = false;
    faqBtn.textContent = idle;
    renderLogs();
    refreshStats();
    paintGrowthLast();
  });
  const cheatBtn = document.getElementById("ai-btn-cheat");
  if (cheatBtn) cheatBtn.addEventListener("click", async () => {
    const body = document.getElementById("ai-cheat-body");
    cheatBtn.disabled = true;
    if (body) body.innerHTML = `<p class="muted">Scanning submissions...</p>`;
    try {
      const r = await AI_cheatReport();
      if (!r.hits.length) {
        if (body) body.innerHTML = `<p class="muted">Checked ${r.checked} submissions — no copy-paste rings. ✅</p>`;
      } else if (body) {
        body.innerHTML = `
          <p class="muted" style="font-size:0.85rem">${r.hits.length} group(s) share identical code (review on the <a href="submissions.html">Submissions</a> page):</p>
          <table class="ai-calib-table">
            <thead><tr><th>Problem</th><th>Users</th><th>Submissions</th></tr></thead>
            <tbody>${r.hits.map((h) => `
              <tr>
                <td>${escapeHtml(h.problemTitle)}</td>
                <td>${h.userNames.map((n) => escapeHtml(n)).join("<br>")}</td>
                <td>${h.submissions}</td>
              </tr>`).join("")}
            </tbody>
          </table>`;
      }
      showToast(`Checked ${r.checked}: ${r.hits.length} group(s)`, r.hits.length ? "info" : "success");
    } catch (e) {
      if (body) body.innerHTML = `<p class="muted">Scan failed: ${escapeHtml(e.message)}</p>`;
      showToast("Scan failed: " + e.message, "error");
    }
    cheatBtn.disabled = false;
    renderLogs();
  });
}

let AIUI_bulkCache = [];

function initContent() {
  const gapBtn = document.getElementById("ai-btn-gap");
  if (gapBtn) gapBtn.addEventListener("click", async () => {
    gapBtn.disabled = true;
    try {
      const r = await AI_runGapFill(3, { auto: false });
      const el = document.getElementById("ai-gap-result");
      if (el) el.textContent = r.added.length ? `Added: ${r.added.map((p) => "#" + p.problem_number + " " + p.title).join(" · ")}` : "All candidates were duplicates — nothing added.";
      showToast(`Gap-fill added ${r.added.length}`, r.added.length ? "success" : "info");
    } catch (e) {
      showToast("Gap-fill failed: " + e.message, "error");
    }
    gapBtn.disabled = false;
    renderLogs();
    refreshStats();
  });

  const qBtn = document.getElementById("ai-btn-quality");
  if (qBtn) qBtn.addEventListener("click", async () => {
    const body = document.getElementById("ai-quality-body");
    qBtn.disabled = true;
    if (body) body.innerHTML = `<p class="muted">Scanning problems...</p>`;
    try {
      const r = await AI_qualityReport();
      if (!r.issues.length) {
        if (body) body.innerHTML = `<p class="muted">All ${r.total} problems passed quality checks. ✅</p>`;
      } else if (body) {
        body.innerHTML = `
          <p class="muted" style="font-size:0.85rem">${r.issues.length}/${r.total} problem(s) need attention:</p>
          <table class="ai-calib-table">
            <thead><tr><th>#</th><th>Title</th><th>Issues</th><th></th></tr></thead>
            <tbody>${r.issues.slice(0, 50).map((p) => `
              <tr>
                <td class="mono muted">${p.number ?? "—"}</td>
                <td>${escapeHtml(p.title || "(untitled)")}</td>
                <td><code>${p.flags.map((f) => escapeHtml(f)).join(", ")}</code></td>
                <td><a class="btn btn--secondary btn--sm" href="problem-form.html?id=${encodeURIComponent(p.id)}">Edit</a></td>
              </tr>`).join("")}
            </tbody>
          </table>
          ${r.issues.length > 50 ? `<p class="muted" style="font-size:0.8rem">Showing 50 of ${r.issues.length}.</p>` : ""}`;
      }
      showToast(`Quality: ${r.issues.length} issue(s) in ${r.total}`, r.issues.length ? "info" : "success");
    } catch (e) {
      if (body) body.innerHTML = `<p class="muted">Report failed: ${escapeHtml(e.message)}</p>`;
      showToast("Report failed: " + e.message, "error");
    }
    qBtn.disabled = false;
    renderLogs();
  });

  const hBtn = document.getElementById("ai-btn-hints");
  if (hBtn) hBtn.addEventListener("click", async () => {
    if (!confirm("Top up all problems with fewer than 3 hints?")) return;
    hBtn.disabled = true;
    try {
      const r = await AI_fixHints();
      const el = document.getElementById("ai-hints-result");
      if (el) el.textContent = `Checked ${r.checked}, fixed ${r.fixed}.`;
      showToast(`Fixed hints on ${r.fixed} problem(s)`, "success");
    } catch (e) {
      showToast("Hint fix failed: " + e.message, "error");
    }
    hBtn.disabled = false;
    renderLogs();
  });

  const bCheck = document.getElementById("ai-btn-bulk-check");
  if (bCheck) bCheck.addEventListener("click", async () => {
    const body = document.getElementById("ai-bulk-body");
    const impBtn = document.getElementById("ai-btn-bulk-import");
    const fmt = document.getElementById("ai-bulk-format").value;
    const text = document.getElementById("ai-bulk-text").value;
    if (impBtn) impBtn.disabled = true;
    AIUI_bulkCache = [];
    if (!text.trim()) {
      if (body) body.innerHTML = `<p class="muted">Paste something first.</p>`;
      return;
    }
    if (body) body.innerHTML = `<p class="muted">Validating...</p>`;
    try {
      const { rows, errors } = AI_parseBulkImport(text, fmt);
      const verdicts = await AI_validateBulkRows(rows);
      AIUI_bulkCache = verdicts;
      const okCount = verdicts.filter((v) => v.ok).length;
      if (body) {
        body.innerHTML = `
          ${errors.map((e) => `<p class="ai-bulk-bad">Row ${e.row}: ${escapeHtml(e.error)}</p>`).join("")}
          <p class="muted" style="font-size:0.85rem">${okCount}/${verdicts.length} row(s) valid.</p>
          <table class="ai-calib-table">
            <thead><tr><th>Row</th><th>Title</th><th>Verdict</th><th>Failed checks</th></tr></thead>
            <tbody>${verdicts.map((v) => `
              <tr>
                <td>${v.row}</td>
                <td>${escapeHtml(v.title)}</td>
                <td class="${v.ok ? "ai-bulk-ok" : "ai-bulk-bad"}">${v.ok ? "✅ Valid" : "❌ Invalid"}</td>
                <td class="muted" style="font-size:0.8rem">${v.checks.filter((c) => !c.pass).map((c) => escapeHtml(c.label)).join(", ") || "—"}</td>
              </tr>`).join("")}
            </tbody>
          </table>`;
      }
      if (impBtn) impBtn.disabled = okCount === 0;
      showToast(`${okCount}/${verdicts.length} valid`, okCount ? "success" : "error");
    } catch (e) {
      if (body) body.innerHTML = `<p class="muted">Validation failed: ${escapeHtml(e.message)}</p>`;
    }
  });

  const bImp = document.getElementById("ai-btn-bulk-import");
  if (bImp) bImp.addEventListener("click", async () => {
    const good = AIUI_bulkCache.filter((v) => v.ok);
    if (!good.length) return;
    if (!confirm(`Import ${good.length} valid row(s)?`)) return;
    bImp.disabled = true;
    try {
      const r = await AI_runBulkImport(AIUI_bulkCache);
      showToast(`Imported ${r.added} problem(s)`, "success");
      document.getElementById("ai-bulk-text").value = "";
      document.getElementById("ai-bulk-body").innerHTML = `<p class="muted">Imported ${r.added}. Paste more or leave.</p>`;
      AIUI_bulkCache = [];
    } catch (e) {
      showToast("Import failed: " + e.message, "error");
    }
    renderLogs();
    refreshStats();
  });
}
