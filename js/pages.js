"use strict";

(() => {
  const A = window.Admin;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const qs = () => Object.fromEntries(new URLSearchParams(location.search).entries());
  const empty = (columns, text = "No matching records found") => `<tr><td class="empty" colspan="${columns}">${A.esc(text)}</td></tr>`;
  const rowId = (value) => A.attr(String(value || ""));

  function table(headers, body, label = "Data table") {
    return `<div class="table-wrap"><table aria-label="${A.attr(label)}"><thead><tr>${headers.map((header) => `<th>${A.esc(header)}</th>`).join("")}</tr></thead><tbody>${body || empty(headers.length)}</tbody></table></div>`;
  }
  function setLoading() { A.setContent('<div class="loading-screen"><span>Loading live data</span></div>'); }
  function showError(error) { A.setContent(`<div class="card"><h2>Could not load this page</h2><p class="text-red">${A.esc(error.message)}</p><button class="btn" id="retry-page">Try again</button></div>`); }
  function dateInput(daysAgo = 0) { return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10); }
  function bindPagination(load, state) { $$('[data-page-go]').forEach((button) => button.addEventListener("click", () => { state.page = Number(button.dataset.pageGo); load(); })); }
  function bindFilterForm(form, state, load) {
    form?.addEventListener("submit", (event) => { event.preventDefault(); Object.assign(state, Object.fromEntries(new FormData(form).entries()), { page: 1 }); load(); });
    form?.addEventListener("reset", () => setTimeout(() => { for (const key of Object.keys(state)) if (key !== "page" && key !== "page_size") state[key] = ""; state.page = 1; load(); }, 0));
  }
  async function auditedDialog(config, operation) {
    const data = await A.dialog({ ...config, reason: config.reason !== false });
    if (!data) return null;
    return operation(data);
  }
  function downloadObjectRows(rows, filename) {
    if (!rows?.length) return A.toast("There is no data to export", "error");
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const cell = (value) => { let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value); if (/^[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"','""')}"`; };
    A.download(`${keys.map(cell).join(",")}\n${rows.map((row) => keys.map((key) => cell(row[key])).join(",")).join("\n")}\n`, filename);
  }

  async function dashboard() {
    A.shell("Command center", "Live product health, growth, revenue and engagement in one place.", '<button class="btn" id="refresh">↻ Refresh</button><a class="btn btn-primary" href="/problem-edit.html">+ New problem</a>');
    const load = async () => {
      setLoading();
      try {
        const data = await A.read("dashboard", "overview"); const k = data.kpis;
        const kpis = [
          ["Total users",k.total_users,`+${A.fmt(k.signups_today)} today`,"cyan"],
          ["Signups · 7d",k.signups_7d,`${A.fmt(k.signups_30d)} in 30d`,"green"],
          ["Daily active",k.dau,"last_active_date today","purple"],
          ["Active premium",k.active_premium,"non-expired access","amber"],
          ["Revenue · 30d",k.revenue_30d == null ? "Restricted" : A.inr(k.revenue_30d),k.revenue_7d == null ? "role restricted" : `${A.inr(k.revenue_today)} today · ${A.inr(k.revenue_7d)} in 7d`,"green"],
          ["Solves today",k.solves_today,`${A.fmt(k.battles_today)} battles`,"cyan"],
          ["Push subscribers",k.push_subscribers == null ? "Restricted" : A.fmt(k.push_subscribers),"active endpoints","purple"],
          ["Streaks ≥ 3",k.streaks_3_plus,"engaged learners","amber"],
        ];
        A.setContent(`${data.alerts.length ? `<div class="alert-strip">${data.alerts.map((item) => `<div class="alert ${item.level === "danger" ? "alert-danger" : ""}">⚠ ${A.esc(item.text)}</div>`).join("")}</div>` : '<div class="alert-strip"><div class="alert empty-alert">✓ No operational alerts detected</div></div>'}<div class="kpi-grid">${kpis.map(([label,value,note,color]) => `<div class="kpi kpi-${color}"><span class="kpi-label">${A.esc(label)}</span><strong class="kpi-value">${typeof value === "number" ? A.fmt(value) : A.esc(value)}</strong><span class="kpi-note">${A.esc(note)}</span></div>`).join("")}</div><div class="grid grid-2"><section class="card"><div class="card-head"><div><h2>Signups</h2><p>New profiles over the last 30 days</p></div><span class="tag tag-green">LIVE</span></div><div class="chart">${A.lineChart(data.charts.signups,{label:"Daily signups"})}</div></section><section class="card"><div class="card-head"><div><h2>Daily solves</h2><p>Solved submissions over the last 30 days</p></div></div><div class="chart">${A.lineChart(data.charts.solves,{label:"Daily solves",color:"#8b5cf6"})}</div></section>${data.charts.revenue.length ? `<section class="card"><div class="card-head"><div><h2>Revenue by plan</h2><p>Daily captured amount, stacked by plan</p></div><strong>${A.inr(k.revenue_30d)}</strong></div><div class="chart">${A.stackedBars(data.charts.revenue)}</div></section>` : ""}<section class="card"><div class="card-head"><div><h2>Recent events</h2><p>Latest activity across PyDebug</p></div></div><ul class="activity-list">${data.recent.length ? data.recent.map((item) => `<li><span class="activity-icon">${item.type === "payment" ? "₹" : item.type === "signup" ? "+" : item.type === "battle" ? "⚔" : "✓"}</span><span>${A.esc(item.text)}</span><small>${A.ago(item.at)}</small></li>`).join("") : '<li class="empty">No recent activity</li>'}</ul></section></div>`);
      } catch (error) { showError(error); }
    };
    $("#refresh")?.addEventListener("click", load); await load();
  }

  async function users() {
    A.shell("Users", "Search, segment and support every PyDebug learner.", '<button class="btn" id="export-users">⇩ Export CSV</button>');
    const state = { page: 1, page_size: 50, search: qs().search || "", plan: "", status: "", inactive: "", from: "", to: "" };
    const load = async () => {
      setLoading();
      try {
        const data = await A.read("users", "list", state);
        const rows = data.rows.map((row) => `<tr><td><a class="cell-title text-cyan" href="/user.html?id=${encodeURIComponent(row.id)}">${A.esc(row.display_name || row.full_name || "Unnamed user")}</a><span class="cell-sub">${A.esc(row.email || row.id)}</span></td><td>${row.is_premium ? A.tag("premium") : A.tag("free")}${row.premium_expires_at ? `<span class="cell-sub">to ${A.date(row.premium_expires_at,false)}</span>` : ""}</td><td><strong>${A.fmt(row.xp)}</strong><span class="cell-sub">${A.fmt(row.streak)} day streak</span></td><td>${A.tag(row.status || "active")}${row.status_until ? `<span class="cell-sub">until ${A.date(row.status_until,false)}</span>` : ""}</td><td>${A.date(row.last_active_date,false)}</td><td>${A.date(row.created_at,false)}</td><td><a class="btn btn-sm" href="/user.html?id=${encodeURIComponent(row.id)}">Open →</a></td></tr>`).join("");
        A.setContent(`<form class="toolbar" id="filters"><div class="field field-grow"><label>Search</label><input name="search" value="${A.attr(state.search)}" placeholder="Email, name, UUID or referral code"></div><div class="field"><label>Plan</label><select name="plan"><option value="">All plans</option><option value="premium" ${state.plan === "premium" ? "selected" : ""}>Premium</option><option value="free" ${state.plan === "free" ? "selected" : ""}>Free</option></select></div><div class="field"><label>Status</label><select name="status"><option value="">All statuses</option>${["active","warned","muted","suspended"].map((value)=>`<option ${state.status===value?"selected":""}>${value}</option>`).join("")}</select></div><div class="field"><label>Inactive</label><select name="inactive"><option value="">Any activity</option><option value="7" ${state.inactive==="7"?"selected":""}>7+ days</option><option value="30" ${state.inactive==="30"?"selected":""}>30+ days</option></select></div><div class="field"><label>Signed up from</label><input name="from" type="date" value="${A.attr(state.from)}"></div><div class="field"><label>Signed up to</label><input name="to" type="date" value="${A.attr(state.to)}"></div><button class="btn btn-primary" type="submit">Apply</button><button class="btn btn-quiet" type="reset">Reset</button></form>${table(["User","Plan","Progress","Status","Last active","Joined",""], rows, "Users")}${A.pagination(data)}`);
        bindFilterForm($("#filters"), state, load); bindPagination(load,state);
      } catch (error) { showError(error); }
    };
    $("#export-users")?.addEventListener("click", async (event) => A.run(event.currentTarget, async () => { const result=await A.job("export",{resource:"users"}); A.download(result.csv,result.filename); }, "User export ready"));
    await load();
  }

  function detailTable(headers, rows, render, text) { return table(headers, rows.length ? rows.map(render).join("") : empty(headers.length,text), text); }
  async function userDetail() {
    const id = qs().id;
    A.shell("User 360°", "Profile, premium, progress, streak, referrals and safety controls.", '<a class="btn" href="/users.html">← All users</a>');
    if (!id) return showError(new Error("Missing user id"));
    let data;
    const load = async (activeTab = "overview") => {
      try {
        data = await A.read("users", "detail", { id }); const p=data.profile; const emailMasked=String(p.email||"").includes("***");
        const overviewActions = `${A.has("users","edit") ? '<button class="btn btn-sm" data-user-action="edit">Edit name</button>' : ""}${A.has("users","warn") ? '<button class="btn btn-sm" data-user-action="warn">Warn</button>' : ""}${A.has("users","mute") ? '<button class="btn btn-sm btn-danger" data-user-action="mute">Mute</button>' : ""}${A.has("users","suspend") ? `<button class="btn btn-sm ${p.status === "suspended" ? "" : "btn-danger"}" data-user-action="${p.status === "suspended" ? "unsuspend" : "suspend"}">${p.status === "suspended" ? "Unsuspend" : "Suspend"}</button>` : ""}${A.has("users","delete") ? '<button class="btn btn-sm btn-danger" data-user-action="delete">Delete user</button>' : ""}`;
        const paymentRows = [...data.payments,...data.payment_grants].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        A.setContent(`<section class="card profile-head"><div class="avatar">${A.esc((p.display_name||p.full_name||p.email||"U").slice(0,2).toUpperCase())}</div><div><h1>${A.esc(p.display_name||p.full_name||"Unnamed user")}</h1><p id="profile-email">${A.esc(p.email||p.id)} ${emailMasked && A.has("users","reveal_email") ? '<button class="btn btn-sm btn-quiet" data-user-action="reveal">Reveal</button>' : ""}</p></div><div class="topbar-spacer"></div>${A.tag(p.status||"active")}${p.is_premium?A.tag("premium"):A.tag("free")}</section><div class="tabs" role="tablist">${["overview","premium","progress","streak","referrals","battles","achievements","notifications","audit"].map((tab)=>`<button data-tab="${tab}" class="${tab===activeTab?"is-active":""}">${tab[0].toUpperCase()+tab.slice(1)}</button>`).join("")}</div>
        <section class="tab-panel ${activeTab==="overview"?"is-active":""}" data-panel="overview"><div class="card"><div class="card-head"><div><h2>Account overview</h2><p>Core identity and account safety state</p></div><div class="actions">${overviewActions}</div></div><dl class="definition-grid"><div><dt>User ID</dt><dd class="mono">${A.esc(p.id)}</dd></div><div><dt>Joined</dt><dd>${A.date(p.created_at)}</dd></div><div><dt>Last active</dt><dd>${A.date(p.last_active_date,false)}</dd></div><div><dt>Referral code</dt><dd class="mono">${A.esc(p.referral_code||"—")}</dd></div><div><dt>XP</dt><dd>${A.fmt(p.xp)}</dd></div><div><dt>Streak</dt><dd>${A.fmt(p.streak)} days</dd></div><div><dt>Battle record</dt><dd>${A.fmt(p.battle_wins)} / ${A.fmt(p.battle_plays)}</dd></div><div><dt>Status reason</dt><dd>${A.esc(p.status_reason||"—")}</dd></div></dl></div></section>
        <section class="tab-panel ${activeTab==="premium"?"is-active":""}" data-panel="premium"><div class="card"><div class="card-head"><div><h2>Premium access</h2><p>${p.is_premium?`Active until ${A.date(p.premium_expires_at)}`:"No active entitlement"}</p></div><div class="actions">${A.has("users","grant_premium")?'<button class="btn btn-primary btn-sm" data-user-action="grant">Grant / extend</button>':""}${p.is_premium&&A.has("users","revoke_premium")?'<button class="btn btn-danger btn-sm" data-user-action="revoke">Revoke</button>':""}</div></div>${detailTable(["Reference","Plan","Amount","Date"],paymentRows,(row)=>`<tr><td class="mono">${A.esc(row.razorpay_payment_id||row.payment_id||row.id||"manual")}</td><td>${A.esc(row.plan||row.plan_key||"—")}</td><td>${row.amount_paise!=null?A.inr(row.amount_paise):"—"}</td><td>${A.date(row.created_at)}</td></tr>`,"No payment history")}</div></section>
        <section class="tab-panel ${activeTab==="progress"?"is-active":""}" data-panel="progress"><div class="card"><div class="card-head"><div><h2>Progress</h2><p>${A.fmt(data.submissions.length)} recent submissions</p></div><div class="actions">${A.has("users","adjust_xp")?'<button class="btn btn-sm" data-user-action="xp">Adjust XP</button>':""}${A.has("users","reset_progress")?'<button class="btn btn-danger btn-sm" data-user-action="reset">Reset progress</button>':""}</div></div>${detailTable(["Problem","Status","Solved","Created"],data.submissions,(row)=>`<tr><td class="mono">${A.esc(row.problem_id)}</td><td>${A.tag(row.status)}</td><td>${A.date(row.solved_at)}</td><td>${A.date(row.created_at)}</td></tr>`,"No submissions")}</div></section>
        <section class="tab-panel ${activeTab==="streak"?"is-active":""}" data-panel="streak"><div class="grid grid-2"><div class="card"><h2>${A.fmt(p.streak)} day streak</h2><p class="muted">${A.fmt(p.streak_freezes)} freezes available</p></div><div class="card"><div class="actions">${A.has("users","restore_streak")?'<button class="btn" data-user-action="restore">Restore streak</button>':""}${A.has("users","grant_freeze")?'<button class="btn" data-user-action="freeze">Grant freeze</button>':""}</div></div></div></section>
        <section class="tab-panel ${activeTab==="referrals"?"is-active":""}" data-panel="referrals"><div class="card"><div class="card-head"><div><h2>Referrals & signals</h2><p>${A.fmt(p.referral_qualified_count)} qualified of ${A.fmt(p.referral_count)}</p></div>${A.state.session.role==="superadmin"?'<button class="btn btn-danger btn-sm" data-user-action="revoke-referral">Revoke rewards</button>':""}</div>${detailTable(["Signal","Details","State","Action"],data.referral_signals,(row)=>`<tr><td>${A.esc(row.signal_type||row.type||row.id)}</td><td class="json-value">${A.esc(JSON.stringify(row))}</td><td>${row.invalidated_at?A.tag("invalidated"):A.tag("open")}</td><td>${!row.invalidated_at&&A.has("referrals","invalidate")?`<button class="btn btn-danger btn-sm" data-signal-id="${rowId(row.id)}">Invalidate</button>`:"—"}</td></tr>`,"No fraud signals")}</div></section>
        <section class="tab-panel ${activeTab==="battles"?"is-active":""}" data-panel="battles"><div class="card"><div class="card-head"><div><h2>Battle activity</h2><p>Invites are ${p.battle_invites_enabled===false?"disabled":"enabled"}</p></div>${A.has("users","set_battle_invites")?`<button class="btn btn-sm" data-user-action="battle">${p.battle_invites_enabled===false?"Enable":"Disable"} invites</button>`:""}</div>${detailTable(["Battle","Difficulty","Started","Finished"],data.battles,(row)=>`<tr><td class="mono">${A.esc(row.id)}</td><td>${A.tag(row.difficulty)}</td><td>${A.date(row.created_at)}</td><td>${A.date(row.finished_at)}</td></tr>`,"No battle history")}</div></section>
        <section class="tab-panel ${activeTab==="achievements"?"is-active":""}" data-panel="achievements"><div class="card"><h2>Achievements</h2>${detailTable(["Achievement","Unlocked"],data.achievements,(row)=>`<tr><td>${A.esc(row.achievement_id)}</td><td>${A.date(row.unlocked_at)}</td></tr>`,"No achievements")}</div></section>
        <section class="tab-panel ${activeTab==="notifications"?"is-active":""}" data-panel="notifications"><div class="card"><div class="card-head"><div><h2>Notifications</h2><p>Recent in-app delivery</p></div>${A.has("push","test_send")?'<button class="btn btn-primary btn-sm" data-user-action="notify">Send test</button>':""}</div>${detailTable(["Title","Message","Read","Sent"],data.notifications,(row)=>`<tr><td>${A.esc(row.title)}</td><td>${A.esc(row.message||row.body)}</td><td>${row.is_read?A.tag("read"):A.tag("unread")}</td><td>${A.date(row.created_at)}</td></tr>`,"No notifications")}</div></section>
        <section class="tab-panel ${activeTab==="audit"?"is-active":""}" data-panel="audit"><div class="card"><h2>User audit trail</h2>${detailTable(["Admin","Action","Reason","Time"],data.audit,(row)=>`<tr><td class="mono">${A.esc(row.admin_id)}</td><td>${A.esc(row.resource)} · ${A.esc(row.action)}</td><td>${A.esc(row.reason||"—")}</td><td>${A.date(row.created_at)}</td></tr>`,"No admin actions for this user")}</div></section>`);
        bindUserDetail(load,p);
      } catch(error){showError(error);}
    };
    await load();
  }

  function bindUserDetail(load,p) {
    $$('[data-tab]').forEach((button)=>button.addEventListener("click",()=>{ $$('[data-tab]').forEach((x)=>x.classList.toggle("is-active",x===button)); $$('[data-panel]').forEach((panel)=>panel.classList.toggle("is-active",panel.dataset.panel===button.dataset.tab)); history.replaceState(null,"",`${location.pathname}${location.search}#${button.dataset.tab}`); }));
    $$('[data-signal-id]').forEach((button)=>button.addEventListener("click",async()=>{ const values=await A.dialog({title:"Invalidate referral signal",message:"This marks the signal invalid and records the reason.",reason:true,danger:true,confirmLabel:"Invalidate"}); if(!values)return; await A.run(button,()=>A.write("referrals","invalidate",{id:button.dataset.signalId},values.reason),"Signal invalidated"); await load("referrals"); }));
    $$('[data-user-action]').forEach((button)=>button.addEventListener("click",async()=>{
      const action=button.dataset.userAction; let values;
      try {
        if(action==="reveal"){const result=await A.run(button,()=>A.write("users","reveal_email",{id:p.id}),"Email reveal audited"); $("#profile-email").textContent=result.email; return;}
        if(action==="edit"){values=await A.dialog({title:"Edit display name",fields:[{name:"display_name",label:"Display name",value:p.display_name||"",required:true}]}); if(values)await A.run(button,()=>A.write("users","edit",{id:p.id,display_name:values.display_name},"Profile corrected by support"),"Name updated");}
        if(action==="grant"){values=await A.dialog({title:"Grant or extend premium",message:"Days are added after the current expiry when access is active.",fields:[{name:"days",label:"Days",type:"number",value:"30",min:1,max:3650,required:true}],reason:true}); if(values)await A.run(button,()=>A.write("users","grant_premium",{id:p.id,days:Number(values.days)},values.reason),"Premium updated");}
        if(action==="revoke"){values=await A.dialog({title:"Revoke premium",message:"Access ends immediately. This does not issue a Razorpay refund.",reason:true,requireText:"REVOKE",danger:true,confirmLabel:"Revoke access"}); if(values)await A.run(button,()=>A.write("users","revoke_premium",{id:p.id},values.reason),"Premium revoked");}
        if(action==="suspend"){values=await A.dialog({title:"Suspend user",message:"Sign-in enforcement must also read profiles.status in the main product.",fields:[{name:"until",label:"Until (optional)",type:"datetime-local"}],reason:true,requireText:"SUSPEND",danger:true}); if(values)await A.run(button,()=>A.write("users","suspend",{id:p.id,until:values.until||null},values.reason),"User suspended");}
        if(action==="unsuspend"){values=await A.dialog({title:"Unsuspend user",reason:true,confirmLabel:"Restore access"}); if(values)await A.run(button,()=>A.write("users","unsuspend",{id:p.id},values.reason),"User restored");}
        if(action==="warn"||action==="mute"){values=await A.dialog({title:`${action === "warn" ? "Warn" : "Mute"} user`,fields:[{name:"until",label:"Until (optional)",type:"datetime-local"}],reason:true,requireText:action.toUpperCase(),danger:action==="mute"}); if(values)await A.run(button,()=>A.write("users",action,{id:p.id,until:values.until||null},values.reason),`User ${action === "warn" ? "warned" : "muted"}`);}
        if(action==="delete"){values=await A.dialog({title:"Permanently delete user",message:"This removes the Supabase Auth user and cascading data. It cannot be undone.",reason:true,requireText:"DELETE",danger:true,confirmLabel:"Delete permanently"}); if(values){await A.run(button,()=>A.write("users","delete",{id:p.id},values.reason),"User deleted");location.href="/users.html";return;}}
        if(action==="xp"){values=await A.dialog({title:"Adjust XP",fields:[{name:"delta",label:"XP delta (+ or -)",type:"number",value:"10",min:-100000,max:100000,required:true}],reason:true}); if(values)await A.run(button,()=>A.write("users","adjust_xp",{id:p.id,delta:Number(values.delta)},values.reason),"XP adjusted");}
        if(action==="reset"){values=await A.dialog({title:"Reset all progress",message:"Submissions, hints, achievements, XP and streak are reset.",reason:true,requireText:"RESET",danger:true}); if(values)await A.run(button,()=>A.write("users","reset_progress",{id:p.id},values.reason),"Progress reset");}
        if(action==="restore"){values=await A.dialog({title:"Restore streak",fields:[{name:"streak",label:"Streak days",type:"number",value:String(Math.max(1,p.streak||1)),min:1,max:10000,required:true}],reason:true}); if(values)await A.run(button,()=>A.write("users","restore_streak",{id:p.id,streak:Number(values.streak)},values.reason),"Streak restored");}
        if(action==="freeze"){values=await A.dialog({title:"Grant streak freezes",fields:[{name:"count",label:"Freezes",type:"number",value:"1",min:1,max:20,required:true}],reason:true}); if(values)await A.run(button,()=>A.write("users","grant_freeze",{id:p.id,count:Number(values.count)},values.reason),"Freeze granted");}
        if(action==="battle"){const enabled=p.battle_invites_enabled===false; values=await A.dialog({title:`${enabled?"Enable":"Disable"} battle invites`,reason:true}); if(values)await A.run(button,()=>A.write("users","set_battle_invites",{id:p.id,enabled},values.reason),"Battle preference updated");}
        if(action==="revoke-referral"){values=await A.dialog({title:"Revoke referral rewards",message:"Referral premium-until rewards are cleared for this user.",reason:true,requireText:"REVOKE",danger:true}); if(values)await A.run(button,()=>A.write("referrals","revoke_reward",{id:p.id},values.reason),"Referral rewards revoked");}
        if(action==="notify"){values=await A.dialog({title:"Send test notification",fields:[{name:"title",label:"Title",value:"PyDebug test notification",required:true},{name:"message",label:"Message",type:"textarea",value:"This is a test from the PyDebug admin panel.",required:true}],reason:true}); if(values)await A.run(button,()=>A.write("users","test_notification",{id:p.id,title:values.title,message:values.message},values.reason),"Test notification created");}
        if(values)await load(action==="grant"||action==="revoke"?"premium":action==="xp"||action==="reset"?"progress":action==="restore"||action==="freeze"?"streak":action==="battle"?"battles":action==="revoke-referral"?"referrals":"overview");
      }catch(error){if(error)A.toast(error.message,"error");}
    }));
  }

  async function problems() {
    A.shell("Problem library", "Draft, publish, archive and measure every practice problem.", `${A.state.session.role==="superadmin"?'<button class="btn" id="trigger-rebuild">↻ Rebuild user site</button>':""}${A.has("problems","create")?'<a class="btn btn-primary" href="/problem-edit.html">+ New problem</a>':""}`);
    const state={page:1,page_size:50,search:"",type:"",difficulty:"",status:"",access:""};
    const load=async()=>{setLoading();try{const data=await A.read("problems","list",state);const rows=data.rows.map((row)=>`<tr><td><a class="cell-title text-cyan" href="/problem-edit.html?id=${encodeURIComponent(row.id)}">${A.esc(row.title)}</a><span class="cell-sub">${A.esc(row.topic)}</span></td><td>${A.tag(row.type)}</td><td>${A.tag(row.difficulty)}</td><td>${row.is_premium?A.tag("premium"):A.tag("free")}</td><td>${A.tag(row.status)}</td><td><strong>${A.fmt(row.solve_count)}</strong> / ${A.fmt(row.attempt_count)}<span class="cell-sub">${Number(row.success_rate||0).toFixed(1)}% success</span></td><td><div class="actions"><a class="btn btn-sm" href="/problem-edit.html?id=${encodeURIComponent(row.id)}">Open</a>${A.has("problems","edit")?`<button class="btn btn-sm" data-duplicate="${rowId(row.id)}">Duplicate</button>`:""}${A.has("ai","control")&&A.has("problems","create")?`<button class="btn btn-sm btn-quiet" data-variation="${rowId(row.id)}" title="AI: generate variations of this problem">✦ AI</button>`:""}${A.has("problems","delete")?`<button class="btn btn-sm btn-danger" data-delete="${rowId(row.id)}" data-title="${A.attr(row.title)}">Delete</button>`:""}</div></td></tr>`).join("");A.setContent(`<form class="toolbar" id="filters"><div class="field field-grow"><label>Search</label><input name="search" value="${A.attr(state.search)}" placeholder="Title or topic"></div>${[["type",["bug","question"]],["difficulty",["easy","medium","hard"]],["status",["draft","published","archived"]],["access",["free","premium"]]].map(([name,options])=>`<div class="field"><label>${name}</label><select name="${name}"><option value="">All</option>${options.map((value)=>`<option ${state[name]===value?"selected":""}>${value}</option>`).join("")}</select></div>`).join("")}<button class="btn btn-primary">Apply</button><button class="btn btn-quiet" type="reset">Reset</button></form>${table(["Problem","Type","Difficulty","Access","Status","Performance",""],rows,"Problems")}${A.pagination(data)}`);bindFilterForm($("#filters"),state,load);bindPagination(load,state);$$('[data-duplicate]').forEach((button)=>button.addEventListener("click",async()=>{await A.run(button,()=>A.write("problems","duplicate",{id:button.dataset.duplicate},"Content variant created"),"Draft copy created");load();}));$$('[data-variation]').forEach((button)=>button.addEventListener("click",async()=>{const values=await A.dialog({title:"AI variations",message:"Generate 3 new variations of this problem (same topic, type and difficulty). Every variation is validated and duplicate-checked before insert.",reason:true,danger:true,confirmLabel:"Generate"});if(!values)return;await A.run(button,()=>A.ai("variations",{problem_id:button.dataset.variation,count:3},values.reason),"Variations generated");load();}));$$('[data-delete]').forEach((button)=>button.addEventListener("click",async()=>{const values=await A.dialog({title:"Delete problem",message:button.dataset.title,reason:true,requireText:"DELETE",danger:true});if(!values)return;await A.run(button,()=>A.write("problems","delete",{id:button.dataset.delete},values.reason),"Problem deleted");load();}));}catch(error){showError(error);}};$("#trigger-rebuild")?.addEventListener("click",async(event)=>{const values=await A.dialog({title:"Trigger user-site rebuild",message:"Dispatch the configured main-repository workflow after content changes.",reason:true});if(!values)return;await A.run(event.currentTarget,()=>A.job("rebuild",{},values.reason),"Rebuild dispatched");});await load();
  }

  async function problemEdit() {
    const id=qs().id; const editing=Boolean(id); A.shell(editing?"Edit problem":"New problem",editing?"Update content, access and publishing state.":"Create a draft or publish a new practice problem.",'<a class="btn" href="/problems.html">← Library</a>');
    if(editing&&!A.has("problems","read"))return showError(new Error("You do not have access"));
    let p={type:"bug",title:"",description:"",difficulty:"easy",topic:"",is_premium:false,starter_code:"",expected_output:"",hints:[],battle_error:"",status:"draft",admin_skip_notification:true};
    try{if(editing)p=await A.read("problems","detail",{id});}catch(error){return showError(error);}
    const canEdit=A.has("problems",editing?"edit":"create");
    A.setContent(`<div class="editor-layout"><form class="card" id="problem-form"><div class="form-grid"><div class="field"><label>Type</label><select name="type"><option value="bug" ${p.type==="bug"?"selected":""}>Fix the bug</option><option value="question" ${p.type==="question"?"selected":""}>Predict output</option></select></div><div class="field"><label>Difficulty</label><select name="difficulty">${["easy","medium","hard"].map((value)=>`<option ${p.difficulty===value?"selected":""}>${value}</option>`).join("")}</select></div><div class="field span-2"><label>Title</label><input name="title" maxlength="180" value="${A.attr(p.title)}" required></div><div class="field span-2"><label>Description</label><textarea name="description" required>${A.esc(p.description)}</textarea></div><div class="field"><label>Topic</label><input name="topic" maxlength="100" value="${A.attr(p.topic)}" required placeholder="e.g. loops"></div><div class="field"><label>Status</label><select name="status">${["draft","published","archived"].map((value)=>`<option ${p.status===value?"selected":""}>${value}</option>`).join("")}</select></div><div class="field span-2"><label>Starter code</label><textarea class="code" name="starter_code" required spellcheck="false">${A.esc(p.starter_code)}</textarea></div><div class="field span-2"><label>Expected output</label><textarea name="expected_output">${A.esc(p.expected_output)}</textarea></div><div class="field"><label>Battle error</label><input name="battle_error" value="${A.attr(p.battle_error)}"></div><div class="field"><label>Hints (one per line)</label><textarea name="hints">${A.esc((p.hints||[]).join("\n"))}</textarea></div><div class="field span-2 check-row"><input id="premium" name="is_premium" type="checkbox" ${p.is_premium?"checked":""}><label for="premium">Premium-only problem</label></div><div class="field span-2 check-row"><input id="notify" name="notify_users" type="checkbox" ${!p.admin_skip_notification?"checked":""}><label for="notify">Notify users on publish</label></div><div class="field-help span-2">When off, <span class="mono">admin_skip_notification=true</span>. Ensure your existing insert notification trigger checks this flag before broadcasting.</div></div><button class="btn btn-primary btn-block" type="submit" ${canEdit?"":"disabled"}>${editing?"Save changes":"Create problem"}</button></form><aside class="card preview-pane"><div class="card-head"><div><h2 id="preview-title">${A.esc(p.title||"Untitled problem")}</h2><p id="preview-meta">${A.esc(p.difficulty)} · ${A.esc(p.topic||"topic")}</p></div><span id="preview-status">${A.tag(p.status)}</span></div><p class="preview-description" id="preview-description">${A.esc(p.description||"Description preview")}</p><pre class="code" id="preview-code">${A.esc(p.starter_code||"# Code preview")}</pre><h3>Expected output</h3><pre class="code" id="preview-output">${A.esc(p.expected_output||"—")}</pre><h3>Hints</h3><ol class="hint-list" id="preview-hints">${(p.hints||[]).map((hint)=>`<li>${A.esc(hint)}</li>`).join("")||"<li>None yet</li>"}</ol></aside></div>`);
    const form=$("#problem-form"); const update=()=>{const values=Object.fromEntries(new FormData(form).entries());$("#preview-title").textContent=values.title||"Untitled problem";$("#preview-meta").textContent=`${values.difficulty} · ${values.topic||"topic"}`;$("#preview-description").textContent=values.description||"Description preview";$("#preview-code").textContent=values.starter_code||"# Code preview";$("#preview-output").textContent=values.expected_output||"—";$("#preview-status").innerHTML=A.tag(values.status);const hints=values.hints.split("\n").map((x)=>x.trim()).filter(Boolean);$("#preview-hints").innerHTML=hints.length?hints.map((x)=>`<li>${A.esc(x)}</li>`).join(""):"<li>None yet</li>";};form.addEventListener("input",update);form.addEventListener("submit",async(event)=>{event.preventDefault();const button=event.submitter;const raw=Object.fromEntries(new FormData(form).entries());const payload={...raw,is_premium:form.elements.is_premium.checked,notify_users:form.elements.notify_users.checked,hints:raw.hints.split("\n").map((x)=>x.trim()).filter(Boolean)};try{const result=await A.run(button,()=>A.write("problems",editing?"edit":"create",{...payload,...(editing?{id}:{})},editing?"Content updated":"New content created"),editing?"Problem saved":"Problem created");if(!editing&&result?.id)location.href=`/problem-edit.html?id=${encodeURIComponent(result.id)}`;}catch{}});
  }

  async function payments() {
    A.shell("Payments", "Premium purchase ledger, income, active premium users, manual grants and Razorpay reconciliation.", '<button class="btn" id="export-payments">⇩ Export CSV</button>');
    const state={page:1,page_size:50,search:qs().search||"",plan:"",from:"",to:""}; let reconcileRows=[];
    const load=async()=>{
      setLoading();
      try{
        const data=await A.read("payments","list",state);
        const s=data.summary;
        const expiring=(iso)=>Boolean(iso)&&new Date(iso).getTime()-Date.now()<=7*86400000;
        const expired=(iso)=>Boolean(iso)&&new Date(iso).getTime()<Date.now();
        const rows=data.rows.map((row)=>`<tr><td><span class="cell-title">${A.esc(row.user?.display_name||row.user?.full_name||row.user?.email||row.user_id)}</span><span class="cell-sub mono">${A.esc(row.user_id)}</span></td><td>${A.tag(row.plan_label||row.plan_key||"premium")}${row.source==="grant"?`<span class="cell-sub">grant</span>`:""}</td><td class="text-green"><strong>${A.inr(row.amount_paise)}</strong>${row.discount_paise?`<span class="cell-sub">list ${A.inr(row.list_price_paise)} · ${row.discount_source==="signup_offer"?"20% signup offer · ":""}saved ${A.inr(row.discount_paise)}</span>`:""}</td><td>${row.expires_at?A.date(row.expires_at,false):"lifetime"}${expired(row.expires_at)?` ${A.tag("expired")}`:""}</td><td class="mono">${A.esc(row.payment_id||"—")}</td><td>${A.date(row.created_at)}</td></tr>`).join("");
        const premiumRows=data.active_premium.map((row)=>`<tr><td><a class="cell-title text-cyan" href="/user.html?id=${encodeURIComponent(row.id)}">${A.esc(row.display_name||row.full_name||row.email||row.id)}</a></td><td>${row.premium_expires_at?A.date(row.premium_expires_at,false):"lifetime"}</td><td>${!row.premium_expires_at||!expiring(row.premium_expires_at)?A.tag("active"):A.tag("expiring soon")}</td></tr>`).join("");
        const unmatched=data.unmatched_payments.length?`<div class="alert-strip"><div class="alert alert-danger">⚠ ${data.unmatched_payments.length} captured Razorpay payment(s) not credited as premium: ${data.unmatched_payments.slice(0,5).map((row)=>A.esc(row.payment_id)).join(" · ")} — reconcile below.</div></div>`:'<div class="alert-strip"><div class="alert empty-alert">✓ Every captured Razorpay payment is credited as premium</div></div>';
        A.setContent(`${unmatched}<div class="kpi-grid"><div class="kpi kpi-green"><span class="kpi-label">Total income · all time</span><strong class="kpi-value">${A.inr(s.total_paise)}</strong><span class="kpi-note">${A.fmt(s.count)} purchases · ${A.fmt(s.paying_users)} paying users</span></div><div class="kpi kpi-cyan"><span class="kpi-label">Income · 30d</span><strong class="kpi-value">${A.inr(s.days30_paise)}</strong></div><div class="kpi"><span class="kpi-label">Income · 90d</span><strong class="kpi-value">${A.inr(s.days90_paise)}</strong></div><div class="kpi kpi-purple"><span class="kpi-label">Active premium users</span><strong class="kpi-value">${A.fmt(data.active_premium.length)}</strong><span class="kpi-note">expiring soonest first</span></div>${Object.entries(s.by_plan).slice(0,4).map(([plan,value])=>`<div class="kpi"><span class="kpi-label">${A.esc(plan)}</span><strong class="kpi-value">${A.inr(value)}</strong></div>`).join("")}</div><div class="grid grid-2"><section class="card"><div class="card-head"><div><h2>Income trend</h2><p>Actual amount paid per day, stacked by plan</p></div></div><div class="chart">${A.stackedBars(data.daily)}</div></section><section class="card"><div class="card-head"><div><h2>Operations</h2><p>Manual grants never create fake payment rows</p></div></div><div class="actions">${A.has("payments","manual_grant")?'<button class="btn btn-primary" id="manual-grant">Manual grant</button>':""}${A.has("payments","reconcile")?'<label class="btn" for="reconcile-file">Choose Razorpay CSV</label><input id="reconcile-file" type="file" accept=".csv,text/csv" hidden><button class="btn" id="run-reconcile" disabled>Reconcile</button>':""}</div><p class="muted" id="reconcile-status">Upload columns such as payment_id, order_id, amount and status.</p><div id="reconcile-results"></div></section></div><section class="card"><div class="card-head"><div><h2>Active premium users</h2><p>Who bought premium and until when — expiring soonest first</p></div></div>${table(["User","Premium until","State"],premiumRows,"Active premium users")}</section><form class="toolbar" id="filters"><div class="field field-grow"><label>Search payment/order ID</label><input name="search" value="${A.attr(state.search)}"></div><div class="field"><label>Plan</label><select name="plan"><option value="">All plans</option>${["monthly","sixmonth","yearly"].map((v)=>`<option ${state.plan===v?"selected":""}>${v}</option>`)}</select></div><div class="field"><label>From</label><input name="from" type="date" value="${A.attr(state.from)}"></div><div class="field"><label>To</label><input name="to" type="date" value="${A.attr(state.to)}"></div><button class="btn btn-primary">Apply</button></form>${table(["User","Plan","Amount paid","Premium until","Payment ID","Purchased"],rows,"Premium purchases")}${A.pagination(data)}`);
        bindFilterForm($("#filters"),state,load);bindPagination(load,state);
        $("#manual-grant")?.addEventListener("click",async(event)=>{const values=await A.dialog({title:"Manual premium grant",message:"Use only for verified support/finance cases.",fields:[{name:"id",label:"User UUID",required:true},{name:"days",label:"Days",type:"number",value:"30",min:1,max:3650,required:true}],reason:true});if(!values)return;await A.run(event.currentTarget,()=>A.write("payments","manual_grant",{id:values.id,days:Number(values.days)},values.reason),"Premium granted");});
        $("#reconcile-file")?.addEventListener("change",async(event)=>{const file=event.target.files[0];if(!file)return;reconcileRows=A.parseCsv(await file.text()).slice(0,1000);$("#reconcile-status").textContent=`${reconcileRows.length} rows ready`;$("#run-reconcile").disabled=!reconcileRows.length;});
        $("#run-reconcile")?.addEventListener("click",async(event)=>{const result=await A.run(event.currentTarget,()=>A.job("reconcile_payments",{rows:reconcileRows},"Razorpay ledger reconciliation"),"Reconciliation complete");const flagged=result.filter((row)=>row.result==="paid_not_credited");downloadObjectRows(result,`razorpay-reconciliation-${dateInput()}.csv`);$("#reconcile-status").textContent=`${flagged.length} paid-but-not-credited rows highlighted below and in the export`;$("#reconcile-results").innerHTML=flagged.length?`<div class="alert-strip"><div class="alert alert-danger">${flagged.map((row)=>A.esc(row.payment_id)).join(" · ")}</div></div>`:'<div class="alert-strip"><div class="alert empty-alert">✓ No paid-but-not-credited rows</div></div>';});
      }catch(error){showError(error);}
    };
    $("#export-payments")?.addEventListener("click",async(event)=>A.run(event.currentTarget,async()=>{const result=await A.job("export",{resource:"payments"});A.download(result.csv,result.filename);},"Payment export ready"));
    await load();
  }

  async function referrals() {
    A.shell("Referral integrity", "Funnel performance, top advocates and anti-fraud review queue."); const state={page:1,page_size:50,status:"open"};
    const load=async()=>{setLoading();try{const data=await A.read("referrals","list",state);const queue=data.queue.map((row)=>`<tr><td><span class="cell-title">${A.esc(row.user?.display_name||row.user?.email||row.user_id||"Unknown")}</span><span class="cell-sub mono">${A.esc(row.user_id)}</span></td><td>${A.esc(row.signal_type||row.type||"signal")}</td><td class="json-value">${A.esc(JSON.stringify(row))}</td><td>${row.invalidated_at?A.tag("invalidated"):A.tag("open")}</td><td><div class="actions">${!row.invalidated_at&&A.has("referrals","invalidate")?`<button class="btn btn-danger btn-sm" data-invalidate="${rowId(row.id)}">Invalidate</button>`:""}${A.state.session.role==="superadmin"&&row.user_id?`<button class="btn btn-danger btn-sm" data-revoke-reward="${rowId(row.user_id)}">Revoke reward</button>`:""}</div></td></tr>`).join("");A.setContent(`<div class="kpi-grid"><div class="kpi kpi-cyan"><span class="kpi-label">Referred</span><strong class="kpi-value">${A.fmt(data.funnel.referred)}</strong></div><div class="kpi kpi-green"><span class="kpi-label">Qualified</span><strong class="kpi-value">${A.fmt(data.funnel.qualified)}</strong></div><div class="kpi kpi-purple"><span class="kpi-label">Converted</span><strong class="kpi-value">${A.fmt(data.funnel.converted)}</strong></div></div><div class="grid grid-2"><section class="card"><div class="card-head"><div><h2>Fraud queue</h2><p>Account signals awaiting a decision</p></div><select id="queue-status"><option value="open">Open</option><option value="all" ${state.status==="all"?"selected":""}>All</option></select></div>${table(["User","Signal","Evidence","State",""],queue,"Referral signals")}${A.pagination(data)}</section><section class="card"><div class="card-head"><div><h2>Top referrers</h2><p>Ranked by qualified referrals</p></div></div><ol class="activity-list">${data.top.map((row)=>`<li><span class="activity-icon">↗</span><span><strong>${A.esc(row.display_name||row.full_name||row.email||row.id)}</strong><small>${A.fmt(row.referral_count)} total referrals</small></span><strong>${A.fmt(row.referral_qualified_count)}</strong></li>`).join("")||'<li class="empty">No referrals</li>'}</ol></section></div>`);bindPagination(load,state);$("#queue-status").addEventListener("change",(event)=>{state.status=event.target.value;state.page=1;load();});$$('[data-invalidate]').forEach((button)=>button.addEventListener("click",async()=>{const values=await A.dialog({title:"Invalidate referral",reason:true,requireText:"INVALID",danger:true});if(!values)return;await A.run(button,()=>A.write("referrals","invalidate",{id:button.dataset.invalidate},values.reason),"Referral invalidated");load();}));$$('[data-revoke-reward]').forEach((button)=>button.addEventListener("click",async()=>{const values=await A.dialog({title:"Revoke referral reward",message:"Premium referral rewards for this user will be cleared.",reason:true,requireText:"REVOKE",danger:true});if(!values)return;await A.run(button,()=>A.write("referrals","revoke_reward",{id:button.dataset.revokeReward},values.reason),"Referral reward revoked");load();}));}catch(error){showError(error);}};await load();
  }

  async function battles() {
    A.shell("Battle operations", "Completion health, difficulty mix, question pools and stuck sessions.", `${A.has("battles","cleanup")?'<button class="btn btn-danger" id="cleanup">Clean stuck battles</button>':""}`);const state={page:1,page_size:50,difficulty:"",from:"",to:""};
    const load=async()=>{setLoading();try{const data=await A.read("battles","list",state),m=data.metrics;const rows=data.rows.map((row)=>`<tr><td class="mono">${A.esc(row.id)}</td><td>${A.tag(row.difficulty)}</td><td class="mono">${A.esc(row.challenger_id||"—")}</td><td class="mono">${A.esc(row.opponent_id||"—")}</td><td>${A.date(row.created_at)}</td><td>${row.finished_at?A.tag("completed"):A.tag("open")}</td></tr>`).join("");A.setContent(`<div class="kpi-grid"><div class="kpi kpi-cyan"><span class="kpi-label">Battles · 30d</span><strong class="kpi-value">${A.fmt(m.battles_30d)}</strong></div><div class="kpi kpi-green"><span class="kpi-label">Completion</span><strong class="kpi-value">${m.completion_rate}%</strong></div>${["easy","medium","hard"].map((d)=>`<div class="kpi"><span class="kpi-label">${d} pool</span><strong class="kpi-value">${A.fmt(m.question_pool[d])}</strong><span class="kpi-note">${A.fmt(m.difficulty_mix[d])} battles</span></div>`).join("")}</div><section class="card"><div class="card-head"><div><h2>Battles per day</h2><p>Last 30 days</p></div></div><div class="chart">${A.lineChart(m.daily,{label:"Battles per day",color:"#fbbf24"})}</div></section><form class="toolbar" id="filters"><div class="field"><label>Difficulty</label><select name="difficulty"><option value="">All</option>${["easy","medium","hard"].map((v)=>`<option ${state.difficulty===v?"selected":""}>${v}</option>`).join("")}</select></div><div class="field"><label>From</label><input type="date" name="from" value="${A.attr(state.from)}"></div><div class="field"><label>To</label><input type="date" name="to" value="${A.attr(state.to)}"></div><button class="btn btn-primary">Apply</button></form>${table(["Battle","Difficulty","Challenger","Opponent","Started","State"],rows,"Battles")}${A.pagination(data)}`);bindFilterForm($("#filters"),state,load);bindPagination(load,state);}catch(error){showError(error);}};$("#cleanup")?.addEventListener("click",async(event)=>{const values=await A.dialog({title:"Close stuck battles",message:"Open battles older than the threshold receive a finished_at timestamp.",fields:[{name:"hours",label:"Older than (hours)",type:"number",value:"2",min:1,max:48}],reason:true,requireText:"CLEANUP",danger:true});if(!values)return;await A.run(event.currentTarget,()=>A.job("cleanup_battles",{hours:Number(values.hours)},values.reason),"Stuck battles closed");load();});await load();
  }

  async function moderation() {
    A.shell("Moderation", "Review discussions, resolve flags and apply proportionate user actions.");const state={page:1,page_size:50,tab:"flags",status:"open",search:""};
    const load=async()=>{setLoading();try{const data=await A.read("moderation","list",state);const isFlags=data.tab==="flags";const rows=isFlags?data.rows.map((row)=>`<tr><td class="mono">${A.esc(row.discussion_id)}</td><td>${A.esc(row.reason||"No reason")}</td><td>${A.date(row.created_at)}</td><td>${row.resolved_at?A.tag(row.resolution):A.tag("open")}</td><td>${!row.resolved_at&&A.has("moderation","resolve")?`<div class="actions"><button class="btn btn-sm" data-mod="dismissed" data-flag="${rowId(row.id)}" data-discussion="${rowId(row.discussion_id)}">Dismiss</button><button class="btn btn-sm btn-danger" data-mod="hidden" data-flag="${rowId(row.id)}" data-discussion="${rowId(row.discussion_id)}">Hide</button><button class="btn btn-sm btn-danger" data-mod="user_muted" data-flag="${rowId(row.id)}" data-discussion="${rowId(row.discussion_id)}">Mute user</button><button class="btn btn-sm btn-danger" data-mod="deleted" data-flag="${rowId(row.id)}" data-discussion="${rowId(row.discussion_id)}">Delete</button></div>`:"—"}</td></tr>`).join(""):data.rows.map((row)=>`<tr><td><span class="cell-title">${A.esc(row.user?.display_name||row.user?.email||row.user_id||row.author_id||"Unknown")}</span></td><td>${A.esc(row.content||row.body||row.message||"")}</td><td>${A.fmt(row.like_count)}</td><td>${A.date(row.created_at)}</td><td>${A.has("moderation","resolve")?`<div class="actions"><button class="btn btn-sm" data-safety="warn" data-user="${rowId(row.user_id||row.author_id)}">Warn</button><button class="btn btn-sm btn-danger" data-safety="mute" data-user="${rowId(row.user_id||row.author_id)}">Mute</button><button class="btn btn-sm btn-danger" data-feed="hidden" data-discussion="${rowId(row.id)}">Hide</button><button class="btn btn-sm btn-danger" data-feed="deleted" data-discussion="${rowId(row.id)}">Delete</button></div>`:"—"}</td></tr>`).join("");A.setContent(`<div class="tabs"><button class="${isFlags?"is-active":""}" data-view="flags">Flag queue</button><button class="${!isFlags?"is-active":""}" data-view="feed">Discussion feed</button></div><div class="toolbar">${isFlags?`<div class="field"><label>State</label><select id="mod-status"><option value="open">Open</option><option value="resolved" ${state.status==="resolved"?"selected":""}>Resolved</option></select></div>`:`<div class="field field-grow"><label>Search posts</label><input id="mod-search" value="${A.attr(state.search)}"></div><button class="btn" id="mod-search-btn">Search</button>`}</div>${table(isFlags?["Discussion","Reason","Flagged","State",""]:["Author","Post","Likes","Posted",""],rows,"Moderation")}${A.pagination(data)}`);$$('[data-view]').forEach((button)=>button.addEventListener("click",()=>{state.tab=button.dataset.view;state.page=1;load();}));$("#mod-status")?.addEventListener("change",(event)=>{state.status=event.target.value;state.page=1;load();});$("#mod-search-btn")?.addEventListener("click",()=>{state.search=$("#mod-search").value;state.page=1;load();});bindPagination(load,state);$$('[data-mod],[data-feed]').forEach((button)=>button.addEventListener("click",async()=>{const resolution=button.dataset.mod||button.dataset.feed;const destructive=resolution!=="dismissed";const values=await A.dialog({title:`${resolution} discussion`,message:destructive?"This affects visible user content.":"The flag will be closed with no content change.",reason:destructive,requireText:destructive?resolution.toUpperCase():undefined,danger:destructive});if(!values)return;await A.run(button,()=>A.write("moderation",["dismissed","user_muted"].includes(resolution)?"resolve":resolution,{flag_id:button.dataset.flag||null,discussion_id:button.dataset.discussion,resolution},values.reason||"Flag dismissed after review"),"Moderation action saved");load();}));$$('[data-safety]').forEach((button)=>button.addEventListener("click",async()=>{if(!button.dataset.user)return A.toast("Post has no user id","error");const action=button.dataset.safety;const values=await A.dialog({title:`${action === "warn" ? "Warn" : "Mute"} discussion author`,reason:true,requireText:action.toUpperCase(),danger:action==="mute"});if(!values)return;await A.run(button,()=>A.write("users",action,{id:button.dataset.user},values.reason),`Author ${action === "warn" ? "warned" : "muted"}`);load();}));}catch(error){showError(error);}};await load();
  }

  async function push() {
    A.shell("Push center", "Compose segmented broadcasts and review campaign delivery.");
    const state={page:1,page_size:50};
    const load=async()=>{setLoading();try{const data=await A.read("push","list",state);const rows=data.rows.map((row)=>`<tr><td><span class="cell-title">${A.esc(row.title)}</span><span class="cell-sub">${A.esc(row.body||row.message)}</span></td><td>${A.tag(row.segment||"all")}</td><td>${A.esc(row.url||"/")}</td><td>${A.date(row.created_at)}</td></tr>`).join("");A.setContent(`${A.has("push","send")?`<section class="card"><div class="card-head"><div><h2>New broadcast</h2><p>Creates a push_announcements campaign for the delivery worker.</p></div></div><form id="push-form" class="form-grid"><div class="field"><label>Title</label><input name="title" maxlength="120" required></div><div class="field"><label>Target URL</label><input name="url" value="/" required></div><div class="field span-2"><label>Body</label><textarea name="body" maxlength="500" required></textarea></div><div class="field"><label>Segment</label><select name="segment">${["all","free","premium","inactive-7d","streak-at-risk"].map((v)=>`<option>${v}</option>`).join("")}</select></div><div class="field"><label>&nbsp;</label><button class="btn btn-primary btn-block">Queue broadcast</button></div></form></section>`:""}<div class="grid grid-2"><section class="card"><div class="card-head"><div><h2>Campaigns</h2><p>Latest queued announcements</p></div></div>${table(["Message","Segment","URL","Created"],rows,"Push campaigns")}${A.pagination(data)}</section><section class="card"><div class="card-head"><div><h2>Delivery report</h2><p>Broadcast and event logs</p></div></div>${detailTable(["Campaign","Delivered","Failed","Time"],data.delivery,(row)=>`<tr><td class="mono">${A.esc(row.announcement_id||row.id)}</td><td>${A.fmt(row.delivered_count||row.sent_count)}</td><td class="text-red">${A.fmt(row.failed_count)}</td><td>${A.date(row.created_at)}</td></tr>`,"No delivery logs")}<h3>Recent push events</h3>${detailTable(["Event","Status","Error","Time"],data.events.slice(0,20),(row)=>`<tr><td>${A.esc(row.event||row.type||row.id)}</td><td>${A.tag(row.status||"logged")}</td><td>${A.esc(row.error||"—")}</td><td>${A.date(row.created_at)}</td></tr>`,"No event logs")}</section></div>`);bindPagination(load,state);$("#push-form")?.addEventListener("submit",async(event)=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget).entries());const confirm=await A.dialog({title:"Queue push broadcast",message:`Send to segment: ${values.segment}`,reason:true,confirmLabel:"Queue campaign"});if(!confirm)return;await A.run(event.submitter,()=>A.job("broadcast",values,confirm.reason),"Broadcast queued");event.currentTarget.reset();load();});}catch(error){showError(error);}};await load();
  }

  async function emails() {
    A.shell("Email operations", "Lifecycle delivery logs and safe test sends.");
    const state={page:1,page_size:50};
    const render=async()=>{let data={rows:[],total:0,page:1,page_size:50};try{if(A.has("emails","read"))data=await A.read("emails","list",state);const rows=data.rows.map((row)=>`<tr><td>${A.esc(row.event||row.type||row.template||"lifecycle")}</td><td>${A.esc(row.email||row.recipient||row.user_id||"—")}</td><td>${A.tag(row.status||"sent")}</td><td>${A.esc(row.error||"—")}</td><td>${A.date(row.created_at)}</td></tr>`).join("");A.setContent(`${A.has("emails","test_send")?`<section class="card"><div class="card-head"><div><h2>Test email</h2><p>Support admins can only send to their own admin address.</p></div></div><form class="form-grid" id="email-form"><div class="field"><label>Recipient</label><input name="to" type="email" value="${A.attr(A.state.session.email)}" required></div><div class="field"><label>Subject</label><input name="subject" value="PyDebug admin email test" required></div><div class="field span-2"><label>Plain-text message</label><textarea name="text" required>This is a test email from PyDebug Admin.</textarea></div><button class="btn btn-primary">Send test</button></form></section>`:""}${A.has("emails","read")?`<section class="card"><div class="card-head"><div><h2>Lifecycle log</h2><p>Recent email activity</p></div></div>${table(["Event","Recipient","Status","Error","Time"],rows,"Email logs")}${A.pagination(data)}</section>`:""}`);bindPagination(render,state);$("#email-form")?.addEventListener("submit",async(event)=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget).entries());const confirm=await A.dialog({title:"Send test email",message:`Recipient: ${values.to}`,reason:true});if(!confirm)return;await A.run(event.submitter,()=>A.job("test_email",values,confirm.reason),"Test email sent");});}catch(error){showError(error);}};await render();
  }

  async function reports() {
    A.shell("Reports", "Growth, retention, revenue, content quality, engagement and churn.", '<button class="btn" id="export-report">⇩ Export report CSV</button>');let report;const state={from:dateInput(90),to:dateInput()};
    const load=async()=>{setLoading();try{report=await A.read("reports","overview",state);const retention=report.growth.retention.map((row)=>`<tr><td>${A.esc(row.cohort)}</td><td>${A.fmt(row.users)}</td><td>${row.d1}%</td><td>${row.d7}%</td><td>${row.d30}%</td></tr>`).join("");const problemRows=(rows)=>rows.map((row)=>`<tr><td>${A.esc(row.title)}</td><td>${A.tag(row.difficulty)}</td><td>${A.fmt(row.attempts)}</td><td>${row.success_rate}%</td></tr>`).join("");A.setContent(`<form class="toolbar" id="report-range"><div class="field"><label>From</label><input name="from" type="date" value="${state.from}"></div><div class="field"><label>To</label><input name="to" type="date" value="${state.to}"></div><button class="btn btn-primary">Run report</button></form><div class="kpi-grid"><div class="kpi kpi-green"><span class="kpi-label">Revenue</span><strong class="kpi-value">${A.inr(report.revenue.total_paise)}</strong></div><div class="kpi kpi-cyan"><span class="kpi-label">ARPU</span><strong class="kpi-value">${A.inr(report.revenue.arpu_paise)}</strong></div><div class="kpi"><span class="kpi-label">Paying users</span><strong class="kpi-value">${A.fmt(report.revenue.paying_users)}</strong></div><div class="kpi kpi-purple"><span class="kpi-label">Active learners</span><strong class="kpi-value">${A.fmt(report.engagement.active_users)}</strong></div><div class="kpi"><span class="kpi-label">Submissions</span><strong class="kpi-value">${A.fmt(report.engagement.submissions)}</strong></div><div class="kpi kpi-amber"><span class="kpi-label">Expiring · 7d</span><strong class="kpi-value">${A.fmt(report.churn.length)}</strong></div></div><div class="grid grid-2"><section class="card"><div class="card-head"><div><h2>Retention cohorts</h2><p>Practice on exact D1 / D7 / D30 after signup</p></div></div>${table(["Cohort","Users","D1","D7","D30"],retention,"Retention")}</section><section class="card"><div class="card-head"><div><h2>Revenue mix</h2><p>Captured amount by plan</p></div></div><div class="metric-list">${Object.entries(report.revenue.plan_mix).map(([key,value])=>`<div class="metric-row"><span>${A.esc(key)}</span><div class="metric-track"><div class="metric-fill metric-fill-static"></div></div><strong>${A.inr(value)}</strong></div>`).join("")||'<p class="muted">No revenue in range</p>'}</div></section><section class="card"><div class="card-head"><div><h2>Hardest problems</h2><p>Lowest solve rate</p></div></div>${table(["Problem","Difficulty","Attempts","Success"],problemRows(report.content.hardest),"Hardest problems")}</section><section class="card"><div class="card-head"><div><h2>Easiest problems</h2><p>Highest solve rate</p></div></div>${table(["Problem","Difficulty","Attempts","Success"],problemRows(report.content.easiest),"Easiest problems")}</section><section class="card"><div class="card-head"><div><h2>Premium churn watch</h2><p>Expiring in seven days</p></div></div>${detailTable(["User","Email","Expires"],report.churn,(row)=>`<tr><td><a class="text-cyan" href="/user.html?id=${encodeURIComponent(row.id)}">${A.esc(row.display_name||row.id)}</a></td><td>${A.esc(row.email)}</td><td>${A.date(row.premium_expires_at)}</td></tr>`,"No upcoming expiries")}</section></div>`);bindFilterForm($("#report-range"),state,load);}catch(error){showError(error);}};$("#export-report")?.addEventListener("click",async(event)=>A.run(event.currentTarget,async()=>{const result=await A.job("export",{resource:"reports",from:state.from,to:state.to});A.download(result.csv,result.filename);},"Report export ready"));await load();
  }

  async function settings() {
    A.shell("Settings & team", "Feature flags and least-privilege admin access.");
    const load=async()=>{setLoading();try{const data=await A.read("settings","list");const settingsRows=data.settings.map((row)=>`<tr><td class="mono">${A.esc(row.key)}</td><td class="json-value">${A.esc(JSON.stringify(row.value))}</td><td>${A.date(row.updated_at)}</td><td><button class="btn btn-sm" data-setting="${A.attr(row.key)}" data-value="${A.attr(JSON.stringify(row.value))}">Edit</button></td></tr>`).join("");const admins=data.admins.map((row)=>`<tr><td><span class="cell-title">${A.esc(row.email)}</span><span class="cell-sub mono">${A.esc(row.user_id)}</span></td><td>${A.tag(row.role)}</td><td>${row.totp_enabled?A.tag("2fa-on"):A.tag("2fa-off")}</td><td>${A.date(row.last_login_at)}</td><td><div class="actions"><button class="btn btn-sm" data-admin-edit="${rowId(row.user_id)}" data-role="${A.attr(row.role)}">Role</button>${row.user_id!==A.state.session.id?`<button class="btn btn-danger btn-sm" data-admin-delete="${rowId(row.user_id)}">Remove</button>`:""}</div></td></tr>`).join("");A.setContent(`<div class="grid grid-2"><section class="card"><div class="card-head"><div><h2>App settings</h2><p>Public-readable JSON flags consumed by the main product</p></div><button class="btn btn-primary btn-sm" id="new-setting">+ Setting</button></div>${table(["Key","Value","Updated",""],settingsRows,"App settings")}</section><section class="card"><div class="card-head"><div><h2>Admin team</h2><p>Server-enforced role assignments</p></div><button class="btn btn-primary btn-sm" id="add-admin">+ Admin</button></div>${table(["Admin","Role","2FA","Last login",""],admins,"Admin team")}</section></div>`);const editSetting=async(key,value)=>{const modal=await A.dialog({title:key?"Edit setting":"New setting",fields:[{name:"key",label:"Key",value:key||"",required:true},{name:"value",label:"JSON value",type:"textarea",value:value??"true",required:true}],reason:true});if(!modal)return;let parsed;try{parsed=JSON.parse(modal.value);}catch{return A.toast("Value must be valid JSON","error");}await A.write("settings","set",{key:modal.key,value:parsed},modal.reason);A.toast("Setting saved");load();};$$('[data-setting]').forEach((button)=>button.addEventListener("click",()=>editSetting(button.dataset.setting,button.dataset.value)));$("#new-setting").addEventListener("click",()=>editSetting());$("#add-admin").addEventListener("click",async()=>{const values=await A.dialog({title:"Add admin",message:"The email must already belong to a PyDebug user.",fields:[{name:"email",label:"Email",type:"email",required:true},{name:"role",label:"Role",type:"select",options:["superadmin","content_editor","support","finance","moderator","analyst"].map((value)=>({value,label:value.replaceAll("_"," ")}))}],reason:true});if(!values)return;await A.write("admins","create",{email:values.email,role:values.role},values.reason);A.toast("Admin added");load();});$$('[data-admin-edit]').forEach((button)=>button.addEventListener("click",async()=>{const values=await A.dialog({title:"Change admin role",fields:[{name:"role",label:"Role",type:"select",value:button.dataset.role,options:["superadmin","content_editor","support","finance","moderator","analyst"].map((value)=>({value,label:value.replaceAll("_"," ")}))}],reason:true});if(!values)return;await A.write("admins","edit",{id:button.dataset.adminEdit,role:values.role},values.reason);A.toast("Role updated");load();}));$$('[data-admin-delete]').forEach((button)=>button.addEventListener("click",async()=>{const values=await A.dialog({title:"Remove admin access",message:"The user's PyDebug account remains; only admin access is removed.",reason:true,requireText:"REMOVE",danger:true});if(!values)return;await A.write("admins","delete",{id:button.dataset.adminDelete},values.reason);A.toast("Admin removed");load();}));}catch(error){showError(error);}};await load();
  }

  async function audit() {
    A.shell("Audit log", "Immutable history of every privileged admin mutation.", '<button class="btn" id="export-audit">⇩ Export CSV</button>');const state={page:1,page_size:50,admin:"",log_resource:"",log_action:"",from:"",to:""};
    const load=async()=>{setLoading();try{const data=await A.read("audit","list",state);const rows=data.rows.map((row)=>`<tr><td>${A.date(row.created_at)}</td><td><span class="cell-title mono">${A.esc(row.admin_id)}</span><span class="cell-sub">${A.esc(row.admin_role)}</span></td><td>${A.esc(row.resource)} · <strong>${A.esc(row.action)}</strong><span class="cell-sub">${A.esc(row.target_id||"—")}</span></td><td>${A.esc(row.reason||"—")}</td><td><details><summary>Diff</summary><pre class="code">${A.esc(JSON.stringify({old:row.old_value,new:row.new_value},null,2))}</pre></details></td><td class="mono">${A.esc(row.ip||"—")}</td></tr>`).join("");A.setContent(`<form class="toolbar" id="filters"><div class="field"><label>Resource</label><input name="log_resource" value="${A.attr(state.log_resource)}" placeholder="users, problems, auth…"></div><div class="field"><label>Action</label><input name="log_action" value="${A.attr(state.log_action)}" placeholder="generate, scan, edit, login…"></div><div class="field"><label>Admin UUID</label><input name="admin" value="${A.attr(state.admin)}"></div><div class="field"><label>From</label><input type="date" name="from" value="${A.attr(state.from)}"></div><div class="field"><label>To</label><input type="date" name="to" value="${A.attr(state.to)}"></div><button class="btn btn-primary">Apply</button></form>${table(["Time","Admin","Action","Reason","Values","IP"],rows,"Audit log")}${A.pagination(data)}`);bindFilterForm($("#filters"),state,load);bindPagination(load,state);}catch(error){showError(error);}};$("#export-audit")?.addEventListener("click",async(event)=>A.run(event.currentTarget,async()=>{const result=await A.job("export",{resource:"audit"});A.download(result.csv,result.filename);},"Audit export ready"));await load();
  }

  /* ============================================================
     AI Control Center — port of the legacy admin panel's Own-AI
     (js/ai-brain.js + admin-ai.js). The engine runs entirely on the
     server (api/ai.js -> lib/server/own-ai.js); this page is the
     control surface: master switch, module toggles, factory,
     guards, growth/safety/content runners, reports and the lab.
     ============================================================ */
  async function aiControl() {
    const control = A.has("ai", "control");
    A.shell("AI Control Center", "Your own AI — no API key, no external calls. Moderation, a verified problem factory, growth nudges and reports, all running on this server.", '<button class="btn btn-sm" id="ai-btn-refresh">↻ Refresh</button>');
    const sw = (key, label, desc, opts = "") => `<div class="ai-module"><label class="switch" title="${A.attr(label)}"><input type="checkbox" data-setting="${key}" ${control ? "" : "disabled"}><span class="knob"></span></label><div class="ai-module__copy"><strong>${label}</strong><span>${desc}</span></div>${opts}</div>`;
    const runBtn = (id, label, title) => control ? `<button class="btn btn-sm" id="${id}" title="${A.attr(title)}">${label}</button>` : "";
    A.setContent(`
      <div class="card ai-master ${""}" id="ai-master-card">
        <div class="ai-master__row">
          <label class="switch switch--lg" title="Master switch"><input type="checkbox" id="ai-master" ${control ? "" : "disabled"}><span class="knob"></span></label>
          <div class="ai-master__copy">
            <h2>🤖 AI Control Center <span class="tag tag-muted" id="ai-master-tag">OFF</span></h2>
            <p>One master switch. When ON, the guard watches discussions, keeps the library duplicate-free, runs the problem factory on schedule and sends growth nudges. Background runs happen while this page is open — the server enforces the schedule.</p>
          </div>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi"><span>Comments removed</span><strong id="ai-stat-removed">0</strong><em>abusive deleted</em></div>
        <div class="kpi kpi-amber"><span>Warnings sent</span><strong id="ai-stat-warned">0</strong><em>offender notices</em></div>
        <div class="kpi kpi-green"><span>Problems added</span><strong id="ai-stat-added">0</strong><em>by the factory</em></div>
        <div class="kpi kpi-purple"><span>Duplicates removed</span><strong id="ai-stat-dups">0</strong><em>auto-dedup</em></div>
        <div class="kpi kpi-cyan"><span>Bug guard</span><strong id="ai-stat-errguard">0</strong><em>error-free bugs deleted</em></div>
        <div class="kpi"><span>Premium added</span><strong id="ai-stat-premium">0</strong><em>⭐ marked</em></div>
      </div>
      <div class="ai-stat-strip muted">
        <span id="ai-last-mod">Moderation: never</span><span id="ai-last-dedup">Dedup: never</span><span id="ai-last-errguard">Error guard: never</span><span id="ai-last-gen">Factory: never</span><span id="ai-last-welcome">Welcome: never</span>
        <span id="ai-watch-note">Watch: idle</span>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>AI modules</h2><p>What the guard does when the master switch is ON.</p></div>
          ${sw("moderation", "Discussion moderation", "Scans comments (English + Hindi/Hinglish), deletes abusive ones and warns the offender.", runBtn("ai-btn-scan", "Scan now", "Scan the latest comments"))}
          ${sw("dedup", "Duplicate guard", "Never inserts a duplicate; scans the library and deletes newer duplicates with their submissions and discussions.", runBtn("ai-btn-dedup", "Run", "Find and delete duplicates"))}
          ${sw("error_guard", "Bug error-guard", "Deletes Fix-the-Bug problems whose starter code runs WITHOUT raising any Python error.", runBtn("ai-btn-errguard", "Run", "Scan for error-free bug code"))}
          ${sw("auto_problems", "Auto problem factory", "Generates problems on a schedule (below) — every problem is validated before insert.", runBtn("ai-btn-generate", "Generate", "Generate a batch now"))}
          ${sw("welcome", "Welcome new users", "Sends a friendly welcome notification to users who joined in the last 24h.", runBtn("ai-btn-welcome", "Run", "Welcome new users"))}
        </div>
        <div class="card">
          <div class="card-head"><h2>Factory settings</h2><p>What and how often the factory generates.</p></div>
          <div class="form-grid">
            <div class="field"><label>Problems per run</label><input type="number" min="1" max="20" data-factory="per_run" ${control ? "" : "disabled"}></div>
            <div class="field"><label>Auto-run every (hours)</label><input type="number" min="1" max="72" data-factory="auto_hours" ${control ? "" : "disabled"}></div>
            <div class="field"><label>Mix</label><select data-factory="mix" ${control ? "" : "disabled"}><option value="both">Bug + Question</option><option value="bug">Bug only</option><option value="question">Question only</option></select></div>
            <div class="field"><label>Difficulty</label><select data-factory="difficulty" ${control ? "" : "disabled"}><option value="mixed">Mixed</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
          </div>
          ${sw("announce", "Announce new problems", "Broadcasts a notification to all users when the AI adds problems.")}
          ${sw("premium_mix", "Premium mix", "Marks a share of factory problems as Premium-only.")}
          <div class="form-grid">
            <div class="field"><label>Premium percent (0-90)</label><input type="number" min="0" max="90" data-factory="premium_percent" ${control ? "" : "disabled"}></div>
            <div class="field"><label>&nbsp;</label><button class="btn btn-block" id="ai-btn-preview" ${control ? "" : "disabled"}>👁 Preview one problem</button></div>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Growth &amp; retention</h2><p>Nudges that bring users back. All are rate-limited per user.</p></div>
          ${sw("expiry", "Premium expiry reminders", "Reminds users whose premium expires within 3 days (and expired within 2).", `${runBtn("ai-btn-exp", "Run", "Send expiry reminders")}<span class="ai-last" id="ai-last-exp">never</span>`)}
          ${sw("winback", "Win-back inactive users", "Nudges users inactive for 7+ days with a personal note.", `${runBtn("ai-btn-winback", "Run", "Send win-back nudges")}<span class="ai-last" id="ai-last-winback">never</span>`)}
          ${sw("stuck", "Stuck-user encouragement", "Helps users with 5+ failed attempts and no solve on one problem.", `${runBtn("ai-btn-stuck", "Run", "Send stuck-user help")}<span class="ai-last" id="ai-last-stuck">never</span>`)}
          ${sw("leaderboard", "Leaderboard alerts", "Congratulates top-25 XP users who enter the top 10 or climb 3+ spots.", `${runBtn("ai-btn-lead", "Run", "Send leaderboard alerts")}<span class="ai-last" id="ai-last-lead">never</span>`)}
        </div>
        <div class="card">
          <div class="card-head"><h2>Safety+</h2><p>Extra shields beyond the core guard.</p></div>
          ${sw("hindi", "Hindi / Hinglish filter", "Adds Devanagari + Hinglish abuse patterns to the comment scanner. English is always on.")}
          ${sw("faq", "FAQ auto-helper", "Replies to top-level questions older than 24h that have no answer yet.", `${runBtn("ai-btn-faq", "Run", "Reply to waiting questions")}<span class="ai-last" id="ai-last-faq">never</span>`)}
          <div class="ai-module"><div class="ai-module__copy"><strong>Copy-paste cheat scan</strong><span>Finds the same submission code (normalized) from 3+ different users on one problem in the last 30 days. Report only — a human reviews.</span></div>${runBtn("ai-btn-cheat", "Scan", "Scan submissions for copied code")}</div>
          <div class="ai-result" id="ai-cheat-body" hidden></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Content AI</h2><p>Keep the library complete, consistent and high-quality.</p></div>
        <div class="grid-3">
          <div class="ai-module"><div class="ai-module__copy"><strong>Topic gap filler</strong><span>Finds the thinnest topic × difficulty cells and generates problems for them.</span></div>${runBtn("ai-btn-gap", "Fill gaps", "Generate for the thinnest cells")}</div>
          <div class="ai-module"><div class="ai-module__copy"><strong>Variations</strong><span>Generate 3 variations of any problem from the <a class="text-cyan" href="/problems.html">problem library</a> (✦ AI button on a row).</span></div></div>
          <div class="ai-module"><div class="ai-module__copy"><strong>Quality report</strong><span>Flags short titles, weak descriptions, missing code/output, thin hints, duplicate numbers and error-free bug code.</span></div>${runBtn("ai-btn-quality", "Scan", "Run the quality report")}</div>
          <div class="ai-module"><div class="ai-module__copy"><strong>Auto hint repair</strong><span>Tops problems up to exactly 3 hints using the topic hint bank.</span></div>${runBtn("ai-btn-hints", "Fix hints", "Top up hints to 3")}</div>
        </div>
        <div class="ai-result" id="ai-gap-result" hidden></div>
        <div class="ai-result" id="ai-quality-body" hidden></div>
        <div class="ai-result" id="ai-hints-result" hidden></div>
        <h3 class="ai-subhead">Bulk import</h3>
        <p class="muted">Paste a JSON array of problems, or CSV with a header row: <code>type,title,difficulty,topic,starter_code,expected_output</code> (+ optional <code>hint1,hint2,hint3</code> or hints joined with <code>|</code>, <code>is_premium</code>). Every row is validated before anything is inserted.</p>
        <div class="toolbar">
          <div class="field"><label>Format</label><select id="ai-bulk-format" ${control ? "" : "disabled"}><option value="json">JSON array</option><option value="csv">CSV</option></select></div>
        </div>
        <div class="field"><label>Rows</label><textarea id="ai-bulk-text" rows="7" spellcheck="false" placeholder='[{"type":"bug","title":"…","difficulty":"easy","topic":"lists","starter_code":"…","expected_output":"…","hints":["…","…","…"]}]' ${control ? "" : "disabled"}></textarea></div>
        <div class="actions">
          <button class="btn" id="ai-btn-bulk-check" ${control ? "" : "disabled"}>Validate only</button>
          <button class="btn btn-primary" id="ai-btn-bulk-import" ${control ? "" : "disabled"}>Import valid rows</button>
        </div>
        <div class="ai-result" id="ai-bulk-body" hidden></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Daily digest</h2><p>One-glance summary of users, problems, submissions and AI activity.</p></div>
          <div id="ai-digest-body"><div class="empty-alert">No digest yet — build one.</div></div>
          <div class="actions"><button class="btn" id="ai-btn-digest" ${control ? "" : "disabled"}>Build digest</button></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Panel health</h2><p>Score 0–100 with actionable findings. Fix buttons run the matching AI action.</p></div>
          <div id="ai-health-body"><div class="empty-alert">Run the health check from the activity log card.</div></div>
          <div class="actions"><button class="btn" id="ai-btn-health" ${control ? "" : "disabled"}>Run health check</button></div>
          <div class="ai-checks" id="ai-health-list"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Difficulty calibration</h2><p>Reads real solve rates (min 8 attempts) and suggests easier/harder difficulties. Apply changes one by one or all at once.</p></div>
        <div id="ai-calib-body"><div class="empty-alert">Run the calibration to load suggestions.</div></div>
        <div class="actions">
          <button class="btn" id="ai-btn-calib" ${control ? "" : "disabled"}>Run calibration</button>
          <button class="btn btn-primary" id="ai-btn-calib-apply" ${control ? "" : "disabled"}>Apply selected</button>
          <button class="btn" id="ai-btn-calib-apply-all" ${control ? "" : "disabled"}>Apply all</button>
        </div>
      </div>

      <div class="card" id="ai-preview-card" hidden>
        <div class="card-head"><h2>👁 Problem preview</h2><p>One fully validated problem — nothing was inserted. Generate a batch from the factory settings above.</p></div>
        <div id="ai-preview-body"></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Local diagnostic lab</h2><p>Paste Python code — the local checker (never executes it) reports the first likely error and common mistakes.</p></div>
          <div class="field"><label>Code</label><textarea id="ai-diag-code" rows="6" spellcheck="false" placeholder="items = [3, 1, 2]&#10;ordered = items.sort()&#10;print(ordered)" ${control ? "" : "disabled"}></textarea></div>
          <div class="actions"><button class="btn" id="ai-btn-diag" ${control ? "" : "disabled"}>Diagnose</button></div>
          <div class="ai-result" id="ai-diag-body" hidden></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Moderation tester</h2><p>Test the exact filter the guard uses on comments (English + Hindi when enabled).</p></div>
          <div class="field"><label>Text</label><textarea id="ai-test-text" rows="4" placeholder="Type a comment to test…" ${control ? "" : "disabled"}></textarea></div>
          <div class="actions"><button class="btn" id="ai-btn-test" ${control ? "" : "disabled"}>Test text</button></div>
          <div class="ai-result" id="ai-test-result" hidden></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>AI activity log</h2><p>Everything the AI did, newest first. Stored in <code>ai_logs</code> — it follows you across devices.</p></div>
        <div class="table-wrap"><table class="table" id="ai-log-table"><thead><tr><th>When</th><th>Level</th><th>Action</th><th>Detail</th></tr></thead><tbody id="ai-log-tbody"></tbody></table></div>
        <div class="actions"><button class="btn btn-danger" id="ai-btn-clear-logs" ${control ? "" : "disabled"}>Clear log</button></div>
      </div>
    `);

    /* ---------------- state + painting ---------------- */
    let settings = null;
    let calib = null;
    const $id = (id) => document.getElementById(id);
    const paintMaster = () => {
      const on = settings?.master === true;
      const master = $id("ai-master");
      if (master) master.checked = on;
      const tag = $id("ai-master-tag");
      if (tag) { tag.textContent = on ? "ON" : "OFF"; tag.className = `tag ${on ? "tag-green" : "tag-muted"}`; }
      const card = $id("ai-master-card");
      if (card) card.classList.toggle("ai-master--on", on);
    };
    const paintSettings = () => {
      if (!settings) return;
      $$("[data-setting]").forEach((input) => { input.checked = settings[input.dataset.setting] === true; });
      $$("[data-factory]").forEach((input) => {
        const key = input.dataset.factory;
        if (input.tagName === "SELECT") input.value = settings[key] ?? input.value;
        else input.value = settings[key] ?? "";
      });
      paintMaster();
    };
    const paintStats = (stats, lastRuns) => {
      const set = (id, value) => { const el = $id(id); if (el) el.textContent = A.fmt(value ?? 0); };
      set("ai-stat-removed", stats?.commentsRemoved);
      set("ai-stat-warned", stats?.warningsSent);
      set("ai-stat-added", stats?.problemsAdded);
      set("ai-stat-dups", stats?.duplicatesRemoved);
      set("ai-stat-errguard", stats?.bugGuardRemoved);
      set("ai-stat-premium", stats?.premiumAdded);
      const last = (id, key) => { const el = $id(id); if (el) el.textContent = `${key}: ${lastRuns?.[keyMap(key)] ? A.ago(new Date(lastRuns[keyMap(key)]).toISOString()) : "never"}`; };
      const keyMap = (label) => ({ Moderation: "moderation", Dedup: "dedup", "Error guard": "errguard", Factory: "problems", Welcome: "welcome", Expiry: "expiry", Winback: "winback", Stuck: "stuck", Leaderboard: "lead", FAQ: "faq" }[label] || label);
      last("ai-last-mod", "Moderation"); last("ai-last-dedup", "Dedup"); last("ai-last-errguard", "Error guard");
      last("ai-last-gen", "Factory"); last("ai-last-welcome", "Welcome");
      last("ai-last-exp", "Expiry"); last("ai-last-winback", "Winback"); last("ai-last-stuck", "Stuck");
      last("ai-last-lead", "Leaderboard"); last("ai-last-faq", "FAQ");
    };
    const renderLogs = (logs) => {
      const tbody = $id("ai-log-tbody");
      if (!tbody) return;
      tbody.innerHTML = !logs?.length
        ? '<tr><td colspan="4" class="muted">No activity yet — turn the AI ON and run something.</td></tr>'
        : logs.map((entry) => `<tr><td class="mono muted">${A.esc(A.date(entry.t))}</td><td>${A.tag(entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : entry.level === "success" ? "solved" : "muted")}</td><td><strong>${A.esc(entry.action)}</strong></td><td class="muted">${A.esc(entry.detail)}</td></tr>`).join("");
    };
    const renderDigest = (digest) => {
      const body = $id("ai-digest-body");
      if (!body) return;
      if (!digest) { body.innerHTML = '<div class="empty-alert">No digest yet — build one.</div>'; return; }
      const s = digest.stats || {};
      const chip = (label, value, tone = "") => `<span class="ai-chip ${tone}"><strong>${A.fmt(value)}</strong> ${label}</span>`;
      body.innerHTML = `
        <div class="ai-digest-chips">
          ${chip("users", s.totalUsers)}${chip("new today", s.newUsers, "tag-green")}${chip("problems", s.totalProblems)}
          ${chip("new problems", s.newProblems, "tag-green")}${chip("submissions 24h", s.subs24)}${chip("solve rate", s.solveRate === null || s.solveRate === undefined ? "—" : `${s.solveRate}%`, s.solveRate !== null && s.solveRate !== undefined && s.solveRate < 35 ? "tag-red" : "")}
          ${chip("comments 24h", s.comments24)}${chip("removed 24h", s.removed24, "tag-amber")}${chip("AI added 24h", s.added24, "tag-cyan")}
        </div>
        <ul class="hint-list">${(digest.highlights || []).map((h) => `<li>${A.esc(h)}</li>`).join("")}</ul>
        <p class="muted">Generated ${A.ago(digest.generated_at)} · top problem (7d): ${A.esc(s.topProblem?.title || "—")} (${A.fmt(s.topProblem?.attempts || 0)} attempts)</p>`;
    };
    const renderHealth = (health) => {
      const body = $id("ai-health-body");
      const list = $id("ai-health-list");
      if (!body || !list) return;
      if (!health) { body.innerHTML = '<div class="empty-alert">Run the health check.</div>'; list.innerHTML = ""; return; }
      const score = Math.max(0, Math.min(100, Number(health.score) || 0));
      body.innerHTML = `<div class="ai-scorebar"><div class="ai-scorebar__fill ${score < 50 ? "ai-scorebar__fill--bad" : score < 80 ? "ai-scorebar__fill--warn" : "ai-scorebar__fill--good"}" style="width:${score}%"></div></div><p><strong class="ai-score">${score}</strong><span class="muted">/100 · ${health.checks?.length || 0} checks · ${A.ago(health.generated_at)}</span></p>`;
      list.innerHTML = (health.checks || []).map((check) => `
        <div class="ai-check ai-check--${check.status}">
          <span class="ai-check__dot">${check.status === "ok" ? "✓" : "✗"}</span>
          <div class="ai-check__copy"><strong>${A.esc(check.label)}</strong><span>${A.esc(check.detail)}</span></div>
          ${check.fix?.id ? `<button class="btn btn-sm" data-fix="${A.attr(check.fix.id)}">Fix</button>` : ""}
        </div>`).join("");
    };
    const renderCalib = () => {
      const body = $id("ai-calib-body");
      if (!body) return;
      if (!calib) { body.innerHTML = '<div class="empty-alert">Run the calibration to load suggestions.</div>'; return; }
      if (!calib.suggestions?.length) { body.innerHTML = `<div class="empty-alert">No suggestions — ${A.fmt(calib.judged)} problem(s) judged, solve rates look balanced.</div>`; return; }
      body.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th></th><th>Problem</th><th>Now</th><th>Suggested</th><th>Solve rate</th><th>Why</th><th></th></tr></thead><tbody>${calib.suggestions.map((s, i) => `<tr>
        <td><input type="checkbox" data-calib-check="${i}" checked></td>
        <td><a class="cell-title text-cyan" href="/problem-edit.html?id=${encodeURIComponent(s.problem_id)}">${A.esc(s.title)}</a></td>
        <td>${A.tag(s.current)}</td><td>${A.tag(s.suggested)}</td>
        <td><strong>${s.rate}%</strong><span class="cell-sub">${A.fmt(s.attempts)} attempts</span></td>
        <td class="muted">${A.esc(s.reason)}</td>
        <td><button class="btn btn-sm" data-calib-one="${i}">Apply</button></td>
      </tr>`).join("")}</tbody></table></div>`;
    };
    const renderPreview = (preview) => {
      const card = $id("ai-preview-card");
      const body = $id("ai-preview-body");
      if (!card || !body) return;
      card.hidden = false;
      const p = preview.problem || {};
      body.innerHTML = `
        <div class="ai-digest-chips">${A.tag(p.type)}${A.tag(p.difficulty)}${A.tag(p.topic)}${p.is_premium ? A.tag("premium") : A.tag("free")}</div>
        <h3>${A.esc(p.title)}</h3>
        <p>${A.esc(p.description)}</p>
        <div class="grid-2">
          <div><h4 class="ai-subhead">Starter code</h4><pre class="code">${A.esc(p.starter_code)}</pre></div>
          <div><h4 class="ai-subhead">Expected output</h4><pre class="code">${A.esc(p.expected_output)}</pre></div>
        </div>
        <h4 class="ai-subhead">Hints (${(p.hints || []).length})</h4>
        <ul class="hint-list">${(p.hints || []).map((h) => `<li>${A.esc(h)}</li>`).join("")}</ul>
        <h4 class="ai-subhead">Validation checklist</h4>
        <div class="ai-checks">${(preview.checks || []).map((c) => `<div class="ai-check ai-check--${c.pass ? "ok" : "bad"}"><span class="ai-check__dot">${c.pass ? "✓" : "✗"}</span><div class="ai-check__copy"><strong>${A.esc(c.label)}</strong></div></div>`).join("")}</div>
        <p class="muted">Template <code>${A.esc(preview.template_id)}</code> · nothing was inserted — use “Generate” in the factory card to add a batch.</p>`;
    };
    const renderResult = (id, html) => { const el = $id(id); if (el) { el.hidden = false; el.innerHTML = html; } };

    /* ---------------- actions ---------------- */
    const refreshAll = async () => {
      try {
        const [settingsData, logsData, digestData] = await Promise.all([
          A.aiGet("settings"), A.aiGet("logs", { limit: 100 }), A.aiGet("digest"),
        ]);
        settings = settingsData?.settings || settings;
        paintSettings();
        paintStats(settingsData?.stats, settingsData?.last_runs);
        renderLogs(logsData?.logs);
        renderDigest(digestData?.digest);
      } catch (error) { A.toast(error.message, "error"); }
    };
    const save = async (patch) => {
      try {
        const data = await A.ai("save_settings", { patch });
        settings = data.settings;
        paintSettings();
        A.toast("Settings saved");
      } catch (error) { A.toast(error.message, "error"); }
    };
    const act = async (button, action, payload = {}, options = {}) => {
      if (!control) return;
      let reason = "";
      if (options.ask) {
        const values = await A.dialog({
          title: options.title || "Run AI action",
          message: options.message || "",
          reason: true,
          danger: options.danger !== false,
          confirmLabel: options.confirmLabel || "Run",
        });
        if (!values) return;
        reason = values.reason;
      }
      const result = await A.run(button, () => A.ai(action, payload, reason), options.success || "Done");
      await refreshAll();
      return result;
    };
    const loadHealth = async (button) => {
      const health = await A.run(button, () => A.ai("health"), "Health check done");
      renderHealth(health);
    };
    const loadCalib = async (button) => {
      calib = await A.run(button, () => A.ai("calibrate"), "Calibration done");
      renderCalib();
    };
    const applyCalib = async (button, selectedOnly) => {
      if (!calib?.suggestions?.length) return;
      const chosen = selectedOnly
        ? calib.suggestions.filter((_, i) => document.querySelector(`[data-calib-check="${i}"]`)?.checked)
        : calib.suggestions;
      if (!chosen.length) return A.toast("Select at least one suggestion", "error");
      const values = await A.dialog({ title: "Apply difficulty changes", message: `Apply ${chosen.length} suggestion(s)? This edits those problems.`, reason: true, danger: true, confirmLabel: "Apply" });
      if (!values) return;
      const items = chosen.map((s) => ({ problem_id: s.problem_id, suggested: s.suggested, title: s.title, reason: s.reason }));
      await A.run(button, () => A.ai("calibrate_apply", { items }, values.reason), "Difficulty updated");
      await loadCalib($id(selectedOnly ? "ai-btn-calib-apply" : "ai-btn-calib-apply-all"));
      await refreshAll();
    };
    const FIX_ACTIONS = {
      dedup: { action: "dedup", title: "Delete duplicate problems", message: "The AI scans the library and deletes newer duplicates (keeping the oldest), including their submissions and discussions.", confirmLabel: "Delete duplicates" },
      errguard: { action: "errguard", title: "Run the bug error-guard", message: "Deletes Fix-the-Bug problems whose starter code runs WITHOUT raising any Python error.", confirmLabel: "Delete error-free bugs" },
      moderation: { action: "scan", title: "Run discussion moderation", message: "Scans the latest comments, deletes abusive ones and warns the offenders.", confirmLabel: "Scan now" },
      factory: { action: "generate", title: "Run the problem factory", message: "Generates a validated batch of problems (mix/difficulty from the factory settings).", confirmLabel: "Generate" },
      "factory-hard": { action: "generate", payload: { difficulty: "hard" }, title: "Run the problem factory (hard)", message: "Generates a validated batch of HARD problems.", confirmLabel: "Generate" },
      hints: { action: "hints", title: "Auto-fix weak hints", message: "Tops problems up to exactly 3 hints using the topic hint bank.", confirmLabel: "Fix hints" },
    };
    const FIX_LINKS = { discussions: "/moderation.html", broadcast: "/push.html" };

    /* ---------------- bindings ---------------- */
    $id("ai-btn-refresh")?.addEventListener("click", refreshAll);
    const master = $id("ai-master");
    master?.addEventListener("change", () => save({ master: master.checked }));
    $$("[data-setting]").forEach((input) => input.addEventListener("change", () => save({ [input.dataset.setting]: input.checked })));
    $$("[data-factory]").forEach((input) => input.addEventListener("change", () => save({ [input.dataset.factory]: input.tagName === "SELECT" ? input.value : Number(input.value) })));

    $id("ai-btn-scan")?.addEventListener("click", (e) => act(e.currentTarget, "scan", {}, { ask: true, title: "Run discussion moderation", message: "Scans the latest comments, deletes abusive ones and warns the offenders.", confirmLabel: "Scan now", success: "Moderation scan done" }));
    $id("ai-btn-dedup")?.addEventListener("click", (e) => act(e.currentTarget, "dedup", {}, { ask: true, title: "Delete duplicate problems", message: "The AI scans the library and deletes newer duplicates (keeping the oldest), including their submissions and discussions.", confirmLabel: "Delete duplicates", success: "Dedup done" }));
    $id("ai-btn-errguard")?.addEventListener("click", (e) => act(e.currentTarget, "errguard", {}, { ask: true, title: "Run the bug error-guard", message: "Deletes Fix-the-Bug problems whose starter code runs WITHOUT raising any Python error.", confirmLabel: "Delete error-free bugs", success: "Error guard done" }));
    $id("ai-btn-generate")?.addEventListener("click", (e) => act(e.currentTarget, "generate", {}, { ask: true, title: "Run the problem factory", message: "Generates a validated batch of problems (mix/difficulty from the factory settings above).", confirmLabel: "Generate", success: "Problems generated" }));
    $id("ai-btn-welcome")?.addEventListener("click", (e) => act(e.currentTarget, "welcome", {}, { ask: true, title: "Welcome new users", message: "Sends a welcome notification to users who joined in the last 24h.", confirmLabel: "Send welcomes", success: "Welcomes sent" }));
    $id("ai-btn-preview")?.addEventListener("click", async (e) => {
      const preview = await A.run(e.currentTarget, () => A.ai("preview"), "Preview ready");
      renderPreview(preview);
    });
    $id("ai-btn-exp")?.addEventListener("click", (e) => act(e.currentTarget, "expiry", {}, { ask: true, title: "Premium expiry reminders", message: "Reminds users whose premium expires within 3 days (and expired within 2).", confirmLabel: "Send reminders", success: "Reminders sent" }));
    $id("ai-btn-winback")?.addEventListener("click", (e) => act(e.currentTarget, "winback", {}, { ask: true, title: "Win-back inactive users", message: "Nudges users inactive for 7+ days with a personal note.", confirmLabel: "Send nudges", success: "Win-back done" }));
    $id("ai-btn-stuck")?.addEventListener("click", (e) => act(e.currentTarget, "stuck", {}, { ask: true, title: "Stuck-user encouragement", message: "Helps users with 5+ failed attempts and no solve on one problem.", confirmLabel: "Send help", success: "Stuck help sent" }));
    $id("ai-btn-lead")?.addEventListener("click", (e) => act(e.currentTarget, "leaderboard", {}, { ask: true, title: "Leaderboard alerts", message: "Congratulates top-25 XP users who enter the top 10 or climb 3+ spots.", confirmLabel: "Send alerts", success: "Leaderboard alerts sent" }));
    $id("ai-btn-faq")?.addEventListener("click", (e) => act(e.currentTarget, "faq", { limit: 10 }, { ask: true, title: "FAQ auto-helper", message: "Replies to top-level questions older than 24h that have no answer yet (posted as you).", confirmLabel: "Reply to questions", success: "FAQ replies posted" }));
    $id("ai-btn-cheat")?.addEventListener("click", async (e) => {
      const report = await A.run(e.currentTarget, () => A.ai("cheat"), "Cheat scan done");
      renderResult("ai-cheat-body", !report.hits?.length
        ? `<div class="alert">✅ Checked ${A.fmt(report.checked)} submissions — no copy-paste rings found.</div>`
        : `<div class="alert alert-danger">⚠️ ${report.hits.length} shared-code group(s) need review (same code from 3+ users on one problem):</div><div class="table-wrap"><table class="table"><thead><tr><th>Problem</th><th>Users</th><th>Copies</th></tr></thead><tbody>${report.hits.map((h) => `<tr><td>${A.esc(h.problemTitle)}</td><td>${h.userNames.map((n) => A.esc(n)).join(", ")}</td><td><strong>${h.users.length}</strong></td></tr>`).join("")}</tbody></table></div>`);
    });
    $id("ai-btn-gap")?.addEventListener("click", async (e) => {
      const result = await act(e.currentTarget, "gap", { count: 3 }, { ask: true, title: "Fill topic gaps", message: "Finds the thinnest topic × difficulty cells and generates problems for them.", confirmLabel: "Fill gaps", success: "Gaps filled" });
      if (result) renderResult("ai-gap-result", `<div class="alert">✅ Added ${A.fmt(result.added?.length || 0)} problem(s), skipped ${A.fmt(result.skipped || 0)} duplicate(s). Thinnest cells: ${(result.cells || []).map((c) => `${c.topic}/${c.diff} (${c.count})`).join(", ") || "—"}</div>`);
    });
    $id("ai-btn-quality")?.addEventListener("click", async (e) => {
      const report = await A.run(e.currentTarget, () => A.ai("quality"), "Quality report done");
      renderResult("ai-quality-body", !report.issues?.length
        ? `<div class="alert">✅ All ${A.fmt(report.total)} problems passed every quality check.</div>`
        : `<div class="alert alert-danger">⚠️ ${report.issues.length} of ${A.fmt(report.total)} problems flagged:</div><div class="table-wrap"><table class="table"><thead><tr><th>Problem</th><th>Flags</th></tr></thead><tbody>${report.issues.map((p) => `<tr><td><a class="cell-title text-cyan" href="/problem-edit.html?id=${encodeURIComponent(p.id)}">${A.esc(p.title)}</a></td><td>${p.flags.map((f) => A.tag("warn")).join("")}</td></tr>`).join("")}</tbody></table></div>`);
    });
    $id("ai-btn-hints")?.addEventListener("click", async (e) => {
      const result = await act(e.currentTarget, "hints", {}, { ask: true, title: "Auto-fix weak hints", message: "Tops problems up to exactly 3 hints using the topic hint bank.", confirmLabel: "Fix hints", success: "Hints repaired" });
      if (result) renderResult("ai-hints-result", `<div class="alert">✅ Checked ${A.fmt(result.checked)} problem(s), topped up ${A.fmt(result.fixed)}.</div>`);
    });
    $id("ai-btn-bulk-check")?.addEventListener("click", async (e) => {
      const text = $id("ai-bulk-text")?.value || "";
      const format = $id("ai-bulk-format")?.value || "json";
      const report = await A.run(e.currentTarget, () => A.ai("bulk_validate", { text, format }), "Validation done");
      const rows = (report.verdicts || []).map((v, i) => `<tr><td>${i + 1}</td><td>${v.ok ? A.tag("solved") : A.tag("deleted")}</td><td class="muted">${A.esc(v.errors?.join("; ") || v.warnings?.join("; ") || "ok")}</td></tr>`).join("");
      renderResult("ai-bulk-body", `<div class="alert">${report.valid} of ${report.total} rows valid${report.errors?.length ? ` · parse errors: ${report.errors.map((x) => A.esc(x.error || x)).join("; ")}` : ""}.</div>${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Verdict</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}`);
    });
    $id("ai-btn-bulk-import")?.addEventListener("click", async (e) => {
      const text = $id("ai-bulk-text")?.value || "";
      const format = $id("ai-bulk-format")?.value || "json";
      if (!text.trim()) return A.toast("Paste rows first", "error");
      const values = await A.dialog({ title: "Bulk import problems", message: "Valid rows are inserted as published problems (validated and duplicate-checked). Invalid rows are skipped.", reason: true, danger: true, confirmLabel: "Import" });
      if (!values) return;
      const result = await A.run(e.currentTarget, () => A.ai("bulk_import", { text, format }, values.reason), "Import done");
      renderResult("ai-bulk-body", `<div class="alert">✅ Imported ${A.fmt(result.added)} problem(s).</div>`);
      await refreshAll();
    });
    $id("ai-btn-digest")?.addEventListener("click", async (e) => {
      const digest = await act(e.currentTarget, "digest", { build: true }, { ask: true, title: "Build the daily digest", message: "Reads users, problems, submissions, comments and AI activity, then writes the digest.", confirmLabel: "Build digest", success: "Digest built" });
      if (digest) renderDigest(digest);
    });
    $id("ai-btn-health")?.addEventListener("click", (e) => loadHealth(e.currentTarget));
    $id("ai-btn-calib")?.addEventListener("click", (e) => loadCalib(e.currentTarget));
    $id("ai-btn-calib-apply")?.addEventListener("click", (e) => applyCalib(e.currentTarget, true));
    $id("ai-btn-calib-apply-all")?.addEventListener("click", (e) => applyCalib(e.currentTarget, false));
    document.addEventListener("click", async (event) => {
      const fixButton = event.target.closest?.("[data-fix]");
      if (fixButton) {
        const fixId = fixButton.dataset.fix;
        if (FIX_LINKS[fixId]) { location.href = FIX_LINKS[fixId]; return; }
        const config = FIX_ACTIONS[fixId];
        if (config) await act(fixButton, config.action, config.payload || {}, { ask: true, ...config, success: "Fixed" });
        return;
      }
      const one = event.target.closest?.("[data-calib-one]");
      if (one && calib?.suggestions?.length) {
        const item = calib.suggestions[Number(one.dataset.calibOne)];
        if (!item) return;
        const values = await A.dialog({ title: "Apply difficulty change", message: `“${item.title}”: ${item.current} → ${item.suggested} (${item.reason}).`, reason: true, confirmLabel: "Apply" });
        if (!values) return;
        await A.run(one, () => A.ai("calibrate_apply", { items: [{ problem_id: item.problem_id, suggested: item.suggested, title: item.title, reason: item.reason }] }, values.reason), "Applied");
        await loadCalib($id("ai-btn-calib"));
        await refreshAll();
      }
    });
    $id("ai-btn-diag")?.addEventListener("click", async (e) => {
      const code = $id("ai-diag-code")?.value || "";
      if (!code.trim()) return A.toast("Paste some code first", "error");
      const report = await A.run(e.currentTarget, () => A.ai("diagnose", { code }), "Diagnosis ready");
      renderResult("ai-diag-body", report.report?.diagnostics?.length
        ? `<div class="ai-checks">${report.report.diagnostics.map((d) => `<div class="ai-check ai-check--${d.severity === "error" ? "bad" : d.severity === "warn" ? "warn" : "ok"}"><span class="ai-check__dot">${d.severity === "error" ? "✗" : d.severity === "warn" ? "!" : "✓"}</span><div class="ai-check__copy"><strong>${A.esc(d.message)}</strong><span>line ${d.line}${d.hint ? ` — ${A.esc(d.hint)}` : ""}</span></div></div>`).join("")}</div>`
        : '<div class="alert">✅ No issues found by the local checker.</div>');
    });
    $id("ai-btn-test")?.addEventListener("click", async (e) => {
      const text = $id("ai-test-text")?.value || "";
      if (!text.trim()) return A.toast("Type some text first", "error");
      const { scan } = await A.run(e.currentTarget, () => A.ai("test_text", { text }), "Test done");
      const tone = scan.flagged ? (scan.severity === "severe" ? "deleted" : scan.severity === "spam" ? "warn" : "warn") : "solved";
      renderResult("ai-test-result", scan.flagged
        ? `<div class="alert alert-danger">🚫 Flagged as <strong>${A.esc(scan.severity)}</strong> — hits: ${scan.hits.map((h) => A.esc(h)).join(", ")}. The guard would delete this comment${settings?.warn_user === true ? " and warn the author" : ""}.</div>`
        : '<div class="alert">✅ Clean — the guard would keep this comment.</div>');
    });
    $id("ai-btn-clear-logs")?.addEventListener("click", async (e) => {
      const values = await A.dialog({ title: "Clear the AI activity log", message: "Deletes every row in ai_logs. This cannot be undone.", reason: true, requireText: "CLEAR", danger: true, confirmLabel: "Clear log" });
      if (!values) return;
      await A.run(e.currentTarget, () => A.ai("clear_logs", {}, values.reason), "Log cleared");
      await refreshAll();
    });

    /* ---------------- background watch (while this page is open) ---------------- */
    const watchNote = $id("ai-watch-note");
    if (watchNote && control) {
      const tick = async () => {
        try {
          const result = await A.ai("watch");
          if (result.ran) {
            const names = (result.results || []).map((r) => r.name).join(", ");
            watchNote.textContent = `Watch: tick ${A.ago(new Date().toISOString())}${names ? ` — ran ${names}` : " — nothing due"}`;
            if (result.results?.length) await refreshAll();
          } else {
            watchNote.textContent = `Watch: ${result.reason === "master_off" ? "master OFF" : "rate-limited"}`;
          }
        } catch { /* watch is best-effort */ }
        setTimeout(tick, 60000);
      };
      setTimeout(tick, 5000);
    }

    if (!control) A.toast("Read-only: your role can view the AI Control Center but not run actions.", "error");
    await refreshAll();
  }

  const handlers={dashboard,users,user:userDetail,problems,"problem-edit":problemEdit,ai:aiControl,payments,referrals,battles,moderation,push,emails,reports,settings,audit};
  window.AdminPages={init:async(page)=>{const handler=handlers[page];if(!handler)throw new Error(`Unknown page: ${page}`);await handler();}};
})();
