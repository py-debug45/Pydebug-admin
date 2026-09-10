// ai-safety.js — Safety+ runners (Own-AI, no API keys).
// Loads AFTER ai-brain.js. Modules: Hindi/Hinglish abuse filter (merged into
// the main scanner), FAQ auto-helper replies, copy-paste cheating detector.

/* ---------------- Hindi / Hinglish abuse lists ----------------
   SUB = matched inside longer tokens (distinctive, len>=6 only).
   EXACT = whole-token only (avoids "blunder", "propaganda", "abc"...).
   DEVA = Devanagari substrings matched on raw text. */

const AI_HINDI_SUB = [
  "chutiya", "chootiya", "chootia", "madarchod", "madharchod", "maderchod",
  "bhenchod", "behanchod", "behenchod", "bhosdike", "bhosadike", "haraami",
  "kameena", "gaandu",
];

const AI_HINDI_EXACT = [
  "chut", "choot", "lund", "lauda", "lavda", "loda", "gandu", "gaand",
  "gand", "randi", "rundi", "sala", "saala", "harami", "kutta", "kamina",
  "bhadwa", "bhadva", "hijra", "hijda", "tatti", "bhosda", "bhosdi",
  "bsdk", "mc", "bc",
];

const AI_HINDI_DEVA = [
  "चूतिया", "चूत", "मादरचोद", "मदरचोद", "भोसड़ी", "भोसडी", "भोसड़ा",
  "बहनचोद", "भेनचोद", "भेंचोद", "लंड", "लौड़ा", "लौडा", "लौड़े",
  "गांडू", "गांड", "रंडी", "रण्डी", "साला", "हरामी", "कुत्ता",
  "कमीना", "कमीने", "भड़वा", "भडवा", "हिजड़ा", "टट्टी",
];

const AI_HINDI_PHRASES = [
  "teri maa", "teri ma", "teri behen", "teri bahan", "bhosdi ke",
  "maa chuda", "behen chuda",
];

function AI_scanHindi(text) {
  const raw = String(text || "");
  if (!raw.trim()) return { flagged: false, severity: null, hits: [] };
  const lower = raw.toLowerCase();

  // 1. Devanagari direct match.
  for (const w of AI_HINDI_DEVA) {
    if (raw.includes(w)) return { flagged: true, severity: "severe", hits: [w] };
  }

  // 2. Roman phrases.
  const spaced = " " + lower.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ") + " ";
  for (const p of AI_HINDI_PHRASES) {
    if (spaced.includes(" " + p + " ")) return { flagged: true, severity: "severe", hits: [p] };
  }

  // 3. Roman tokens (reuse the brain's leetspeak normalizer).
  const tokens = lower.split(/[^a-z0-9@$\!\*\#]+/).filter((t) => t.length >= 2);
  const hits = [];
  for (const tok of tokens) {
    const v1 = AI_normToken(tok);
    const variants = [...new Set([v1, AI_collapseRepeats(v1)])];
    for (const v of variants) {
      if (!v) continue;
      for (const w of AI_HINDI_EXACT) {
        if (v === w) hits.push(w);
      }
      for (const w of AI_HINDI_SUB) {
        if (v.length >= w.length && v.includes(w)) hits.push(w);
      }
    }
  }
  const uniq = [...new Set(hits)];
  if (uniq.length) return { flagged: true, severity: "severe", hits: uniq };
  return { flagged: false, severity: null, hits: [] };
}

// Merge Hindi into the main scanner (brain must load first).
// Toggle: settings.hindi === false disables Hindi (English always stays on).
if (typeof AI_scanText === "function") {
  const AI_scanTextBase = AI_scanText;
  AI_scanText = function (text) {
    const r = AI_scanTextBase(text);
    if (r.flagged) return r;
    try {
      if (AI_getSettings().hindi === false) return r;
    } catch (e) {}
    return AI_scanHindi(text);
  };
}

/* ---------------- FAQ auto-helper ---------------- */

const AI_FAQ_RULES = [
  {
    keys: ["hint", "stuck", "not working", "not work", "confused", "don't understand", "dont understand", "help", "samajh"],
    reply: "Stuck? Open the 💡 hints on this problem — they unlock one by one. Also try an easier problem on the same topic first, then come back!",
  },
  {
    keys: ["error", "traceback", "exception", "crash"],
    reply: "Read the LAST line of the error message first — it names the real problem (NameError, TypeError...). Then check that exact line in your code. You've got this! 💪",
  },
  {
    keys: ["premium", "payment", "pay", "subscription", "renew"],
    reply: "Premium questions? You can manage everything from your profile page. If a payment didn't reflect within a few minutes, contact support with your payment ID. ⭐",
  },
  {
    keys: ["xp", "leaderboard", "rank", "streak"],
    reply: "You earn XP for every solve (harder = more XP), and your streak grows when you solve daily. Climb the leaderboard one problem at a time! 🏆",
  },
  {
    keys: ["answer", "solution", "output", "what will"],
    reply: "We won't spoil the answer — but here's a method: trace the code line by line on paper, then test your guess. That's how debugging skills grow! 🐍",
  },
];

const AI_FAQ_DEFAULT = "Good question! While you wait for the community: re-read the problem, check the 💡 hints, and try a tiny example by hand. 🙌";

function AI_faqReplyFor(content) {
  const lower = String(content || "").toLowerCase();
  for (const rule of AI_FAQ_RULES) {
    if (rule.keys.some((k) => lower.includes(k))) return rule.reply;
  }
  return AI_FAQ_DEFAULT;
}

// Reply to old (>24h) unanswered top-level questions. Posts as the admin.
async function AI_runFaqReplies(limit, opts) {
  limit = Math.max(1, Math.min(25, Number(limit) || 10));
  opts = opts || {};
  let adminId = null;
  try {
    const { data: { session } } = await sb.auth.getSession();
    adminId = session && session.user && session.user.id;
  } catch (e) {}
  if (!adminId) throw new Error("Not signed in.");

  const { data, error } = await sb.from("problem_discussions")
    .select("id, problem_id, user_id, content, parent_comment_id, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const rows = data || [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const looksQuestion = (c) => {
    const t = String(c.content || "");
    if (!t.trim()) return false;
    if (t.includes("?")) return true;
    const lower = t.toLowerCase();
    return AI_FAQ_RULES.some((r) => r.keys.some((k) => lower.includes(k)));
  };
  const cands = rows
    .filter((c) => !c.parent_comment_id && looksQuestion(c) && new Date(c.created_at).getTime() < cutoff)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let replied = 0, skippedAnswered = 0;
  for (const c of cands) {
    if (replied >= limit) break;
    // Skip when a reply already exists (human or bot).
    let hasReply = false;
    try {
      const { data: kids } = await sb.from("problem_discussions").select("id").eq("parent_comment_id", c.id).limit(1);
      hasReply = !!(kids && kids.length);
    } catch (e) {}
    if (hasReply) { skippedAnswered++; continue; }
    const body = "🤖 Auto-helper: " + AI_faqReplyFor(c.content) + "\n\n— PyDebug Helper (auto-reply, a human may follow up)";
    const { error: insErr } = await sb.from("problem_discussions").insert({
      problem_id: c.problem_id, user_id: adminId, content: body,
      parent_comment_id: c.id, is_solution: false, like_count: 0,
    });
    if (insErr) {
      AI_log("faq_error", `Reply failed on ${c.id}: ${insErr.message}`, "error");
      continue;
    }
    replied++;
    AI_log("faq_replied", `Auto-answered a waiting question (${String(c.content || "").slice(0, 60)}...).`, "success");
  }
  if (!replied && !opts.auto) {
    AI_log("faq_run", `Checked ${cands.length} waiting question(s) — nothing to answer.`, "info");
  } else if (replied) {
    AI_log("faq_run", `FAQ helper replied to ${replied} question(s), skipped ${skippedAnswered} already-answered.`, "success");
  }
  return { waiting: cands.length, replied, skippedAnswered };
}

/* ---------------- Copy-paste cheating detector ----------------
   Same normalized code, same problem, 3+ distinct users (30 days).
   Report-only — never auto-punishes. */

function AI_normSubmitCode(s) {
  return String(s || "")
    .split("\n")
    .map((line) => line.split("#")[0])
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function AI_cheatReport() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data, error } = await sb.from("submissions")
    .select("id, user_id, problem_id, code, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) throw error;
  const rows = data || [];
  const groups = {};
  rows.forEach((r) => {
    if (!r.user_id || !r.problem_id || !r.code) return;
    const n = AI_normSubmitCode(r.code);
    if (n.length < 60) return; // ignore trivial snippets
    const k = r.problem_id + "§" + AI_hash(n);
    (groups[k] = groups[k] || { problem_id: r.problem_id, users: new Set(), count: 0, sample: String(r.code).slice(0, 200) }).users.add(String(r.user_id));
    groups[k].count++;
  });
  const hits = Object.values(groups)
    .filter((g) => g.users.size >= 3)
    .map((g) => ({ problem_id: g.problem_id, users: [...g.users], submissions: g.count, sample: g.sample }))
    .sort((a, b) => b.users.length - a.users.length);
  if (!hits.length) {
    AI_log("cheat_run", `Checked ${rows.length} submissions — no copy-paste rings found.`, "success");
    return { checked: rows.length, hits: [] };
  }
  // Resolve names for the report.
  const uIds = [...new Set(hits.flatMap((h) => h.users))];
  const pIds = [...new Set(hits.map((h) => h.problem_id))];
  let nameById = {}, titleById = {};
  try {
    const { data: users } = await sb.from("profiles").select("id, email, display_name").in("id", uIds);
    (users || []).forEach((u) => { nameById[u.id] = u.display_name || u.email || u.id; });
  } catch (e) {}
  try {
    const { data: probs } = await sb.from("problems").select("id, title").in("id", pIds);
    (probs || []).forEach((p) => { titleById[p.id] = p.title; });
  } catch (e) {}
  hits.forEach((h) => {
    h.userNames = h.users.map((u) => nameById[u] || u);
    h.problemTitle = titleById[h.problem_id] || h.problem_id;
  });
  AI_log("cheat_run", `Checked ${rows.length} submissions — ${hits.length} shared-code group(s) need review.`, "warn");
  return { checked: rows.length, hits };
}
