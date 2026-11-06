// admin-audit.js — audit log viewer + shared write helper.
//
// Production upgrades over the original 300-row, client-filtered view:
//   • real server-side pagination (count + range) so nothing disappears
//   • date range + action filters applied in SQL, not in the browser
//   • CSV export of the full filtered result set
//   • device / session columns (user_agent, ip, session_id) when present
//   • a failed audit write is loud, never a silent console.warn

let cachedAuditRows = [];
let auditPage = 0;
let auditTotal = 0;

const AUDIT_PAGE_SIZE = ADMIN_PAGE_SIZE;
const AUDIT_EXPORT_LIMIT = 5000;

onAdminReady(async () => {
  if (!document.getElementById("audit-body")) return;
  if (!(await requirePerm("audit.read"))) return;

  await loadAudit(0);

  document.getElementById("refresh-audit")?.addEventListener("click", () => loadAudit(auditPage));
  document.getElementById("audit-export-btn")?.addEventListener("click", exportAudit);
  document.getElementById("audit-action")?.addEventListener("change", () => loadAudit(0));
  document.getElementById("audit-from")?.addEventListener("change", () => loadAudit(0));
  document.getElementById("audit-to")?.addEventListener("change", () => loadAudit(0));

  const searchEl = document.getElementById("audit-search");
  if (searchEl) searchEl.addEventListener("input", debounce(() => loadAudit(0), 300));
});

function auditFilters() {
  const action = document.getElementById("audit-action")?.value || "all";
  const search = (document.getElementById("audit-search")?.value || "").trim();
  const from = document.getElementById("audit-from")?.value || "";
  const to = document.getElementById("audit-to")?.value || "";
  return { action, search, from, to };
}

function applyAuditFilters(query, filters) {
  if (filters.action && filters.action !== "all") query = query.eq("action", filters.action);

  if (filters.from) {
    const start = new Date(`${filters.from}T00:00:00`);
    if (!Number.isNaN(start.getTime())) query = query.gte("created_at", start.toISOString());
  }
  if (filters.to) {
    const end = new Date(`${filters.to}T23:59:59.999`);
    if (!Number.isNaN(end.getTime())) query = query.lte("created_at", end.toISOString());
  }

  if (filters.search) {
    const term = sanitizeIlike(filters.search);
    if (term) {
      const safe = term.replace(/[(),]/g, " ");
      query = query.or([
        `action.ilike.%${safe}%`,
        `entity_type.ilike.%${safe}%`,
        `entity_id.ilike.%${safe}%`,
        `target_id.ilike.%${safe}%`,
        `reason.ilike.%${safe}%`,
      ].join(","));
    }
  }

  return query;
}

async function loadAudit(page) {
  const body = document.getElementById("audit-body");
  if (!body) return;

  auditPage = Math.max(0, Number(page) || 0);
  body.innerHTML = `<tr><td colspan="7" class="empty-row">Loading audit events…</td></tr>`;

  const filters = auditFilters();
  let query = sb
    .from("admin_audit_log")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(auditPage * AUDIT_PAGE_SIZE, auditPage * AUDIT_PAGE_SIZE + AUDIT_PAGE_SIZE - 1);

  query = applyAuditFilters(query, filters);

  const { data, error, count } = await query;

  if (error) {
    body.innerHTML = `<tr><td colspan="7" class="empty-row">Could not load audit log: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  cachedAuditRows = Array.isArray(data) ? data : [];
  auditTotal = Number.isFinite(count) ? count : cachedAuditRows.length;
  renderAuditRows();
  renderPagination(document.getElementById("audit-pagination"), auditPage, auditTotal, (next) => loadAudit(next));
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 10 ? `${text.slice(0, 8)}…` : text || "—";
}

function deviceLabel(row) {
  const ua = String(row.user_agent || "");
  if (!ua && !row.ip) return '<span class="muted">—</span>';
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Safari\//.test(ua) ? "Safari" : "Browser";
  const os =
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad|iOS/.test(ua) ? "iOS" :
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" : "";
  const label = ua ? `${browser}${os ? ` · ${os}` : ""}` : "Unknown device";
  const ip = row.ip ? String(row.ip) : "";
  const title = [ua, ip, row.session_id ? `session ${row.session_id}` : ""].filter(Boolean).join("\n");
  return `<span title="${escapeHtml(title)}" style="font-size:0.72rem">${escapeHtml(label)}${ip ? `<br><span class="muted mono" style="font-size:0.64rem">${escapeHtml(ip)}</span>` : ""}</span>`;
}

function detailsOf(row) {
  const details = row.new_value && Object.keys(row.new_value).length ? row.new_value : (row.metadata || {});
  const reason = row.reason ? `[${row.reason}] ` : "";
  const json = JSON.stringify(details);
  return `<span class="mono" style="font-size:0.72rem;display:inline-block;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(reason + json)}">${escapeHtml(reason + json)}</span>`;
}

function renderAuditRows() {
  const body = document.getElementById("audit-body");
  if (!body) return;

  if (!cachedAuditRows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-row">No audit events match these filters.</td></tr>`;
    return;
  }

  body.innerHTML = cachedAuditRows.map((row) => `
    <tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(row.created_at))}">${escapeHtml(timeAgo(row.created_at))}</td>
      <td class="mono muted" title="${escapeHtml(row.admin_id || "")}">${escapeHtml(shortId(row.admin_id))}</td>
      <td><span class="tag tag--info">${escapeHtml(row.action || "")}</span></td>
      <td>${escapeHtml(row.entity_type || row.resource || "—")}</td>
      <td class="mono muted">${escapeHtml(row.entity_id || row.target_id || "—")}</td>
      <td>${deviceLabel(row)}</td>
      <td>${detailsOf(row)}</td>
    </tr>`).join("");
}

async function exportAudit() {
  const btn = document.getElementById("audit-export-btn");
  if (btn) btn.disabled = true;
  try {
    const filters = auditFilters();
    let query = sb
      .from("admin_audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(AUDIT_EXPORT_LIMIT);
    query = applyAuditFilters(query, filters);

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data || []).map((row) => ({
      created_at: row.created_at,
      admin_id: row.admin_id || "",
      action: row.action || "",
      entity_type: row.entity_type || row.resource || "",
      entity_id: row.entity_id || row.target_id || "",
      reason: row.reason || "",
      ip: row.ip || "",
      user_agent: row.user_agent || "",
      session_id: row.session_id || "",
      details: JSON.stringify(row.new_value && Object.keys(row.new_value).length ? row.new_value : (row.metadata || {})),
    }));

    if (!rows.length) {
      showToast("Nothing to export for these filters", "error");
      return;
    }
    downloadCSV(`pydebug-audit-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  } catch (error) {
    showToast(`Could not export audit log: ${error.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Backwards-compatible helper used by older pages.
async function writeAudit(action, entityType, entityId, metadata = {}) {
  if (typeof writeAdminAudit === "function") {
    return writeAdminAudit(action, entityType, entityId, metadata);
  }
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
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
    if (error) throw error;
  } catch (e) {
    console.error("[admin] audit log failed:", e.message);
    if (typeof showToast === "function") showToast("Audit log entry failed — check the console", "error");
  }
}
