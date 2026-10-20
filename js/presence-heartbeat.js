// =============================================================
// presence-heartbeat.js — PyDebug LIVE PRESENCE (for the USER-facing app)
// =============================================================
// This is the file that makes REAL users appear on the admin panel's
// "Live right now" list (admin dashboard.html).
//
// INSTALL IN THE USER-FACING PYDEBUG APP (2 steps):
//   1. Copy this file into the user app's js/ folder.
//   2. Add ONE script tag to the user app's pages (after the script that
//      creates the global `sb` Supabase client, e.g. after
//      <script src="js/supabaseClient.js"></script>):
//        <script src="js/presence-heartbeat.js"></script>
//      Put it on the main app pages (home/problem/playground/profile).
//   Then re-run supabase-admin-setup.sql in the Supabase SQL editor —
//   it creates the user_presence table this file writes to (idempotent).
//
// HOW IT WORKS
//   * While a logged-in user has the site in the FOREGROUND, this file
//     upserts that user's row in public.user_presence every 25 seconds
//     (and immediately when the tab comes back to the foreground).
//   * When the user CLOSES the page/app, it deletes their row immediately
//     (best-effort synchronous request). If the browser is force-killed
//     before that can run, the row simply stops being refreshed — the admin
//     panel only counts rows refreshed within the last 60 seconds, so the
//     user disappears from "Live right now" within at most ~60 seconds and
//     is back INSTANTLY if they reopen the site.
//   * It is completely fail-safe: every network call is fire-and-forget,
//     nothing here can throw into, block, or break the user app.
//   * Privacy: only the user's own id + which page they are on. Nothing
//     else leaves the device.
// =============================================================
(function () {
  "use strict";
  if (window.__pydebugPresenceLoaded) return; // never double-initialise
  window.__pydebugPresenceLoaded = true;

  const BEAT_MS = 25 * 1000; // heartbeat interval while the page is visible
  const TABLE = "user_presence";

  let sbClient = null;
  let userId = null;
  let jwt = null;
  let timer = null;

  function beat() {
    if (!sbClient || !userId) return;
    // Don't count the user as "on the site" while their tab/app is in the
    // background (phone locked, other tab focused). Reappears instantly on
    // return because beat() fires the moment the page becomes visible.
    if (document.visibilityState === "hidden") return;
    let page = "/";
    try { page = (location.pathname || "/").split("?")[0]; } catch (e) {}
    try {
      sbClient.from(TABLE)
        .upsert(
          { user_id: userId, last_seen_at: new Date().toISOString(), page: page },
          { onConflict: "user_id" }
        )
        .then(function () {})
        .catch(function () {}); // silent by design
    } catch (e) { /* never break the user app */ }
  }

  // Immediate removal on close/exit. A synchronous XHR is the only reliable
  // way to ship a request that finishes DURING page teardown. If the browser
  // is force-killed instead, the 60s expiry on the admin side covers it.
  function leave() {
    if (!userId) return;
    const url = window.SUPABASE_URL;
    const key = window.SUPABASE_ANON_KEY || window.SUPABASE_KEY || window.SUPABASE_APIKEY;
    if (!url || !key || !jwt) return; // skip — TTL handles it
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("DELETE", url.replace(/\/+$/, "") + "/rest/v1/" + TABLE +
        "?user_id=eq." + encodeURIComponent(userId), false);
      xhr.setRequestHeader("apikey", key);
      xhr.setRequestHeader("Authorization", "Bearer " + jwt);
      xhr.send();
    } catch (e) { /* best-effort only */ }
  }

  function start(uid, token) {
    if (!uid) return;
    userId = uid;
    jwt = token || jwt;
    beat();
    if (timer) clearInterval(timer);
    timer = setInterval(beat, BEAT_MS);
  }

  function tryBoot() {
    if (sbClient) return true;
    // The user app exposes its Supabase client as the global `sb`
    // (same convention as this admin panel).
    if (!window.sb || typeof window.sb.auth !== "object" && !window.sb.auth) return false;
    sbClient = window.sb;
    try {
      sbClient.auth.getSession().then(function (res) {
        const session = res && res.data && res.data.session;
        if (session && session.user) start(session.user.id, session.access_token);
      }).catch(function () {});
      sbClient.auth.onAuthStateChange(function (_evt, session) {
        if (session && session.user) start(session.user.id, session.access_token);
      });
    } catch (e) { /* fail-safe */ }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") beat();
    });
    window.addEventListener("focus", beat);
    window.addEventListener("online", beat);
    window.addEventListener("pagehide", leave); // fires on close/exit
    window.addEventListener("beforeunload", leave); // older-browser fallback
    return true;
  }

  let attempts = 0;
  (function wait() {
    if (tryBoot()) return;
    if (++attempts > 60) return; // ~30s of grace, then give up quietly
    setTimeout(wait, 500);
  })();
})();
