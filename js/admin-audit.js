// admin-audit.js — audit log viewer + shared writeAudit helper.

let cachedAuditRows = [];

onAdminReady(async () => {
  if (!document.getElementById("audit-body")) return;
  if (!(await requireAdmin())) return;
  await loadAudit();
  document.getElementById("refresh-audit").onclick = loadAudit;
  document.getElementById("audit-action").onchange = loadAudit;
  const searchEl = document.getElementById("audit-search");
  if (searchEl) searchEl.addEventListener("input", debounce(renderAuditRows, 200));
});

async function loadAudit() {
  const body = document.getElementById("audit-body");
  let q = sb.from("admin_audit_log").select("*").order("created_at", { ascending: false }).limit(300);
  const a = document.getElementById("audit-action").value;
  if (a !== "all") q = q.eq("action", a);
  const { data, error } = await q;
  if (error) {
    body.innerHTML = `<tr><td colspan="5" class="empty-row">Could not load audit log: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  cachedAuditRows = data || [];
  renderAuditRows();
}

function renderAuditRows() {
  const body = document.getElementById("audit-body");
  const searchEl = document.getElementById("audit-search");
  const term = searchEl ? searchEl.value.trim().toLowerCase() : "";

  const rows = cachedAuditRows.filter((x) => {
    if (!term) return true;
    const hay = `${x.action || ""} ${x.entity_type || x.resource || ""} ${x.entity_id || x.target_id || ""} ${x.reason || ""} ${JSON.stringify(x.new_value || x.metadata || {})}`.toLowerCase();
    return hay.includes(term);
  });

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty-row">No audit events match your filter.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((x) => {
    const detailsObj = x.new_value && Object.keys(x.new_value).length ? x.new_value : (x.metadata || {});
    const reasonBit = x.reason ? `[${x.reason}] ` : "";
    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(x.created_at))}">${escapeHtml(timeAgo(x.created_at))}</td>
      <td><span class="tag tag--info">${escapeHtml(x.action || "")}</span></td>
      <td>${escapeHtml(x.entity_type || x.resource || "—")}</td>
      <td class="mono muted">${escapeHtml(x.entity_id || x.target_id || "—")}</td>
      <td class="mono" style="font-size:0.75rem;max-width:360px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(reasonBit + JSON.stringify(detailsObj))}</td>
    </tr>`;
  }).join("");
}

async function writeAudit(action, entityType, entityId, metadata = {}) {
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (user) {
      const { error } = await sb.from("admin_audit_log").insert({
        admin_id: user.id,
        action,
        resource: String(entityType || "admin-panel"),
        target_id: String(entityId || ""),
        entity_type: String(entityType || "admin-panel"),
        entity_id: String(entityId || ""),
        new_value: metadata || {},
        metadata: metadata || {},
      });
      if (error) console.warn("audit log:", error.message);
    }
  } catch (e) {
    console.warn("audit log:", e.message);
  }
}
