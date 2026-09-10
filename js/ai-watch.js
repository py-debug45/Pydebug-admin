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

      // 6. Growth + safety daily runners (each at most once per 24h).
      try {
        const DAY = 24 * 60 * 60 * 1000;
        const daily = [
          ["expiry", s.expiry, "AI_runExpiryReminders"],
          ["winback", s.winback, "AI_runWinback"],
          ["stuck", s.stuck, "AI_runStuckHelp"],
          ["lead", s.leaderboard, "AI_runLeaderboardAlerts"],
          ["faq", s.faq, "AI_runFaqReplies"],
        ];
        for (const [key, enabled, fnName] of daily) {
          const fn = typeof window !== "undefined" ? window[fnName] : null;
          if (enabled && typeof fn === "function" && now - (last[key] || 0) > DAY) {
            try {
              if (key === "faq") await fn(10, { auto: true });
              else await fn({ auto: true });
              AI_setLastRun(key);
            } catch (e) {
              console.warn("AI " + key + ":", e.message);
            }
          }
        }
      } catch (e) {
        console.warn("AI daily runners:", e.message);
      }

      // 5. Daily digest — auto-build once every ~20h while Guard is ON.
      if (now - (last.digest || 0) > 20 * 60 * 60 * 1000) {
        try {
          await AI_buildDigest();
          AI_setLastRun("digest");
        } catch (e) {
          console.warn("AI digest:", e.message);
        }
      }

      paintGuardPill(s);
      try { AI_refreshBell(); } catch (e) {}
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

  /* ---- Admin bell: floating AI inbox on every page ---- */
  const AI_BELL_SEEN_KEY = "pydebug_ai_bell_seen_v1";

  function AI_bellItems() {
    try {
      if (typeof AI_getLogs !== "function") return [];
      return AI_getLogs().filter((l) => ["warn", "error", "success"].includes(l.level)).slice(0, 15);
    } catch (e) {
      return [];
    }
  }

  function AI_bellSeen() {
    try {
      return Number(localStorage.getItem(AI_BELL_SEEN_KEY) || 0);
    } catch (e) {
      return 0;
    }
  }

  function AI_refreshBell() {
    const badge = document.getElementById("ai-bell-badge");
    if (!badge) return;
    const seen = AI_bellSeen();
    const unread = AI_bellItems().filter((l) => new Date(l.t).getTime() > seen && l.level !== "success").length;
    badge.textContent = unread > 9 ? "9+" : String(unread);
    badge.style.display = unread ? "" : "none";
  }

  function AI_bellEsc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function AI_renderBellList() {
    const list = document.getElementById("ai-bell-list");
    if (!list) return;
    const items = AI_bellItems();
    if (!items.length) {
      list.innerHTML = '<div class="ai-bell__empty">All quiet. Turn the AI ON to get findings here.</div>';
      return;
    }
    const dot = (l) => (l === "error" ? "🔴" : l === "warn" ? "🟡" : "🟢");
    list.innerHTML = items.map((l) =>
      `<div class="ai-bell__item"><span>${dot(l.level)}</span><span><strong>${AI_bellEsc(l.action)}</strong> — ${AI_bellEsc(l.detail)}</span></div>`
    ).join("");
  }

  async function AI_mountBell() {
    if (document.getElementById("ai-bell") || typeof AI_getLogs !== "function") return;
    // Admins only — result cached 5 min per tab to avoid extra queries.
    try {
      const cached = Number(sessionStorage.getItem("pydebug_ai_isadmin") || 0);
      if (Date.now() - cached > 5 * 60 * 1000) {
        if (!(await quietAdminCheck())) return;
        sessionStorage.setItem("pydebug_ai_isadmin", String(Date.now()));
      }
    } catch (e) {
      return;
    }
    const wrap = document.createElement("div");
    wrap.id = "ai-bell";
    wrap.className = "ai-bell";
    wrap.innerHTML =
      '<button class="ai-bell__btn" id="ai-bell-btn" title="AI notifications">🔔<span class="ai-bell__badge" id="ai-bell-badge" style="display:none">0</span></button>' +
      '<div class="ai-bell__panel" id="ai-bell-panel" style="display:none">' +
      '<div class="ai-bell__head"><strong>\uD83E\uDD16 AI inbox</strong><button id="ai-bell-read">Mark read</button></div>' +
      '<div class="ai-bell__list" id="ai-bell-list"></div>' +
      '<a class="ai-bell__foot" href="ai.html">Open AI Control \u2192</a></div>';
    document.body.appendChild(wrap);
    const panel = document.getElementById("ai-bell-panel");
    document.getElementById("ai-bell-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = panel.style.display !== "none";
      panel.style.display = open ? "none" : "";
      if (!open) AI_renderBellList();
    });
    document.addEventListener("click", (ev) => {
      if (!wrap.contains(ev.target)) panel.style.display = "none";
    });
    document.getElementById("ai-bell-read").addEventListener("click", () => {
      try {
        localStorage.setItem(AI_BELL_SEEN_KEY, String(Date.now()));
      } catch (e) {}
      AI_refreshBell();
    });
    AI_refreshBell();
  }

  window.addEventListener("load", () => {
    setTimeout(tick, 5000);       // first pass shortly after page load
    setInterval(tick, 60000);
    AI_mountBell();     // then every minute
    try {
      if (typeof AI_getSettings === "function") paintGuardPill(AI_getSettings());
    } catch (e) {}
  });
})();
