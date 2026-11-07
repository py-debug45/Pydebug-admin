// admin-trash.js — soft-delete archive (restore / purge) for the admin panel.
//
// Every destructive button in the panel now calls admin_soft_delete(), which
// copies the row into deletion_archive before removing it. This page is the
// undo layer: filter, inspect, restore or permanently purge — all audited.

const TRASH_PAGE_SIZE = ADMIN_PAGE_SIZE; // keeps renderPagination() page maths exact

let trashRows = [];
let trashPage = 0;
let trashTotal = 0;
let trashSearchTerm = "";
let trashHasArchive = true;

onAdminReady(async () => {
  const admin = await requirePerm("trash.read");
  if (!admin) return;

  await loadTrash(0);

  const search = document.getElementById("trash-search");
  if (search) {
    search.addEventListener("input", debounce(() => {
      trashSearchTerm = search.value.trim().toLowerCase();
      renderTrash();
    }, 200));
  }

  document.getElementById("trash-table-filter")?.addEventListener("change", () => loadTrash(0));
  document.getElementById("trash-state-filter")?.addEventListener("change", () => loadTrash(0));
  document.getElementById("trash-refresh-btn")?.addEventListener("click", () => loadTrash(trashPage));
  document.getElementById("trash-export-btn")?.addEventListener("click", exportTrash);
  document.getElementById("trash-clear-btn")?.addEventListener("click", () => {
    const table = document.getElementById("trash-table-filter");
    const state = document.getElementById("trash-state-filter");
    if (table) table.value = "all";
    if (state) state.value = "archived";
    if (search) search.value = "";
    trashSearchTerm = "";
    loadTrash(0);
  });

  if (window.AdminSavedViews) {
    AdminSavedViews.init({
      page: "trash",
      fields: ["trash-table-filter", "trash-state-filter", "trash-search"],
      onChange: () => {
        const field = document.getElementById("trash-search");
        trashSearchTerm = (field?.value || "").trim().toLowerCase();
        loadTrash(0);
      },
    });
  }

  const tbody = document.getElementById("trash-tbody");
  tbody?.addEventListener("click", onTrashAction);
});

function trashStateOf(row) {
  if (row.purged_at) return "purged";
  if (row.restored_at) return "restored";
  return "archived";
}

function currentTrashFilters() {
  return {
    table: document.getElementById("trash-table-filter")?.value || "all",
    state: document.getElementById("trash-state-filter")?.value || "archived",
  };
}

async function loadTrash(page) {
  const tbody = document.getElementById("trash-tbody");
  const filters = currentTrashFilters();
  trashPage = Math.max(0, page);

  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Loading Trash…</td></tr>`;
  }

  let query = sb
    .from("deletion_archive")
    .select("*", { count: "exact" })
    .order("deleted_at", { ascending: false })
    .range(trashPage * TRASH_PAGE_SIZE, trashPage * TRASH_PAGE_SIZE + TRASH_PAGE_SIZE - 1);

  if (filters.table !== "all") query = query.eq("table_name", filters.table);

  if (filters.state === "archived") query = query.is("restored_at", null).is("purged_at", null);
  else if (filters.state === "restored") query = query.not("restored_at", "is", null);
  else if (filters.state === "purged") query = query.not("purged_at", "is", null);

  const { data, error, count } = await query;

  if (error) {
    if (tbody) {
      if (isMissingTable(error)) {
        trashHasArchive = false;
        tbody.innerHTML = `<tr><td colspan="7" class="empty-row">
          Trash is not set up yet. Run <code>db/migrations/20261106_admin_platform_core.sql</code> in
          Supabase → SQL Editor, then refresh this page.
        </td></tr>`;
      } else {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Could not load Trash: ${escapeHtml(error.message)}</td></tr>`;
      }
    }
    return;
  }

  trashHasArchive = true;
  trashRows = Array.isArray(data) ? data : [];
  trashTotal = Number.isFinite(count) ? count : trashRows.length;
  renderTrash();
}

function isMissingTable(error) {
  const msg = String(error?.message || "").toLowerCase();
  return error?.code === "42P01" || msg.includes("does not exist") || msg.includes("schema cache");
}

function trashPreview(row) {
  const payload = row.payload || {};
  const candidates = [
    payload.title,
    payload.display_name,
    payload.email,
    payload.message,
    payload.body,
    payload.comment,
    payload.code,
    payload.content,
  ].filter((v) => typeof v === "string" && v.trim());

  if (!candidates.length) return `<span class="muted">${escapeHtml(JSON.stringify(payload).slice(0, 90))}…</span>`;
  const text = candidates[0].replace(/\s+/g, " ").trim();
  return escapeHtml(text.length > 110 ? `${text.slice(0, 110)}…` : text);
}

function renderTrash() {
  const tbody = document.getElementById("trash-tbody");
  const countEl = document.getElementById("trash-count");
  if (!tbody) return;

  if (countEl) countEl.textContent = trashTotal ? String(trashTotal) : "";

  const rows = trashSearchTerm
    ? trashRows.filter((row) => {
        const hay = JSON.stringify({
          id: row.row_id,
          table: row.table_name,
          reason: row.reason,
          payload: row.payload,
        }).toLowerCase();
        return hay.includes(trashSearchTerm);
      })
    : trashRows;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${
      trashSearchTerm ? "No archived rows match this search." : "Trash is empty — nothing to restore."
    }</td></tr>`;
    renderTrashPagination();
    return;
  }

  const canWrite = can("trash.write");

  tbody.innerHTML = rows.map((row) => {
    const state = trashStateOf(row);
    const stateTag =
      state === "archived" ? '<span class="tag tag--attempted">in trash</span>' :
      state === "restored" ? '<span class="tag tag--solved">restored</span>' :
      '<span class="tag tag--failed">purged</span>';

    return `<tr>
      <td class="muted" title="${escapeHtml(fmtDateTime(row.deleted_at))}">${escapeHtml(timeAgo(row.deleted_at))}</td>
      <td><span class="tag tag--info trash-table-tag">${escapeHtml(row.table_name)}</span></td>
      <td class="mono muted" title="${escapeHtml(row.row_id)}">${escapeHtml(String(row.row_id).slice(0, 10))}…</td>
      <td>
        <div class="trash-preview">${trashPreview(row)}</div>
        <details>
          <summary class="muted" style="cursor:pointer;font-size:0.68rem">View JSON</summary>
          <pre class="trash-preview" style="max-height:180px;overflow:auto;white-space:pre-wrap">${escapeHtml(JSON.stringify(row.payload, null, 2))}</pre>
        </details>
      </td>
      <td class="muted">${escapeHtml(row.reason || "—")}</td>
      <td>${stateTag}</td>
      <td>
        <div class="trash-actions">
          ${state === "archived" && canWrite
            ? `<button type="button" class="btn btn--primary btn--sm" data-trash-restore="${escapeHtml(row.id)}">Restore</button>
               <button type="button" class="btn btn--danger btn--sm" data-trash-purge="${escapeHtml(row.id)}">Purge</button>`
            : '<span class="muted" style="font-size:0.7rem">—</span>'}
        </div>
      </td>
    </tr>`;
  }).join("");

  renderTrashPagination();
}

function renderTrashPagination() {
  const root = document.getElementById("trash-pagination");
  if (!root) return;
  if (!trashHasArchive) {
    root.innerHTML = "";
    return;
  }
  renderPagination(root, trashPage, trashTotal, (nextPage) => loadTrash(nextPage));
}

async function onTrashAction(event) {
  const restoreBtn = event.target.closest("[data-trash-restore]");
  const purgeBtn = event.target.closest("[data-trash-purge]");

  if (restoreBtn) {
    const id = restoreBtn.dataset.trashRestore;
    restoreBtn.disabled = true;
    restoreBtn.textContent = "Restoring…";
    try {
      const { error } = await sb.rpc("admin_restore_row", { p_archive_id: id });
      if (error) throw error;
      showToast("Row restored — it is live again", "success");
      await loadTrash(trashPage);
    } catch (error) {
      showToast(`Could not restore: ${error.message}`, "error");
      restoreBtn.disabled = false;
      restoreBtn.textContent = "Restore";
    }
    return;
  }

  if (purgeBtn) {
    const id = purgeBtn.dataset.trashPurge;
    const typed = window.prompt(
      "This permanently deletes the archived row. Type PURGE to confirm.\n\n(It stays in the audit log as a purged event.)"
    );
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== "PURGE") {
      showToast("Purge cancelled — confirmation text did not match", "error");
      return;
    }

    purgeBtn.disabled = true;
    purgeBtn.textContent = "Purging…";
    try {
      const { error } = await sb.rpc("admin_purge_row", { p_archive_id: id });
      if (error) throw error;
      showToast("Row permanently purged", "success");
      await loadTrash(trashPage);
    } catch (error) {
      showToast(`Could not purge: ${error.message}`, "error");
      purgeBtn.disabled = false;
      purgeBtn.textContent = "Purge";
    }
  }
}

function exportTrash() {
  if (!trashRows.length) {
    showToast("Nothing to export", "error");
    return;
  }
  const rows = trashRows.map((row) => ({
    archive_id: row.id,
    deleted_at: row.deleted_at,
    table_name: row.table_name,
    row_id: row.row_id,
    reason: row.reason || "",
    state: trashStateOf(row),
    restored_at: row.restored_at || "",
    purged_at: row.purged_at || "",
    deleted_by: row.deleted_by || "",
    payload: JSON.stringify(row.payload || {}),
  }));
  downloadCSV(`pydebug-trash-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}
