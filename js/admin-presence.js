// admin-presence.js — Dashboard: "Live right now" + "Practiced today"
//
// "Live right now" shows which REAL users are on the PyDebug site THIS
// second, by name. It is exact by design:
//   * Data source: public.user_presence — each user's app upserts a row
//     every 25s while in the foreground and deletes it on close
//     (js/presence-heartbeat.js in the user app).
//   * A user counts as ACTIVE only while last_seen_at is within
//     PRESENCE_TTL_MS (60s). A closed page stops heartbeating, so its name
//     drops out within a few seconds (immediate when the leave-delete lands,
//     and within 60s worst-case for a force-killed browser).
//   * Freshness: Supabase Realtime (postgres_changes) pushes each heartbeat
//     to this page with a polling fallback, and a local 5s tick re-checks
//     expiry — so removals show up even if the socket is down.
//
// "Practiced today" shows, of all users, who practiced today by name:
// the union of profiles with last_active_date = today (the column the user
// app's streaks use) and users with submissions since local midnight.

const PRESENCE_TTL_MS = 60 * 1000;        // "active" window
const PRESENCE_POLL_MS = 25 * 1000;       // safety-net refresh (realtime is primary)
const PRESENCE_TICK_MS = 5 * 1000;        // local expiry check + "8s ago" labels
const PRESENCE_DEBOUNCE_MS = 900;         // coalesce bursts of heartbeat events
const PRESENCE_MAX_ROWS = 25;             // live list shows top N, then "+N more"
const DAILY_MAX_ROWS = 20;

let presenceLive = new Map();      // user_id -> { userId, lastSeen, page, profile }
let presenceChannel = null;
let presenceStarted = false;
let presenceBroken = false;        // true once the table/RLS is known missing
let presenceRefreshQueued = false;
let lastPresenceRefresh = 0;
let dailyStarted = false;

function presenceLocalTodayStr() {
  // Local YYYY-MM-DD — same convention the user app uses for
  // profiles.last_active_date (both run in the owner's timezone).
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function presenceUserName(p) {
  if (!p) return null;
  return p.display_name || p.full_name || (p.email ? p.email.split("@")[0] : null) || "User";
}

function presenceSecondsAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
}

// ---------- Live right now -------------------------------------------------

function presenceTableMissing(err) {
  const code = err && (err.code || (err.details ? "" : ""));
  const msg = String((err && (err.message || err.hint)) || "");
  return code === "42P01" || code === "PGRST205" ||
    /does not exist|not found in the schema cache|user_presence/i.test(msg);
}

async function loadLiveUsers() {
  const cutoff = new Date(Date.now() - PRESENCE_TTL_MS).toISOString();
  const { data, error } = await sb
    .from("user_presence")
    .select("user_id, last_seen_at, page")
    .gte("last_seen_at", cutoff)
    .limit(500);
  if (error) throw error;

  const rows = data || [];
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const profiles = {};
  if (ids.length) {
    const { data: ups, error: pErr } = await sb
      .from("profiles")
      .select("id, display_name, full_name, email, is_premium")
      .in("id", ids);
    if (!pErr) (ups || []).forEach((u) => { profiles[u.id] = u; });
  }

  const next = new Map();
  rows.forEach((r) => {
    const ms = new Date(r.last_seen_at).getTime();
    if (isNaN(ms) || Date.now() - ms > PRESENCE_TTL_MS) return; // stale row
    next.set(r.user_id, {
      userId: r.user_id,
      lastSeen: ms,
      page: r.page || "",
      profile: profiles[r.user_id] || null,
    });
  });
  presenceLive = next;
  renderLiveList();
}

let lastLiveSignature = "";

function renderLiveList() {
  const countEl = document.getElementById("live-count");
  const statEl = document.getElementById("stat-active-now");
  const listEl = document.getElementById("live-list");
  if (!listEl) return;

  const items = [...presenceLive.values()].sort((a, b) => b.lastSeen - a.lastSeen);

  // Heartbeats arrive every few seconds but the *names on screen* rarely
  // change. Skip the innerHTML rewrite (and the icon/observer work it
  // triggers) when the visible set is identical — only the "Ns ago" labels
  // need updating, and the 5s tick already does that.
  const signature = items.map((u) => u.userId + ":" + (u.page || "")).join("|");
  if (signature === lastLiveSignature && listEl.childElementCount) {
    if (statEl) statEl.textContent = String(items.length);
    if (countEl) countEl.textContent = String(items.length);
    tickPresenceTimes();
    return;
  }
  lastLiveSignature = signature;
  if (statEl) statEl.textContent = String(items.length);
  if (countEl) countEl.textContent = String(items.length);

  if (!items.length) {
    listEl.innerHTML = `<li class="empty-row">Nobody is on the site right now.</li>`;
    return;
  }

  const shown = items.slice(0, PRESENCE_MAX_ROWS);
  listEl.innerHTML = shown.map((u) => {
    const name = escapeHtml(presenceUserName(u.profile) || "User " + String(u.userId).slice(0, 6));
    const premium = u.profile && u.profile.is_premium ? ' <span class="tag tag--premium">Pro</span>' : "";
    const page = u.page && u.page !== "/" ? `<span class="live-item__page">${escapeHtml(u.page)}</span>` : "";
    return `<li>
      <span class="live-item__dot"></span>
      <span class="live-item__name">${name}${premium}</span>
      ${page}
      <span class="live-item__time" data-last-seen="${u.lastSeen}"></span>
    </li>`;
  }).join("") +
  (items.length > PRESENCE_MAX_ROWS
    ? `<li class="empty-row">…and ${items.length - PRESENCE_MAX_ROWS} more</li>`
    : "");
  tickPresenceTimes();
}

// Local 5s tick: re-label "Ns ago" and drop anyone whose 60s window lapsed.
// This is what guarantees a closed page leaves the list even with zero
// realtime events (their last row just stops being fresh).
function tickPresenceTimes() {
  const now = Date.now();
  let changed = false;
  [...presenceLive.keys()].forEach((id) => {
    const u = presenceLive.get(id);
    if (u && now - u.lastSeen > PRESENCE_TTL_MS) {
      presenceLive.delete(id);
      changed = true;
    }
  });
  if (changed) { renderLiveList(); return; }

  const listEl = document.getElementById("live-list");
  if (listEl) {
    listEl.querySelectorAll("[data-last-seen]").forEach((el) => {
      el.textContent = presenceSecondsAgo(Number(el.dataset.lastSeen));
    });
  }
  const upd = document.getElementById("live-updated");
  if (upd) upd.textContent = lastPresenceRefresh ? "updated " + presenceSecondsAgo(lastPresenceRefresh) : "";
}

async function refreshLive() {
  if (presenceBroken) return;
  try {
    await loadLiveUsers();
    lastPresenceRefresh = Date.now();
    tickPresenceTimes();
  } catch (e) {
    if (presenceTableMissing(e)) {
      presenceBroken = true; // table not created yet — stop hammering
      const listEl = document.getElementById("live-list");
      if (listEl) listEl.innerHTML =
        `<li class="empty-row">Run the latest <code>supabase-admin-setup.sql</code> in Supabase, then reload.</li>`;
      return;
    }
    console.warn("presence refresh:", e.message);
    // Keep the last good list on screen; the tick keeps expiring it.
  }
}

// Best-effort cleanup of rows older than 24h (RLS allows only that).
async function purgeStalePresence() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await sb.from("user_presence").delete().lt("last_seen_at", cutoff);
  } catch (e) { /* harmless */ }
}

function initLivePresence() {
  if (presenceStarted || !document.getElementById("live-list")) return;
  presenceStarted = true;

  refreshLive();
  purgeStalePresence();
  // Both timers idle out while the tab is in the background: a hidden admin
  // tab used to keep querying Supabase every 25s and repainting every 5s,
  // which drains phones and makes the tab sluggish when you come back.
  setInterval(() => { if (!document.hidden) tickPresenceTimes(); }, PRESENCE_TICK_MS);
  setInterval(() => { if (!document.hidden) refreshLive(); }, PRESENCE_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshLive();
  });

  try {
    presenceChannel = sb
      .channel("pydebug-admin-live-presence")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "user_presence" },
        () => {
          if (presenceRefreshQueued) return;
          presenceRefreshQueued = true;
          setTimeout(() => { presenceRefreshQueued = false; refreshLive(); }, PRESENCE_DEBOUNCE_MS);
        })
      .subscribe();
  } catch (e) {
    console.warn("presence realtime:", e.message); // polling still covers it
  }
}

// ---------- Practiced today ------------------------------------------------

async function loadDailyPractice() {
  if (dailyStarted) return;
  dailyStarted = true;

  const listEl = document.getElementById("daily-list");
  const countEls = [document.getElementById("daily-count"), document.getElementById("stat-daily-practice")];
  const subEl = document.getElementById("stat-daily-sub");
  const today = presenceLocalTodayStr();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startIso = startOfToday.toISOString();

  // (a) Submissions since local midnight — hard proof of practice today,
  //     plus per-user count + last practice time.
  const subCounts = {};
  const lastSubAt = {};
  const subUserIds = new Set();
  try {
    const { data: subs, error } = await sb
      .from("submissions")
      .select("user_id, created_at")
      .gte("created_at", startIso)
      .limit(5000);
    if (error) throw error;
    (subs || []).forEach((s) => {
      if (!s.user_id) return;
      subUserIds.add(s.user_id);
      subCounts[s.user_id] = (subCounts[s.user_id] || 0) + 1;
      const t = new Date(s.created_at).getTime();
      if (t > (lastSubAt[s.user_id] || 0)) lastSubAt[s.user_id] = t;
    });
  } catch (e) {
    console.warn("daily submissions:", e.message);
  }

  // (b) Users the user app itself marked active today (streaks use this).
  const markedIds = new Set();
  try {
    const { data: marked, error } = await sb
      .from("profiles")
      .select("id")
      .eq("last_active_date", today)
      .limit(5000);
    if (error) throw error;
    (marked || []).forEach((p) => markedIds.add(p.id));
  } catch (e) {
    // 42703 = profiles.last_active_date missing on this project — the
    // submissions set (a) is then the only source. Anything else is noise.
    if (e.code !== "42703") console.warn("daily last_active_date:", e.message);
  }

  const ids = [...new Set([...markedIds, ...subUserIds])];
  let profiles = [];
  if (ids.length) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, display_name, full_name, email, streak, is_premium")
      .in("id", ids);
    if (!error) profiles = data || [];
  }

  let totalUsers = null;
  try {
    const { count, error } = await sb.from("profiles").select("*", { count: "exact", head: true });
    if (!error) totalUsers = count;
  } catch (e) { /* keep sub label generic */ }

  const rows = profiles
    .map((p) => ({
      profile: p,
      name: presenceUserName(p) || "User",
      submitted: subUserIds.has(p.id),
      times: subCounts[p.id] || 0,
      lastAt: lastSubAt[p.id] || null,
    }))
    .sort((a, b) => (b.times - a.times) || ((b.lastAt || 0) - (a.lastAt || 0)) || ((b.profile.streak || 0) - (a.profile.streak || 0)));

  countEls.forEach((el) => { if (el) el.textContent = String(rows.length); });
  if (subEl && totalUsers) {
    const pct = totalUsers ? Math.round((rows.length / totalUsers) * 100) : 0;
    subEl.textContent = `of ${totalUsers.toLocaleString("en-IN")} total users (${pct}%)`;
  } else if (subEl) {
    subEl.textContent = "since midnight";
  }

  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = `<li class="empty-row">Nobody has practiced yet today.</li>`;
    return;
  }

  const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  listEl.innerHTML = rows.slice(0, DAILY_MAX_ROWS).map((r, i) => {
    const premium = r.profile.is_premium ? ' <span class="tag tag--premium">Pro</span>' : "";
    const meta = [
      r.times ? `${r.times} submission${r.times === 1 ? "" : "s"} today` : "practiced today",
      (r.profile.streak || 0) > 0 ? `🔥 ${r.profile.streak}` : null,
    ].filter(Boolean).join(" · ");
    const time = r.lastAt ? fmtTime(r.lastAt) : "";
    return `<li>
      <span class="daily-rank">#${i + 1}</span>
      <span class="live-item__name">${escapeHtml(r.name)}${premium}</span>
      <span class="live-item__meta">${escapeHtml(meta)}</span>
      ${time ? `<span class="live-item__time">${escapeHtml(time)}</span>` : ""}
    </li>`;
  }).join("") +
  (rows.length > DAILY_MAX_ROWS ? `<li class="empty-row">…and ${rows.length - DAILY_MAX_ROWS} more</li>` : "");
}
