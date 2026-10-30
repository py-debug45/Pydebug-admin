// =============================================================
// presence-heartbeat.js — install in the USER-facing PyDebug app
// =============================================================
// Apply db/migrations/20261030_presence_server_clock.sql first. Copy this file
// into the learner app and load it after its Supabase client on its main pages.
// The database, not the learner's device clock, timestamps each heartbeat.
//
// A visible, signed-in page sends a heartbeat every 25 seconds. A hidden,
// closed or signed-out page stops; the dashboard expires the row within about
// 60 seconds. No unload delete is sent: the table has one row per USER, and
// deleting it when one tab closes would incorrectly hide other open devices.
// This is a best-effort estimate, not proof of human activity. Nothing here
// should block or break the learner app.
// =============================================================
(function () {
  "use strict";
  if (window.__pydebugPresenceLoaded) return;
  window.__pydebugPresenceLoaded = true;

  const BEAT_MS = 25 * 1000;
  const TABLE = "user_presence";
  let sbClient = null;
  let userId = null;
  let timer = null;
  let pageActive = true;
  let lastBeatAt = 0;
  let authRevision = 0;

  function beat() {
    if (!sbClient || !userId || !pageActive) return;
    if (document.visibilityState && document.visibilityState !== "visible") return;
    if (document.hidden) return;
    const now = Date.now();
    // Focus, pageshow and token events can arrive together. Avoid a burst of
    // identical writes, but do not let a corrected device clock block beats.
    if (lastBeatAt && now >= lastBeatAt && now - lastBeatAt < 1000) return;
    lastBeatAt = now;
    let page = "/";
    try { page = location.pathname || "/"; } catch (e) {}
    try {
      sbClient.from(TABLE)
        .upsert({ user_id: userId, page: page }, { onConflict: "user_id" })
        .then(function () {})
        .catch(function () {});
    } catch (e) { /* never break the learner app */ }
  }

  function stop() {
    userId = null;
    lastBeatAt = 0;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function start(uid) {
    if (!uid) { stop(); return; }
    if (userId !== uid) {
      stop();
      userId = uid;
    }
    beat();
    if (!timer) timer = setInterval(beat, BEAT_MS);
  }

  function tryBoot() {
    if (sbClient) return true;
    let client = window.sb;
    // A top-level `const sb` is a global lexical binding, not window.sb.
    try { if (!client && typeof sb !== "undefined") client = sb; } catch (e) {}
    if (!client || !client.auth || typeof client.from !== "function" ||
        typeof client.auth.getSession !== "function" || typeof client.auth.onAuthStateChange !== "function") return false;
    sbClient = client;

    try {
      sbClient.auth.onAuthStateChange(function (_event, session) {
        const revision = ++authRevision;
        if (!session || !session.user) { stop(); return; }
        // Avoid issuing Supabase requests inside its auth-state callback lock.
        setTimeout(function () {
          if (revision === authRevision) start(session.user.id);
        }, 0);
      });
      const revision = authRevision;
      sbClient.auth.getSession().then(function (res) {
        if (revision !== authRevision) return;
        const session = res && res.data && res.data.session;
        start(session && session.user && session.user.id);
      }).catch(function () {});
    } catch (e) { /* fail-safe */ }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") beat();
    });
    window.addEventListener("focus", beat);
    window.addEventListener("online", beat);
    window.addEventListener("pagehide", function () { pageActive = false; });
    window.addEventListener("pageshow", function () { pageActive = true; beat(); });
    return true;
  }

  let attempts = 0;
  (function wait() {
    if (tryBoot()) return;
    if (++attempts > 60) return;
    setTimeout(wait, 500);
  })();
})();
