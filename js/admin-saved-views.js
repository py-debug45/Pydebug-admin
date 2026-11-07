// admin-saved-views.js — named filter presets for the panel's list screens.
//
// Storage: public.saved_views (RLS: everyone reads their own rows, admins also
// read shared rows, and only the author can update or delete). The panel never
// needs to know the row shape — it hands over a page name and the list of
// filter element ids, and this module reads/writes them.
//
//   AdminSavedViews.init({
//     page: "trash",
//     fields: ["trash-table-filter", "trash-state-filter"],
//     onChange: () => loadTrash(0),
//   });
//
// Elements used (all optional except the select + save button):
//   #saved-view-select  — dropdown of stored views
//   #saved-view-save    — "Save view"
//   #saved-view-shared  — checkbox: share with the rest of the team
//   #saved-view-delete  — "Delete" (only for views you own)

(function () {
  const TABLE = "saved_views";

  function node(id) {
    return document.getElementById(id);
  }

  function toast(message, tone) {
    if (typeof showToast === "function") showToast(message, tone || "success");
  }

  function readState(fields) {
    const state = {};
    fields.forEach((id) => {
      const el = node(id);
      if (!el) return;
      const value = String(el.value == null ? "" : el.value).trim();
      if (value) state[id] = value;
    });
    return state;
  }

  function writeState(fields, state) {
    const source = state && typeof state === "object" ? state : {};
    fields.forEach((id) => {
      const el = node(id);
      if (!el) return;
      const next = Object.prototype.hasOwnProperty.call(source, id) ? String(source[id]) : "";
      el.value = next;
      // A select silently keeps its first option when the stored value is not
      // in the list (e.g. a removed action) — reset it so the filter matches.
      if (el.tagName === "SELECT" && el.value !== next) el.value = el.options[0] ? el.options[0].value : "";
    });
  }

  async function currentUserId() {
    try {
      const { data } = await sb.auth.getUser();
      return (data && data.user && data.user.id) || null;
    } catch (error) {
      return null;
    }
  }

  async function fetchViews(page) {
    const { data, error } = await sb
      .from(TABLE)
      .select("id, name, query, is_shared, admin_id")
      .eq("page", page)
      .order("created_at", { ascending: true });
    return { views: data || [], error };
  }

  function init(config) {
    const options = config || {};
    const page = options.page;
    const fields = Array.isArray(options.fields) ? options.fields : [];
    const onChange = typeof options.onChange === "function" ? options.onChange : null;

    const select = node("saved-view-select");
    const saveBtn = node("saved-view-save");
    const deleteBtn = node("saved-view-delete");
    const sharedBox = node("saved-view-shared");
    if (!select || !saveBtn || !page) return null;

    let views = [];
    let me = null;

    function render() {
      select.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = views.length ? "Saved views…" : "No saved views yet";
      select.appendChild(placeholder);

      views.forEach((view) => {
        const option = document.createElement("option");
        option.value = view.id;
        option.textContent = view.is_shared ? `${view.name} · shared` : view.name;
        select.appendChild(option);
      });

      select.value = "";
      if (deleteBtn) deleteBtn.hidden = true;
    }

    async function reload() {
      const result = await fetchViews(page);
      views = result.views;
      if (result.error) toast(`Saved views: ${result.error.message}`, "warn");
      render();
    }

    select.addEventListener("change", () => {
      const view = views.find((item) => item.id === select.value);
      if (deleteBtn) deleteBtn.hidden = !(view && me && view.admin_id === me);
      if (!view) return;
      writeState(fields, view.query);
      if (onChange) onChange();
      toast(`View “${view.name}” applied`);
    });

    saveBtn.addEventListener("click", async () => {
      const state = readState(fields);
      if (Object.keys(state).length === 0) {
        toast("Set at least one filter before saving a view", "warn");
        return;
      }
      const name = (window.prompt("Name this view (for example: Archived notifications)") || "").trim();
      if (!name) return;
      if (name.length > 60) {
        toast("Keep the name under 60 characters", "warn");
        return;
      }

      saveBtn.disabled = true;
      try {
        if (!me) me = await currentUserId();
        const { error } = await sb.from(TABLE).insert({
          admin_id: me,
          page,
          name,
          query: state,
          is_shared: !!(sharedBox && sharedBox.checked),
        });
        if (error) {
          toast(`Could not save the view: ${error.message}`, "error");
          return;
        }
        toast(`View “${name}” saved`);
        await reload();
      } finally {
        saveBtn.disabled = false;
      }
    });

    if (deleteBtn) {
      deleteBtn.addEventListener("click", async () => {
        const view = views.find((item) => item.id === select.value);
        if (!view) return;
        const ok = window.confirm(`Delete the saved view “${view.name}”?`);
        if (!ok) return;
        const { error } = await sb.from(TABLE).delete().eq("id", view.id);
        if (error) {
          toast(`Could not delete the view: ${error.message}`, "error");
          return;
        }
        toast(`View “${view.name}” deleted`);
        await reload();
      });
    }

    (async () => {
      me = await currentUserId();
      await reload();
    })();

    return { reload };
  }

  window.AdminSavedViews = { init };
})();
