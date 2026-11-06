// admin-settings.js — runtime configuration, feature flags, team roles and
// admin sessions for the PyDebug panel.
//
// All writes go through SECURITY DEFINER RPCs that re-check `has_perm(...)`
// server-side, so hiding a button is a convenience, never the security
// boundary. Every mutation is audited by the database function itself.

let settingsState = {};
let flagsState = [];
let membersState = [];
let sessionsState = [];
let canManageTeam = false;
let currentAdminSessionId = null;

const ROLE_OPTIONS = ["owner", "admin", "moderator", "support", "finance", "content"];

const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderator",
  support: "Support",
  finance: "Finance",
  content: "Content",
};

const PERMISSION_MATRIX = [
  ["Dashboard & insights", "dashboard.read", ["owner", "admin", "moderator", "support", "finance", "content"]],
  ["Read learners", "users.read", ["owner", "admin", "moderator", "support", "finance"]],
  ["Edit learners / premium", "users.write", ["owner", "admin", "moderator"]],
  ["Payments & orders", "payments.read", ["owner", "admin", "support", "finance"]],
  ["Grants & entitlements", "payments.write", ["owner", "admin", "finance"]],
  ["Refunds", "payments.refund", ["owner", "finance"]],
  ["Coupons & creators", "coupons.write", ["owner", "admin", "finance"]],
  ["Problems (create/edit)", "problems.write", ["owner", "admin", "content"]],
  ["Problems (delete)", "problems.delete", ["owner", "admin", "content"]],
  ["Community moderation", "community.write", ["owner", "admin", "moderator"]],
  ["Certificates", "certificates.write", ["owner", "admin", "content"]],
  ["Broadcasts & notifications", "notifications.write", ["owner", "admin"]],
  ["AI control", "ai.write", ["owner", "admin", "content"]],
  ["Audit log", "audit.read", ["owner", "admin", "moderator", "support", "finance"]],
  ["Settings", "settings.write", ["owner", "admin"]],
  ["Team & roles", "team.write", ["owner", "admin"]],
  ["Trash (restore / purge)", "trash.write", ["owner", "admin", "moderator", "content"]],
];

onAdminReady(async () => {
  const admin = await requirePerm("settings.read");
  if (!admin) return;

  canManageTeam = can("team.write");
  currentAdminSessionId = getAdminSessionId();
  bindTabs();
  bindEvents();
  lockReadOnlyFields();
  await Promise.all([loadSettings(), loadFlags(), loadTeam(), loadSessions()]);
  setStatus("Ready");
});

/* ------------------------------------------------------------------ helpers */

function setStatus(text) {
  const el = document.getElementById("settings-status");
  if (el) el.textContent = text;
}

function esc(value) {
  return escapeHtml(String(value ?? ""));
}

function isMissingFunction(error) {
  if (!error) return false;
  const msg = String(error.message || error.details || "").toLowerCase();
  return (
    error.code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("does not exist") ||
    msg.includes("schema cache")
  );
}

function migrationHint() {
  return `<div class="empty-row">Run <code>db/migrations/20261106_admin_platform_core.sql</code> in Supabase → SQL Editor to enable this section.</div>`;
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-settings-tab]"));
  const panels = Array.from(document.querySelectorAll(".settings-panel"));

  const activate = (name, updateHash) => {
    const target = tabs.find((t) => t.dataset.settingsTab === name) || tabs[0];
    if (!target) return;
    const id = target.dataset.settingsTab;
    tabs.forEach((tab) => {
      const isActive = tab === target;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.id === `settings-${id}`));
    if (updateHash) {
      try { history.replaceState(null, "", `#${id}`); } catch (e) {}
    }
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.settingsTab, true));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const index = tabs.indexOf(tab);
      const next = e.key === "ArrowDown" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
      tabs[next].focus();
      activate(tabs[next].dataset.settingsTab, true);
    });
  });

  const fromHash = (window.location.hash || "").replace("#", "");
  if (fromHash && tabs.some((t) => t.dataset.settingsTab === fromHash)) {
    activate(fromHash, false);
  }
}

function lockReadOnlyFields() {
  if (can("settings.write")) return;
  document.querySelectorAll("[data-setting], #plans-rows input, #team-add-form input, #team-role").forEach((el) => {
    el.disabled = true;
  });
}

function bindEvents() {
  document.getElementById("settings-reload-btn")?.addEventListener("click", async () => {
    await Promise.all([loadSettings(), loadFlags(), loadTeam(), loadSessions()]);
    setStatus(`Reloaded ${new Date().toLocaleTimeString("en-IN")}`);
    showToast("Settings reloaded", "success");
  });

  document.querySelectorAll("[data-save-panel]").forEach((btn) => {
    btn.addEventListener("click", () => savePanel(btn));
  });

  document.getElementById("plans-save-btn")?.addEventListener("click", savePlans);
  document.getElementById("plan-add-row")?.addEventListener("click", () => {
    const rows = getPlansFromForm();
    rows.push({ key: `plan_${rows.length + 1}`, name: "New plan", amount_paise: 0, days: 30 });
    renderPlans(rows);
  });
  document.getElementById("ai-save-btn")?.addEventListener("click", saveAi);
  document.getElementById("flags-refresh-btn")?.addEventListener("click", loadFlags);
  document.getElementById("team-refresh-btn")?.addEventListener("click", loadTeam);
  document.getElementById("team-add-form")?.addEventListener("submit", addMember);
  document.getElementById("team-tbody")?.addEventListener("change", onMemberRoleChange);
  document.getElementById("team-tbody")?.addEventListener("click", onMemberAction);
  document.getElementById("sessions-root")?.addEventListener("click", onSessionAction);
  document.getElementById("revoke-others-btn")?.addEventListener("click", revokeOtherSessions);
  document.getElementById("export-settings-btn")?.addEventListener("click", exportSettings);
  document.getElementById("revoke-all-btn")?.addEventListener("click", revokeAllSessions);
  document.getElementById("copy-rotate-sql")?.addEventListener("click", copyRotateSql);
}

/* ----------------------------------------------------------------- settings */

async function loadSettings() {
  const { data, error } = await sb.rpc("admin_get_settings");
  if (error) {
    if (isMissingFunction(error)) {
      settingsState = {};
      showToast("Settings tables missing — run the platform migration first.", "error");
      return;
    }
    showToast(`Could not load settings: ${error.message}`, "error");
    return;
  }
  settingsState = data && typeof data === "object" ? data : {};
  applySettings(settingsState);
  renderPlans(getCatalog(settingsState));
}

function applySettings(state) {
  document.querySelectorAll("[data-setting]").forEach((el) => {
    const key = el.dataset.setting;
    if (!Object.prototype.hasOwnProperty.call(state, key)) return;
    const value = state[key];
    const type = el.dataset.type || "text";

    if (type === "bool") {
      el.checked = value === true;
    } else if (type === "rupees") {
      el.value = Number(value || 0) / 100;
    } else if (type === "json") {
      el.value = JSON.stringify(value, null, 2);
    } else if (value === null || value === undefined) {
      el.value = "";
    } else if (typeof value === "object") {
      el.value = JSON.stringify(value);
    } else {
      el.value = String(value);
    }
  });

  const features = state["ai.features"] && typeof state["ai.features"] === "object" ? state["ai.features"] : {};
  document.querySelectorAll("[data-ai-feature]").forEach((cb) => {
    cb.checked = features[cb.dataset.aiFeature] !== false;
  });
}

function readField(el) {
  const type = el.dataset.type || "text";
  if (type === "bool") return el.type === "checkbox" ? el.checked : el.value === "true";
  if (type === "number") {
    const n = Number(el.value);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "rupees") {
    const n = Number(el.value);
    return Math.round((Number.isFinite(n) ? n : 0) * 100);
  }
  if (type === "json") {
    try { return JSON.parse(el.value || "null"); } catch (e) {
      throw new Error("Invalid JSON — fix the highlighted field");
    }
  }
  return el.value;
}

function collectPanelPairs(panel) {
  const pairs = [];
  panel.querySelectorAll("[data-setting]").forEach((el) => {
    if (el.disabled) return;
    const key = el.dataset.setting;
    const value = readField(el);
    if (JSON.stringify(value) !== JSON.stringify(settingsState[key])) {
      pairs.push({ key, value });
    }
  });
  return pairs;
}

async function savePanel(button) {
  if (!ensureCan("settings.write")) return;
  const panel = button.closest(".settings-panel");
  if (!panel) return;

  let pairs;
  try {
    pairs = collectPanelPairs(panel);
  } catch (e) {
    showToast(e.message, "error");
    return;
  }

  if (!pairs.length) {
    showToast("Nothing changed", "info");
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Saving…";

  let saved = 0;
  try {
    for (const pair of pairs) {
      const { error } = await sb.rpc("admin_set_setting", { p_key: pair.key, p_value: pair.value });
      if (error) throw error;
      settingsState[pair.key] = pair.value;
      saved += 1;
    }
    showToast(`${saved} setting${saved === 1 ? "" : "s"} saved`, "success");
    setStatus(`Saved ${new Date().toLocaleTimeString("en-IN")}`);
  } catch (error) {
    showToast(`Could not save: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* -------------------------------------------------------------------- plans */

function getCatalog(state) {
  const catalog = state && state["plans.catalog"];
  if (Array.isArray(catalog)) return catalog;
  return [];
}

function renderPlans(plans) {
  const root = document.getElementById("plans-rows");
  if (!root) return;

  if (!plans.length) {
    root.innerHTML = `<div class="empty-row">No plans configured. Add one to start selling premium.</div>`;
    return;
  }

  root.innerHTML = plans.map((plan, index) => `
    <div class="flag-row" data-plan-row data-index="${index}">
      <div class="settings-grid" style="flex:1;margin:0">
        <div class="setting-field">
          <label>Plan key</label>
          <input type="text" data-plan-field="key" value="${esc(plan.key || "")}" placeholder="monthly">
        </div>
        <div class="setting-field">
          <label>Display name</label>
          <input type="text" data-plan-field="name" value="${esc(plan.name || "")}" placeholder="Monthly">
        </div>
        <div class="setting-field">
          <label>Price (₹)</label>
          <input type="number" min="0" step="1" data-plan-field="amount" value="${Number(plan.amount_paise || 0) / 100}">
        </div>
        <div class="setting-field">
          <label>Days</label>
          <input type="number" min="1" step="1" data-plan-field="days" value="${Number(plan.days || 30)}">
        </div>
      </div>
      <div class="flag-row__controls">
        <button type="button" class="btn btn--danger btn--sm" data-plan-remove="${index}" ${can("settings.write") ? "" : "disabled"}>Remove</button>
      </div>
    </div>`).join("");

  root.querySelectorAll("[data-plan-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rows = getPlansFromForm();
      rows.splice(Number(btn.dataset.planRemove), 1);
      renderPlans(rows);
    });
  });
}

function getPlansFromForm() {
  const rows = Array.from(document.querySelectorAll("[data-plan-row]"));
  return rows.map((row) => ({
    key: row.querySelector('[data-plan-field="key"]').value.trim(),
    name: row.querySelector('[data-plan-field="name"]').value.trim(),
    amount_paise: Math.round(Number(row.querySelector('[data-plan-field="amount"]').value || 0) * 100),
    days: Math.max(1, Math.round(Number(row.querySelector('[data-plan-field="days"]').value || 30))),
  }));
}

async function savePlans() {
  if (!ensureCan("settings.write")) return;
  const plans = getPlansFromForm();
  const keys = plans.map((p) => p.key);
  if (plans.some((p) => !p.key || !p.name)) {
    showToast("Every plan needs a key and a name", "error");
    return;
  }
  if (new Set(keys).size !== keys.length) {
    showToast("Plan keys must be unique", "error");
    return;
  }

  const btn = document.getElementById("plans-save-btn");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Saving…";
  try {
    const { error } = await sb.rpc("admin_set_setting", { p_key: "plans.catalog", p_value: plans });
    if (error) throw error;
    settingsState["plans.catalog"] = plans;
    showToast("Plan catalog saved", "success");
  } catch (error) {
    showToast(`Could not save plans: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ----------------------------------------------------------------------- AI */

async function saveAi() {
  if (!ensureCan("settings.write")) return;
  const btn = document.getElementById("ai-save-btn");
  const master = document.getElementById("set-ai-master");
  const budget = document.getElementById("set-ai-budget");
  const features = {};
  document.querySelectorAll("[data-ai-feature]").forEach((cb) => {
    features[cb.dataset.aiFeature] = cb.checked;
  });

  const pairs = [
    { key: "ai.master_enabled", value: master ? master.checked : false },
    { key: "ai.monthly_budget_paise", value: Math.round(Number(budget?.value || 0) * 100) },
    { key: "ai.features", value: features },
  ];

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Saving…";
  try {
    for (const pair of pairs) {
      const { error } = await sb.rpc("admin_set_setting", { p_key: pair.key, p_value: pair.value });
      if (error) throw error;
      settingsState[pair.key] = pair.value;
    }
    showToast("AI settings saved", "success");
  } catch (error) {
    showToast(`Could not save AI settings: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* -------------------------------------------------------------------- flags */

async function loadFlags() {
  const root = document.getElementById("flags-root");
  if (root) root.innerHTML = `<div class="empty-row">Loading feature flags…</div>`;

  const { data, error } = await sb.rpc("admin_list_flags");
  if (error) {
    if (isMissingFunction(error)) {
      if (root) root.innerHTML = migrationHint();
      return;
    }
    if (root) root.innerHTML = `<div class="empty-row">Could not load flags: ${esc(error.message)}</div>`;
    return;
  }

  flagsState = Array.isArray(data) ? data : [];
  renderFlags();
}

function renderFlags() {
  const root = document.getElementById("flags-root");
  if (!root) return;
  if (!flagsState.length) {
    root.innerHTML = `<div class="empty-row">No feature flags yet — run the migration to seed them.</div>`;
    return;
  }

  const editable = can("settings.write");
  root.innerHTML = flagsState.map((flag) => `
    <div class="flag-row" data-flag-key="${esc(flag.key)}">
      <div>
        <div class="flag-row__title">
          ${esc(flag.label || flag.key)}
          <span class="flag-key">${esc(flag.key)}</span>
        </div>
        <div class="flag-row__desc">${esc(flag.description || "")}</div>
      </div>
      <div class="flag-row__controls">
        <label class="flag-rollout" title="Gradual rollout percentage">
          <input type="range" min="0" max="100" step="5" value="${Number(flag.rollout_percent ?? 100)}"
                 data-flag-rollout="${esc(flag.key)}" ${editable ? "" : "disabled"}>
          <span data-flag-rollout-label="${esc(flag.key)}">${Number(flag.rollout_percent ?? 100)}%</span>
        </label>
        <label class="switch">
          <input type="checkbox" data-flag-toggle="${esc(flag.key)}" ${flag.enabled ? "checked" : ""} ${editable ? "" : "disabled"}>
          <span class="switch__track" aria-hidden="true"></span>
          <span class="sr-only">Enable ${esc(flag.label || flag.key)}</span>
        </label>
      </div>
    </div>`).join("");

  root.querySelectorAll("[data-flag-toggle]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const key = checkbox.dataset.flagToggle;
      const rolloutInput = root.querySelector(`[data-flag-rollout="${CSS.escape(key)}"]`);
      updateFlag(key, checkbox.checked, rolloutInput ? Number(rolloutInput.value) : null);
    });
  });

  let rolloutTimer = null;
  root.querySelectorAll("[data-flag-rollout]").forEach((range) => {
    range.addEventListener("input", () => {
      const label = root.querySelector(`[data-flag-rollout-label="${CSS.escape(range.dataset.flagRollout)}"]`);
      if (label) label.textContent = `${range.value}%`;
    });
    range.addEventListener("change", () => {
      const key = range.dataset.flagRollout;
      const checkbox = root.querySelector(`[data-flag-toggle="${CSS.escape(key)}"]`);
      clearTimeout(rolloutTimer);
      rolloutTimer = setTimeout(() => {
        updateFlag(key, checkbox ? checkbox.checked : true, Number(range.value));
      }, 250);
    });
  });
}

async function updateFlag(key, enabled, rollout) {
  if (!ensureCan("settings.write")) return;
  const previous = flagsState.find((f) => f.key === key);
  if (previous) {
    previous.enabled = enabled;
    if (rollout !== null && rollout !== undefined) previous.rollout_percent = rollout;
  }

  const { error } = await sb.rpc("admin_set_flag", {
    p_key: key,
    p_enabled: enabled,
    p_rollout: rollout === null || rollout === undefined ? null : rollout,
  });

  if (error) {
    showToast(`Flag update failed: ${error.message}`, "error");
    await loadFlags();
    return;
  }

  showToast(`${key} ${enabled ? "enabled" : "disabled"}${rollout != null ? ` · ${rollout}% rollout` : ""}`, "success");
}

/* --------------------------------------------------------------------- team */

async function loadTeam() {
  const body = document.getElementById("team-tbody");
  if (!body) return;

  const { data, error } = await sb.rpc("admin_list_members");
  if (error) {
    body.innerHTML = `<tr><td colspan="5" class="empty-row">${isMissingFunction(error) ? "Run the platform migration to enable team roles." : `Could not load team: ${esc(error.message)}`}</td></tr>`;
    renderPermissionMatrix();
    return;
  }

  membersState = Array.isArray(data) ? data : [];
  renderTeam();
  renderPermissionMatrix();
}

function renderTeam() {
  const body = document.getElementById("team-tbody");
  if (!body) return;

  if (!membersState.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty-row">No team members found.</td></tr>`;
    return;
  }

  const editable = canManageTeam;
  body.innerHTML = membersState.map((member) => `
    <tr data-member-id="${esc(member.user_id)}">
      <td>
        <div class="user-name-main">
          <a class="user-name-link" href="user-detail.html?id=${encodeURIComponent(member.user_id)}">${esc(member.display_name || member.email || member.user_id)}</a>
          ${member.is_legacy ? '<span class="role-chip role-chip--owner">legacy</span>' : ""}
        </div>
        <div class="muted" style="font-size:0.7rem">${esc(member.email || "")}</div>
      </td>
      <td>
        <select class="role-select" data-member-role="${esc(member.user_id)}" ${editable ? "" : "disabled"}>
          ${ROLE_OPTIONS.map((role) => `<option value="${role}" ${role === member.role ? "selected" : ""}>${ROLE_LABELS[role]}</option>`).join("")}
        </select>
      </td>
      <td class="muted">${member.created_at ? esc(fmtDateTime(member.created_at)) : "—"}</td>
      <td class="muted">${member.last_seen_at ? esc(timeAgo(member.last_seen_at)) : "—"}</td>
      <td>
        <button type="button" class="btn btn--danger btn--sm" data-member-remove="${esc(member.user_id)}" ${editable ? "" : "disabled"}>Remove</button>
      </td>
    </tr>`).join("");
}

function renderPermissionMatrix() {
  const body = document.getElementById("perm-matrix-body");
  if (!body) return;
  body.innerHTML = PERMISSION_MATRIX.map(([label, perm, roles]) => `
    <tr>
      <td>${esc(label)} <span class="flag-key">${esc(perm)}</span></td>
      ${ROLE_OPTIONS.map((role) => {
        const allowed = roles.includes(role) || role === "owner";
        return `<td class="${allowed ? "" : "is-off"}">${allowed ? "✓" : "—"}</td>`;
      }).join("")}
    </tr>`).join("");
}

async function addMember(event) {
  if (!ensureCan("team.write")) return;
  event.preventDefault();
  const emailEl = document.getElementById("team-email");
  const roleEl = document.getElementById("team-role");
  const email = (emailEl?.value || "").trim();
  const role = roleEl?.value || "support";
  if (!email) return;

  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const { error } = await sb.rpc("admin_add_member", { p_email: email, p_role: role });
    if (error) throw error;
    showToast(`${email} added as ${ROLE_LABELS[role]}`, "success");
    if (emailEl) emailEl.value = "";
    await loadTeam();
  } catch (error) {
    showToast(`Could not add member: ${error.message}`, "error");
  } finally {
    submit.disabled = false;
  }
}

async function onMemberRoleChange(event) {
  if (!ensureCan("team.write")) return;
  const select = event.target.closest("[data-member-role]");
  if (!select) return;
  const userId = select.dataset.memberRole;
  const role = select.value;
  try {
    const { error } = await sb.rpc("admin_set_member_role", { p_user_id: userId, p_role: role });
    if (error) throw error;
    showToast(`Role updated to ${ROLE_LABELS[role]}`, "success");
    await loadTeam();
  } catch (error) {
    showToast(`Could not change role: ${error.message}`, "error");
    await loadTeam();
  }
}

async function onMemberAction(event) {
  if (!ensureCan("team.write")) return;
  const btn = event.target.closest("[data-member-remove]");
  if (!btn) return;
  const userId = btn.dataset.memberRemove;
  const member = membersState.find((m) => m.user_id === userId);
  const label = member ? (member.display_name || member.email) : "this member";

  if (!window.confirm(`Remove ${label}'s admin access?\n\nThey will lose panel access immediately. Their learner account stays intact.`)) {
    return;
  }

  btn.disabled = true;
  try {
    const { error } = await sb.rpc("admin_remove_member", { p_user_id: userId, p_clear_legacy: true });
    if (error) throw error;
    showToast("Admin access removed", "success");
    await loadTeam();
  } catch (error) {
    showToast(`Could not remove member: ${error.message}`, "error");
    btn.disabled = false;
  }
}

/* ----------------------------------------------------------------- sessions */

async function loadSessions() {
  const root = document.getElementById("sessions-root");
  if (!root) return;

  const { data, error } = await sb.rpc("admin_list_sessions");
  if (error) {
    root.innerHTML = `<div class="empty-row">${isMissingFunction(error) ? "Run the platform migration to enable session tracking." : `Could not load sessions: ${esc(error.message)}`}</div>`;
    return;
  }

  sessionsState = Array.isArray(data) ? data : [];
  renderSessions();
}

function shortAgent(ua) {
  const value = String(ua || "Unknown device");
  const browser =
    /Edg\//.test(value) ? "Edge" :
    /OPR\//.test(value) ? "Opera" :
    /Chrome\//.test(value) ? "Chrome" :
    /Firefox\//.test(value) ? "Firefox" :
    /Safari\//.test(value) ? "Safari" : "Browser";
  const os =
    /Android/.test(value) ? "Android" :
    /iPhone|iPad|iOS/.test(value) ? "iOS" :
    /Windows/.test(value) ? "Windows" :
    /Mac OS X/.test(value) ? "macOS" :
    /Linux/.test(value) ? "Linux" : "device";
  return `${browser} on ${os}`;
}

function renderSessions() {
  const root = document.getElementById("sessions-root");
  if (!root) return;

  if (!sessionsState.length) {
    root.innerHTML = `<div class="empty-row">No sessions recorded yet.</div>`;
    return;
  }

  root.innerHTML = sessionsState.map((session) => {
    const isCurrent = session.id === currentAdminSessionId;
    const revoked = Boolean(session.revoked_at);
    return `
      <div class="session-row ${isCurrent ? "is-current" : ""} ${revoked ? "is-revoked" : ""}">
        <div class="session-row__main">
          <div class="session-row__ua">${esc(shortAgent(session.user_agent))}${isCurrent ? ' <span class="role-chip role-chip--support">this device</span>' : ""}</div>
          <div class="session-row__meta">
            ${esc(session.email || "admin")} · signed in ${esc(timeAgo(session.created_at))} · last seen ${esc(timeAgo(session.last_seen_at))}
            ${revoked ? ` · revoked ${esc(timeAgo(session.revoked_at))}` : ""}
          </div>
        </div>
        ${revoked
          ? '<span class="tag tag--failed">revoked</span>'
          : `<button type="button" class="btn btn--danger btn--sm" data-session-revoke="${esc(session.id)}">Revoke</button>`}
      </div>`;
  }).join("");
}

async function onSessionAction(event) {
  if (!ensureCan("team.write")) return;
  const btn = event.target.closest("[data-session-revoke]");
  if (!btn) return;
  const id = btn.dataset.sessionRevoke;
  if (!window.confirm("Revoke this session?\n\nThat tab will be signed out on its next action.")) return;

  btn.disabled = true;
  try {
    const { error } = await sb.rpc("admin_revoke_session", { p_id: id, p_reason: "revoked from settings" });
    if (error) throw error;
    showToast("Session revoked", "success");
    await loadSessions();
  } catch (error) {
    showToast(`Could not revoke session: ${error.message}`, "error");
    btn.disabled = false;
  }
}

async function revokeOtherSessions() {
  if (!ensureCan("team.write")) return;
  if (!window.confirm("Sign out every other admin session except this one?")) return;
  try {
    const { data, error } = await sb.rpc("admin_revoke_other_sessions", { p_keep: currentAdminSessionId });
    if (error) throw error;
    showToast(`${data || 0} other session${Number(data) === 1 ? "" : "s"} revoked`, "success");
    await loadSessions();
  } catch (error) {
    showToast(`Could not revoke sessions: ${error.message}`, "error");
  }
}

async function revokeAllSessions() {
  if (!ensureCan("team.write")) return;
  if (!window.confirm("Sign out EVERY admin session, including this tab?\n\nYou will need to log in again.")) return;
  try {
    const { error } = await sb.rpc("admin_revoke_other_sessions", { p_keep: null });
    if (error) throw error;
    showToast("All sessions revoked — signing you out", "success");
    setTimeout(() => logoutAdmin(), 700);
  } catch (error) {
    showToast(`Could not revoke sessions: ${error.message}`, "error");
  }
}

/* ------------------------------------------------------------------- danger */

function exportSettings() {
  const blob = new Blob([JSON.stringify(settingsState, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pydebug-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  showToast("Settings snapshot downloaded", "success");
}

function copyRotateSql() {
  const sql = `update public.admin_panel_security
set password_hash = crypt('REPLACE_WITH_A_NEW_LONG_PASSPHRASE', gen_salt('bf')), updated_at = now()
where id = 1;`;
  copyAdminText(sql, "Password rotation SQL copied");
}
