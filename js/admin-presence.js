// Dashboard: server-timed live presence and daily practice.
//
// A live user is one whose latest heartbeat reached the database in the last
// 60 seconds. This is an estimate of an open, foreground page, not proof that
// someone is actively using it. A closed page can remain visible for up to
// a minute if its final request is lost. The server supplies both the snapshot
// time and the heartbeat timestamps, so neither browser's clock can create a
// permanent "online" user.

const PRESENCE_TTL_MS = 60 * 1000;
const PRESENCE_POLL_MS = 25 * 1000;
const PRESENCE_TICK_MS = 5 * 1000;
const PRESENCE_DEBOUNCE_MS = 900;
const PRESENCE_MAX_ROWS = 25;
const DAILY_POLL_MS = 60 * 1000;
const DAILY_MAX_ROWS = 20;
const PRESENCE_PAGE_SIZE = 500;
const PRESENCE_PROFILE_BATCH = 100;

let presenceLive = new Map();
let presenceChannel = null;
let presenceStarted = false;
let presenceBroken = false;
let presenceRefreshQueued = false;
let presenceRefreshPending = false;
let presenceInFlight = null;
let presenceError = null;
let lastPresenceRefresh = 0;
let dailyInFlight = null;
let lastLiveSignature = "";

function presenceLocalTodayStr() {
  // profiles.last_active_date uses the user's local YYYY-MM-DD convention.
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function presenceUserName(p) {
  if (!p) return null;
  return p.display_name || p.full_name || (p.email ? p.email.split("@")[0] : null) || null;
}

function presenceFormatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
}

// The snapshot's age is calculated on the server. Locally we only measure
// elapsed time since the request began, conservatively including its latency.
// performance.now() survives wall-clock corrections; Date.now() also handles
// browsers whose monotonic clock pauses while a phone sleeps.
function presenceClock() {
  return {
    wall: Date.now(),
    monotonic: typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now() : null,
  };
}

function presenceElapsed(clock) {
  const wall = Date.now() - clock.wall;
  const monotonic = clock.monotonic !== null && typeof performance !== "undefined"
    ? performance.now() - clock.monotonic : 0;
  return Math.max(0, wall, monotonic);
}

function presenceAge(user) {
  return user.ageAtCheck + presenceElapsed(user.clock);
}

async function presenceProfiles(ids, columns) {
  const profiles = new Map();
  // Large .in() filters can exceed URL limits; don't lose users when a list
  // grows beyond one batch or the PostgREST per-response row limit.
  for (let i = 0; i < ids.length; i += PRESENCE_PROFILE_BATCH) {
    const { data, error } = await sb.from("profiles").select(columns)
      .in("id", ids.slice(i, i + PRESENCE_PROFILE_BATCH));
    if (error) throw error;
    (data || []).forEach((profile) => profiles.set(profile.id, profile));
  }
  return profiles;
}

// ---------- Live right now -------------------------------------------------

function presenceSetupMissing(err) {
  const code = err && err.code;
  const msg = String((err && (err.message || err.hint)) || "");
  return ["42P01", "42883", "PGRST202", "PGRST205"].includes(code) ||
    /could not find (?:the )?function (?:public\.)?admin_get_live_presence/i.test(msg);
}

async function loadLiveUsers() {
  const clock = presenceClock();
  const { data, error } = await sb.rpc("admin_get_live_presence");
  if (error) throw error;
  const checkedAt = data && Date.parse(data.checked_at);
  if (!data || !Array.isArray(data.rows) || !Number.isFinite(checkedAt)) {
    throw new Error("Invalid live presence snapshot");
  }

  const users = [];
  data.rows.forEach((row) => {
    const seenAt = Date.parse(row.last_seen_at);
    const ageAtCheck = checkedAt - seenAt;
    // Also validate the result in the browser. In particular a legacy future
    // timestamp must never be clamped to "0s ago" and shown indefinitely.
    if (!row.user_id || !Number.isFinite(ageAtCheck) || ageAtCheck < 0 || ageAtCheck >= PRESENCE_TTL_MS) return;
    const user = { userId: row.user_id, ageAtCheck, clock, page: row.page || "", profile: null };
    if (presenceAge(user) < PRESENCE_TTL_MS) users.push(user);
  });
  users.sort((a, b) => a.ageAtCheck - b.ageAtCheck);

  // Names are only needed for the visible rows. The snapshot itself contains
  // all active IDs, so the count is not silently truncated at 500 or 1,000.
  const ids = [...new Set(users.slice(0, PRESENCE_MAX_ROWS).map((user) => user.userId))];
  let profiles = new Map();
  if (ids.length) {
    try {
      profiles = await presenceProfiles(ids, "id, display_name, full_name, email, is_premium");
    } catch (e) {
      console.warn("presence profiles:", e.message);
    }
  }

  const next = new Map();
  users.forEach((user) => {
    if (presenceAge(user) >= PRESENCE_TTL_MS) return;
    user.profile = profiles.get(user.userId) || null;
    next.set(user.userId, user);
  });
  return next;
}

function renderLiveList() {
  const countEl = document.getElementById("live-count");
  const statEl = document.getElementById("stat-active-now");
  const listEl = document.getElementById("live-list");
  if (!listEl) return;

  if (presenceError) {
    lastLiveSignature = "";
    if (statEl) statEl.textContent = "—";
    if (countEl) countEl.textContent = "—";
    listEl.innerHTML = `<li class="empty-row">${escapeHtml(presenceError)}</li>`;
    return;
  }

  const items = [...presenceLive.values()].sort((a, b) => a.ageAtCheck - b.ageAtCheck);
  const signature = JSON.stringify(items.map((user) => [
    user.userId, user.page, presenceUserName(user.profile), !!(user.profile && user.profile.is_premium),
  ]));
  if (statEl) statEl.textContent = String(items.length);
  if (countEl) countEl.textContent = String(items.length);

  // Do not rebuild the list for every heartbeat, but do use the latest
  // heartbeat from the map when updating its age labels.
  if (signature === lastLiveSignature && listEl.childElementCount) {
    tickPresenceTimes();
    return;
  }
  lastLiveSignature = signature;

  if (!items.length) {
    listEl.innerHTML = `<li class="empty-row">Nobody is on the site right now.</li>`;
    return;
  }

  listEl.innerHTML = items.slice(0, PRESENCE_MAX_ROWS).map((user) => {
    const name = escapeHtml(presenceUserName(user.profile) || "User " + String(user.userId).slice(0, 6));
    const premium = user.profile && user.profile.is_premium ? ' <span class="tag tag--premium">Pro</span>' : "";
    const page = user.page && user.page !== "/" ? `<span class="live-item__page">${escapeHtml(user.page)}</span>` : "";
    return `<li>
      <span class="live-item__dot"></span>
      <span class="live-item__name">${name}${premium}</span>
      ${page}
      <span class="live-item__time" data-presence-id="${escapeHtml(user.userId)}"></span>
    </li>`;
  }).join("") +
  (items.length > PRESENCE_MAX_ROWS
    ? `<li class="empty-row">…and ${items.length - PRESENCE_MAX_ROWS} more</li>` : "");
  tickPresenceTimes();
}

function tickPresenceTimes() {
  if (presenceError) return;
  let changed = false;
  presenceLive.forEach((user, id) => {
    if (presenceAge(user) >= PRESENCE_TTL_MS) {
      presenceLive.delete(id);
      changed = true;
    }
  });
  if (changed) { renderLiveList(); return; }

  const listEl = document.getElementById("live-list");
  if (listEl) {
    listEl.querySelectorAll("[data-presence-id]").forEach((el) => {
      const user = presenceLive.get(el.dataset.presenceId);
      if (user) el.textContent = presenceFormatAge(presenceAge(user));
    });
  }
  const upd = document.getElementById("live-updated");
  if (upd) upd.textContent = lastPresenceRefresh ? "updated " + presenceFormatAge(Date.now() - lastPresenceRefresh) : "";
}

function refreshLive() {
  if (presenceBroken) return Promise.resolve(false);
  if (presenceInFlight) {
    // Coalesce overlapping poll/realtime events, then perform one fresh read.
    // An older slow response can never overwrite a newer snapshot.
    presenceRefreshPending = true;
    return presenceInFlight;
  }
  presenceInFlight = (async () => {
    try {
      presenceLive = await loadLiveUsers();
      presenceError = null;
      lastPresenceRefresh = Date.now();
      renderLiveList();
      tickPresenceTimes();
      return true;
    } catch (e) {
      presenceBroken = presenceSetupMissing(e);
      presenceError = presenceBroken
        ? "Live activity needs the latest presence database migration. Apply it and reload."
        : "Live activity is unavailable. Retrying…";
      presenceLive = new Map();
      renderLiveList();
      const upd = document.getElementById("live-updated");
      if (upd) upd.textContent = presenceBroken ? "setup needed" : "refresh failed";
      console.warn("presence refresh:", e && e.message);
      return false;
    }
  })().finally(() => {
    presenceInFlight = null;
    if (presenceRefreshPending) {
      presenceRefreshPending = false;
      if (!presenceBroken && !document.hidden) refreshLive();
    }
  });
  return presenceInFlight;
}

// user_presence has at most one row per user. Do not delete from the client
// using the admin phone's clock: if that clock is wrong it can erase live rows.
function initLivePresence() {
  if (presenceStarted || !document.getElementById("live-list")) return;
  presenceStarted = true;
  refreshLive();
  setInterval(() => { if (!document.hidden) tickPresenceTimes(); }, PRESENCE_TICK_MS);
  setInterval(() => { if (!document.hidden) refreshLive(); }, PRESENCE_POLL_MS);
  setInterval(() => { if (!document.hidden) loadDailyPractice(); }, DAILY_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      tickPresenceTimes();
      refreshLive();
      loadDailyPractice();
    }
  });

  try {
    presenceChannel = sb
      .channel("pydebug-admin-live-presence")
      .on("postgres_changes", { event: "*", schema: "public", table: "user_presence" }, () => {
        if (document.hidden || presenceRefreshQueued) return;
        presenceRefreshQueued = true;
        setTimeout(() => { presenceRefreshQueued = false; if (!document.hidden) refreshLive(); }, PRESENCE_DEBOUNCE_MS);
      })
      .subscribe();
  } catch (e) {
    console.warn("presence realtime:", e.message); // polling still covers it
  }
}

// ---------- Practiced today ------------------------------------------------

async function presenceReadAll(buildQuery) {
  const rows = [];
  for (let offset = 0; ; offset += PRESENCE_PAGE_SIZE) {
    const { data, error } = await buildQuery().range(offset, offset + PRESENCE_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PRESENCE_PAGE_SIZE) return rows;
  }
}

function dailyUnavailable() {
  ["daily-count", "stat-daily-practice"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "—";
  });
  const sub = document.getElementById("stat-daily-sub");
  if (sub) sub.textContent = "practice data unavailable";
  const list = document.getElementById("daily-list");
  if (list) list.innerHTML = `<li class="empty-row">Practice data is unavailable. Retrying…</li>`;
}

function loadDailyPractice() {
  if (dailyInFlight) return dailyInFlight;
  dailyInFlight = loadDailyPracticeData().catch((e) => {
    console.warn("daily practice:", e && e.message);
    dailyUnavailable();
    return false;
  }).finally(() => { dailyInFlight = null; });
  return dailyInFlight;
}

async function loadDailyPracticeData() {
  const listEl = document.getElementById("daily-list");
  const countEls = [document.getElementById("daily-count"), document.getElementById("stat-daily-practice")];
  const subEl = document.getElementById("stat-daily-sub");
  const today = presenceLocalTodayStr();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startIso = startOfToday.toISOString();

  const [subResult, markedResult] = await Promise.allSettled([
    presenceReadAll(() => sb.from("submissions").select("id, user_id, created_at")
      .gte("created_at", startIso).order("id", { ascending: true })),
    presenceReadAll(() => sb.from("profiles").select("id")
      .eq("last_active_date", today).order("id", { ascending: true })),
  ]);
  if (subResult.status === "rejected") console.warn("daily submissions:", subResult.reason);
  if (markedResult.status === "rejected") console.warn("daily last_active_date:", markedResult.reason);
  if (subResult.status === "rejected" && markedResult.status === "rejected") {
    dailyUnavailable();
    return false;
  }
  const partial = subResult.status === "rejected" || markedResult.status === "rejected";
  const subCounts = {};
  const lastSubAt = {};
  const subUserIds = new Set();
  (subResult.status === "fulfilled" ? subResult.value : []).forEach((s) => {
    if (!s.user_id) return;
    subUserIds.add(s.user_id);
    subCounts[s.user_id] = (subCounts[s.user_id] || 0) + 1;
    const t = new Date(s.created_at).getTime();
    if (t > (lastSubAt[s.user_id] || 0)) lastSubAt[s.user_id] = t;
  });
  const markedIds = (markedResult.status === "fulfilled" ? markedResult.value : []).map((p) => p.id).filter(Boolean);
  const ids = [...new Set([...markedIds, ...subUserIds])];

  let profiles = new Map();
  let namesUnavailable = false;
  if (ids.length) {
    try {
      profiles = await presenceProfiles(ids, "id, display_name, full_name, email, streak, is_premium");
    } catch (e) {
      namesUnavailable = true;
      console.warn("daily profiles:", e.message);
    }
  }

  let totalUsers = null;
  try {
    const { count, error } = await sb.from("profiles").select("*", { count: "exact", head: true });
    if (!error && Number.isFinite(count) && count >= 0) totalUsers = count;
  } catch (e) { /* keep sub label generic */ }

  const rows = ids.map((id) => {
    const profile = profiles.get(id) || { id };
    return {
      profile,
      name: presenceUserName(profile) || "User " + String(id).slice(0, 6),
      times: subCounts[id] || 0,
      lastAt: lastSubAt[id] || null,
    };
  }).sort((a, b) => (b.times - a.times) || ((b.lastAt || 0) - (a.lastAt || 0)) || ((b.profile.streak || 0) - (a.profile.streak || 0)));

  countEls.forEach((el) => { if (el) el.textContent = String(rows.length) + (partial ? "+" : ""); });
  if (subEl && totalUsers !== null) {
    const pct = totalUsers ? Math.round((rows.length / totalUsers) * 100) : 0;
    subEl.textContent = `of ${totalUsers.toLocaleString("en-IN")} total users (${pct}%)${partial ? " · partial" : ""}`;
  } else if (subEl) {
    subEl.textContent = partial ? "since midnight · partial" : "since midnight";
  }

  if (!listEl) return !partial && !namesUnavailable;
  if (!rows.length) {
    listEl.innerHTML = partial
      ? `<li class="empty-row">No activity found in the available data; some sources could not be loaded.</li>`
      : `<li class="empty-row">Nobody has practiced yet today.</li>`;
    return !partial && !namesUnavailable;
  }

  const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  listEl.innerHTML = rows.slice(0, DAILY_MAX_ROWS).map((r, i) => {
    const premium = r.profile.is_premium ? ' <span class="tag tag--premium">Pro</span>' : "";
    const streak = Number(r.profile.streak) || 0;
    const meta = [
      r.times ? `${r.times} submission${r.times === 1 ? "" : "s"} today` : "practiced today",
      streak > 0 ? `🔥 ${streak}` : null,
    ].filter(Boolean).join(" · ");
    const time = r.lastAt ? fmtTime(r.lastAt) : "";
    return `<li>
      <span class="daily-rank">#${i + 1}</span>
      <span class="live-item__name">${escapeHtml(r.name)}${premium}</span>
      <span class="live-item__meta">${escapeHtml(meta)}</span>
      ${time ? `<span class="live-item__time">${escapeHtml(time)}</span>` : ""}
    </li>`;
  }).join("") +
  (rows.length > DAILY_MAX_ROWS ? `<li class="empty-row">…and ${rows.length - DAILY_MAX_ROWS} more</li>` : "") +
  (partial ? `<li class="empty-row">Some practice sources could not be loaded.</li>` : "") +
  (namesUnavailable ? `<li class="empty-row">Some names could not be loaded.</li>` : "");
  return !partial && !namesUnavailable;
}
