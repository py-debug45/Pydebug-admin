// ai-watch.js — background guardian. Loaded on every admin page.
// While the master switch is ON and an admin is logged in, it quietly runs
// the enabled AI modules on a schedule. Cross-tab lock prevents double work.

(function () {
  "use strict";

  let running = false;

  function lockIsFresh() {
    try {
      const last = Number(localStorage.getItem(AI_LOCK_KEY) || 0);
      return Date.now() - last < 45000; // another tab ran <45s ago
    } catch (e) {
      return false;
    }
  }

  function takeLock() {
    try {
      localStorage.setItem(AI_LOCK_KEY, String(Date.now()));
    } catch (e) {}
  }

  async function quietAdminCheck() {
    try {
      if (typeof sb === "undefined") return false;
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return false;
      const { data: profile, error } = await sb
        .from("profiles")
        .select("is_admin")
        .eq("id", session.user.id)
        .single();
      return !error && !!profile && !!profile.is_admin;
    } catch (e) {
      return false;
    }
  }

  async function tick() {
    if (running) return;
    try {
      if (typeof AI_getSettings !== "function") return;
      const s = AI_getSettings();
      if (!s.master) {
        paintGuardPill(s);
        return;
      }
      if (lockIsFresh()) {
        paintGuardPill(s);
        return;
      }
      takeLock();
      if (!(await quietAdminCheck())) {
        paintGuardPill(s);
        return;
      }
      running = true;
      const last = AI_getLastRuns();
      const now = Date.now();

      // 1. Discussion moderation — every tick (cheap scan).
      if (s.moderation) {
        try {
          await AI_runModeration({ auto: true });
        } catch (e) {
          console.warn("AI moderation:", e.message);
        }
      }

      // 2. Duplicate cleanup — at most once per hour.
      if (s.dedup && now - (last.dedup || 0) > 60 * 60 * 1000) {
        try {
          await AI_runDedup({ auto: true });
          AI_setLastRun("dedup");
        } catch (e) {
          console.warn("AI dedup:", e.message);
        }
      }

      // 3. Auto problem generation — per configured interval.
      const hours = Math.min(72, Math.max(1, Number(s.auto_hours) || 12));
      if (s.auto_problems && now - (last.problems || 0) > hours * 60 * 60 * 1000) {
        try {
          await AI_generateProblems(s.per_run || 3, { auto: true });
          AI_setLastRun("problems");
        } catch (e) {
          console.warn("AI factory:", e.message);
        }
      }

      // 4. Welcome new users — at most once per hour.
      if (s.welcome && now - (last.welcome || 0) > 60 * 60 * 1000) {
        try {
          await AI_runWelcome({ auto: true });
          AI_setLastRun("welcome");
        } catch (e) {
          console.warn("AI welcome:", e.message);
        }
      }

      paintGuardPill(s);
    } catch (e) {
      console.warn("AI watch tick:", e.message);
    } finally {
      running = false;
    }
  }

  // Small status pill shown in page topbars (if the element exists).
  function paintGuardPill(s) {
    try {
      document.querySelectorAll("[data-ai-guard-pill]").forEach((el) => {
        const on = !!(s && s.master);
        el.className = "ai-guard-pill " + (on ? "ai-guard-pill--on" : "ai-guard-pill--off");
        el.innerHTML = on
          ? '<span class="ai-dot"></span>🤖 AI Guard ON'
          : '🤖 AI Guard OFF';
        el.title = on ? "Own-AI is watching this panel" : "Own-AI is off — enable it in AI Control";
        if (!el.dataset.aiLinked) {
          el.dataset.aiLinked = "1";
          el.style.cursor = "pointer";
          el.addEventListener("click", () => { window.location.href = "ai.html"; });
        }
      });
    } catch (e) {}
  }

  window.addEventListener("load", () => {
    setTimeout(tick, 5000);       // first pass shortly after page load
    setInterval(tick, 60000);     // then every minute
    try {
      if (typeof AI_getSettings === "function") paintGuardPill(AI_getSettings());
    } catch (e) {}
  });
})();
