"use strict";

(() => {
  const state = { session: null, csrf: null, searchTimer: null };
  const MATRIX = {
    dashboard: { read: "*" },
    users: { read: ["superadmin","support","finance","moderator","analyst"], reveal_email: ["superadmin","support","finance"], edit: ["superadmin","support"], grant_premium: ["superadmin","support","finance"], revoke_premium: ["superadmin","finance"], suspend: ["superadmin","support"], warn: ["superadmin","moderator"], mute: ["superadmin","moderator"], adjust_xp: ["superadmin","support"], reset_progress: ["superadmin"], restore_streak: ["superadmin","support"], grant_freeze: ["superadmin","support"], set_battle_invites: ["superadmin","support"], delete: ["superadmin"] },
    problems: { read: ["superadmin","content_editor","support","moderator","analyst"], create: ["superadmin","content_editor"], edit: ["superadmin","content_editor"], delete: ["superadmin","content_editor"] },
    payments: { read: ["superadmin","support","finance","analyst"], manual_grant: ["superadmin","finance"], reconcile: ["superadmin","finance"] },
    referrals: { read: ["superadmin","support","finance","moderator","analyst"], invalidate: ["superadmin","moderator"] },
    battles: { read: ["superadmin","support","moderator","analyst"], cleanup: ["superadmin"] },
    moderation: { read: ["superadmin","support","moderator","analyst"], resolve: ["superadmin","moderator"] },
    push: { read: ["superadmin","analyst"], send: ["superadmin"], test_send: ["superadmin","support"] },
    emails: { read: ["superadmin","analyst"], test_send: ["superadmin","support"] },
    reports: { read: ["superadmin","finance","analyst"] },
    settings: { read: ["superadmin"], edit: ["superadmin"] },
    audit: { read: "*" },
  };

  const nav = [
    ["index.html","dashboard","⌁","Dashboard","dashboard"],
    ["users.html","users","◎","Users","users"],
    ["problems.html","problems","◇","Problems","problems"],
    ["payments.html","payments","₹","Payments","payments"],
    ["referrals.html","referrals","↗","Referrals","referrals"],
    ["battles.html","battles","⚔","Battles","battles"],
    ["moderation.html","moderation","◉","Moderation","moderation"],
    ["push.html","push","◌","Push center","push"],
    ["emails.html","emails","✉","Emails","emails"],
    ["reports.html","reports","▥","Reports","reports"],
    ["settings.html","settings","⚙","Settings","settings"],
    ["audit.html","audit","≡","Audit log","audit"],
  ];

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }
  function attr(value) { return esc(value).replace(/`/g, "&#96;"); }
  function fmt(value) { return Number(value || 0).toLocaleString("en-IN"); }
  function inr(paise) { return paise == null ? "Restricted" : `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; }
  function date(value, withTime = true) {
    if (!value) return "—";
    const d = new Date(value); if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", withTime ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short", year: "numeric" });
  }
  function ago(value) {
    if (!value) return "—";
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return "just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`; return date(value, false);
  }
  function tag(value) { const safe = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, ""); return `<span class="tag tag-${safe}">${esc(value || "unknown")}</span>`; }
  function initials(email) { return String(email || "A").split("@")[0].slice(0, 2).toUpperCase(); }

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (options.mutation && state.csrf) headers["X-CSRF-Token"] = state.csrf;
    const response = await fetch(url, { credentials: "same-origin", ...options, headers, body: options.body && !(options.body instanceof FormData) && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body });
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 && document.body.dataset.page !== "login") location.replace("/login.html");
      const error = new Error(data?.error || `Request failed (${response.status})`);
      error.code = data?.code; error.status = response.status; throw error;
    }
    return data;
  }
  async function getSession() {
    if (state.session) return state.session;
    const result = await request("/api/auth?action=session");
    state.session = result.user; state.csrf = result.csrf; return state.session;
  }
  function params(values) { const out = new URLSearchParams(); Object.entries(values || {}).forEach(([key, value]) => { if (value !== "" && value !== undefined && value !== null) out.set(key, value); }); return out; }
  async function read(resource, action = "list", values = {}) { const response = await request(`/api/read?${params({ ...values, resource, action })}`); return response.data; }
  async function write(resource, action, payload = {}, reason = "") { const response = await request("/api/write", { method: "POST", mutation: true, body: { resource, action, payload, reason } }); return response.data; }
  async function job(jobName, payload = {}, reason = "") { const response = await request("/api/jobs", { method: "POST", mutation: true, body: { job: jobName, payload, reason } }); return response.data; }
  async function ai(action, payload = {}, reason = "") { const response = await request("/api/ai", { method: "POST", mutation: true, body: { action, payload, reason } }); return response.data; }
  function has(resource, action = "read") { const value = MATRIX[resource]?.[action]; return value === "*" || (Array.isArray(value) && value.includes(state.session?.role)); }

  function toast(message, type = "success") {
    let stack = document.querySelector(".toast-stack");
    if (!stack) { stack = document.createElement("div"); stack.className = "toast-stack"; stack.setAttribute("aria-live", "polite"); document.body.append(stack); }
    const item = document.createElement("div"); item.className = `toast ${type === "error" ? "toast-error" : ""}`; item.textContent = message; stack.append(item);
    setTimeout(() => item.remove(), 4500);
  }

  function dialog(options = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div"); backdrop.className = "modal-backdrop";
      const fields = (options.fields || []).map((field) => `<div class="field"><label for="dialog-${attr(field.name)}">${esc(field.label)}</label>${field.type === "textarea" ? `<textarea id="dialog-${attr(field.name)}" name="${attr(field.name)}" ${field.required ? "required" : ""} placeholder="${attr(field.placeholder || "")}">${esc(field.value || "")}</textarea>` : field.type === "select" ? `<select id="dialog-${attr(field.name)}" name="${attr(field.name)}">${(field.options || []).map((entry) => `<option value="${attr(entry.value)}" ${String(entry.value) === String(field.value) ? "selected" : ""}>${esc(entry.label)}</option>`).join("")}</select>` : `<input id="dialog-${attr(field.name)}" name="${attr(field.name)}" type="${attr(field.type || "text")}" value="${attr(field.value || "")}" placeholder="${attr(field.placeholder || "")}" ${field.required ? "required" : ""} ${field.min != null ? `min="${attr(field.min)}"` : ""} ${field.max != null ? `max="${attr(field.max)}"` : ""}>`}${field.help ? `<div class="field-help">${esc(field.help)}</div>` : ""}</div>`).join("");
      const reason = options.reason ? `<div class="field"><label for="dialog-reason">Reason <span class="text-red">*</span></label><textarea id="dialog-reason" name="reason" required minlength="5" placeholder="This is recorded in the immutable audit log"></textarea></div>` : "";
      const confirm = options.requireText ? `<div class="field"><label for="dialog-confirm">Type <span class="mono text-red">${esc(options.requireText)}</span> to confirm</label><input id="dialog-confirm" name="confirm" autocomplete="off" required></div>` : "";
      backdrop.innerHTML = `<form class="modal" role="dialog" aria-modal="true"><h2>${esc(options.title || "Confirm action")}</h2><p>${esc(options.message || "")}</p>${fields}${reason}${confirm}<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn ${options.danger ? "btn-danger" : "btn-primary"}">${esc(options.confirmLabel || "Continue")}</button></div></form>`;
      document.body.append(backdrop);
      const form = backdrop.querySelector("form"); const first = form.querySelector("input,select,textarea"); if (first) first.focus();
      const close = (value) => { backdrop.remove(); resolve(value); };
      backdrop.querySelector("[data-cancel]").addEventListener("click", () => close(null));
      backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(null); });
      form.addEventListener("submit", (event) => {
        event.preventDefault(); const data = Object.fromEntries(new FormData(form).entries());
        if (options.requireText && data.confirm !== options.requireText) { toast(`Type ${options.requireText} exactly`, "error"); return; }
        if (options.reason && String(data.reason || "").trim().length < 5) { toast("Please enter a meaningful reason", "error"); return; }
        close(data);
      });
    });
  }

  function pageUrl(page) { return page === "dashboard" ? "/index.html" : `/${page}.html`; }
  function shell(title, subtitle, actions = "") {
    const page = document.body.dataset.page;
    const allowedNav = nav.filter((item) => item[4] === "dashboard" || has(item[4], "read") || (item[4] === "emails" && has("emails", "test_send")));
    const app = document.getElementById("app");
    app.innerHTML = `<a class="skip-link" href="#main-content">Skip to content</a><div class="app-shell"><aside class="sidebar" id="sidebar"><div class="brand"><span class="brand-mark">&gt;_</span><span>PyDebug</span><span class="environment">ADMIN</span></div><div class="nav-label">Workspace</div><nav class="nav">${allowedNav.map(([href,key,icon,label]) => `<a href="/${href}" class="${page === key || (page === "user" && key === "users") || (page === "problem-edit" && key === "problems") ? "is-active" : ""}"><span class="nav-icon">${icon}</span>${esc(label)}</a>`).join("")}</nav><div class="sidebar-user"><div class="sidebar-user-row"><div class="avatar">${esc(initials(state.session.email))}</div><div class="sidebar-user-copy"><strong>${esc(state.session.email)}</strong><span>${esc(state.session.role.replaceAll("_", " "))}</span></div><button class="icon-btn" id="logout" title="Log out" aria-label="Log out">↪</button></div></div></aside><div class="sidebar-backdrop" id="sidebar-backdrop"></div><div class="main-wrap"><header class="topbar"><button class="icon-btn menu-btn" id="menu" aria-label="Open navigation">☰</button><div class="global-search"><span class="search-glyph">⌕</span><input id="global-search" type="search" autocomplete="off" placeholder="Search users, problems, payments…" aria-label="Global search"><span class="search-key">/</span><div class="search-results" id="search-results" hidden></div></div><div class="topbar-spacer"></div><span class="role-pill">${esc(state.session.role.replaceAll("_", " "))}</span></header><main id="main-content" class="content" tabindex="-1"><div class="page-head"><div><div class="eyebrow">PYDEBUG / ${esc(page.replaceAll("-", " "))}</div><h1>${esc(title)}</h1><p>${esc(subtitle || "")}</p></div><div class="page-actions">${actions}</div></div><div id="page-content"><div class="loading-screen"><span>Loading live data</span></div></div></main></div></div>`;
    bindShell();
  }

  function bindShell() {
    const sidebar = document.getElementById("sidebar"); const backdrop = document.getElementById("sidebar-backdrop");
    const close = () => { sidebar.classList.remove("is-open"); backdrop.classList.remove("is-open"); };
    document.getElementById("menu")?.addEventListener("click", () => { sidebar.classList.toggle("is-open"); backdrop.classList.toggle("is-open"); });
    backdrop?.addEventListener("click", close);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); if (event.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName)) { event.preventDefault(); document.getElementById("global-search")?.focus(); } });
    document.getElementById("logout")?.addEventListener("click", async () => { try { await request("/api/auth", { method: "POST", mutation: true, body: { action: "logout" } }); } finally { location.replace("/login.html"); } });
    const input = document.getElementById("global-search"); const results = document.getElementById("search-results");
    input?.addEventListener("input", () => { clearTimeout(state.searchTimer); const term = input.value.trim(); if (term.length < 2) { results.hidden = true; return; } state.searchTimer = setTimeout(async () => { try { const data = await read("search", "list", { q: term }); results.innerHTML = searchHtml(data); results.hidden = false; } catch { results.hidden = true; } }, 280); });
    document.addEventListener("click", (event) => { if (!event.target.closest(".global-search") && results) results.hidden = true; });
  }

  function searchHtml(data) {
    const section = (label, rows, render) => rows?.length ? `<div class="search-section">${label}</div>${rows.map(render).join("")}` : "";
    const html = section("Users", data.users, (row) => `<a href="/user.html?id=${encodeURIComponent(row.id)}"><span>${esc(row.display_name || row.full_name || row.email || row.id)}</span><small>${esc(row.status || "user")}</small></a>`)
      + section("Problems", data.problems, (row) => `<a href="/problem-edit.html?id=${encodeURIComponent(row.id)}"><span>${esc(row.title)}</span><small>${esc(row.difficulty)}</small></a>`)
      + section("Payments", data.payments, (row) => `<a href="/payments.html?search=${encodeURIComponent(row.razorpay_payment_id || row.id)}"><span>${esc(row.razorpay_payment_id || row.id)}</span><small>${esc(row.plan)}</small></a>`);
    return html || `<div class="empty">No results</div>`;
  }

  function setContent(html) { const element = document.getElementById("page-content"); if (element) element.innerHTML = html; }
  function pagination(data) {
    const pages = Math.max(1, Math.ceil(Number(data.total || 0) / Number(data.page_size || 50)));
    return `<div class="pagination"><button class="btn btn-sm" data-page-go="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>← Previous</button><span>PAGE ${data.page} / ${pages} · ${fmt(data.total)} ROWS</span><button class="btn btn-sm" data-page-go="${data.page + 1}" ${data.page >= pages ? "disabled" : ""}>Next →</button></div>`;
  }

  function lineChart(series, options = {}) {
    const values = series.map((item) => Number(item.value || 0)); const max = Math.max(1, ...values); const width = 700; const height = 220; const pad = 24;
    const points = values.map((value, index) => `${pad + index * (width - pad * 2) / Math.max(1, values.length - 1)},${height - pad - value * (height - pad * 2) / max}`).join(" ");
    const area = points ? `${pad},${height-pad} ${points} ${width-pad},${height-pad}` : "";
    const labels = series.filter((_, i) => i % Math.max(1, Math.ceil(series.length / 6)) === 0).map((item, i, visible) => { const original = series.indexOf(item); const x = pad + original * (width-pad*2)/Math.max(1,series.length-1); return `<text class="chart-label" x="${x}" y="215" text-anchor="middle">${esc(String(item.date || "").slice(5))}</text>`; }).join("");
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${attr(options.label || "Chart")}"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${options.color || "#2dd4bf"}" stop-opacity=".28"/><stop offset="1" stop-color="${options.color || "#2dd4bf"}" stop-opacity="0"/></linearGradient></defs>${[.25,.5,.75,1].map((n) => `<line class="chart-grid" x1="${pad}" x2="${width-pad}" y1="${height-pad-(height-pad*2)*n}" y2="${height-pad-(height-pad*2)*n}"/>`).join("")}<polygon points="${area}" fill="url(#chart-fill)"/><polyline points="${points}" fill="none" stroke="${options.color || "#2dd4bf"}" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${labels}</svg>`;
  }

  function stackedBars(series) {
    const keys = ["monthly","sixmonth","yearly","other"]; const colors = ["#2dd4bf","#8b5cf6","#60a5fa","#64748b"]; const max = Math.max(1,...series.map((row) => keys.reduce((sum,key) => sum + Number(row[key]||0),0))); const width=700,height=220,pad=24; const barWidth=Math.max(2,(width-pad*2)/Math.max(1,series.length)*.68);
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Revenue by plan">${series.map((row,index) => { const x=pad+index*(width-pad*2)/series.length; let y=height-pad; return keys.map((key,k) => { const h=Number(row[key]||0)*(height-pad*2)/max; y-=h; return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="2" fill="${colors[k]}"/>`; }).join(""); }).join("")}</svg><div class="legend">${keys.map((key)=>`<span><i class="legend-${key}"></i>${esc(key)}</span>`).join("")}</div>`;
  }

  function download(text, filename, type = "text/csv;charset=utf-8") { const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function parseCsv(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    const rows=[]; let row=[],cell="",quoted=false;
    for(let i=0;i<text.length;i+=1){const c=text[i],next=text[i+1]; if(c==='"'&&quoted&&next==='"'){cell+='"';i+=1;} else if(c==='"'){quoted=!quoted;} else if(c===','&&!quoted){row.push(cell);cell="";} else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&next==='\n')i+=1;row.push(cell);if(row.some((v)=>v!==""))rows.push(row);row=[];cell="";} else cell+=c;} row.push(cell);if(row.some((v)=>v!==""))rows.push(row); if(rows.length<2)return[]; const headers=rows.shift().map((value)=>value.trim().toLowerCase().replace(/[^a-z0-9]+/g,"_")); return rows.map((values)=>Object.fromEntries(headers.map((key,index)=>[key,values[index]||""])));
  }
  async function run(button, operation, success = "Done") { const old = button?.textContent; if (button) { button.disabled = true; button.textContent = "Working…"; } try { const result = await operation(); toast(success); return result; } catch (error) { toast(error.message, "error"); throw error; } finally { if (button) { button.disabled = false; button.textContent = old; } } }

  async function boot() {
    if (document.body.dataset.page === "login") return;
    try { await getSession(); if (!window.AdminPages) throw new Error("Page module failed to load"); await window.AdminPages.init(document.body.dataset.page); }
    catch (error) { if (error.status !== 401) { const app=document.getElementById("app"); if(app) app.innerHTML=`<div class="loading-screen"><div><strong>Admin panel could not start</strong><br><span class="text-red">${esc(error.message)}</span></div></div>`; } }
  }

  window.Admin = { state, esc, attr, fmt, inr, date, ago, tag, request, getSession, read, write, job, has, toast, dialog, shell, setContent, pagination, lineChart, stackedBars, download, parseCsv, run, pageUrl };
  document.addEventListener("DOMContentLoaded", boot);
})();
