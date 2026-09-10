// ai-growth.js — Growth & retention runners (Own-AI, no API keys).
// Loads AFTER ai-brain.js. Modules: premium expiry reminders, win-back for
// inactive users, stuck-user help, leaderboard climb alerts.

/* Recently-notified cooldown helper: returns Set of user ids (as strings)
// that already got a matching-titled notification within `days`. */
async function AI_recentNotified(ids, days, titleTest) {
  const skip = new Set();
  if (!ids.length) return skip;
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await sb.from("notifications")
      .select("user_id, title, created_at")
      .in("user_id", ids)
      .gte("created_at", since)
      .limit(2000);
    if (error) return skip;
    (data || []).forEach((n) => {
      try {
        if (titleTest(n.title)) skip.add(String(n.user_id));
      } catch (e) {}
    });
  } catch (e) {}
  return skip;
}

async function AI_notifyMany(items) {
  // items: [{user_id, type, title, message, link}] — chunked inserts.
  let sent = 0;
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200).map((n) => ({ ...n, is_read: false }));
    const { error } = await sb.from("notifications").insert(chunk);
    if (error) throw error;
    sent += chunk.length;
  }
  return sent;
}

// --- Premium expiring in ≤3 days, or expired ≤2 days ago ---
async function AI_runExpiryReminders(opts) {
  opts = opts || {};
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const plus3 = new Date(now + 3 * 86400000).toISOString().slice(0, 10);
  const minus2 = new Date(now - 2 * 86400000).toISOString();

  let expiring = [];
  let expired = [];
  try {
    const r1 = await sb.from("profiles")
      .select("id, premium_expires_at")
      .eq("is_premium", true)
      .gte("premium_expires_at", nowIso)
      .lte("premium_expires_at", plus3 + "T23:59:59")
      .limit(1000);
    if (r1.error) throw r1.error;
    expiring = r1.data || [];
    const r2 = await sb.from("profiles")
      .select("id, premium_expires_at")
      .eq("is_premium", true)
      .gte("premium_expires_at", minus2)
      .lt("premium_expires_at", nowIso)
      .limit(1000);
    if (r2.error) throw r2.error;
    expired = r2.data || [];
  } catch (e) {
    AI_log("expiry_error", "Could not read premium expiry: " + e.message, "error");
    return { expiring: 0, expired: 0, error: e.message };
  }

  const ids = [...expiring, ...expired].map((u) => u.id);
  const skip = await AI_recentNotified(ids, 7, (t) => /premium.*(expir|renew)/i.test(String(t || "")));

  const items = [];
  expiring.forEach((u) => {
    if (skip.has(String(u.id))) return;
    const days = Math.max(1, Math.ceil((new Date(u.premium_expires_at).getTime() - now) / 86400000));
    items.push({
      user_id: u.id,
      type: "announcement",
      title: `⏰ Premium expires in ${days} day${days === 1 ? "" : "s"}!`,
      message: `Hi! Your PyDebug Premium ends on ${new Date(u.premium_expires_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}. Renew now to keep unlimited hints, hard problems and your streak going!`,
      link: "/problems.html",
    });
  });
  expired.forEach((u) => {
    if (skip.has(String(u.id))) return;
    items.push({
      user_id: u.id,
      type: "announcement",
      title: "😢 Your Premium has expired",
      message: "Your PyDebug Premium just ended. Renew anytime to get back unlimited hints, hard problems and the full experience!",
      link: "/problems.html",
    });
  });

  let sent = 0;
  if (items.length) sent = await AI_notifyMany(items);
  AI_log("expiry_run", `Premium reminders: ${expiring.length} expiring, ${expired.length} expired, ${sent} notified.`, sent ? "success" : "info");
  return { expiring: expiring.length, expired: expired.length, notified: sent };
}

// --- Win back users inactive 7+ days (cooldown 14 days) ---
async function AI_runWinback(opts) {
  opts = opts || {};
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let cands = [];
  try {
    const { data, error } = await sb.from("profiles")
      .select("id, last_active_date")
      .lte("last_active_date", cutoff)
      .limit(500);
    if (error) throw error;
    cands = (data || []).filter((r) => r.last_active_date);
  } catch (e) {
    AI_log("winback_skip", "last_active_date unavailable: " + e.message, "warn");
    return { found: 0, notified: 0, skipped: true };
  }
  if (!cands.length) {
    if (!opts.auto) AI_log("winback_run", "No inactive users found.", "info");
    return { found: 0, notified: 0 };
  }
  // Best-effort personalization (xp + name may not exist on old DBs).
  let extra = {};
  try {
    const { data } = await sb.from("profiles").select("id, display_name, xp").in("id", cands.map((c) => c.id));
    (data || []).forEach((u) => { extra[u.id] = u; });
  } catch (e) {}
  const skip = await AI_recentNotified(cands.map((c) => c.id), 14, (t) => /miss you/i.test(String(t || "")));
  const items = cands
    .filter((c) => !skip.has(String(c.id)))
    .map((c) => {
      const e = extra[c.id] || {};
      const name = e.display_name ? ` ${e.display_name}` : "";
      const xpBit = e.xp ? ` You already have ${Number(e.xp).toLocaleString("en-IN")} XP — don't let it go to waste!` : "";
      return {
        user_id: c.id,
        type: "announcement",
        title: "🥺 We miss you on PyDebug!",
        message: `Hi${name}! It's been a while since your last debug session.${xpBit} Solve one quick problem today and restart your streak!`,
        link: "/problems.html",
      };
    });
  let sent = 0;
  if (items.length) sent = await AI_notifyMany(items);
  AI_log("winback_run", `Win-back: ${cands.length} inactive, ${sent} nudged.`, sent ? "success" : "info");
  return { found: cands.length, notified: sent };
}

// --- Help users stuck on one problem: 5+ recent fails, zero solves ---
async function AI_runStuckHelp(opts) {
  opts = opts || {};
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  let rows = [];
  try {
    const { data, error } = await sb.from("submissions").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(10000);
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    AI_log("stuck_error", "Could not read submissions: " + e.message, "error");
    return { stuck: 0, notified: 0, error: e.message };
  }
  if (!rows.length) {
    if (!opts.auto) AI_log("stuck_run", "No recent submissions to analyse.", "info");
    return { stuck: 0, notified: 0 };
  }
  const st = AI_detectStatusCol(rows[0]);
  const agg = {};
  rows.forEach((r) => {
    if (!r.user_id || !r.problem_id) return;
    const k = r.user_id + "§" + r.problem_id;
    agg[k] = agg[k] || { user_id: r.user_id, problem_id: r.problem_id, fails: 0, solves: 0 };
    if (AI_solvedOf(r, st)) agg[k].solves++;
    else agg[k].fails++;
  });
  const stuck = Object.values(agg).filter((g) => g.fails >= 5 && g.solves === 0);
  if (!stuck.length) {
    if (!opts.auto) AI_log("stuck_run", `Checked ${rows.length} submissions — nobody is stuck.`, "success");
    return { stuck: 0, notified: 0 };
  }
  const pIds = [...new Set(stuck.map((g) => g.problem_id))];
  let titleById = {};
  try {
    const { data } = await sb.from("problems").select("id, title").in("id", pIds);
    (data || []).forEach((p) => { titleById[p.id] = p.title; });
  } catch (e) {}
  const skip = await AI_recentNotified([...new Set(stuck.map((g) => g.user_id))], 7, (t) => /^💡 Stuck on/i.test(String(t || "")));
  const items = [];
  const seenPair = new Set();
  stuck.forEach((g) => {
    if (skip.has(String(g.user_id))) return;
    const pair = g.user_id + "§" + g.problem_id;
    if (seenPair.has(pair)) return;
    seenPair.add(pair);
    const title = titleById[g.problem_id] || "that problem";
    items.push({
      user_id: g.user_id,
      type: "announcement",
      title: `💡 Stuck on "${title}"?`,
      message: `We noticed ${g.fails} attempts — don't give up! Tip: unlock Hint 1, re-read the failing line, and try a tiny example by hand. You are closer than you think!`,
      link: "/problems.html",
    });
  });
  let sent = 0;
  if (items.length) sent = await AI_notifyMany(items);
  AI_log("stuck_run", `Stuck-user help: ${stuck.length} stuck, ${sent} encouraged.`, sent ? "success" : "info");
  return { stuck: stuck.length, notified: sent };
}

// --- Leaderboard climb alerts: top-10 entry or 3+ spot climb ---
const AI_LEAD_KEY = "pydebug_ai_leaderboard_v1";

async function AI_runLeaderboardAlerts(opts) {
  opts = opts || {};
  let board = [];
  try {
    const { data, error } = await sb.from("profiles").select("id, xp").order("xp", { ascending: false }).limit(25);
    if (error) throw error;
    board = (data || []).map((r, i) => ({ id: r.id, xp: Number(r.xp) || 0, rank: i + 1 }));
  } catch (e) {
    AI_log("leaderboard_skip", "XP leaderboard unavailable: " + e.message, "warn");
    return { alerts: 0, skipped: true };
  }
  // Previous snapshot (cloud first, local fallback).
  let prev = null;
  try {
    prev = (await AI_kvGet("leaderboard")) || JSON.parse(localStorage.getItem(AI_LEAD_KEY) || "null");
  } catch (e) {}
  const snap = { at: new Date().toISOString(), ranks: {} };
  board.forEach((r) => { snap.ranks[r.id] = r.rank; });
  try { localStorage.setItem(AI_LEAD_KEY, JSON.stringify(snap)); } catch (e) {}
  AI_kvSet("leaderboard", snap);

  if (!prev || !prev.ranks) {
    AI_log("leaderboard_run", `Snapshot saved (${board.length} ranked) — alerts start from the next run.`, "info");
    return { alerts: 0, baseline: true };
  }
  const items = [];
  board.filter((r) => r.rank <= 10).forEach((r) => {
    const before = prev.ranks[r.id];
    if (before === undefined) {
      items.push({
        user_id: r.id, type: "leaderboard_rank",
        title: `🏆 You entered the Top 10! (#${r.rank})`,
        message: `Amazing! You climbed into the Top 10 with ${r.xp.toLocaleString("en-IN")} XP. Keep solving to reach #1!`,
        link: "/problems.html",
      });
    } else if (before - r.rank >= 3) {
      items.push({
        user_id: r.id, type: "leaderboard_rank",
        title: `🚀 You climbed to #${r.rank}!`,
        message: `You jumped from #${before} to #${r.rank} with ${r.xp.toLocaleString("en-IN")} XP. The top is in sight — keep going!`,
        link: "/problems.html",
      });
    }
  });
  let sent = 0;
  if (items.length) sent = await AI_notifyMany(items);
  AI_log("leaderboard_run", `Leaderboard: ${items.length} climb alert(s) sent.`, sent ? "success" : "info");
  return { alerts: sent };
}
