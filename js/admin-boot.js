// admin-boot.js — the very first script on every admin page.
//
// Why this file exists
// --------------------
// The panel used to depend on a single blocking <script> from a public CDN
// (cdn.jsdelivr.net). When that request was slow, offline, blocked by an ad
// blocker / DNS filter / office firewall, or simply rate-limited, the global
// `supabase` object never appeared — `supabaseClient.js` then threw
// "supabase is not defined", every later script died with it, and the admin
// saw a permanently blank or half-dead page.
//
// Now the SDK is served from this same origin (js/vendor/supabase.min.js, so
// nothing can block it) and this file:
//   1. verifies the SDK actually loaded,
//   2. silently falls back to the CDN copy if the local file is missing,
//   3. gives every page one safe entry point: onAdminReady(fn), which runs
//      only once BOTH the DOM and the Supabase client are genuinely ready,
//   4. shows a readable banner instead of a blank screen if everything fails.
//
// Keep this file tiny and dependency-free: it must never be the thing that
// breaks.
(function () {
  "use strict";

  var FALLBACK_SRCS = [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js",
    "https://unpkg.com/@supabase/supabase-js@2.117.2/dist/umd/supabase.js",
  ];

  var readyCallbacks = [];
  var state = { dom: false, sdk: false, failed: false, flushed: false };

  function domReady() {
    return document.readyState === "interactive" || document.readyState === "complete";
  }

  function runCallback(fn) {
    try {
      var out = fn();
      if (out && typeof out.catch === "function") out.catch(function (err) { console.error("[admin] init:", err); });
    } catch (err) {
      console.error("[admin] init:", err);
    }
  }

  function flush() {
    if (state.flushed || !state.dom || (!state.sdk && !state.failed)) return;
    state.flushed = true;
    var queue = readyCallbacks.slice();
    readyCallbacks.length = 0;
    queue.forEach(runCallback);
  }

  // Public: run `fn` when the DOM + Supabase client are both usable.
  // Replaces the old `document.addEventListener("DOMContentLoaded", …)` in
  // page scripts, which could fire before (or without) a working client.
  window.onAdminReady = function (fn) {
    if (typeof fn !== "function") return;
    if (state.flushed) { runCallback(fn); return; }
    readyCallbacks.push(fn);
    flush();
  };

  function showBootError(message) {
    if (document.getElementById("admin-boot-error")) return;
    var box = document.createElement("div");
    box.id = "admin-boot-error";
    box.setAttribute("role", "alert");
    box.textContent = message;
    box.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:99999;padding:12px 16px;" +
      "font:600 13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;" +
      "color:#fff2f2;background:#7a2027;box-shadow:0 6px 20px rgba(0,0,0,.35)";
    (document.body || document.documentElement).appendChild(box);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = resolve;
      el.onerror = function () { reject(new Error("blocked: " + src)); };
      (document.head || document.documentElement).appendChild(el);
    });
  }

  async function ensureSdk() {
    if (window.supabase && typeof window.supabase.createClient === "function") return true;
    for (var i = 0; i < FALLBACK_SRCS.length; i++) {
      try {
        await loadScript(FALLBACK_SRCS[i]);
        if (window.supabase && typeof window.supabase.createClient === "function") {
          console.warn("[admin] local Supabase bundle missing — loaded fallback:", FALLBACK_SRCS[i]);
          return true;
        }
      } catch (err) {
        console.warn("[admin]", err.message);
      }
    }
    return false;
  }

  // The SDK tag sits directly above this one, so in the normal case this
  // resolves on the first check without touching the network at all.
  ensureSdk().then(function (ok) {
    state.sdk = !!ok;
    if (!ok) {
      state.failed = true;
      if (domReady()) {
        showBootError("Could not load the Supabase library. Check js/vendor/supabase.min.js is deployed, then reload.");
      } else {
        document.addEventListener("DOMContentLoaded", function () {
          showBootError("Could not load the Supabase library. Check js/vendor/supabase.min.js is deployed, then reload.");
        }, { once: true });
      }
    } else if (typeof window.initSupabaseClient === "function") {
      // supabaseClient.js already ran (deferred scripts execute in order, but
      // the fallback path finishes later) — build the client now.
      window.initSupabaseClient();
    }
    flush();
  });

  if (domReady()) {
    state.dom = true;
    flush();
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      state.dom = true;
      flush();
    }, { once: true });
  }

  // Surface real script errors in the UI instead of leaving a silent, broken
  // page (the "page just stops working" symptom).
  window.addEventListener("error", function (event) {
    if (event && event.target && event.target.tagName === "SCRIPT") {
      console.error("[admin] script failed to load:", event.target.src);
    }
  }, true);
})();
