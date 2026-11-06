// admin-command.js — ⌘K command palette for the PyDebug admin panel.
//
// One keystroke to reach any page, any learner, any problem, or an action.
// Deliberately dependency-free and lazy: nothing is fetched until the first
// open, queries are debounced, and every result is permission-filtered using
// the identity loaded by admin-common.js (`can()`).
//
// Keyboard: ⌘K / Ctrl+K to open, ↑ ↓ to move, Enter to run, Esc to close.
// Touch: the top-bar "Search ⌘K" button opens the same palette.

(function () {
  "use strict";

  const RECENTS_KEY = "pydebug_admin_cmdk_recents_v1";
  const MAX_RESULTS = 24;
  const SEARCH_DEBOUNCE_MS = 220;

  let mounted = false;
  let open = false;
  let items = [];
  let activeIndex = 0;
  let searchTimer = null;
  let searchSeq = 0;
  let lastQuery = "";
  let overlay, input, list, empty, hint;

  const PAGES = [
    { label: "Dashboard", href: "dashboard.html", perm: "dashboard.read", keywords: "home overview kpi revenue" },
    { label: "Users", href: "users.html", perm: "users.read", keywords: "learners profiles campus students" },
    { label: "Payments", href: "payments.html", perm: "payments.read", keywords: "orders grants entitlements revenue refund" },
    { label: "Coupons & Creators", href: "coupons.html", perm: "coupons.read", keywords: "promo discount affiliate creator" },
    { label: "Submissions", href: "submissions.html", perm: "submissions.read", keywords: "code runs attempts" },
    { label: "Add Problem", href: "problem-form.html", perm: "problems.write", keywords: "new problem create question" },
    { label: "Community & Hub", href: "community.html", perm: "community.read", keywords: "posts classrooms enquiries feedback flags" },
    { label: "Discussions", href: "discussions.html", perm: "community.read", keywords: "comments chat moderation" },
    { label: "Certificates", href: "certificates.html", perm: "certificates.read", keywords: "verify revoke certificate" },
    { label: "Mocks & Battles", href: "arenas.html", perm: "dashboard.read", keywords: "mock tests battles study plans arenas" },
    { label: "Notifications", href: "notifications.html", perm: "notifications.read", keywords: "push broadcast announce bell" },
    { label: "AI Control", href: "ai.html", perm: "ai.read", keywords: "interview studio ai safety hints" },
    { label: "Growth insights", href: "insights.html", perm: "dashboard.read", keywords: "funnel conversion churn analytics" },
    { label: "Audit log", href: "audit.html", perm: "audit.read", keywords: "security history actions sessions" },
    { label: "Trash", href: "trash.html", perm: "trash.read", keywords: "deleted restore archive undo" },
    { label: "Settings", href: "settings.html", perm: "settings.read", keywords: "config flags team roles maintenance limits plans" },
  ];

  const ACTIONS = [
    {
      label: "New problem",
      hint: "Open the problem editor",
      perm: "problems.write",
      keywords: "create add question",
      run: () => (window.location.href = "problem-form.html"),
    },
    {
      label: "Send a notification",
      hint: "Broadcast bell + push",
      perm: "notifications.write",
      keywords: "push broadcast announce message",
      run: () => (window.location.href = "notifications.html"),
    },
    {
      label: "Feature flags & kill switches",
      hint: "Turn product features on or off",
      perm: "settings.write",
      keywords: "flags toggle rollouts maintenance",
      run: () => (window.location.href = "settings.html#flags"),
    },
    {
      label: "Manage team & roles",
      hint: "Invite an admin, change permissions",
      perm: "team.read",
      keywords: "admin invite role permission owner support finance",
      run: () => (window.location.href = "settings.html#team"),
    },
    {
      label: "Review the Trash",
      hint: "Restore or permanently delete archived rows",
      perm: "trash.read",
      keywords: "deleted restore undo archive purge",
      run: () => (window.location.href = "trash.html"),
    },
    {
      label: "Refresh this page",
      hint: "Reload the current view",
      keywords: "reload sync update",
      run: () => window.location.reload(),
    },
    {
      label: "Export the visible table",
      hint: "Clicks the page's CSV export button",
      keywords: "csv download export data",
      run: () => {
        const btn = document.querySelector('[id^="export-"]');
        if (btn) btn.click();
        else if (typeof showToast === "function") showToast("This page has no export button", "error");
      },
    },
    {
      label: "Log out",
      hint: "End this admin session",
      keywords: "sign out exit",
      run: () => (typeof logoutAdmin === "function" ? logoutAdmin() : window.location.assign("index.html")),
    },
  ];

  function can(perm) {
    return typeof window.can === "function" ? window.can(perm) : true;
  }

  function escapeHtmlLocal(value) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(String(value ?? ""));
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function readRecents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
    } catch (e) {
      return [];
    }
  }

  function remember(item) {
    if (!item || !item.id) return;
    try {
      const recent = readRecents().filter((r) => r.id !== item.id);
      recent.unshift({ id: item.id, label: item.label, type: item.type, href: item.href, runId: item.runId });
      localStorage.setItem(RECENTS_KEY, JSON.stringify(recent.slice(0, 5)));
    } catch (e) {}
  }

  function score(text, query) {
    const hay = String(text || "").toLowerCase();
    const q = query.toLowerCase().trim();
    if (!hay || !q) return 0;
    const direct = hay.indexOf(q);
    if (direct === 0) return 100 - Math.min(20, hay.length - q.length);
    if (direct > 0) return 70 - Math.min(20, direct);
    // Subsequence match ("std" -> "Settings · Team")
    let pos = 0;
    let gaps = 0;
    for (const ch of q) {
      const found = hay.indexOf(ch, pos);
      if (found === -1) return 0;
      gaps += found - pos;
      pos = found + 1;
    }
    return Math.max(10, 45 - gaps);
  }

  function baseItems() {
    const recents = readRecents()
      .filter((r) => !r.href || PAGES.some((p) => p.href === r.href))
      .map((r) => ({
        id: `recent:${r.id}`,
        label: r.label,
        hint: "Recent",
        type: "recent",
        href: r.href,
        runId: r.runId,
        icon: "clock",
      }));

    const pages = PAGES.filter((p) => can(p.perm)).map((p) => ({
      id: `page:${p.href}`,
      label: p.label,
      hint: "Page",
      type: "page",
      href: p.href,
      keywords: p.keywords,
      icon: p.href === "settings.html" ? "settings" : (p.href === "trash.html" ? "trash" : "arrowRight"),
    }));

    const actions = ACTIONS.filter((a) => can(a.perm || "")).map((a) => ({
      id: `action:${a.label}`,
      label: a.label,
      hint: a.hint || "Action",
      type: "action",
      run: a.run,
      keywords: a.keywords,
      icon: "zap",
    }));

    return [...recents, ...pages, ...actions];
  }

  function remoteItems(results) {
    return results.map((r) => ({
      id: r.id,
      label: r.label,
      hint: r.hint,
      type: r.type,
      href: r.href,
      icon: r.icon || "search",
    }));
  }

  function render() {
    if (!list) return;
    if (!items.length) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    activeIndex = Math.max(0, Math.min(activeIndex, items.length - 1));

    list.innerHTML = items.map((item, index) => {
      const icon = typeof window.adminIcon === "function" ? window.adminIcon(item.icon || "search", "cmdk-icon") : "";
      return `
        <li role="option" id="cmdk-option-${index}" aria-selected="${index === activeIndex}" class="cmdk-item${index === activeIndex ? " is-active" : ""}" data-cmdk-index="${index}">
          ${icon}
          <span class="cmdk-item__text">
            <span class="cmdk-item__label">${escapeHtmlLocal(item.label)}</span>
            <span class="cmdk-item__hint">${escapeHtmlLocal(item.hint || "")}</span>
          </span>
          <span class="cmdk-item__type">${escapeHtmlLocal(item.type)}</span>
        </li>`;
    }).join("");

    if (input && items[activeIndex]) {
      input.setAttribute("aria-activedescendant", `cmdk-option-${activeIndex}`);
    }
  }

  function setItems(next) {
    items = next.slice(0, MAX_RESULTS);
    render();
  }

  function filterLocal(query) {
    const base = baseItems();
    if (!query.trim()) return base;
    return base
      .map((item) => ({ item, s: Math.max(score(item.label, query), score(item.keywords || "", query) * 0.6, score(item.hint || "", query) * 0.4) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.item);
  }

  async function searchRemote(query) {
    if (!query.trim() || query.trim().length < 2) return [];
    if (typeof sb === "undefined" || !sb) return [];

    const seq = ++searchSeq;
    const q = query.trim();
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const results = [];

    const jobs = [];

    if (can("users.read")) {
      jobs.push(
        sb.from("profiles")
          .select("id, email, display_name, full_name")
          .or(`email.ilike.${like},display_name.ilike.${like},full_name.ilike.${like}`)
          .limit(5)
          .then(({ data }) => {
            (data || []).forEach((u) => results.push({
              id: `user:${u.id}`,
              label: u.display_name || u.full_name || u.email || u.id,
              hint: `Learner · ${u.email || ""}`,
              type: "user",
              href: `user-detail.html?id=${encodeURIComponent(u.id)}`,
              icon: "users",
            }));
          })
      );
    }

    if (can("problems.read")) {
      jobs.push(
        sb.from("problems")
          .select("id, title, difficulty")
          .ilike("title", like)
          .limit(5)
          .then(({ data }) => {
            (data || []).forEach((p) => results.push({
              id: `problem:${p.id}`,
              label: p.title || `Problem #${p.id}`,
              hint: `Problem · ${p.difficulty || "unrated"}`,
              type: "problem",
              href: `problem-form.html?id=${encodeURIComponent(p.id)}`,
              icon: "code",
            }));
          })
      );
    }

    if (can("payments.read")) {
      jobs.push(
        sb.from("payment_orders")
          .select("order_id, amount, status")
          .ilike("order_id", like)
          .limit(4)
          .then(({ data }) => {
            (data || []).forEach((o) => results.push({
              id: `order:${o.order_id}`,
              label: o.order_id,
              hint: `Order · ${o.status || "unknown"}`,
              type: "order",
              href: "payments.html",
              icon: "card",
            }));
          })
      );
    }

    await Promise.all(jobs.map((j) => Promise.resolve(j).catch(() => {})));

    // A slower response for an older query must never overwrite newer results.
    if (seq !== searchSeq) return [];
    return remoteItems(results);
  }

  function runQuery(rawQuery) {
    const query = rawQuery || "";
    lastQuery = query;
    const local = filterLocal(query);
    setItems(local);

    clearTimeout(searchTimer);
    if (!query.trim() || query.trim().length < 2) return;

    searchTimer = setTimeout(async () => {
      const remote = await searchRemote(query);
      if (!open || query !== lastQuery) return;
      // Deduplicate by id, keep local page/action hits first.
      const seen = new Set(local.map((i) => i.id));
      setItems([...local, ...remote.filter((r) => !seen.has(r.id))]);
    }, SEARCH_DEBOUNCE_MS);
  }

  function choose(index) {
    const item = items[index];
    if (!item) return;
    remember(item);
    close();
    if (typeof item.run === "function") {
      item.run();
      return;
    }
    if (item.href) window.location.href = item.href;
  }

  function move(delta) {
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    render();
    const active = list && list.querySelector(".cmdk-item.is-active");
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  function build() {
    overlay = document.createElement("div");
    overlay.className = "cmdk-overlay";
    overlay.id = "admin-cmdk";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="cmdk-input-row">
          ${typeof window.adminIcon === "function" ? window.adminIcon("search", "cmdk-search-icon") : ""}
          <input id="cmdk-input" class="cmdk-input" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Search pages, learners, problems, orders, actions…"
                 role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list">
          <kbd class="cmdk-esc">Esc</kbd>
        </div>
        <ul id="cmdk-list" class="cmdk-list" role="listbox" aria-label="Results"></ul>
        <div class="cmdk-empty" id="cmdk-empty" hidden>
          Kuch nahi mila. Try a learner email, problem title, order id, or a page name.
        </div>
        <div class="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          <span class="cmdk-foot__brand">PyDebug Admin</span>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    input = overlay.querySelector("#cmdk-input");
    list = overlay.querySelector("#cmdk-list");
    empty = overlay.querySelector("#cmdk-empty");

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    input.addEventListener("input", () => {
      activeIndex = 0;
      runQuery(input.value);
    });
    list.addEventListener("mousemove", (e) => {
      const row = e.target.closest("[data-cmdk-index]");
      if (!row) return;
      const index = Number(row.dataset.cmdkIndex);
      if (index !== activeIndex) {
        activeIndex = index;
        render();
      }
    });
    list.addEventListener("click", (e) => {
      const row = e.target.closest("[data-cmdk-index]");
      if (!row) return;
      choose(Number(row.dataset.cmdkIndex));
    });

    mounted = true;
  }

  function openPalette(prefill) {
    if (!mounted) build();
    open = true;
    activeIndex = 0;
    overlay.hidden = false;
    document.body.classList.add("cmdk-open");
    input.value = prefill || "";
    runQuery(input.value);
    // Focus after the overlay paints so mobile keyboards open reliably.
    requestAnimationFrame(() => input && input.focus());
  }

  function close() {
    if (!open) return;
    open = false;
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("cmdk-open");
  }

  function onKeydown(event) {
    const key = event.key;
    const isPaletteKey = (event.metaKey || event.ctrlKey) && String(key).toLowerCase() === "k";

    if (isPaletteKey) {
      event.preventDefault();
      open ? close() : openPalette();
      return;
    }

    if (!open) return;

    if (key === "Escape") {
      event.preventDefault();
      close();
    } else if (key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  }

  function mount() {
    if (mounted) return;
    build();
    document.addEventListener("keydown", onKeydown, true);
  }

  window.AdminCommand = { mount, open: openPalette, close, isOpen: () => open };

  // Admin pages load this file with `defer`, so the DOM is ready here.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
