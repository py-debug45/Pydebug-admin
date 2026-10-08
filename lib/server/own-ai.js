"use strict";

/*
 * PyDebug OWN-AI — server-side port of the legacy admin panel's "AI Control
 * Center" engine (retired js/ai-brain.js + ai-content.js + ai-growth.js +
 * ai-safety.js + the watcher tick). 100% local rule engine + verified
 * problem-template engine: no AI provider, no API key, no outbound call.
 *
 * Port notes (browser bundle -> server module):
 *   - The Supabase browser client (sb) is replaced by lib/server/own-ai-db.js,
 *     a shim over the panel's service-role PostgREST client (api/_db.js).
 *   - localStorage state (settings / activity log / last runs / digest /
 *     leaderboard snapshot) moved into the ai_settings + ai_logs tables, so
 *     every admin device agrees and the log survives the browser.
 *   - The engine is stateful per process: call loadState() at the start of
 *     every API action so settings/last-runs are fresh.
 *
 * Modules:
 *   1. Discussion moderation  — scans comments (English + Hindi/Hinglish),
 *      deletes abusive ones, warns the offender.
 *   2. Auto problem factory   — generates Fix-the-Bug + Predict-Output
 *      problems with ALL fields filled + exactly 3 hints. EVERY Bug snippet
 *      RAISES a real Python error when run, proven by the static detector
 *      before insert; expected outputs are COMPUTED (never guessed).
 *   2b. Bug error guard       — deletes Fix-the-Bug problems whose code runs
 *      WITHOUT raising any Python error.
 *   3. Duplicate guard        — never inserts a duplicate; auto-deletes
 *      existing duplicates (plus their submissions/discussions).
 *   4. Auto notifications     — offender warnings, new-problem alerts,
 *      welcome msgs, expiry/win-back/stuck/leaderboard nudges, FAQ replies.
 *   5. Reports                — daily digest, panel health, difficulty
 *      calibration from real solve rates.
 *   6. Content AI             — gap filler, variations, quality report,
 *      auto hint repair, bulk import (JSON/CSV).
 *   7. Safety+                — Hindi filter, FAQ auto-helper, copy-paste
 *      cheating detector.
 *   8. Local diagnostic lab   — static Python code checks (never executes
 *      untrusted code).
 */

const sb = require("./own-ai-db");
const { can } = require("./permissions");

// Pick the first key from `candidates` that exists on the sample row.
// Lets the engine survive small schema differences in the user panel.
function detectCol(sample, candidates) {
  if (!sample) return candidates[0];
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(sample, c)) return c;
  }
  return candidates[0];
}

/* ============================================================
   1. SETTINGS — ai_settings table (key "control"), cached in memory
   ============================================================ */

const AI_DEFAULTS = {
  master: false,        // master ON/OFF switch
  moderation: true,     // scan discussions + delete abusive comments
  warn_user: true,      // send warning notification to the offender
  auto_problems: false, // auto-generate problems on a schedule
  per_run: 3,           // how many problems to generate per run
  auto_hours: 12,       // auto-generate interval (hours)
  mix: "both",          // bug | question | both
  difficulty: "mixed",  // mixed | easy | medium | hard
  dedup: true,          // auto-delete duplicate problems
  announce: false,      // broadcast a notification when AI adds problems
  welcome: false,       // welcome notification for brand-new users
  expiry: true,         // premium expiry / expired reminders
  winback: false,       // win-back ping for inactive users
  stuck: true,          // encouragement for stuck users
  leaderboard: false,   // leaderboard climb alerts
  faq: false,           // FAQ auto-helper replies
  hindi: true,          // Hindi/Hinglish abuse filter (English always on)
  premium_mix: false,   // mark a share of factory problems as Premium
  premium_percent: 25,  // % of factory problems marked Premium (~2-3 of 10)
  error_guard: false,   // auto-delete Fix-the-Bug code that runs without error
};

let AI_SETTINGS_CACHE = { ...AI_DEFAULTS };
let AI_LASTRUN_CACHE = {};

// Pull settings + last-run timestamps into the cache. Call at the start of
// every API action.
async function AI_loadState() {
  const stored = await AI_kvGet("control");
  AI_SETTINGS_CACHE = stored && typeof stored === "object" ? { ...AI_DEFAULTS, ...stored } : { ...AI_DEFAULTS };
  const runs = await AI_kvGet("lastruns");
  AI_LASTRUN_CACHE = runs && typeof runs === "object" ? { ...runs } : {};
  return { settings: AI_getSettings(), lastRuns: AI_getLastRuns() };
}

function AI_getSettings() {
  return { ...AI_DEFAULTS, ...AI_SETTINGS_CACHE };
}

const AI_SETTING_TYPES = {
  master: "boolean", moderation: "boolean", warn_user: "boolean",
  auto_problems: "boolean", dedup: "boolean", announce: "boolean",
  welcome: "boolean", expiry: "boolean", winback: "boolean", stuck: "boolean",
  leaderboard: "boolean", faq: "boolean", hindi: "boolean",
  premium_mix: "boolean", error_guard: "boolean",
  per_run: "number", auto_hours: "number", premium_percent: "number",
  mix: "string", difficulty: "string",
};

// Whitelist + type/range validation for settings patches from the panel.
function AI_validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    const error = new Error("settings patch must be an object");
    error.status = 400; error.code = "validation_error";
    throw error;
  }
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    const type = AI_SETTING_TYPES[key];
    if (!type) continue; // unknown keys are ignored, never stored
    if (type === "boolean") clean[key] = value === true;
    else if (type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      if (key === "per_run") clean[key] = Math.max(1, Math.min(20, Math.round(n)));
      else if (key === "auto_hours") clean[key] = Math.max(1, Math.min(72, Math.round(n)));
      else if (key === "premium_percent") clean[key] = Math.max(0, Math.min(90, Math.round(n)));
      else clean[key] = Math.round(n);
    } else if (key === "mix") clean[key] = ["bug", "question", "both"].includes(value) ? value : "both";
    else if (key === "difficulty") clean[key] = ["mixed", "easy", "medium", "hard"].includes(value) ? value : "mixed";
  }
  return clean;
}

async function AI_saveSettings(patch) {
  const clean = AI_validateSettingsPatch(patch);
  const next = { ...AI_getSettings(), ...clean };
  await AI_kvSet("control", next);
  AI_SETTINGS_CACHE = next;
  return { settings: AI_getSettings(), changed: Object.keys(clean) };
}

function AI_getLastRuns() {
  return { ...AI_LASTRUN_CACHE };
}

async function AI_setLastRun(name) {
  AI_LASTRUN_CACHE = { ...AI_LASTRUN_CACHE, [String(name || "run")]: Date.now() };
  await AI_kvSet("lastruns", AI_LASTRUN_CACHE);
}

/* ============================================================
   2. ACTIVITY LOG — ai_logs table (source of truth)
   ============================================================ */

async function AI_log(action, detail, level) {
  const entry = {
    t: new Date().toISOString(),
    level: level || "info",
    action: String(action || ""),
    detail: String(detail || ""),
  };
  try {
    await sb.from("ai_logs").insert({ level: entry.level, action: entry.action, detail: entry.detail });
  } catch (e) {
    console.warn("[own-ai] activity log insert failed:", e.message);
  }
  return entry;
}

async function AI_getLogs(limit = 200) {
  const { data, error } = await sb
    .from("ai_logs")
    .select("id, level, action, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(500, Math.max(1, Number(limit) || 200)));
  if (error) return [];
  return (data || []).map((row) => ({
    id: row.id, t: row.created_at, level: row.level, action: row.action, detail: row.detail,
  }));
}

async function AI_clearLogs() {
  const { error } = await sb.from("ai_logs").delete();
  if (error) {
    const err = new Error("Could not clear the AI activity log: " + error.message);
    err.status = 502; err.code = "db_error";
    throw err;
  }
  return { cleared: true };
}

/* ============================================================
   2b. GENERIC KEY-VALUE — ai_settings table (best-effort)
   ============================================================ */

async function AI_kvGet(key) {
  const { data, error } = await sb.from("ai_settings").select("value").eq("key", String(key)).single();
  if (error || !data) return null;
  return data.value;
}

async function AI_kvSet(key, value) {
  const cleanKey = String(key || "").trim().slice(0, 100);
  if (!cleanKey) return false;
  // update-then-insert: works on real PostgREST and on the dev mock (which
  // has no upsert/merge semantics).
  const { data: updated, error: updateError } = await sb
    .from("ai_settings")
    .update({ value, updated_at: new Date().toISOString() })
    .eq("key", cleanKey);
  if (updateError) return false;
  if (Array.isArray(updated) && updated.length) return true;
  const { error: insertError } = await sb
    .from("ai_settings")
    .insert({ key: cleanKey, value, updated_at: new Date().toISOString() });
  return !insertError;
}

/* ============================================================

/* ============================================================
   3. DISCUSSION MODERATION (English)
   Detects abusive words incl. leetspeak (sh1t, f*ck, b!tch),
   repeated letters (fuuuck), spaced-out evasion (f u c k),
   plus spam / promo patterns.
   ============================================================ */

// Severe words: matched even INSIDE longer tokens (catches "fucking", "sh1thead"...).
const AI_SEVERE_SUB = [
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "cock", "pussy",
  "cunt", "whore", "slut", "blowjob", "handjob", "orgasm", "porn", "hentai",
  "boob", "horny", "boner", "viagra", "scumbag", "douche", "prick", "wanker",
  "tosser", "shithead", "dickhead", "asshat", "jackass", "dumbass", "nigga",
  "nigger", "faggot", "retard", "chink", "wetback", "towelhead", "tranny",
  "shemale", "dyke", "pedo", "jizz", "twat", "skank", "hoe", "milf",
  "masturbat", "strapon", "gangbang", "creampie", "deepthroat", "cumshot",
  "buttplug", "dildo", "vibrator", "playboy", "brazzers", "xvideos", "xnxx",
  "redtube", "pornhub", "onlyfans", "camgirl", "escort", "prostitut", "brothel",
];

// Short / ambiguous words: matched ONLY as whole tokens (so "class",
// "scrape", "canal", "password", "raccoon" never false-positive).
const AI_SEVERE_EXACT = ["ass", "tit", "cum", "fag", "coon", "anal", "gook", "kike", "spic", "poop", "pee", "piss", "crap"];

// Mild insults / rude words: still removed (keeps panel clean) but the
// warning message sent to the user is softer.
const AI_MILD = [
  "damn", "hell", "stupid", "idiot", "dumb", "moron", "loser", "suck", "sucks",
  "sucker", "hate", "ugly", "shutup", "fool", "nonsense", "rascal", "bloody",
];

// Whole-phrase checks on the normalised text (word boundaries).
const AI_SEVERE_PHRASES = ["kill yourself", "kys", "stfu", "gtfo"];

const AI_SPAM_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /telegram|whatsapp|discord\.gg|t\.me\//i,
  /earn (money|cash)|free (followers|money|recharge|gift|paytm)|double your|betting|casino|lottery|loan offer/i,
  /dm me|inbox me|contact me|message me.*(earn|money|offer|deal)/i,
  /(.)\1{6,}/, // aaaaaaaa
];

const AI_LEET = {
  "@": "a", "4": "a", "0": "o", "1": "i", "!": "i", "3": "e",
  $: "s", "5": "s", "7": "t", "+": "t", "9": "g", "6": "g", "8": "b", "*": "", "#": "",
};

function AI_normToken(token) {
  let t = String(token || "").toLowerCase();
  t = t.split("").map((ch) => (AI_LEET[ch] !== undefined ? AI_LEET[ch] : ch)).join("");
  t = t.replace(/[^a-z]/g, "");
  return t;
}

function AI_collapseRepeats(t) {
  return String(t || "").replace(/(.)\1+/g, "$1");
}

function AI_tokenHits(token) {
  const hits = [];
  const v1 = AI_normToken(token);
  const variants = v1.length >= 2 ? [v1, AI_collapseRepeats(v1)] : [];
  for (const v of variants) {
    if (!v) continue;
    for (const w of AI_SEVERE_EXACT) {
      if (v === w) hits.push(w);
    }
    for (const w of AI_SEVERE_SUB) {
      if (v.length >= w.length && v.includes(w)) hits.push(w);
    }
    for (const w of AI_MILD) {
      if (v === w || (v.length > w.length + 1 && v.includes(w) && (v.endsWith("s") || v.endsWith("ed") || v.endsWith("ing")))) hits.push(w);
    }
  }
  return [...new Set(hits)];
}

// Main entry: scan one comment. Returns { flagged, severity, hits[] }.
function AI_scanText(text) {
  const raw = String(text || "");
  if (!raw.trim()) return { flagged: false, severity: null, hits: [] };
  const lower = raw.toLowerCase();

  // 1. Spam / promo / links
  for (const re of AI_SPAM_PATTERNS) {
    if (re.test(raw)) return { flagged: true, severity: "spam", hits: ["spam-pattern"] };
  }

  // 2. Severe phrases
  const spaced = " " + lower.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ") + " ";
  for (const p of AI_SEVERE_PHRASES) {
    if (spaced.includes(" " + p + " ") || spaced.includes(" " + p.replace(/\s+/g, "") + " ")) {
      return { flagged: true, severity: "severe", hits: [p] };
    }
  }

  // 3. Token scan (handles leetspeak + repeated letters)
  const tokens = lower.split(/[^a-z0-9@$\!\*\#]+/).filter((t) => t.length >= 2);
  let severeHits = [];
  let mildHits = [];
  for (const tok of tokens) {
    for (const h of AI_tokenHits(tok)) {
      if (AI_SEVERE_SUB.includes(h) || AI_SEVERE_EXACT.includes(h)) severeHits.push(h);
      else mildHits.push(h);
    }
  }

  // 4a. Spaced-out evasion: "f u c k" (single letters split by spaces).
  // Strict pattern — normal words like "fuck you" do NOT match, so no dup hits.
  const spacedGroups = lower.match(/\b[a-z](?:\s+[a-z]){2,}\b/g) || [];
  for (const g of spacedGroups) {
    const joined = g.replace(/\s+/g, "");
    if (joined.length < 3 || joined.length > 14) continue;
    for (const h of AI_tokenHits(joined)) {
      if (AI_SEVERE_SUB.includes(h) || AI_SEVERE_EXACT.includes(h)) severeHits.push(h + " (spaced)");
      else mildHits.push(h + " (spaced)");
    }
  }

  // 4b. Punctuated evasion inside one word: "s.h.i.t", "c-o-c-k", "b_i_t_c_h".
  const words = lower.split(/\s+/);
  for (const w of words) {
    if (!/[^a-z0-9\s]/.test(w)) continue; // no punctuation — already checked
    const squashed = AI_normToken(w);
    if (squashed.length < 3 || squashed.length > 14) continue;
    for (const h of AI_tokenHits(squashed)) {
      if (AI_SEVERE_SUB.includes(h) || AI_SEVERE_EXACT.includes(h)) severeHits.push(h);
      else mildHits.push(h);
    }
  }

  severeHits = [...new Set(severeHits)];
  mildHits = [...new Set(mildHits)];
  if (severeHits.length) return { flagged: true, severity: "severe", hits: severeHits };
  if (mildHits.length) return { flagged: true, severity: "mild", hits: mildHits };
  return { flagged: false, severity: null, hits: [] };
}



/* ============================================================
   4. PROBLEM FACTORY — verified templates, ZERO guessing.
   Every template COMPUTES its expected output from the same values
   placed into the code, so the output is always exact.
   Bug templates ship BOTH buggy + fixed code plus a `marker` (the exact
   wrong snippet) which the validator checks — guaranteeing the bug exists.
   ============================================================ */

function AI_ri(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function AI_pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function AI_shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
function AI_pyList(arr) {
  return "[" + arr.map((v) => (typeof v === "string" ? "'" + v + "'" : String(v))).join(", ") + "]";
}
function AI_names() {
  return AI_pick(["Ram", "Sita", "Arjun", "Priya", "Rahul", "Neha", "Amit", "Kiran", "Vikram", "Divya"]);
}

const AI_TOPICS = ["loops", "strings", "lists", "dictionaries", "functions", "oop", "recursion", "exceptions", "sets", "sorting", "generators", "tuples"];

// Registry: { id, topic, type: 'bug'|'question', difficulty, make() }
// make() returns { title, description, starter_code, fixed_code?, expected_output, hints[3], bug?, marker?, proof }
const AI_TEMPLATES = [
  /* ---------------- FIX-THE-BUG templates ---------------- */
  /* Every template below produces code that RAISES a real Python error
     when run (never a silent wrong answer). The static detector
     AI_detectPythonError() proves the error before insert, and proves
     the fixed reference code runs clean. */

  { id: "bug-loops-rangestr", topic: "loops", type: "bug", difficulty: "easy",
    make() {
      const n = AI_ri(4, 9);
      const lines = []; for (let i = 0; i < n; i++) lines.push(String(i));
      return {
        title: `TypeError: range('${n}') gets text`,
        description: `This program crashes with TypeError because range() receives text instead of a number. Fix it so it prints 0 to ${n - 1}, one per line.`,
        starter_code: `n = '${n}'\nfor i in range(n):\n    print(i)`,
        fixed_code: `n = ${n}\nfor i in range(n):\n    print(i)`,
        expected_output: lines.join("\n"),
        hints: [
          "range() needs an INTEGER — check what type n actually holds.",
          `n = '${n}' stores text (a string), not the number ${n}.`,
          `Remove the quotes: change the first line to n = ${n}.`,
        ],
        bug: "TypeError (range gets str)", marker: `n = '${n}'`,
        proof: `fixed loop prints 0..${n - 1}`,
      };
    } },

  { id: "bug-loops-shortindex", topic: "loops", type: "bug", difficulty: "easy",
    make() {
      const a = AI_ri(1, 9), b = AI_ri(10, 19);
      const N = AI_pick([3, 4, 5]);
      return {
        title: "IndexError: loop runs past a short list",
        description: `This program should print ${a} and ${b}, but the loop reaches index ${N - 1} which does not exist. Fix the range so it prints both numbers, one per line.`,
        starter_code: `nums = [${a}, ${b}]\nfor i in range(${N}):\n    print(nums[i])`,
        fixed_code: `nums = [${a}, ${b}]\nfor i in range(len(nums)):\n    print(nums[i])`,
        expected_output: `${a}\n${b}`,
        hints: [
          "The list has only 2 items (indexes 0 and 1) but the loop goes further.",
          `range(${N}) produces 0..${N - 1} — index ${N - 1} crashes with IndexError.`,
          "Loop over range(len(nums)) so it always matches the list size.",
        ],
        bug: "IndexError (loop past end)", marker: `range(${N})`,
        proof: "fixed loop prints the 2 stored values",
      };
    } },

  { id: "bug-loops-forint", topic: "loops", type: "bug", difficulty: "easy",
    make() {
      const n = AI_ri(3, 6);
      const lines = []; for (let i = 0; i < n; i++) lines.push(String(i));
      return {
        title: "TypeError: looping directly over a number",
        description: `This program crashes with TypeError because you cannot loop over a plain number. Fix it so it prints 0 to ${n - 1}, one per line.`,
        starter_code: `for i in ${n}:\n    print(i)`,
        fixed_code: `for i in range(${n}):\n    print(i)`,
        expected_output: lines.join("\n"),
        hints: [
          "A 'for' loop needs something iterable — a bare number is not iterable.",
          `Wrap the number with range() to get the sequence 0..${n - 1}.`,
          `Change the first line to: for i in range(${n}):`,
        ],
        bug: "TypeError (int not iterable)", marker: `for i in ${n}:`,
        proof: `fixed loop prints 0..${n - 1}`,
      };
    } },

  { id: "bug-loops-modzero", topic: "loops", type: "bug", difficulty: "medium",
    make() {
      return {
        title: "ZeroDivisionError: modulo by zero in a loop",
        description: "This program crashes with ZeroDivisionError because n is 0. Change n to 3 so it prints 1 three times (one per line).",
        starter_code: "n = 0\nfor i in range(1, 4):\n    print(10 % n)",
        fixed_code: "n = 3\nfor i in range(1, 4):\n    print(10 % n)",
        expected_output: "1\n1\n1",
        hints: [
          "The % (modulo) operator also refuses a zero divisor — just like /.",
          "n is 0, so 10 % n crashes on the very first loop pass.",
          "Change the first line to n = 3 (10 % 3 is 1).",
        ],
        bug: "ZeroDivisionError (modulo zero)", marker: "n = 0",
        proof: "10 % 3 = 1, printed 3 times",
      };
    } },

  { id: "bug-strings-nosuchmethod", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const word = AI_pick(["python", "debug", "coding", "planet", "rocket", "tiger", "laptop", "jungle", "river", "mountain", "window", "garden"]);
      return {
        title: "AttributeError: strings have no uppercase()",
        description: `This program crashes with AttributeError because the method name is wrong. Fix it so it prints ${word.toUpperCase()}.`,
        starter_code: `msg = '${word}'\nprint(msg.uppercase())`,
        fixed_code: `msg = '${word}'\nprint(msg.upper())`,
        expected_output: word.toUpperCase(),
        hints: [
          "AttributeError means the object has no method with that name.",
          "Python strings have upper() — 'uppercase' does not exist.",
          "Change msg.uppercase() to msg.upper().",
        ],
        bug: "AttributeError (wrong method)", marker: "msg.uppercase()",
        proof: `upper() of '${word}' = '${word.toUpperCase()}'`,
      };
    } },

  { id: "bug-strings-intconvert", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const pair = AI_pick([["seventeen", 17], ["twenty", 20], ["thirty", 30], ["twelve", 12], ["fifty", 50], ["ninety", 90]]);
      const w = pair[0], v = pair[1];
      return {
        title: `ValueError: int('${w}')`,
        description: `This program crashes with ValueError because '${w}' is not numeric text. Fix the text so the program prints ${v + 1}.`,
        starter_code: `age_text = '${w}'\nage = int(age_text)\nprint(age + 1)`,
        fixed_code: `age_text = '${v}'\nage = int(age_text)\nprint(age + 1)`,
        expected_output: String(v + 1),
        hints: [
          "int() can only convert text that looks like a number ('17' works, 'seventeen' crashes).",
          `'${w}' contains letters, so int() raises ValueError.`,
          `Change the first line to: age_text = '${v}'`,
        ],
        bug: "ValueError (int of letters)", marker: `age_text = '${w}'`,
        proof: `int('${v}') + 1 = ${v + 1}`,
      };
    } },

  { id: "bug-strings-noquotes", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const name = AI_names();
      return {
        title: `NameError: missing quotes around '${name}'`,
        description: `This program crashes with NameError because the name has no quotes, so Python thinks it is a variable. Fix it so it prints ${name}.`,
        starter_code: `name = ${name}\nprint(name)`,
        fixed_code: `name = '${name}'\nprint(name)`,
        expected_output: name,
        hints: [
          "Text in Python must be wrapped in quotes — otherwise it is treated as a variable name.",
          `There is no variable called ${name}, so Python raises NameError.`,
          `Add quotes: name = '${name}'`,
        ],
        bug: "NameError (missing quotes)", marker: `name = ${name}`,
        proof: `fixed program prints '${name}'`,
      };
    } },

  { id: "bug-strings-printstmt", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const word = AI_pick(["hello", "welcome", "namaste", "python", "debug", "hi there", "good day"]);
      return {
        title: "SyntaxError: print without parentheses",
        description: `This program crashes with SyntaxError because print needs parentheses in Python 3. Fix it so it prints ${word}.`,
        starter_code: `print '${word}'`,
        fixed_code: `print('${word}')`,
        expected_output: word,
        hints: [
          "In Python 3, print is a FUNCTION — its argument must sit inside parentheses.",
          `print '${word}' was Python 2 style and is a SyntaxError now.`,
          `Change the line to: print('${word}')`,
        ],
        bug: "SyntaxError (print stmt)", marker: `print '${word}'`,
        proof: `fixed program prints '${word}'`,
      };
    } },

  { id: "bug-strings-unclosed", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const word = AI_pick(["hello", "welcome", "python", "debug", "morning", "evening"]);
      return {
        title: "SyntaxError: unclosed parenthesis",
        description: `This program crashes with SyntaxError because a closing bracket is missing. Fix it so it prints ${word}.`,
        starter_code: `print('${word}'`,
        fixed_code: `print('${word}')`,
        expected_output: word,
        hints: [
          "Every opening parenthesis needs a matching closing one.",
          "Count the brackets: there is a '(' but no ')' at the end.",
          `Add the missing bracket: print('${word}')`,
        ],
        bug: "SyntaxError (unclosed paren)",
        proof: `fixed program prints '${word}'`,
      };
    } },

  { id: "bug-strings-index", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const w = AI_pick(["hi", "yo", "ok", "up", "go", "cat", "sun"]);
      const idx = AI_ri(3, 9);
      return {
        title: `IndexError: s[${idx}] on '${w}'`,
        description: `This program crashes with IndexError because index ${idx} does not exist in '${w}'. Fix the index so it prints '${w[1]}'.`,
        starter_code: `s = '${w}'\nprint(s[${idx}])`,
        fixed_code: `s = '${w}'\nprint(s[1])`,
        expected_output: w[1],
        hints: [
          `'${w}' has only ${w.length} characters (indexes 0 to ${w.length - 1}).`,
          `Index ${idx} is out of range — that is what IndexError means.`,
          "Change the index to 1 to print the second character.",
        ],
        bug: "IndexError (string index)", marker: `s[${idx}]`,
        proof: `s[1] of '${w}' = '${w[1]}'`,
      };
    } },

  { id: "bug-strings-itemassign", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const w = AI_pick(["cat", "dog", "sun", "box", "pen", "cup", "bee", "owl", "fox", "ant"]);
      let ch = AI_pick(["b", "c", "d", "f", "h", "l", "m", "p", "r", "t"]);
      if (ch === w[0]) ch = "z";
      return {
        title: "TypeError: string letters can't be reassigned",
        description: `Strings are immutable, so this program crashes with TypeError. Rebuild the string so it prints '${ch + w.slice(1)}'.`,
        starter_code: `s = '${w}'\ns[0] = '${ch}'\nprint(s)`,
        fixed_code: `s = '${w}'\ns = '${ch}' + s[1:]\nprint(s)`,
        expected_output: ch + w.slice(1),
        hints: [
          "Strings are IMMUTABLE — s[0] = ... always raises TypeError.",
          "Build a NEW string instead: new first letter + the rest of the old string.",
          `Change the middle line to: s = '${ch}' + s[1:]`,
        ],
        bug: "TypeError (str item assign)", marker: `s[0] = '${ch}'`,
        proof: `rebuilt string is '${ch + w.slice(1)}'`,
      };
    } },

  { id: "bug-strings-nameerror", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const name = AI_names();
      return {
        title: `NameError: name typo ('${name}')`,
        description: `This program crashes with NameError. Find the misspelled variable name and fix it so the program prints ${name}.`,
        starter_code: `name = '${name}'\nprint(nmae)`,
        fixed_code: `name = '${name}'\nprint(name)`,
        expected_output: name,
        hints: [
          "NameError means Python cannot find a variable with that exact spelling.",
          "Compare the variable name where it is created vs where it is printed.",
          "Change print(nmae) to print(name) — the letters 'a' and 'm' are swapped.",
        ],
        bug: "NameError (typo)", marker: "print(nmae)",
        proof: `fixed program prints the stored name '${name}'`,
      };
    } },

  { id: "bug-strings-typeerror", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const age = AI_ri(5, 60);
      return {
        title: "TypeError: string + number",
        description: `This program crashes with TypeError. Fix it so it prints exactly: Age: ${age}`,
        starter_code: `age = ${age}\nprint('Age: ' + age)`,
        fixed_code: `age = ${age}\nprint('Age: ' + str(age))`,
        expected_output: `Age: ${age}`,
        hints: [
          "Python cannot add (concatenate) a string and an integer directly.",
          "The variable age is a number, but 'Age: ' is text — convert one of them.",
          "Wrap age with str(): print('Age: ' + str(age)).",
        ],
        bug: "TypeError (str + int)", marker: "'Age: ' + age",
        proof: `fixed program prints 'Age: ${age}'`,
      };
    } },

  { id: "bug-loops-indent", topic: "loops", type: "bug", difficulty: "easy",
    make() {
      const k = AI_ri(3, 8);
      const lines = []; for (let i = 0; i < k; i++) lines.push(String(i));
      return {
        title: "IndentationError in a loop",
        description: `This program crashes with IndentationError. Fix the indentation so it prints the numbers 0 to ${k - 1}, one per line.`,
        starter_code: `for i in range(${k}):\nprint(i)`,
        fixed_code: `for i in range(${k}):\n    print(i)`,
        expected_output: lines.join("\n"),
        hints: [
          "In Python, the code inside a loop must be indented under the 'for' line.",
          "print(i) is currently at the same level as 'for' — Python expects an indented block.",
          "Add 4 spaces before print(i) so it sits inside the loop body.",
        ],
        bug: "IndentationError", marker: "\nprint(i)",
        proof: `fixed loop prints 0..${k - 1}`,
      };
    } },

  { id: "bug-lists-push", topic: "lists", type: "bug", difficulty: "easy",
    make() {
      const a = AI_ri(1, 9), b = AI_ri(10, 19), c = AI_ri(20, 29);
      const d = AI_ri(30, 99);
      return {
        title: "AttributeError: lists have no push()",
        description: `This program crashes with AttributeError because the method name is wrong. Fix it so it prints [${a}, ${b}, ${c}, ${d}].`,
        starter_code: `nums = [${a}, ${b}, ${c}]\nnums.push(${d})\nprint(nums)`,
        fixed_code: `nums = [${a}, ${b}, ${c}]\nnums.append(${d})\nprint(nums)`,
        expected_output: AI_pyList([a, b, c, d]),
        hints: [
          "AttributeError means the object has no method with that name.",
          "Python lists grow with append() — 'push' exists in other languages, not Python.",
          `Change nums.push(${d}) to nums.append(${d}).`,
        ],
        bug: "AttributeError (push)", marker: `.push(${d})`,
        proof: `after append the list is [${a}, ${b}, ${c}, ${d}]`,
      };
    } },

  { id: "bug-lists-popempty", topic: "lists", type: "bug", difficulty: "easy",
    make() {
      const a = AI_ri(1, 9), b = AI_ri(10, 19);
      return {
        title: "IndexError: pop() from an empty list",
        description: `This program crashes with IndexError because the list is empty. Fill the list with ${a}, ${b} so it prints ${b}.`,
        starter_code: "nums = []\nprint(nums.pop())",
        fixed_code: `nums = [${a}, ${b}]\nprint(nums.pop())`,
        expected_output: String(b),
        hints: [
          "pop() removes AND returns the LAST item — but an empty list has no last item.",
          "The list must contain values before pop() can work.",
          `Change the first line to: nums = [${a}, ${b}]`,
        ],
        bug: "IndexError (pop empty)", marker: "nums = []",
        proof: `pop() of [${a}, ${b}] returns ${b}`,
      };
    } },

  { id: "bug-lists-index", topic: "lists", type: "bug", difficulty: "easy",
    make() {
      const a = AI_ri(1, 9), b = AI_ri(10, 19), c = AI_ri(20, 29);
      return {
        title: "IndexError while printing a list",
        description: `This program should print ${a}, ${b}, ${c} (one per line) but crashes with IndexError on the last step. Fix the loop range.`,
        starter_code: `nums = [${a}, ${b}, ${c}]\nfor i in range(len(nums) + 1):\n    print(nums[i])`,
        fixed_code: `nums = [${a}, ${b}, ${c}]\nfor i in range(len(nums)):\n    print(nums[i])`,
        expected_output: `${a}\n${b}\n${c}`,
        hints: [
          "A list of 3 items has valid indexes 0, 1, 2 — index 3 does not exist.",
          "range(len(nums) + 1) produces 0..3, and nums[3] crashes the program.",
          "Remove the '+ 1' so the loop uses range(len(nums)).",
        ],
        bug: "IndexError (off-by-one)", marker: "range(len(nums) + 1)",
        proof: "fixed loop prints the 3 stored values",
      };
    } },

  { id: "bug-tuples-unpack", topic: "tuples", type: "bug", difficulty: "easy",
    make() {
      const a = AI_ri(1, 9), b = AI_ri(10, 19), c = AI_ri(20, 29);
      return {
        title: "ValueError: too many values to unpack",
        description: `This program crashes with ValueError because 2 names cannot hold 3 values. Fix the unpacking so it prints ${a + b + c}.`,
        starter_code: `a, b = (${a}, ${b}, ${c})\nprint(a + b)`,
        fixed_code: `a, b, c = (${a}, ${b}, ${c})\nprint(a + b + c)`,
        expected_output: String(a + b + c),
        hints: [
          "Unpacking needs EXACTLY matching counts on both sides of '='.",
          `The tuple has 3 values but only 2 names (a, b) are given.`,
          `Add the third name: a, b, c = (${a}, ${b}, ${c})`,
        ],
        bug: "ValueError (unpack)", marker: `a, b = (${a}, ${b}, ${c})`,
        proof: `${a} + ${b} + ${c} = ${a + b + c}`,
      };
    } },

  { id: "bug-functions-lenint", topic: "functions", type: "bug", difficulty: "easy",
    make() {
      const num = AI_ri(100, 99999);
      const digits = String(num).length;
      return {
        title: "TypeError: len() of a number",
        description: `This program should print the digit count (${digits}) but crashes with TypeError. Fix it so it prints ${digits}.`,
        starter_code: `num = ${num}\nprint(len(num))`,
        fixed_code: `num = '${num}'\nprint(len(num))`,
        expected_output: String(digits),
        hints: [
          "len() works on text/lists — not on plain numbers.",
          `num holds the number ${num}; convert it to text first.`,
          `Put quotes around it: num = '${num}'`,
        ],
        bug: "TypeError (len of int)", marker: `num = ${num}`,
        proof: `'${num}' has ${digits} characters`,
      };
    } },

  { id: "bug-functions-colon", topic: "functions", type: "bug", difficulty: "easy",
    make() {
      const age = AI_ri(18, 60);
      return {
        title: "SyntaxError: missing colon after if",
        description: "This program crashes with SyntaxError because the 'if' line has no colon. Fix it so it prints adult.",
        starter_code: `age = ${age}\nif age >= 18\n    print('adult')`,
        fixed_code: `age = ${age}\nif age >= 18:\n    print('adult')`,
        expected_output: "adult",
        hints: [
          "In Python, 'if' / 'for' / 'def' lines must end with a colon (:).",
          "The second line is missing its colon at the end.",
          "Change it to: if age >= 18:",
        ],
        bug: "SyntaxError (missing colon)", marker: "if age >= 18\n",
        proof: `${age} >= 18, so it prints 'adult'`,
      };
    } },

  { id: "bug-functions-assigninif", topic: "functions", type: "bug", difficulty: "easy",
    make() {
      const marks = AI_ri(40, 100);
      return {
        title: "SyntaxError: '=' instead of '=='",
        description: "This program crashes with SyntaxError because '=' (assign) is used where '==' (compare) belongs. Fix it so it prints pass.",
        starter_code: `marks = ${marks}\nif marks = ${marks}:\n    print('pass')\nelse:\n    print('fail')`,
        fixed_code: `marks = ${marks}\nif marks == ${marks}:\n    print('pass')\nelse:\n    print('fail')`,
        expected_output: "pass",
        hints: [
          "'=' ASSIGNS a value; '==' COMPARES two values — conditions need '=='.",
          `The 'if' line uses a single '=' which is a SyntaxError.`,
          `Change it to: if marks == ${marks}:`,
        ],
        bug: "SyntaxError (= vs ==)", marker: `if marks = ${marks}:`,
        proof: `${marks} == ${marks}, so it prints 'pass'`,
      };
    } },

  { id: "bug-sets-index", topic: "sets", type: "bug", difficulty: "easy",
    make() {
      const vals = AI_shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, 3);
      const small = Math.min(...vals);
      return {
        title: "TypeError: sets cannot be indexed",
        description: `This program crashes with TypeError because sets have no positions. Fix it (sort first) so it prints ${small}.`,
        starter_code: `s = {${vals.join(", ")}}\nprint(s[0])`,
        fixed_code: `s = {${vals.join(", ")}}\nprint(sorted(s)[0])`,
        expected_output: String(small),
        hints: [
          "Sets are unordered — s[0] is meaningless and raises TypeError.",
          "sorted(s) turns the set into an ORDERED list you can index.",
          "Change the second line to: print(sorted(s)[0])",
        ],
        bug: "TypeError (set index)", marker: "print(s[0])",
        proof: `smallest of {${vals.join(", ")}} is ${small}`,
      };
    } },

  { id: "bug-sorting-mixed", topic: "sorting", type: "bug", difficulty: "easy",
    make() {
      const a = AI_ri(1, 20), b = AI_ri(21, 50);
      const w1 = AI_pick(["apple", "mango", "pear", "grape"]);
      let w2 = AI_pick(["cat", "dog", "ant", "fox"]);
      if (w2 === w1) w2 = "zebra";
      const asc = [a, b].sort((x, y) => x - y);
      return {
        title: "TypeError: sorting mixed text + numbers",
        description: `This program crashes with TypeError because text and numbers cannot be compared. Remove the words so it prints ${AI_pyList(asc)}.`,
        starter_code: `nums = [${a}, '${w1}', ${b}, '${w2}']\nnums.sort()\nprint(nums)`,
        fixed_code: `nums = [${a}, ${b}]\nnums.sort()\nprint(nums)`,
        expected_output: AI_pyList(asc),
        hints: [
          "Python refuses to order a mix of strings and numbers ('<' not supported).",
          `The list mixes ${a}, ${b} with '${w1}', '${w2}' — the words must go.`,
          `Change the first line to: nums = [${a}, ${b}]`,
        ],
        bug: "TypeError (mixed sort)", marker: `'${w1}'`,
        proof: `sorted([${a}, ${b}]) = ${AI_pyList(asc)}`,
      };
    } },

  { id: "bug-functions-argcount", topic: "functions", type: "bug", difficulty: "medium",
    make() {
      const name = AI_names();
      const msg = AI_pick(["Hello", "Hi", "Welcome", "Good morning"]);
      return {
        title: "TypeError: missing function argument",
        description: `This program crashes with TypeError because greet() needs 2 arguments but gets 1. Fix the call so it prints \"${msg}, ${name}\".`,
        starter_code: `def greet(name, msg):\n    print(msg + ', ' + name)\ngreet('${name}')`,
        fixed_code: `def greet(name, msg):\n    print(msg + ', ' + name)\ngreet('${name}', '${msg}')`,
        expected_output: `${msg}, ${name}`,
        hints: [
          "greet() is defined with TWO parameters (name, msg) — both are required.",
          `The call passes only '${name}', so msg is missing and Python crashes.`,
          `Change the call to: greet('${name}', '${msg}')`,
        ],
        bug: "TypeError (missing arg)", marker: `greet('${name}')`,
        proof: `correct call prints '${msg}, ${name}'`,
      };
    } },

  { id: "bug-functions-unbound", topic: "functions", type: "bug", difficulty: "medium",
    make() {
      const n = AI_ri(1, 20);
      return {
        title: "UnboundLocalError: total used before assignment",
        description: `This program crashes with UnboundLocalError because 'total' is assigned inside the function. Fix it so it prints ${n}.`,
        starter_code: `total = 0\ndef add_bonus(n):\n    total = total + n\n    return total\nprint(add_bonus(${n}))`,
        fixed_code: `total = 0\ndef add_bonus(n):\n    return total + n\nprint(add_bonus(${n}))`,
        expected_output: String(n),
        hints: [
          "Assigning to a name inside a function makes it LOCAL to that function.",
          "So 'total = total + n' reads the local 'total' before it exists — crash.",
          "Just return total + n (reading a global is fine; assigning is not).",
        ],
        bug: "UnboundLocalError", marker: "total = total + n",
        proof: `0 + ${n} = ${n}`,
      };
    } },

  { id: "bug-functions-shadow", topic: "functions", type: "bug", difficulty: "medium",
    make() {
      const vals = [AI_ri(1, 9), AI_ri(1, 9), AI_ri(1, 9)];
      const total = vals[0] + vals[1] + vals[2];
      return {
        title: "TypeError: 'int' object is not callable (sum)",
        description: `This program crashes with TypeError because the name 'sum' was overwritten by a number. Rename the variable so it prints ${total}.`,
        starter_code: `sum = 0\nfor x in ${AI_pyList(vals)}:\n    sum = sum + x\nprint(sum(${AI_pyList(vals)}))`,
        fixed_code: `total = 0\nfor x in ${AI_pyList(vals)}:\n    total = total + x\nprint(total)`,
        expected_output: String(total),
        hints: [
          "Never name a variable 'sum' / 'list' / 'max' — it hides Python's built-in function.",
          "After 'sum = 0', the last line tries to CALL the number 0 like a function.",
          "Rename the variable to 'total' everywhere (and print total).",
        ],
        bug: "TypeError (shadowed builtin)", marker: `print(sum([`,
        proof: `${vals.join(" + ")} = ${total}`,
      };
    } },

  { id: "bug-functions-assert", topic: "functions", type: "bug", difficulty: "medium",
    make() {
      const age = AI_ri(10, 17);
      return {
        title: "AssertionError: age check fails",
        description: `This program crashes with AssertionError because the age is too small. Fix the age so it prints welcome.`,
        starter_code: `age = ${age}\nassert age >= 18, 'must be adult'\nprint('welcome')`,
        fixed_code: "age = 20\nassert age >= 18, 'must be adult'\nprint('welcome')",
        expected_output: "welcome",
        hints: [
          "assert CONDITION crashes the program when the condition is False.",
          `${age} >= 18 is False, so the assert raises AssertionError.`,
          "Change the first line to: age = 20",
        ],
        bug: "AssertionError", marker: `age = ${age}`,
        proof: "20 >= 18 passes, prints 'welcome'",
      };
    } },

  { id: "bug-dict-keyerror", topic: "dictionaries", type: "bug", difficulty: "medium",
    make() {
      const names = AI_shuffle(["ram", "sita", "gita", "hari", "mohan", "laxmi"]).slice(0, 2);
      const x = AI_ri(50, 99), y = AI_ri(50, 99);
      return {
        title: "KeyError: wrong dictionary key",
        description: `This program crashes with KeyError. Fix the key so it prints ${x} (the marks of ${names[0]}).`,
        starter_code: `marks = {'${names[0]}': ${x}, '${names[1]}': ${y}}\nprint(marks['${names[0]}s'])`,
        fixed_code: `marks = {'${names[0]}': ${x}, '${names[1]}': ${y}}\nprint(marks['${names[0]}'])`,
        expected_output: String(x),
        hints: [
          "KeyError means the key you asked for does not exist in the dictionary.",
          `The dictionary has '${names[0]}' but the code asks for '${names[0]}s' (extra letter).`,
          `Change marks['${names[0]}s'] to marks['${names[0]}'].`,
        ],
        bug: "KeyError (wrong key)", marker: `marks['${names[0]}s']`,
        proof: `marks['${names[0]}'] = ${x}`,
      };
    } },

  { id: "bug-dict-pop", topic: "dictionaries", type: "bug", difficulty: "medium",
    make() {
      const names = AI_shuffle(["ram", "sita", "gita", "hari", "mohan", "laxmi"]).slice(0, 3);
      const x = AI_ri(50, 99), y = AI_ri(50, 99);
      return {
        title: `KeyError: pop('${names[2]}') missing`,
        description: `This program crashes with KeyError because '${names[2]}' is not in the dictionary. Fix it so it prints ${x}.`,
        starter_code: `marks = {'${names[0]}': ${x}, '${names[1]}': ${y}}\nprint(marks.pop('${names[2]}'))`,
        fixed_code: `marks = {'${names[0]}': ${x}, '${names[1]}': ${y}}\nprint(marks.pop('${names[0]}'))`,
        expected_output: String(x),
        hints: [
          "pop(key) removes AND returns the value — but the key must exist.",
          `'${names[2]}' is not among the keys, so pop() raises KeyError.`,
          `Change the key to '${names[0]}' (or give pop a default).`,
        ],
        bug: "KeyError (pop missing)", marker: `.pop('${names[2]}')`,
        proof: `pop('${names[0]}') returns ${x}`,
      };
    } },

  { id: "bug-functions-zerodiv", topic: "functions", type: "bug", difficulty: "medium",
    make() {
      const set = AI_pick([[60, 80, 100], [50, 70, 90], [40, 60, 80], [70, 80, 90], [90, 95, 100]]);
      const avg = set.reduce((s, v) => s + v, 0) / set.length;
      return {
        title: "ZeroDivisionError: average of empty list",
        description: `This program crashes with ZeroDivisionError because the list is empty. Fill the list with ${set.join(", ")} so it prints the average ${avg.toFixed(1)}.`,
        starter_code: "scores = []\navg = sum(scores) / len(scores)\nprint(avg)",
        fixed_code: `scores = ${AI_pyList(set)}\navg = sum(scores) / len(scores)\nprint(avg)`,
        expected_output: avg.toFixed(1),
        hints: [
          "len([]) is 0, and dividing by 0 raises ZeroDivisionError.",
          "The scores list must contain numbers before the average can be computed.",
          `Change the first line to: scores = ${AI_pyList(set)}`,
        ],
        bug: "ZeroDivisionError (empty list)", marker: "scores = []",
        proof: `avg(${set.join("+")}) = ${avg.toFixed(1)}`,
      };
    } },

  { id: "bug-oop-self", topic: "oop", type: "bug", difficulty: "medium",
    make() {
      const name = AI_names();
      return {
        title: "AttributeError: missing self",
        description: `This program crashes with AttributeError when calling show(). Fix __init__ so it prints ${name}.`,
        starter_code: `class Student:\n    def __init__(self, name):\n        name = name\n    def show(self):\n        print(self.name)\ns = Student('${name}')\ns.show()`,
        fixed_code: `class Student:\n    def __init__(self, name):\n        self.name = name\n    def show(self):\n        print(self.name)\ns = Student('${name}')\ns.show()`,
        expected_output: name,
        hints: [
          "Inside __init__, 'name = name' only creates a local variable that disappears.",
          "To store data ON the object you must assign it to 'self'.",
          "Change the line to: self.name = name",
        ],
        bug: "missing self (AttributeError)", marker: "\n        name = name",
        proof: `fixed object stores and prints '${name}'`,
      };
    } },

  { id: "bug-oop-classcall", topic: "oop", type: "bug", difficulty: "medium",
    make() {
      const name = AI_names();
      return {
        title: "TypeError: method called on the class",
        description: `This program crashes with TypeError because show() is called on the CLASS instead of an object. Fix it so it prints ${name}.`,
        starter_code: `class Student:\n    def __init__(self, name):\n        self.name = name\n    def show(self):\n        print(self.name)\nStudent.show()`,
        fixed_code: `class Student:\n    def __init__(self, name):\n        self.name = name\n    def show(self):\n        print(self.name)\ns = Student('${name}')\ns.show()`,
        expected_output: name,
        hints: [
          "Methods with 'self' must be called on an OBJECT, not on the class.",
          "Student.show() passes no object, so 'self' is missing — TypeError.",
          `Create the object first: s = Student('${name}'), then s.show()`,
        ],
        bug: "TypeError (unbound method)", marker: "Student.show()",
        proof: `object stores and prints '${name}'`,
      };
    } },

  { id: "bug-exceptions-catch", topic: "exceptions", type: "bug", difficulty: "medium",
    make() {
      const a = AI_ri(10, 50);
      return {
        title: "Wrong exception type caught",
        description: "This program should print \"error\" but it still crashes. Fix the except clause so the crash is caught and it prints error.",
        starter_code: `try:\n    print(${a} / 0)\nexcept ValueError:\n    print('error')`,
        fixed_code: `try:\n    print(${a} / 0)\nexcept ZeroDivisionError:\n    print('error')`,
        expected_output: "error",
        hints: [
          "Dividing by zero raises ZeroDivisionError — not ValueError.",
          "An 'except' block only catches the error type it names.",
          "Change 'except ValueError' to 'except ZeroDivisionError'.",
        ],
        bug: "wrong except type (crash)", marker: "except ValueError:",
        proof: `${a}/0 raises ZeroDivisionError, caught -> prints 'error'`,
      };
    } },

  { id: "bug-exceptions-wrongint", topic: "exceptions", type: "bug", difficulty: "medium",
    make() {
      const fb = AI_ri(1, 99);
      return {
        title: "Wrong exception type for int()",
        description: `This program should print ${fb} but it still crashes. Fix the except clause so the crash is caught and it prints ${fb}.`,
        starter_code: `try:\n    x = int('12a')\nexcept ZeroDivisionError:\n    x = ${fb}\nprint(x)`,
        fixed_code: `try:\n    x = int('12a')\nexcept ValueError:\n    x = ${fb}\nprint(x)`,
        expected_output: String(fb),
        hints: [
          "int('12a') fails because '12a' is not a valid number — that is ValueError.",
          "An 'except' block only catches the error type it names.",
          "Change 'except ZeroDivisionError' to 'except ValueError'.",
        ],
        bug: "wrong except type (ValueError)", marker: "except ZeroDivisionError:",
        proof: `int('12a') raises ValueError, caught -> prints ${fb}`,
      };
    } },

  { id: "bug-exceptions-import", topic: "exceptions", type: "bug", difficulty: "medium",
    make() {
      const n = AI_pick([16, 25, 36, 49, 64, 81]);
      const r = Math.sqrt(n);
      const out = Number.isInteger(r) ? r.toFixed(1) : String(r);
      return {
        title: "ModuleNotFoundError: no module 'maths'",
        description: `This program crashes with ModuleNotFoundError because the module name is misspelled. Fix the import so it prints ${out}.`,
        starter_code: `import maths\nprint(maths.sqrt(${n}))`,
        fixed_code: `import math\nprint(math.sqrt(${n}))`,
        expected_output: out,
        hints: [
          "ModuleNotFoundError means no installed module has that name.",
          "The real module is called 'math' — 'maths' with an 's' does not exist.",
          "Change the first line to: import math (and maths.sqrt to math.sqrt)",
        ],
        bug: "ModuleNotFoundError (typo)", marker: "import maths",
        proof: `math.sqrt(${n}) = ${out}`,
      };
    } },

  { id: "bug-exceptions-filenotfound", topic: "exceptions", type: "bug", difficulty: "medium",
    make() {
      return {
        title: "FileNotFoundError: 'report.txt' doesn't exist",
        description: "This program crashes with FileNotFoundError because it tries to READ a file that was never created. Fix it (create the file with 'w' mode) so it prints saved.",
        starter_code: "f = open('report.txt')\nprint(f.read())",
        fixed_code: "f = open('report.txt', 'w')\nf.write('done')\nf.close()\nprint('saved')",
        expected_output: "saved",
        hints: [
          "open(name) without a mode OPENS FOR READING — the file must already exist.",
          "'report.txt' was never created, so reading it raises FileNotFoundError.",
          "Open with 'w' mode to CREATE it: f = open('report.txt', 'w')",
        ],
        bug: "FileNotFoundError", marker: "f = open('report.txt')",
        proof: "'w' mode creates the file, then prints 'saved'",
      };
    } },

  { id: "bug-tuples-modify", topic: "tuples", type: "bug", difficulty: "medium",
    make() {
      const a = AI_ri(1, 9), b = AI_ri(10, 19), c = AI_ri(20, 29);
      let d = AI_ri(30, 99); if (d === a) d += 1;
      return {
        title: "TypeError: tuple cannot be changed",
        description: `Tuples are immutable, so this program crashes with TypeError. Fix it (convert to a list and back) so it prints (${d}, ${b}, ${c}).`,
        starter_code: `t = (${a}, ${b}, ${c})\nt[0] = ${d}\nprint(t)`,
        fixed_code: `t = (${a}, ${b}, ${c})\nt = list(t)\nt[0] = ${d}\nt = tuple(t)\nprint(t)`,
        expected_output: `(${d}, ${b}, ${c})`,
        hints: [
          "Tuples are IMMUTABLE — you cannot assign to t[0] directly.",
          "The standard trick: convert the tuple to a list, change it, convert back.",
          "Insert 't = list(t)' before the assignment and 't = tuple(t)' after it.",
        ],
        bug: "tuple item assignment (TypeError)", marker: `t = (${a}, ${b}, ${c})\nt[0] = ${d}`,
        proof: `after fix the tuple prints (${d}, ${b}, ${c})`,
      };
    } },

  { id: "bug-sets-unhashable", topic: "sets", type: "bug", difficulty: "hard",
    make() {
      const vals = AI_shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).slice(0, 3);
      const [x, y, z] = vals;
      const sorted = [...vals].sort((p, q) => p - q);
      return {
        title: "TypeError: unhashable list added to set",
        description: `This program crashes with "TypeError: unhashable type: 'list'". Fix the s.add(...) line so it prints ${AI_pyList(sorted)}.`,
        starter_code: `s = {${x}, ${y}}\ns.add([${z}])\nprint(sorted(s))`,
        fixed_code: `s = {${x}, ${y}}\ns.add(${z})\nprint(sorted(s))`,
        expected_output: AI_pyList(sorted),
        hints: [
          "Sets can only contain hashable (immutable) items — a list is not allowed.",
          `s.add([${z}]) tries to add a whole LIST; you only want to add the number ${z}.`,
          `Change the line to: s.add(${z})`,
        ],
        bug: "unhashable type (TypeError)", marker: `s.add([${z}])`,
        proof: `sorted({${x},${y},${z}}) = ${AI_pyList(sorted)}`,
      };
    } },

  { id: "bug-recursion-nobase", topic: "recursion", type: "bug", difficulty: "hard",
    make() {
      const n = AI_ri(3, 5);
      const lines = []; for (let i = n; i >= 1; i--) lines.push(String(i));
      return {
        title: "RecursionError: missing base case",
        description: `This countdown function calls itself forever and crashes with RecursionError. Add a base case so it prints ${n} down to 1, one per line.`,
        starter_code: `def countdown(n):\n    print(n)\n    countdown(n - 1)\ncountdown(${n})`,
        fixed_code: `def countdown(n):\n    if n <= 0:\n        return\n    print(n)\n    countdown(n - 1)\ncountdown(${n})`,
        expected_output: lines.join("\n"),
        hints: [
          "Every recursive function needs a BASE CASE — a condition where it stops calling itself.",
          "countdown keeps going into negative numbers forever (3, 2, 1, 0, -1, ...).",
          "Add at the top of the function: if n <= 0: return",
        ],
        bug: "missing base case (RecursionError)", marker: "def countdown(n):\n    print(n)",
        proof: `fixed countdown(${n}) prints ${lines.join(",")}`,
      };
    } },

  { id: "bug-recursion-wrongdir", topic: "recursion", type: "bug", difficulty: "hard",
    make() {
      const n = AI_ri(3, 5);
      const lines = []; for (let i = n; i >= 1; i--) lines.push(String(i));
      return {
        title: "RecursionError: counting the wrong way",
        description: `This countdown has a base case but still crashes with RecursionError because it counts UP. Fix the step so it prints ${n} down to 1, one per line.`,
        starter_code: `def countdown(n):\n    if n <= 0:\n        return\n    print(n)\n    countdown(n + 1)\ncountdown(${n})`,
        fixed_code: `def countdown(n):\n    if n <= 0:\n        return\n    print(n)\n    countdown(n - 1)\ncountdown(${n})`,
        expected_output: lines.join("\n"),
        hints: [
          "The base case stops at 0 — but the call moves AWAY from 0.",
          "countdown(n + 1) goes 3, 4, 5, ... forever and never reaches 0.",
          "Change the recursive call to: countdown(n - 1)",
        ],
        bug: "wrong direction (RecursionError)", marker: "countdown(n + 1)",
        proof: `fixed countdown(${n}) prints ${lines.join(",")}`,
      };
    } },

  { id: "bug-generators-stopiter", topic: "generators", type: "bug", difficulty: "hard",
    make() {
      const N = AI_ri(2, 4);
      const sq = []; for (let i = 0; i < N; i++) sq.push(i * i);
      const nexts = []; for (let i = 0; i <= N; i++) nexts.push("print(next(gen))");
      return {
        title: "StopIteration: next() past the end",
        description: `This generator holds ${N} values but next() is called ${N + 1} times, so the last call crashes with StopIteration. Collect the values with list() so it prints ${AI_pyList(sq)}.`,
        starter_code: `gen = (x * x for x in range(${N}))\n${nexts.join("\n")}`,
        fixed_code: `gen = (x * x for x in range(${N}))\nvals = list(gen)\nprint(vals)`,
        expected_output: AI_pyList(sq),
        hints: [
          `The generator produces exactly ${N} values (squares of 0..${N - 1}).`,
          `Calling next() a ${N + 1}-th time has nothing left to give — StopIteration.`,
          "Replace the next() calls with: vals = list(gen), then print(vals).",
        ],
        bug: "StopIteration", marker: "print(next(gen))",
        proof: `squares 0..${N - 1} = ${AI_pyList(sq)}`,
      };
    } },

  { id: "bug-oop-notimplemented", topic: "oop", type: "bug", difficulty: "hard",
    make() {
      const sound = AI_pick(["grr", "woof", "meow", "roar", "chirp", "moo"]);
      return {
        title: "NotImplementedError: speak() not implemented",
        description: `This program crashes with NotImplementedError because speak() only raises. Implement it so the program prints '${sound}'.`,
        starter_code: `class Animal:\n    def speak(self):\n        raise NotImplementedError('override me')\nd = Animal()\nprint(d.speak())`,
        fixed_code: `class Animal:\n    def speak(self):\n        return '${sound}'\nd = Animal()\nprint(d.speak())`,
        expected_output: sound,
        hints: [
          "'raise NotImplementedError' is a placeholder meaning: this method is not written yet.",
          "Calling d.speak() runs that placeholder — and crashes.",
          `Replace the raise line with: return '${sound}'`,
        ],
        bug: "NotImplementedError", marker: "raise NotImplementedError",
        proof: `implemented speak() returns '${sound}'`,
      };
    } },

  /* ---------------- PREDICT-OUTPUT templates ---------------- */

  { id: "q-loops-sum", topic: "loops", type: "question", difficulty: "easy",
    make() {
      const a = AI_ri(1, 3), b = a + AI_ri(3, 5);
      let total = 0; for (let i = a; i < b; i++) total += i;
      const terms = []; for (let k = a; k < b; k++) terms.push(k);
      return {
        title: `Loop sum from ${a} to ${b - 1}`,
        description: "What will this program print? Type the exact output.",
        starter_code: `total = 0\nfor i in range(${a}, ${b}):\n    total += i\nprint(total)`,
        expected_output: String(total),
        hints: [
          `The loop adds every number from ${a} up to (but not including) ${b}.`,
          `That is: ${terms.join(" + ")}.`,
          "Add them step by step to get the answer.",
        ],
        proof: `sum(${a}..${b - 1}) = ${total}`,
      };
    } },

  { id: "q-loops-pattern", topic: "loops", type: "question", difficulty: "easy",
    make() {
      const n = AI_ri(3, 7);
      const ch = AI_pick(["*", "#", "@"]);
      const lines = []; for (let i = 1; i < n; i++) lines.push(ch.repeat(i));
      return {
        title: `Character triangle pattern ('${ch}')`,
        description: "What will this program print? Type the exact output (all lines).",
        starter_code: `for i in range(1, ${n}):\n    print('${ch}' * i)`,
        expected_output: lines.join("\n"),
        hints: [
          `'${ch}' * i repeats the character i times on one line.`,
          `The loop runs with i = 1, 2, ... up to ${n - 1}.`,
          "So line 1 has 1 character, line 2 has 2, and so on.",
        ],
        proof: `${n - 1} lines of '${ch}'`,
      };
    } },

  { id: "q-strings-slice", topic: "strings", type: "question", difficulty: "easy",
    make() {
      const word = AI_pick(["python", "planet", "rocket", "tiger", "debug", "coding"]);
      const i = AI_ri(0, 1), j = i + AI_ri(2, 3);
      return {
        title: `Slicing '${word}'`,
        description: "What will this program print? Type the exact output (both lines).",
        starter_code: `word = '${word}'\nprint(word[${i}:${j}])\nprint(len(word))`,
        expected_output: `${word.slice(i, j)}\n${word.length}`,
        hints: [
          "word[a:b] takes characters from index a up to (not including) index b.",
          `Index the letters of '${word}': 0='${word[0]}', 1='${word[1]}', 2='${word[2]}'...`,
          `Slice [${i}:${j}] gives '${word.slice(i, j)}' and the length is ${word.length}.`,
        ],
        proof: `slice + len computed from '${word}'`,
      };
    } },

  { id: "q-strings-fstring", topic: "strings", type: "question", difficulty: "easy",
    make() {
      const name = AI_names();
      const s = AI_ri(60, 100);
      return {
        title: "f-string greeting",
        description: "What will this program print? Type the exact output.",
        starter_code: "name = '" + name + "'\nscore = " + s + "\nprint(f'{name} scored {score}')",
        expected_output: `${name} scored ${s}`,
        hints: [
          "f-strings replace {name} placeholders with the variable values.",
          `name holds '${name}' and score holds ${s}.`,
          "Just substitute the values into the sentence.",
        ],
        proof: "placeholder substitution",
      };
    } },

  { id: "q-strings-methods", topic: "strings", type: "question", difficulty: "medium",
    make() {
      const word = AI_pick(["banana", "pepper", "letter", "coffee", "balloon", "mississippi"]);
      const ch1 = word[1];
      let ch2 = AI_pick(["o", "a", "e", "i", "x"]);
      if (ch2 === ch1) ch2 = "z";
      const ch3 = AI_pick([...new Set(word.split(""))]);
      const count = word.split("").filter((c) => c === ch3).length;
      return {
        title: `String methods on '${word}'`,
        description: "What will this program print? Type the exact output (all 3 lines).",
        starter_code: `msg = '${word}'\nprint(msg.upper())\nprint(msg.replace('${ch1}', '${ch2}'))\nprint(msg.count('${ch3}'))`,
        expected_output: `${word.toUpperCase()}\n${word.split(ch1).join(ch2)}\n${count}`,
        hints: [
          "upper() capitalises everything; replace() swaps ALL occurrences; count() counts occurrences.",
          `upper() gives '${word.toUpperCase()}'.`,
          `Every '${ch1}' becomes '${ch2}', and '${ch3}' appears ${count} time(s).`,
        ],
        proof: "upper/replace/count computed in JS with Python semantics",
      };
    } },

  { id: "q-lists-slice", topic: "lists", type: "question", difficulty: "easy",
    make() {
      const len = AI_ri(4, 6);
      const nums = []; for (let i = 0; i < len; i++) nums.push(AI_ri(1, 50));
      const i = 1, j = len - 1;
      return {
        title: "List slicing and indexing",
        description: "What will this program print? Type the exact output (all 3 lines).",
        starter_code: `nums = ${AI_pyList(nums)}\nprint(nums[${i}:${j}])\nprint(nums[-1])\nprint(len(nums))`,
        expected_output: `${AI_pyList(nums.slice(i, j))}\n${nums[nums.length - 1]}\n${nums.length}`,
        hints: [
          `nums[${i}:${j}] takes elements from index ${i} up to (not including) index ${j}.`,
          "nums[-1] is the LAST element of the list.",
          `Slice = ${AI_pyList(nums.slice(i, j))}, last = ${nums[nums.length - 1]}, length = ${nums.length}.`,
        ],
        proof: "slice/last/len computed from the same array",
      };
    } },

  { id: "q-lists-comp", topic: "lists", type: "question", difficulty: "hard",
    make() {
      const len = AI_ri(5, 7);
      const nums = []; for (let i = 0; i < len; i++) nums.push(AI_ri(1, 12));
      const par = AI_pick([0, 1]);
      const kept = nums.filter((x) => x % 2 === par);
      const out = kept.map((x) => x * x);
      return {
        title: `Squares of ${par === 0 ? "even" : "odd"} numbers`,
        description: "What will this program print? Type the exact output.",
        starter_code: `nums = ${AI_pyList(nums)}\nsquares = [x * x for x in nums if x % 2 == ${par}]\nprint(squares)`,
        expected_output: AI_pyList(out),
        hints: [
          `The 'if' keeps only numbers where x % 2 == ${par} (${par === 0 ? "evens" : "odds"}).`,
          `Kept numbers: ${AI_pyList(kept)} — now square each one.`,
          `Result: ${AI_pyList(out)}.`,
        ],
        proof: "filter + square computed from the same array",
      };
    } },

  { id: "q-dict-get", topic: "dictionaries", type: "question", difficulty: "easy",
    make() {
      const name = AI_names();
      const age = AI_ri(10, 40);
      const city = AI_pick(["Delhi", "Pokhara", "Mumbai", "Jaipur", "Patna", "Ludhiana"]);
      return {
        title: "Dictionary lookup with default",
        description: "What will this program print? Type the exact output (all 3 lines).",
        starter_code: `user = {'name': '${name}', 'age': ${age}}\nprint(user['name'])\nprint(user.get('city', '${city}'))\nprint(len(user))`,
        expected_output: `${name}\n${city}\n2`,
        hints: [
          "user['name'] reads the existing key directly.",
          "get('city', default) returns the default because 'city' is NOT in the dictionary.",
          `So the lines are: ${name} / ${city} / 2.`,
        ],
        proof: "direct lookup + default + len",
      };
    } },

  { id: "q-dict-loop", topic: "dictionaries", type: "question", difficulty: "medium",
    make() {
      const x = AI_ri(5, 20), y = AI_ri(5, 20), z = AI_ri(5, 20);
      return {
        title: "Summing dictionary values",
        description: "What will this program print? Type the exact output (both lines).",
        starter_code: `marks = {'a': ${x}, 'b': ${y}, 'c': ${z}}\ntotal = 0\nfor k in marks:\n    total += marks[k]\nprint(total)\nprint(sorted(marks))`,
        expected_output: `${x + y + z}\n['a', 'b', 'c']`,
        hints: [
          "Looping 'for k in marks' visits each KEY: 'a', 'b', 'c'.",
          `total adds ${x} + ${y} + ${z} = ${x + y + z}.`,
          "sorted(marks) sorts the KEYS alphabetically: ['a', 'b', 'c'].",
        ],
        proof: `sum=${x + y + z}, sorted keys fixed`,
      };
    } },

  { id: "q-functions-default", topic: "functions", type: "question", difficulty: "medium",
    make() {
      const b = AI_ri(2, 9);
      return {
        title: `Power with default argument (${b})`,
        description: "What will this program print? Type the exact output (both lines).",
        starter_code: `def power(base, exp=2):\n    return base ** exp\nprint(power(${b}))\nprint(power(${b}, 3))`,
        expected_output: `${b * b}\n${b * b * b}`,
        hints: [
          "When exp is not given, the default exp=2 is used.",
          `power(${b}) = ${b}**2 = ${b * b}.`,
          `power(${b}, 3) = ${b}**3 = ${b * b * b}.`,
        ],
        proof: `${b}^2 and ${b}^3 computed`,
      };
    } },

  { id: "q-oop-counter", topic: "oop", type: "question", difficulty: "medium",
    make() {
      const a = AI_ri(1, 10), b = AI_ri(1, 10);
      return {
        title: "Counter object adds up",
        description: "What will this program print? Type the exact output.",
        starter_code: `class Counter:\n    def __init__(self):\n        self.count = 0\n    def add(self, n):\n        self.count += n\nc = Counter()\nc.add(${a})\nc.add(${b})\nprint(c.count)`,
        expected_output: String(a + b),
        hints: [
          "The counter starts at 0 and each add(n) increases it.",
          `After add(${a}) the count is ${a}; after add(${b}) it grows by ${b}.`,
          `Final count: ${a} + ${b} = ${a + b}.`,
        ],
        proof: `0 + ${a} + ${b} = ${a + b}`,
      };
    } },

  { id: "q-oop-inherit", topic: "oop", type: "question", difficulty: "medium",
    make() {
      const sound = AI_pick(["woof", "meow", "roar", "chirp", "moo", "hiss", "quack", "neigh"]);
      const animal = { woof: "Dog", meow: "Cat", roar: "Lion", chirp: "Bird", moo: "Cow", hiss: "Snake", quack: "Duck", neigh: "Horse" }[sound];
      return {
        title: `${animal} overrides speak()`,
        description: "What will this program print? Type the exact output.",
        starter_code: `class Animal:\n    def speak(self):\n        return '...'\nclass ${animal}(Animal):\n    def speak(self):\n        return '${sound}'\nd = ${animal}()\nprint(d.speak())`,
        expected_output: sound,
        hints: [
          `${animal} INHERITS from Animal but defines its own speak() method.`,
          "When a child class overrides a method, the child's version wins.",
          `So d.speak() returns '${sound}'.`,
        ],
        proof: "override resolution is deterministic",
      };
    } },

  { id: "q-recursion-fact", topic: "recursion", type: "question", difficulty: "medium",
    make() {
      const n = AI_ri(3, 7);
      let f = 1; for (let i = 2; i <= n; i++) f *= i;
      const terms = []; for (let k = n; k >= 1; k--) terms.push(k);
      return {
        title: `Factorial of ${n}`,
        description: "What will this program print? Type the exact output.",
        starter_code: `def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nprint(fact(${n}))`,
        expected_output: String(f),
        hints: [
          `fact(${n}) = ${n} * fact(${n - 1}) — it multiplies down to fact(1) = 1.`,
          `That is ${terms.join(" x ")}.`,
          `The product equals ${f}.`,
        ],
        proof: `${n}! = ${f}`,
      };
    } },

  { id: "q-exceptions-finally", topic: "exceptions", type: "question", difficulty: "medium",
    make() {
      const fb = AI_ri(1, 99);
      return {
        title: "try / except / finally flow",
        description: "What will this program print? Type the exact output (both lines, in order).",
        starter_code: `try:\n    x = int('12a')\nexcept ValueError:\n    x = ${fb}\nfinally:\n    print('done')\nprint(x)`,
        expected_output: `done\n${fb}`,
        hints: [
          "int('12a') fails because '12a' is not a valid number — ValueError.",
          `The except block runs, setting x = ${fb}.`,
          "'finally' ALWAYS runs first (printing done), then print(x) prints the value.",
        ],
        proof: "ValueError path is deterministic",
      };
    } },

  { id: "q-sets-ops", topic: "sets", type: "question", difficulty: "easy",
    make() {
      const pool = AI_shuffle([1, 2, 3, 4, 5, 6, 7, 8]).slice(0, 6);
      const A = [...new Set(pool.slice(0, 4))];
      const B = [...new Set(pool.slice(2, 6))];
      const union = [...new Set([...A, ...B])];
      const inter = A.filter((v) => B.includes(v)).sort((p, q) => p - q);
      return {
        title: "Set union and intersection",
        description: "What will this program print? Type the exact output (both lines).",
        starter_code: `a = {${A.join(", ")}}\nb = {${B.join(", ")}}\nprint(len(a | b))\nprint(sorted(a & b))`,
        expected_output: `${union.length}\n${AI_pyList(inter)}`,
        hints: [
          "a | b is the UNION (all distinct elements from both sets).",
          "a & b is the INTERSECTION (only elements present in BOTH sets).",
          `Union has ${union.length} elements; intersection sorted is ${AI_pyList(inter)}.`,
        ],
        proof: "union/intersection computed from the same sets",
      };
    } },

  { id: "q-sorting-keylen", topic: "sorting", type: "question", difficulty: "hard",
    make() {
      // words with DISTINCT lengths so `sorted(key=len)` order is deterministic
      const byLen = { 1: ["a", "I"], 2: ["ox", "up", "go"], 3: ["cat", "dog", "sun"], 4: ["wolf", "moon", "star"], 5: ["tiger", "eagle", "snake"], 6: ["giraffe", "monkey", "planet"], 7: ["leopard", "dolphin"] };
      const lens = AI_shuffle([1, 2, 3, 4, 5, 6, 7]).slice(0, 4);
      const words = lens.map((L) => AI_pick(byLen[L]));
      const ordered = [...words].sort((p, q) => p.length - q.length);
      const lensStr = words.map((w) => w + "=" + w.length).join(", ");
      return {
        title: "Sorting words by length",
        description: "What will this program print? Type the exact output.",
        starter_code: `words = ${AI_pyList(words)}\nprint(sorted(words, key=len))`,
        expected_output: AI_pyList(ordered),
        hints: [
          "key=len tells sorted() to compare words by their LENGTH, not alphabetically.",
          `Lengths here: ${lensStr}.`,
          `Shortest first gives ${AI_pyList(ordered)}.`,
        ],
        proof: "distinct lengths => deterministic order",
      };
    } },

  { id: "q-generators-list", topic: "generators", type: "question", difficulty: "medium",
    make() {
      const m = AI_ri(2, 5), n = AI_ri(3, 5);
      const out = []; for (let i = 0; i < n; i++) out.push(i * m);
      return {
        title: `Generator multiples of ${m}`,
        description: "What will this program print? Type the exact output.",
        starter_code: `gen = (x * ${m} for x in range(${n}))\nprint(list(gen))`,
        expected_output: AI_pyList(out),
        hints: [
          `The generator produces x * ${m} for x = 0, 1, ... ${n - 1}.`,
          "list(gen) collects all produced values into a list.",
          `Values: ${out.join(", ")} — format them as a Python list.`,
        ],
        proof: "multiples computed by loop",
      };
    } },

  { id: "q-tuples-unpack", topic: "tuples", type: "question", difficulty: "easy",
    make() {
      const a = AI_ri(1, 9), b = AI_ri(10, 19), c = AI_ri(20, 29);
      return {
        title: "Tuple unpacking",
        description: "What will this program print? Type the exact output (both lines).",
        starter_code: `t = (${a}, ${b}, ${c})\nx, y, z = t\nprint(x + z)\nprint(t[1])`,
        expected_output: `${a + c}\n${b}`,
        hints: [
          "x, y, z = t unpacks the tuple: x is first, y is second, z is third.",
          `So x=${a}, y=${b}, z=${c}.`,
          `x + z = ${a + c}, and t[1] (index 1) = ${b}.`,
        ],
        proof: "positional unpacking is deterministic",
      };
    } },
];

/* ============================================================
   4b. STATIC PYTHON ERROR DETECTOR (no execution needed)
   AI_detectPythonError(code) -> { error, detail, line }
   `error` is a real Python exception name (or null when the code
   looks runnable). Used to:
     (a) PROVE every generated Fix-the-Bug snippet really raises,
     (b) find + auto-delete Fix-the-Bug problems whose code runs clean.
   try/except handling: a raise inside `try` is ignored when a matching
   `except` (or a bare `except:` / `except Exception:`) catches it —
   exactly like real Python. Syntax/Indentation errors are never caught.
   ============================================================ */

const AI_PY_KEYWORDS = new Set(
  "False None True and as assert break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ")
);

const AI_PY_BUILTINS = new Set(
  ("print range len str int float bool list dict set tuple sorted sum min max abs round pow divmod " +
    "type isinstance issubclass enumerate zip open input next iter super ord chr hex oct bin repr format " +
    "callable hasattr getattr setattr vars dir id hash all any reversed map filter slice object " +
    "Exception BaseException ArithmeticError LookupError " +
    "ValueError TypeError KeyError IndexError ZeroDivisionError NameError AttributeError RecursionError " +
    "IndentationError TabError SyntaxError ImportError ModuleNotFoundError FileNotFoundError StopIteration " +
    "AssertionError NotImplementedError UnboundLocalError RuntimeError OverflowError MemoryError " +
    "OSError IOError EOFError KeyboardInterrupt SystemExit GeneratorExit Warning").split(" ")
);

const AI_PY_STDLIB = new Set(
  ("math random sys os json re datetime time collections itertools functools statistics string decimal fractions " +
    "copy typing pathlib dataclasses enum heapq bisect array csv sqlite3 urllib http email html xml logging argparse unittest " +
    "importlib inspect textwrap calendar hashlib secrets uuid numbers cmath operator keyword builtins types warnings contextlib abc io pickle asyncio").split(" ")
);

// Method names that exist on NO common Python type -> always AttributeError.
const AI_PY_BAD_METHODS = ["uppercase", "lowercase", "push", "appendItem", "addItem", "insertAt", "removeAt", "length", "size", "contains", "isEmpty"];

// Methods that only exist on specific types: caller-type mismatch -> AttributeError.
const AI_PY_METHOD_OWNERS = {
  append: ["list"], extend: ["list"], insert: ["list"], sort: ["list"], reverse: ["list"],
  upper: ["str"], lower: ["str"], capitalize: ["str"], title: ["str"], strip: ["str"], lstrip: ["str"],
  rstrip: ["str"], split: ["str"], rsplit: ["str"], splitlines: ["str"], join: ["str"], startswith: ["str"],
  endswith: ["str"], find: ["str"], format: ["str"], encode: ["str"],
  keys: ["dict"], values: ["dict"], items: ["dict"], get: ["dict"], popitem: ["dict"], setdefault: ["dict"],
  add: ["set"], discard: ["set"], union: ["set"], intersection: ["set"], difference: ["set"],
  read: ["file"], write: ["file"], close: ["file"], readline: ["file"], readlines: ["file"],
};

// Split on top-level commas (quote- + bracket-aware).
function AI_pySplitTop(s) {
  const parts = [];
  let cur = "", depth = 0, q = null;
  const t = String(s || "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      cur += ch;
      if (ch === "\\" && i + 1 < t.length) { cur += t[++i]; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function AI_pyStripComment(raw) {
  let q = null;
  const t = String(raw || "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === "\\") { i++; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === "#") return t.slice(0, i);
  }
  return t;
}

// Per-line views: `code` = strings blanked + no comments (structure),
// `src` = comments stripped but strings intact (values).
function AI_pyPrep(code) {
  return String(code || "").split("\n").map((raw, i) => {
    const bare0 = String(raw).replace(/[fFrRbBuU]{0,2}'(?:[^'\\\n]|\\.)*'|[fFrRbBuU]{0,2}"(?:[^"\\\n]|\\.)*"/g, "§");
    const ci = bare0.indexOf("#");
    const bare = ci >= 0 ? bare0.slice(0, ci) : bare0;
    const m = bare.match(/^(\s*)/);
    const src = AI_pyStripComment(raw);
    return {
      raw: String(raw),
      code: bare,
      src,
      srcText: src.trim(),
      num: i + 1,
      indent: (m ? m[1] : "").replace(/\t/g, "    ").length,
      text: bare.trim(),
    };
  });
}

// Statement-level assignment splitter: finds depth-0 `=` (ignores ==, !=,
// <=, >=, := and anything inside brackets/strings). Returns
// { lhsNames:[], aug:bool, lhsEnd, rhs } or null when the line is not an
// assignment (kwargs like key=len and defaults like exp=2 yield null).
function AI_pyAssignSplit(line) {
  const t = String(line || "");
  if (/^\s*(if|elif|while|return|assert|raise|del|yield|with|for)\b/.test(t)) return null;
  let depth = 0, q = null;
  const eqs = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === "\\") { i++; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); continue; }
    if (ch === "=" && depth === 0) {
      const prev = t[i - 1] || "", next = t[i + 1] || "";
      if (prev === "=" || prev === "!" || prev === "<" || prev === ">" || prev === ":" || next === "=") continue;
      eqs.push(i);
    }
  }
  if (!eqs.length) return null;
  const lastEq = eqs[eqs.length - 1];
  const lhsText = t.slice(0, lastEq);
  const aug = /[+\-*/%@|&^~]\s*$/.test(lhsText);
  const names = [];
  lhsText.split("=").forEach((seg) => {
    AI_pySplitTop(seg).forEach((part) => {
      const nm = part.replace(/[+\-*/%@|&^~]+$/, "").trim();
      if (/^[A-Za-z_]\w*$/.test(nm) && !names.includes(nm)) names.push(nm);
    });
  });
  return { lhsNames: names, aug, lhsEnd: lastEq, rhs: t.slice(lastEq + 1) };
}

// Lightweight shape check for Predict-Output code (balanced + closed strings).
function AI_codeShapeOK(code) {
  const live = AI_pyPrep(String(code || "")).filter((l) => l.text);
  let depth = 0;
  const stack = [];
  for (const l of live) {
    let quote = null;
    let escaped = false;
    for (let i = 0; i < l.code.length; i++) {
      const ch = l.code[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "#") break;
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") { stack.push(ch); depth++; }
      else if (ch === ")" || ch === "]" || ch === "}") {
        const expected = { ")": "(", "]": "[", "}": "{" }[ch];
        if (stack.pop() !== expected) return false;
        depth--;
      }
      if (depth < 0) return false;
    }
    if (quote) return false;
  }
  return depth === 0 && stack.length === 0;
}

function AI_detectPythonError(code) {
  const src = String(code || "");
  if (!src.trim()) return { error: null, detail: "empty", line: 0 };
  const L = AI_pyPrep(src);
  const live = L.filter((l) => l.text);
  if (!live.length) return { error: null, detail: "empty", line: 0 };
  const hit = (li, error, detail) => ({ error, detail: detail || error, line: live[li] ? live[li].num : 0 });

  /* ---------- pass 1: functions, classes, try-spans ---------- */
  const funcDefs = [];   // {name, params:[{n,req}], indent, start, end, hasIf, ownerClass, li}
  const classByName = {}; // name -> {name, indent, start, end, methods:{}, selfAssign:Set, selfReads:Set, li}
  const trySpans = [];    // {start, end, excepts:[]}
  let curFunc = null, curClass = null;

  live.forEach((l, li) => {
    if (curFunc && l.indent <= curFunc.indent) curFunc = null;
    if (curClass && l.indent <= curClass.indent) curClass = null;
    let m;
    if ((m = l.text.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/))) {
      const params = AI_pySplitTop(m[2]).map((p) => p.trim()).filter(Boolean).map((p) => {
        const eq = p.indexOf("=");
        return eq >= 0 ? { n: p.slice(0, eq).trim(), req: false } : { n: p.trim(), req: true };
      }).filter((p) => /^[A-Za-z_]\w*$/.test(p.n));
      curFunc = { name: m[1], params, indent: l.indent, start: li, end: li, hasIf: false, ownerClass: curClass ? curClass.name : null, li, globalNames: new Set() };
      funcDefs.push(curFunc);
      if (curClass) curClass.methods[m[1]] = curFunc;
      return;
    }
    if ((m = l.text.match(/^class\s+([A-Za-z_]\w*)/))) {
      curClass = { name: m[1], indent: l.indent, start: li, end: li, methods: {}, selfAssign: new Set(), selfReads: new Set(), li };
      classByName[m[1]] = curClass;
      return;
    }
    if (curFunc) { curFunc.end = li; if (/^if\b/.test(l.text)) curFunc.hasIf = true; }
    if (curClass) curClass.end = li;
    if (curFunc && curFunc.ownerClass && curClass && curClass.name === curFunc.ownerClass) {
      let sm;
      const reA = /self\.([A-Za-z_]\w*)\s*(?:\+|\-|\*|\/|%|\/\/|\*\*)?=(?!=)/g;
      while ((sm = reA.exec(l.code))) curClass.selfAssign.add(sm[1]);
      const reR = /self\.([A-Za-z_]\w*)/g;
      while ((sm = reR.exec(l.code))) curClass.selfReads.add(sm[1]);
    }
    if ((m = l.text.match(/^global\s+(.+)$/)) && curFunc) {
      m[1].split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z_]\w*$/.test(x)).forEach((x) => curFunc.globalNames.add(x));
    }
    if ((m = l.text.match(/^nonlocal\s+(.+)$/)) && curFunc) {
      m[1].split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z_]\w*$/.test(x)).forEach((x) => curFunc.globalNames.add(x));
    }
    if (/^try\s*:/.test(l.text)) {
      const span = { start: li + 1, end: li, excepts: [] };
      for (let j = li + 1; j < live.length; j++) {
        const lj = live[j];
        if (lj.indent < l.indent) break;
        if (lj.indent === l.indent) {
          const em = lj.text.match(/^except\b\s*(?:\(([^)]*)\)|([^:]*))?:/);
          if (em) {
            const names = (em[1] || em[2] || "").trim();
            if (!names) span.excepts.push("*");
            else names.split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean).forEach((x) => span.excepts.push(x));
            continue;
          }
          break;
        }
        span.end = j;
      }
      trySpans.push(span);
    }
  });

  const AI_guarded = (li, errName) => {
    for (const s of trySpans) {
      if (li >= s.start && li <= s.end) {
        if (s.excepts.includes("*") || s.excepts.includes("Exception") || s.excepts.includes("BaseException") || s.excepts.includes(errName)) return true;
      }
    }
    return false;
  };

  /* ---------- rule A: block keyword missing its colon (before indent!) ---------- */
  for (let li = 0; li < live.length; li++) {
    const l = live[li];
    if (/^(if|elif|for|while|def|class|with)\b/.test(l.text) && !/:\s*$/.test(l.text)) {
      const kw = l.text.split(/[\s(:]/)[0];
      return hit(li, "SyntaxError", "missing ':' at end of '" + kw + "' line");
    }
    if (/^(else|try|finally)\b/.test(l.text) && !/:\s*$/.test(l.text))
      return hit(li, "SyntaxError", "missing ':'");
    if (/^except\b/.test(l.text) && !/:\s*$/.test(l.text))
      return hit(li, "SyntaxError", "missing ':' after except");
  }

  /* ---------- rule B: more syntax slips ---------- */
  for (let li = 0; li < live.length; li++) {
    const l = live[li];
    if (/^(if|elif|while)\b/.test(l.text) && /[^=!<>]=\s*[^=]/.test(l.text))
      return hit(li, "SyntaxError", "'=' used instead of '==' in condition");
    if (/^print\s+\S/.test(l.text) && !/^print\s*\(/.test(l.text))
      return hit(li, "SyntaxError", "print needs parentheses in Python 3");
    if (/^(return|break|continue)\b/.test(l.text) && l.indent === 0)
      return hit(li, "SyntaxError", "'" + l.text.split(/[\s(:]/)[0] + "' outside function/loop");
    if (/^yield\b/.test(l.text) && l.indent === 0)
      return hit(li, "SyntaxError", "'yield' outside function");
    if (/\bawait\b/.test(l.text) && !funcDefs.some((f) => f.li <= li && li <= f.end && /^\s*async\s+def\b/.test(live[f.li].text)))
      return hit(li, "SyntaxError", "'await' outside async function");
    if (/^nonlocal\b/.test(l.text) && l.indent === 0)
      return hit(li, "SyntaxError", "'nonlocal' outside function");
  }

  /* ---------- rule C: indentation ---------- */
  const depthAfter = [];
  let _depth = 0;
  live.forEach((l, li) => {
    for (const ch of l.code) {
      if (ch === "(" || ch === "[" || ch === "{") _depth++;
      else if (ch === ")" || ch === "]" || ch === "}") _depth = Math.max(0, _depth - 1);
    }
    depthAfter[li] = _depth;
  });
  const BLOCK_START = /^(for|while|if|elif|else|def|class|try|except\b.*|finally|with)\b.*:\s*$/;
  for (let li = 0; li < live.length; li++) {
    const l = live[li];
    if (BLOCK_START.test(l.text)) {
      const nx = live[li + 1];
      if (!nx) return hit(li, "IndentationError", "expected an indented block after '" + l.text + "'");
      if (nx.indent <= l.indent) return hit(li + 1, "IndentationError", "expected an indented block after '" + l.text + "'");
      continue;
    }
    if (li > 0 && l.indent > live[li - 1].indent && depthAfter[li - 1] === 0 && !/:\s*$/.test(live[li - 1].text))
      return hit(li, "IndentationError", "unexpected indent");
  }

  /* ---------- rule D: unbalanced brackets / unclosed quotes ---------- */
  if (depthAfter[live.length - 1] !== 0)
    return hit(live.length - 1, "SyntaxError", "unbalanced brackets/parentheses");
  for (let li = 0; li < live.length; li++) {
    if (/['"]/.test(live[li].code))
      return hit(li, "SyntaxError", "unclosed string quote");
  }

  /* ---------- rule E: unknown imports ---------- */
  for (let li = 0; li < live.length; li++) {
    const l = live[li];
    let m;
    if ((m = l.text.match(/^import\s+(.+)$/))) {
      const mods = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim().split(".")[0]);
      for (const mod of mods) {
        if (mod && !AI_PY_STDLIB.has(mod) && !AI_guarded(li, "ModuleNotFoundError"))
          return hit(li, "ModuleNotFoundError", "no module named '" + mod + "'");
      }
    } else if ((m = l.text.match(/^from\s+([A-Za-z_]\w*)/))) {
      if (!AI_PY_STDLIB.has(m[1]) && !AI_guarded(li, "ModuleNotFoundError"))
        return hit(li, "ModuleNotFoundError", "no module named '" + m[1] + "'");
    }
  }

  /* ---------- pass 1b: definition sites (order-aware) + owners ---------- */
  const ownerOf = new Array(live.length).fill(null);
  funcDefs.forEach((f) => { for (let j = f.start + 1; j <= f.end; j++) ownerOf[j] = f; });
  const modDefs = {};   // name -> {li, sameOk}
  const lineExempt = live.map(() => new Set());
  funcDefs.forEach((f) => {
    f.localDefs = {};
    f.params.forEach((p) => { f.localDefs[p.n] = f.start; });
  });
  const addMod = (n, li, sameOk) => {
    if (!/^[A-Za-z_]\w*$/.test(n) || AI_PY_KEYWORDS.has(n)) return;
    if (!(n in modDefs)) modDefs[n] = { li, sameOk: !!sameOk };
  };
  const addLocal = (f, n, li) => {
    if (!/^[A-Za-z_]\w*$/.test(n) || AI_PY_KEYWORDS.has(n)) return;
    if (!(n in f.localDefs)) f.localDefs[n] = li;
  };

  live.forEach((l, li) => {
    const F = ownerOf[li];
    const add = (n, sameOk) => { if (F) addLocal(F, n, li); else addMod(n, li, sameOk); };
    let m;
    // def / class names + params
    if ((m = l.text.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/))) {
      if (!F) addMod(m[1], li, true); else addLocal(F, m[1], li);
      lineExempt[li].add(m[1]);
      const f = funcDefs.find((x) => x.li === li);
      if (f) f.params.forEach((p) => lineExempt[li].add(p.n));
      return;
    }
    if ((m = l.text.match(/^class\s+([A-Za-z_]\w*)/))) {
      if (!F) addMod(m[1], li, true); else addLocal(F, m[1], li);
      lineExempt[li].add(m[1]);
      return;
    }
    // imports define names usable on the same line
    if ((m = l.text.match(/^import\s+(.+)$/))) {
      m[1].split(",").forEach((part) => {
        const bits = part.trim().split(/\s+as\s+/);
        const nm = (bits[1] || bits[0]).trim().split(".")[0];
        add(nm, true); lineExempt[li].add(nm);
        l.text.match(/[A-Za-z_]\w*/g).forEach((t) => lineExempt[li].add(t));
      });
      return;
    }
    if ((m = l.text.match(/^from\s+[A-Za-z_]\w*\s+import\s+(.+)$/))) {
      if (m[1].trim() !== "*") {
        m[1].split(",").forEach((part) => {
          const bits = part.trim().split(/\s+as\s+/);
          const nm = (bits[1] || bits[0]).trim();
          add(nm, true); lineExempt[li].add(nm);
        });
      }
      l.text.match(/[A-Za-z_]\w*/g).forEach((t) => lineExempt[li].add(t));
      return;
    }
    // for-targets (usable on the same line: comprehensions!)
    if ((m = l.text.match(/\bfor\s+([^;]*?)\s+in\b/))) {
      AI_pySplitTop(m[1]).forEach((t) => {
        const nm = t.trim();
        if (/^[A-Za-z_]\w*$/.test(nm)) { add(nm, true); lineExempt[li].add(nm); }
      });
    }
    // except ... as e / with ... as f
    if ((m = l.text.match(/\bas\s+([A-Za-z_]\w*)\s*:/))) { add(m[1], true); lineExempt[li].add(m[1]); }
    if ((m = l.text.match(/^with\b.*\bas\s+([A-Za-z_]\w*)\s*:/))) { add(m[1], true); lineExempt[li].add(m[1]); }
    // lambda params
    if ((m = l.text.match(/\blambda\b([^:]*):/))) {
      AI_pySplitTop(m[1]).forEach((p) => {
        const nm = p.trim().split("=")[0].trim();
        if (/^[A-Za-z_]\w*$/.test(nm)) { add(nm, true); lineExempt[li].add(nm); }
      });
    }
    // plain assignments: LHS usable only on LATER lines (RHS resolves to earlier defs)
    const sp = AI_pyAssignSplit(l.code);
    if (sp) sp.lhsNames.forEach((nm) => add(nm, false));
  });

  // identifier uses on a line (skips keywords, builtins, attributes, kwargs/LHS)
  const usesOn = (li) => {
    const l = live[li];
    const sp = AI_pyAssignSplit(l.code);
    const out = [];
    const re = /[A-Za-z_]\w*/g;
    let m;
    while ((m = re.exec(l.code))) {
      const nm = m[0];
      const at = m.index;
      if (AI_PY_KEYWORDS.has(nm) || AI_PY_BUILTINS.has(nm)) continue;
      if (at > 0 && l.code[at - 1] === ".") continue;
      if (lineExempt[li].has(nm)) continue;
      if (sp && !sp.aug && at + nm.length <= sp.lhsEnd) continue; // LHS of plain `=`
      const rest = l.code.slice(at + nm.length).match(/^\s*(.)(.)?/);
      if (rest && rest[1] === "=" && rest[2] !== "=") continue; // kwarg / default / LHS
      out.push(nm);
    }
    return out;
  };

  /* ---------- rule F: NameError (order-aware) ---------- */
  for (let li = 0; li < live.length; li++) {
    const F = ownerOf[li];
    for (const nm of usesOn(li)) {
      let ok;
      if (F) {
        ok = (nm in F.localDefs) || (nm in modDefs);
      } else {
        const d = modDefs[nm];
        ok = !!d && (d.li < li || (d.li === li && d.sameOk));
      }
      if (!ok && !AI_guarded(li, "NameError"))
        return hit(li, "NameError", "name '" + nm + "' is not defined");
    }
  }

  /* ---------- rule G: UnboundLocalError (use before local def) ---------- */
  for (const F of funcDefs) {
    for (let li = F.start + 1; li <= F.end; li++) {
      for (const nm of usesOn(li)) {
        if (F.globalNames.has(nm)) continue;
        if (F.params.some((p) => p.n === nm)) continue;
        const defLi = F.localDefs[nm];
        if (defLi !== undefined && defLi >= li && !AI_guarded(li, "UnboundLocalError"))
          return hit(li, "UnboundLocalError", "local variable '" + nm + "' referenced before assignment");
      }
    }
  }

  /* ---------- rule H: `x = x` self-assignment (missing self -> AttributeError) ---------- */
  for (let li = 0; li < live.length; li++) {
    if (/^([A-Za-z_]\w*)\s*=\s*\1\s*$/.test(live[li].text) && !AI_guarded(li, "AttributeError"))
      return hit(li, "AttributeError", "object has no attribute (missing 'self' in assignment)");
  }

  /* ---------- rule I: methods that exist nowhere / on the wrong type ---------- */
  const reBad = new RegExp("\\.(" + AI_PY_BAD_METHODS.join("|") + ")\\s*\\(");
  for (let li = 0; li < live.length; li++) {
    const mBad = live[li].code.match(reBad);
    if (mBad && !AI_guarded(li, "AttributeError"))
      return hit(li, "AttributeError", "no method '" + mBad[1] + "'");
  }

  /* ---------- pass 1c: incremental type map + per-line value rules ---------- */
  const T = {};        // name -> {t, v, n, keys, count, quoted, unquoted, empty}
  const appended = new Set();
  const genRange = {}; // genvar -> N
  const nextCount = {}; // genvar -> next() calls
  const fullBare = live.map((l) => l.code).join("\n");

  const typeOfRHS = (rhs) => {
    const r = String(rhs || "").trim();
    let m;
    if ((m = r.match(/^(['"])(.*)\1$/s))) {
      const inner = m[2];
      if (/['"]/.test(inner)) return { t: "unknown" };
      return { t: "str", v: inner };
    }
    if (/^-?\d+$/.test(r)) return { t: "num", v: Number(r), zero: Number(r) === 0 };
    if (/^-?\d*\.\d+$/.test(r)) return { t: "num", v: Number(r) };
    if (/^None$/.test(r)) return { t: "none" };
    if (/^(True|False)$/.test(r)) return { t: "bool" };
    if (/^\(.*\)$/s.test(r) && AI_pySplitTop(r.slice(1, -1)).length > 1) return { t: "tuple" };
    if ((m = r.match(/^\[(.*)\]$/s))) {
      const items = AI_pySplitTop(m[1]).map((x) => x.trim()).filter((x) => x);
      return {
        t: "list", empty: items.length === 0, count: items.length,
        quoted: items.some((x) => /^['"]/.test(x)), unquoted: items.some((x) => !/^['"]/.test(x)),
      };
    }
    if ((m = r.match(/^\{(.*)\}$/s))) {
      const inner = m[1].trim();
      if (!inner) return { t: "dict", keys: [], empty: true };
      const items = AI_pySplitTop(inner);
      const hasColon = items.some((x) => {
        let d = 0, q = null;
        for (const ch of x) {
          if (q) { if (ch === q) q = null; continue; }
          if (ch === "'" || ch === '"') { q = ch; continue; }
          if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) d--;
          else if (ch === ":" && d === 0) return true;
        }
        return false;
      });
      if (!hasColon) return { t: "set", empty: false };
      const keys = [];
      items.forEach((x) => {
        let d = 0, q = null, cut = -1;
        for (let i = 0; i < x.length; i++) {
          const ch = x[i];
          if (q) { if (ch === q) q = null; continue; }
          if (ch === "'" || ch === '"') { q = ch; continue; }
          if ("([{".includes(ch)) d++; else if (")]}".includes(ch)) d--;
          else if (ch === ":" && d === 0) { cut = i; break; }
        }
        if (cut > 0) keys.push(x.slice(0, cut).trim().replace(/^(['"])(.*)\1$/, "$2"));
      });
      return { t: "dict", keys, empty: false };
    }
    if (/^list\s*\(/.test(r) || /^sorted\s*\(/.test(r)) return { t: "list", empty: false };
    if (/^dict\s*\(/.test(r)) return { t: "dict", keys: [], empty: false };
    if (/^set\s*\(/.test(r)) return { t: "set", empty: false };
    if (/^tuple\s*\(/.test(r)) return { t: "tuple" };
    if (/^str\s*\(/.test(r)) return { t: "str", v: "" };
    if (/^(int|float)\s*\(/.test(r)) return { t: "num" };
    if (/^range\s*\(/.test(r)) return { t: "range" };
    if (/^open\s*\(/.test(r)) return { t: "file" };
    if (/^\(.*\bfor\b.*\bin\b.*\)$/s.test(r)) return { t: "gen" };
    if ((m = r.match(/^([A-Za-z_]\w*)\s*\(/))) {
      if (classByName[m[1]]) return { t: "instance" };
      return { t: "unknown" };
    }
    if ((m = r.match(/^([A-Za-z_]\w*)$/))) return T[m[1]] ? { ...T[m[1]] } : { t: "unknown" };
    return { t: "unknown" };
  };

  // collect generator ranges + next() counts (StopIteration)
  live.forEach((l) => {
    const gm = l.code.match(/([A-Za-z_]\w*)\s*=\s*\([^()]*\bfor\s+\w+\s+in\s+\brange\s*\(\s*(\d+)\s*\)[^()]*\)/);
    if (gm) genRange[gm[1]] = Number(gm[2]);
  });
  Object.keys(genRange).forEach((g) => {
    const re = new RegExp("\\bnext\\s*\\(\\s*" + g + "\\s*\\)", "g");
    nextCount[g] = (fullBare.match(re) || []).length;
  });

  const recentLoop = (li, varName) => {
    for (let j = li - 1; j >= 0; j--) {
      const m = live[j].code.match(/\bfor\s+([A-Za-z_]\w*)\s+in\s+\brange\s*\(\s*(\d+)\s*\)/);
      if (m && m[1] === varName) return { N: Number(m[2]), li: j };
      if (live[j].indent === 0 && /^(def|class)\b/.test(live[j].text)) break;
    }
    return null;
  };

  for (let li = 0; li < live.length; li++) {
    const l = live[li];
    const srcT = l.srcText;

    // seed defs/classes into the type map
    let dm;
    if ((dm = l.text.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/))) T[dm[1]] = { t: "func" };
    if ((dm = l.text.match(/^class\s+([A-Za-z_]\w*)/))) T[dm[1]] = { t: "class" };
    if ((dm = l.text.match(/^import\s+(.+)$/))) {
      dm[1].split(",").forEach((part) => {
        const bits = part.trim().split(/\s+as\s+/);
        T[(bits[1] || bits[0]).trim().split(".")[0]] = { t: "module" };
      });
    }
    // track .append (list no longer empty)
    let am;
    const reApp = /([A-Za-z_]\w*)\.append\s*\(/g;
    while ((am = reApp.exec(l.code))) appended.add(am[1]);

    // update types for assignments (never let an unknown RHS wipe a known type)
    const spT = AI_pyAssignSplit(l.src);
    if (spT && !spT.aug) {
      spT.lhsNames.forEach((nm) => {
        const nt = typeOfRHS(spT.rhs);
        if (nt.t !== "unknown" || !(nm in T)) T[nm] = nt;
      });
    }
    // for-targets are unknown-typed but defined
    const fm = l.text.match(/\bfor\s+([^;]*?)\s+in\b/);
    if (fm) AI_pySplitTop(fm[1]).forEach((t) => { const nm = t.trim(); if (/^[A-Za-z_]\w*$/.test(nm) && !T[nm]) T[nm] = { t: "unknown" }; });

    const G = (err) => AI_guarded(li, err);

    // J-a: item assignment on tuple / str
    let mAssign = l.code.match(/^([A-Za-z_]\w*)\s*\[.*\]\s*=(?!=)/);
    if (mAssign && T[mAssign[1]]) {
      const tt = T[mAssign[1]].t;
      if (tt === "tuple" && !G("TypeError")) return hit(li, "TypeError", "tuple does not support item assignment");
      if (tt === "str" && !G("TypeError")) return hit(li, "TypeError", "string does not support item assignment");
    }
    // J-b: string + number
    let mPlus = l.code.match(/§\s*\+\s*([A-Za-z_]\w*|\d[\d.]*)/);
    if (mPlus) {
      const tok = mPlus[1];
      if (/^\d/.test(tok)) { if (!G("TypeError")) return hit(li, "TypeError", "cannot concatenate 'str' and number"); }
      else if (T[tok] && T[tok].t === "num" && !G("TypeError")) return hit(li, "TypeError", "cannot concatenate 'str' and 'int'");
    }
    let mPlusR = l.code.match(/([A-Za-z_]\w*|\d[\d.]*)\s*\+\s*§/);
    if (mPlusR) {
      const tok = mPlusR[1];
      if (/^\d/.test(tok)) { if (!G("TypeError")) return hit(li, "TypeError", "cannot add number and 'str'"); }
      else if (T[tok] && T[tok].t === "num" && !G("TypeError")) return hit(li, "TypeError", "cannot add 'int' and 'str'");
    }
    // J-b2: string * string
    if (/§\s*\*\s*§/.test(l.code) && !G("TypeError"))
      return hit(li, "TypeError", "can't multiply 'str' by 'str'");
    // J-c: range() with bad arg
    if (/\brange\s*\(\s*['"]/.test(l.code) && !G("TypeError"))
      return hit(li, "TypeError", "range() wants an integer, not text");
    if (/\brange\s*\(\s*\d+\.\d/.test(l.code) && !G("TypeError"))
      return hit(li, "TypeError", "range() wants an integer, not float");
    let mRange = l.code.match(/\brange\s*\(\s*([A-Za-z_]\w*)\s*[,)]/);
    if (mRange && T[mRange[1]] && T[mRange[1]].t === "str" && !G("TypeError"))
      return hit(li, "TypeError", "range() wants an integer, not text");
    // J-d: len() of a number
    if (/\blen\s*\(\s*-?\d/.test(l.code) && !G("TypeError"))
      return hit(li, "TypeError", "len() of a number");
    let mLen = l.code.match(/\blen\s*\(\s*([A-Za-z_]\w*)\s*\)/);
    if (mLen && T[mLen[1]] && T[mLen[1]].t === "num" && !G("TypeError"))
      return hit(li, "TypeError", "len() of a number");
    // J-e: for-loop directly over a number
    if (/\bfor\s+\w+\s+in\s+-?\d/.test(l.code) && !G("TypeError"))
      return hit(li, "TypeError", "looping over a number (not iterable)");
    // J-f: unhashable list added to a set
    if (/\.add\s*\(\s*\[/.test(l.code) && !G("TypeError"))
      return hit(li, "TypeError", "unhashable type: 'list'");
    // J-g: sorting a mixed-type list
    let mSort = l.code.match(/([A-Za-z_]\w*)\.sort\s*\(/);
    if (mSort && T[mSort[1]] && T[mSort[1]].t === "list" && T[mSort[1]].quoted && T[mSort[1]].unquoted && !G("TypeError"))
      return hit(li, "TypeError", "sorting mixed text + numbers");
    let mSorted = l.code.match(/sorted\s*\(\s*([A-Za-z_]\w*)\s*[,)]/);
    if (mSorted && T[mSorted[1]] && T[mSorted[1]].t === "list" && T[mSorted[1]].quoted && T[mSorted[1]].unquoted && !G("TypeError"))
      return hit(li, "TypeError", "sorting mixed text + numbers");
    // J-h: indexing a set
    const reSub = /([A-Za-z_]\w*)\s*\[/g;
    let mSub;
    while ((mSub = reSub.exec(l.code))) {
      if (T[mSub[1]] && T[mSub[1]].t === "set" && !G("TypeError"))
        return hit(li, "TypeError", "'set' object is not subscriptable");
    }
    // J-i: int()/float() of letters
    let mIntLit = srcT.match(/\b(int|float)\s*\(\s*(['"])([^'"]*)\2/);
    if (mIntLit && /[a-zA-Z]/.test(mIntLit[3]) && !G("ValueError"))
      return hit(li, "ValueError", "invalid literal for " + mIntLit[1] + "()");
    let mIntVar = l.code.match(/\b(int|float)\s*\(\s*([A-Za-z_]\w*)\s*\)/);
    if (mIntVar && T[mIntVar[2]] && T[mIntVar[2]].t === "str" && /[a-zA-Z]/.test(T[mIntVar[2]].v || "") && !G("ValueError"))
      return hit(li, "ValueError", "invalid literal for " + mIntVar[1] + "()");
    // J-j: unpack count mismatch
    let mUnpack = l.code.match(/^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*=\s*(\(|\[)/);
    if (mUnpack) {
      const names = AI_pySplitTop(mUnpack[1]).length;
      const rhsB = l.code.slice(l.code.indexOf(mUnpack[2]));
      const inner = rhsB.slice(1, rhsB.lastIndexOf(mUnpack[2] === "(" ? ")" : "]"));
      const vals = AI_pySplitTop(inner).filter((x) => x.trim()).length;
      if (vals !== names && !G("ValueError"))
        return hit(li, "ValueError", "too many values to unpack");
    }
    // J-k: range(len(x) + 1)
    if (/\brange\s*\(\s*len\s*\([^)]*\)\s*\+\s*1\s*\)/.test(l.code) && !G("IndexError"))
      return hit(li, "IndexError", "loop runs one step past the list");
    // J-l: [len(x)] subscript
    if (/\[\s*len\s*\(/.test(l.code) && !G("IndexError"))
      return hit(li, "IndexError", "index len(list) does not exist");
    // J-m: pop() from an empty list
    let mPop = l.code.match(/([A-Za-z_]\w*)\.pop\s*\(/);
    if (mPop && T[mPop[1]] && T[mPop[1]].t === "list" && T[mPop[1]].empty && !appended.has(mPop[1]) && !G("IndexError"))
      return hit(li, "IndexError", "pop from empty list");
    // J-n: division / modulo by zero
    if (/(\/\/|\/|%)\s*0(?![\d.])/.test(l.code) && !G("ZeroDivisionError"))
      return hit(li, "ZeroDivisionError", "division by zero");
    let mDivVar = l.code.match(/(\/\/|\/|%)\s*([A-Za-z_]\w*)\b/);
    if (mDivVar && T[mDivVar[2]] && T[mDivVar[2]].zero && !G("ZeroDivisionError"))
      return hit(li, "ZeroDivisionError", "division by zero");
    let mLenDiv = l.code.match(/\/\s*len\s*\(\s*([A-Za-z_]\w*)\s*\)/);
    if (mLenDiv && T[mLenDiv[1]] && T[mLenDiv[1]].t === "list" && T[mLenDiv[1]].empty && !appended.has(mLenDiv[1]) && !G("ZeroDivisionError"))
      return hit(li, "ZeroDivisionError", "dividing by len() of an empty list");
    // J-o: string index out of range
    const reSO = /([A-Za-z_]\w*)\s*\[(-?\d+)\]/g;
    let mSO;
    while ((mSO = reSO.exec(l.code))) {
      const info = T[mSO[1]];
      if (info && info.t === "str" && typeof info.v === "string" && info.v) {
        const idx = Number(mSO[2]);
        if ((idx >= 0 && idx >= info.v.length) || (idx < 0 && -idx > info.v.length)) {
          if (!G("IndexError")) return hit(li, "IndexError", "string index out of range");
        }
      }
    }
    // J-p: dict key missing (literal key reads + single-arg pop)
    const reDK = /([A-Za-z_]\w*)\s*\[\s*(['"])([^'"]*)\2\s*\]/g;
    let mDK;
    while ((mDK = reDK.exec(srcT))) {
      const info = T[mDK[1]];
      if (info && info.t === "dict" && info.keys && !info.keys.includes(mDK[3]) && !G("KeyError"))
        return hit(li, "KeyError", "key '" + mDK[3] + "' not found");
    }
    let mDPop = srcT.match(/([A-Za-z_]\w*)\.pop\s*\(\s*(['"])([^'"]*)\2(\s*,)?\s*\)/);
    if (mDPop && !mDPop[4] && T[mDPop[1]] && T[mDPop[1]].t === "dict" && T[mDPop[1]].keys && !T[mDPop[1]].keys.includes(mDPop[3]) && !G("KeyError"))
      return hit(li, "KeyError", "key '" + mDPop[3] + "' not found");
    // J-q: open() a file that cannot exist here + exit()/quit()
    if (/\bopen\s*\(\s*(['"])[^'"]*\1\s*\)/.test(srcT) && !G("FileNotFoundError"))
      return hit(li, "FileNotFoundError", "file does not exist");
    if (/^(exit|quit)\s*\(/.test(l.text) && !G("SystemExit"))
      return hit(li, "SystemExit", "exit() called");
    // J-r: assert that is provably false
    let mAssert = l.code.match(/^assert\s+(.+)$/);
    if (mAssert) {
      const cond0 = AI_pySplitTop(mAssert[1])[0].trim();
      if (/^(False|None|0|0\.0|§|\[\]|\{\})\s*$/.test(cond0)) {
        if (!G("AssertionError")) return hit(li, "AssertionError", "assertion failed");
      } else {
        let cond = cond0;
        Object.keys(T).forEach((nm) => {
          if (T[nm] && T[nm].t === "num" && typeof T[nm].v === "number")
            cond = cond.replace(new RegExp("\\b" + nm + "\\b", "g"), String(T[nm].v));
        });
        const cm = cond.match(/^(-?\d+(?:\.\d+)?)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
        if (cm) {
          const a = Number(cm[1]), b = Number(cm[3]);
          const okCmp = cm[2] === "==" ? a === b : cm[2] === "!=" ? a !== b : cm[2] === ">=" ? a >= b : cm[2] === "<=" ? a <= b : cm[2] === ">" ? a > b : a < b;
          if (!okCmp && !G("AssertionError")) return hit(li, "AssertionError", "assertion failed");
        }
      }
    }
    // J-s: explicit raise
    let mRaise = l.code.match(/^\s*raise\s+([A-Za-z_]\w*)/);
    if (mRaise) {
      const nm = /^[A-Z]\w*$/.test(mRaise[1]) ? mRaise[1] : "Exception";
      if (!G(nm)) return hit(li, nm, "raised by the code");
    }
    // J-s2: method that only exists on other types (caller type known)
    const reM = /([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
    let mM;
    while ((mM = reM.exec(l.code))) {
      const owners = AI_PY_METHOD_OWNERS[mM[2]];
      const cinfo = T[mM[1]];
      if (owners && cinfo && ["str", "list", "dict", "set", "file"].includes(cinfo.t) && !owners.includes(cinfo.t) && !G("AttributeError"))
        return hit(li, "AttributeError", "'" + cinfo.t + "' has no method '" + mM[2] + "'");
    }
    // J-t: calling a variable that holds plain data
    if (!/^\s*(def|class|import|from)\b/.test(l.text)) {
      const reC = /([A-Za-z_]\w*)\s*\(/g;
      let mC;
      while ((mC = reC.exec(l.code))) {
        if (mC.index > 0 && l.code[mC.index - 1] === ".") continue;
        const info = T[mC[1]];
        if (info && ["num", "str", "list", "dict", "set", "tuple", "none", "bool"].includes(info.t) && !G("TypeError"))
          return hit(li, "TypeError", "'" + info.t + "' object is not callable");
      }
    }
    // J-u: literal subscript out of range ([1,2][5], 'abc'[9])
    let mLitL = l.code.match(/\[([^\[\]]*)\]\s*\[(-?\d+)\]/);
    if (mLitL) {
      const n = AI_pySplitTop(mLitL[1]).filter((x) => x.trim()).length;
      const idx = Number(mLitL[2]);
      if ((idx >= 0 && idx >= n) || (idx < 0 && -idx > n)) {
        if (!G("IndexError")) return hit(li, "IndexError", "list index out of range");
      }
    }
    let mLitS = srcT.match(/(['"])([^'"]*)\1\s*\[(-?\d+)\]/);
    if (mLitS) {
      const idx = Number(mLitS[3]);
      if ((idx >= 0 && idx >= mLitS[2].length) || (idx < 0 && -idx > mLitS[2].length)) {
        if (!G("IndexError")) return hit(li, "IndexError", "string index out of range");
      }
    }
    // J-v: loop range longer than a literal list it indexes
    const reLoopSub = /([A-Za-z_]\w*)\s*\[\s*([A-Za-z_]\w*)\s*\]/g;
    let mLS;
    while ((mLS = reLoopSub.exec(l.code))) {
      const arr = T[mLS[1]];
      if (arr && arr.t === "list" && typeof arr.count === "number") {
        const loop = recentLoop(li, mLS[2]);
        if (loop && loop.N > arr.count && !G("IndexError"))
          return hit(li, "IndexError", "loop runs past the end of the list");
      }
    }
  }

  /* ---------- rule V: wrong number of arguments ---------- */
  const findFunc = (name) => funcDefs.find((f) => f.name === name && !f.ownerClass);
  const findMethod = (name) => {
    for (const cn of Object.keys(classByName)) {
      if (classByName[cn].methods[name]) return classByName[cn].methods[name];
    }
    return null;
  };
  for (let li = 0; li < live.length; li++) {
    const l = live[li];
    if (/^\s*(def|class|import|from)\b/.test(l.text)) continue;
    const reCall = /([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(([^()]*)\)/g;
    let mc;
    while ((mc = reCall.exec(l.code))) {
      const args = AI_pySplitTop(mc[3]).map((x) => x.trim()).filter((x) => x);
      if (mc[2]) {
        // dotted call: caller.method(args)
        const caller = mc[1], mname = mc[2];
        if (classByName[caller]) {
          const M = classByName[caller].methods[mname];
          if (M && M.params.length && M.params[0].n === "self" && args.length < M.params.length && !AI_guarded(li, "TypeError"))
            return hit(li, "TypeError", "method called on the class without an instance");
        } else {
          const M = findMethod(mname);
          if (M && M.params.length && M.params[0].n === "self") {
            const need = M.params.length - 1;
            if ((args.length < need || args.length > need) && !AI_guarded(li, "TypeError"))
              return hit(li, "TypeError", "wrong number of arguments for '" + mname + "'");
          }
        }
      } else {
        const fname = mc[1];
        if (classByName[fname]) {
          const init = classByName[fname].methods.__init__;
          if (!init) {
            if (args.length > 0 && !AI_guarded(li, "TypeError"))
              return hit(li, "TypeError", "wrong number of arguments");
          } else {
            const req = init.params.filter((p) => p.req).length - (init.params[0] && init.params[0].n === "self" ? 1 : 0);
            const tot = init.params.length - (init.params[0] && init.params[0].n === "self" ? 1 : 0);
            if ((args.length < req || args.length > tot) && !AI_guarded(li, "TypeError"))
              return hit(li, "TypeError", "wrong number of arguments");
          }
        } else {
          const F = findFunc(fname);
          if (F) {
            const req = F.params.filter((p) => p.req).length;
            const tot = F.params.length;
            if ((args.length < req || args.length > tot) && !AI_guarded(li, "TypeError"))
              return hit(li, "TypeError", "wrong number of arguments for '" + fname + "'");
          }
        }
      }
    }
  }

  /* ---------- rule W: runaway recursion ---------- */
  for (const F of funcDefs) {
    const body = live.slice(F.start + 1, F.end + 1);
    const reSelf = new RegExp("\\b" + F.name + "\\s*\\(");
    const callIdx = [];
    body.forEach((l, k) => { if (reSelf.test(l.code)) callIdx.push(F.start + 1 + k); });
    if (!callIdx.length) continue;
    if (!F.hasIf) {
      if (!AI_guarded(callIdx[0], "RecursionError"))
        return hit(callIdx[0], "RecursionError", "no base case — calls itself forever");
    } else {
      const joined = body.map((l) => l.text).join("; ");
      const baseM = joined.match(/\bif\s+([A-Za-z_]\w*)\s*(<=|<|==)\s*(\d+)/);
      if (baseM) {
        const reAway = new RegExp("\\b" + baseM[1] + "\\s*\\+");
        for (const ci of callIdx) {
          if (reAway.test(live[ci].code) && !AI_guarded(ci, "RecursionError"))
            return hit(ci, "RecursionError", "moves away from the base case");
        }
      }
    }
  }

  /* ---------- rule X: self.X read but never assigned ---------- */
  for (const cn of Object.keys(classByName)) {
    const C = classByName[cn];
    const missing = [...C.selfReads].filter((r) => !C.selfAssign.has(r));
    if (missing.length) {
      for (let li = C.start; li <= C.end; li++) {
        if (new RegExp("self\\." + missing[0] + "\\b").test(live[li].code)) {
          if (!AI_guarded(li, "AttributeError"))
            return hit(li, "AttributeError", "object has no attribute '" + missing[0] + "'");
          break;
        }
      }
    }
  }

  /* ---------- rule Y: next() past the end of a generator ---------- */
  for (const g of Object.keys(genRange)) {
    if ((nextCount[g] || 0) > genRange[g]) {
      for (let li = 0; li < live.length; li++) {
        if (new RegExp("\\bnext\\s*\\(\\s*" + g + "\\s*\\)").test(live[li].code)) {
          if (!AI_guarded(li, "StopIteration"))
            return hit(li, "StopIteration", "next() past the end");
          break;
        }
      }
    }
  }

  return { error: null, detail: "no error detected", line: 0 };
}

/* -------------------------------------------------------------------------
   Local code diagnostic lab — a private, deterministic second pair of eyes.
   It never sends code off-device and never executes untrusted code.
   ------------------------------------------------------------------------- */
function AI_diagnoseCode(code) {
  const src = String(code || "");
  const diagnostics = [];
  const add = (severity, message, line, detail) => diagnostics.push({ severity, message, line: line || 0, detail: detail || "" });
  if (!src.trim()) return { ok: false, diagnostics: [{ severity: "info", message: "Paste some Python code to inspect it.", line: 0 }] };

  try {
    const detected = AI_detectPythonError(src);
    if (detected.error) {
      add("error", `${detected.error}: ${detected.detail}`, detected.line, "This is the first likely runtime or syntax failure found by the local checker.");
    }
  } catch (e) {
    add("info", "The local Python checker could not read this snippet.", 0, String(e.message || e));
  }

  const lines = src.split(/\r?\n/);
  const literalLengths = {};
  const lineOf = (re) => {
    const index = lines.findIndex((line) => re.test(line));
    return index < 0 ? 0 : index + 1;
  };
  // These are high-signal mistakes that can still produce valid Python.
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const number = index + 1;
    if (!line || line.startsWith("#")) return;
    const literal = line.match(/^([A-Za-z_]\w*)\s*=\s*\[([^\]]*)\]/);
    if (literal) literalLengths[literal[1]] = literal[2].trim() ? literal[2].split(",").length : 0;
    if (/\b[A-Za-z_]\w*\s*=\s*[A-Za-z_]\w*\.sort\s*\(/.test(line)) {
      add("warning", "list.sort() changes the list and returns None.", number, "Use sorted(items) when you need a new list value.");
    }
    if (/\s*=\s*[^=].*\.(append|extend|insert|remove|reverse)\s*\(/.test(line)) {
      add("warning", "This list method mutates in place and returns None.", number, "Do the mutation on its own line, then use the list.");
    }
    const indexUse = line.match(/\b([A-Za-z_]\w*)\s*\[\s*(-?\d+)\s*\]/);
    if (indexUse && literalLengths[indexUse[1]] !== undefined) {
      const index = Number(indexUse[2]);
      const length = literalLengths[indexUse[1]];
      if (index >= length || index < -length) add("error", `Index ${index} is outside ${indexUse[1]} (length ${length}).`, number, "Valid indexes run from 0 to length - 1, or -1 backwards.");
    }
    if (/\bis\s+(None|True|False|[0-9]+|["'])/.test(line)) {
      add("warning", "Use == for value comparison here; is checks object identity.", number, "Keep is for None, True or False identity checks.");
    }
    if (/except\s*:\s*$/.test(line)) {
      add("tip", "Bare except catches every error, including unexpected system exits.", number, "Prefer a specific exception such as except ValueError:");
    }
    if (/\bfor\s+\w+\s+in\s+range\s*\(\s*1\s*,\s*len\s*\(/.test(line)) {
      add("tip", "Check the range start: beginning at 1 skips the first item.", number, "This may be intentional, but it is a common off-by-one mistake.");
    }
    if (/\bprint\s*\([^)]*\)\s*#?\s*$/.test(line) && /\bdebug\b/i.test(line)) {
      add("tip", "Debug print left in the snippet.", number, "Remove it or make the learner-facing output explicit.");
    }
  });

  // A balanced snippet is a useful, independent check even when the runtime
  // detector has no opinion about the code yet.
  try {
    if (!AI_codeShapeOK(src)) add("error", "Unbalanced brackets or an unclosed string.", lineOf(/[([{][^\n]*$/), "Check every (), [] and {} pair and close quoted strings.");
  } catch (e) {}

  // De-duplicate identical messages so the report stays calm and useful.
  const unique = [];
  const seen = new Set();
  diagnostics.forEach((item) => {
    const key = `${item.severity}|${item.message}|${item.line}`;
    if (!seen.has(key)) { seen.add(key); unique.push(item); }
  });
  return { ok: !unique.some((item) => item.severity === "error"), diagnostics: unique };
}

/* ============================================================
   5. VALIDATION + DUPLICATE GUARD
   ============================================================ */

function AI_normCode(s) {
  return String(s || "").toLowerCase().replace(/[""]/g, "'").replace(/\s+/g, " ").trim();
}

function AI_hash(str) {
  let h = 5381;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// Fingerprint over CODE + OUTPUT only (titles may legitimately repeat).
// Short snippets (<30 chars) are never treated as duplicates.
function AI_fingerprint(starterCode, expectedOutput) {
  const n = AI_normCode(starterCode) + "§" + AI_normCode(expectedOutput);
  if (n.length < 30) return null;
  return AI_hash(n);
}

// Validate a generated problem. `knownFps` = Set of existing fingerprints.
// Returns { ok, checks: [{label, pass}] }.
function AI_validateProblem(p, knownFps) {
  const checks = [];
  const has = (v) => String(v || "").trim().length > 0;

  checks.push({ label: "Title filled", pass: has(p.title) });
  checks.push({ label: "Description filled", pass: has(p.description) });
  checks.push({ label: "Code filled", pass: has(p.starter_code) });
  checks.push({ label: "Expected output filled", pass: has(p.expected_output) });

  const hints = Array.isArray(p.hints) ? p.hints.filter((h) => String(h || "").trim().length >= 8) : [];
  checks.push({ label: "Exactly 3 quality hints", pass: hints.length === 3 });
  checks.push({
    label: "Hints are distinct",
    pass: new Set(hints.map((h) => h.trim().toLowerCase())).size === hints.length,
  });
  checks.push({ label: "Valid type (bug/question)", pass: p.type === "bug" || p.type === "question" });
  checks.push({ label: "Valid topic", pass: AI_TOPICS.includes(p.topic) });
  checks.push({ label: "Valid difficulty", pass: ["easy", "medium", "hard"].includes(p.difficulty) });

  if (p.type === "bug") {
    checks.push({ label: "Fixed reference code present", pass: has(p.fixed_code) });
    checks.push({ label: "Buggy code differs from fixed code", pass: has(p.fixed_code) && p.starter_code.trim() !== p.fixed_code.trim() });
    // The buggy snippet MUST raise a real Python error when run (never a
    // silent wrong answer), and the fixed reference must run clean.
    let detErr = null;
    try { detErr = AI_detectPythonError(p.starter_code).error; } catch (e) { detErr = null; }
    checks.push({
      label: detErr ? `Raises ${detErr} when run (verified)` : "Raises a Python error when run",
      pass: !!detErr,
    });
    if (has(p.fixed_code)) {
      let detFix = "validator-crashed";
      try { detFix = AI_detectPythonError(p.fixed_code).error; } catch (e) { /* keep failed */ }
      checks.push({ label: "Fixed code runs clean (no error)", pass: !detFix });
    }
    if (p.marker) {
      checks.push({ label: `Bug verified in code (${p.bug || "bug"})`, pass: p.starter_code.includes(p.marker) });
      checks.push({ label: "Bug absent from fixed code", pass: !has(p.fixed_code) || !p.fixed_code.includes(p.marker) });
    }
  } else {
    checks.push({ label: "Output computed (proof attached)", pass: has(p.proof) });
    // Predict-Output code must produce the BEST exact output: no placeholders,
    // no stray markup, and structurally sound code (balanced + closed strings).
    const out = String(p.expected_output || "");
    checks.push({
      label: "Output is exact (no placeholders)",
      pass: out.trim().length > 0 && !/(\.\.\.|TODO|FIXME|\?\?\?|YOUR_|<[^>\s]+>)/.test(out),
    });
    let shapeOK = false;
    try { shapeOK = AI_codeShapeOK(p.starter_code); } catch (e) { shapeOK = false; }
    checks.push({ label: "Code shape OK (balanced, closed strings)", pass: shapeOK });
  }
  if (knownFps) {
    const fp = AI_fingerprint(p.starter_code, p.expected_output);
    checks.push({ label: "Not a duplicate", pass: !fp || !knownFps.has(fp) });
  }
  return { ok: checks.every((c) => c.pass), checks };
}

function AI_pickTemplate(mix, difficulty) {
  const m = mix || AI_getSettings().mix || "both";
  const d = difficulty || AI_getSettings().difficulty || "mixed";
  let pool = AI_TEMPLATES.filter((t) => (m === "both" ? true : t.type === m));
  if (!pool.length) pool = [...AI_TEMPLATES];
  if (d !== "mixed") {
    const sub = pool.filter((t) => t.difficulty === d);
    if (sub.length >= 2) pool = sub; // fall back to mixed if too few
  }
  return AI_pick(pool);
}

// Fetch all problems (paginated) — returns { rows, fps:Set, maxNum }.
async function AI_fetchProblemsIndex() {
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("problems")
      .select("id, title, starter_code, expected_output, problem_number, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    (data || []).forEach((r) => rows.push(r));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  const fps = new Set();
  let maxNum = 0;
  rows.forEach((r) => {
    const fp = AI_fingerprint(r.starter_code, r.expected_output);
    if (fp) fps.add(fp);
    const n = Number(r.problem_number) || 0;
    if (n > maxNum) maxNum = n;
  });
  return { rows, fps, maxNum };
}

/* ============================================================
   6. RUNNERS (called by watcher + AI page buttons)
   ============================================================ */

// --- 6a. Moderate discussions: delete abusive/spam, warn offender ---
async function AI_runModeration(opts) {
  opts = opts || {};
  const settings = AI_getSettings();
  const { data, error } = await sb
    .from("problem_discussions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(400);
  if (error) throw error;
  const comments = data || [];
  let removed = 0, warned = 0;

  const flagged = comments
    .map((c) => ({ c, scan: AI_scanText(c.content) }))
    .filter((x) => x.scan.flagged);
  if (!flagged.length) {
    if (!opts.auto) await AI_log("moderation_scan", `Scanned ${comments.length} comments — all clean.`, "success");
    return { scanned: comments.length, removed: 0, warned: 0 };
  }

  // Problem titles for warning messages.
  const pIds = [...new Set(flagged.map((x) => x.c.problem_id).filter(Boolean))];
  let titleById = {};
  if (pIds.length) {
    const { data: probs } = await sb.from("problems").select("id, title").in("id", pIds);
    (probs || []).forEach((p) => { titleById[p.id] = p.title; });
  }

  for (const { c, scan } of flagged) {
    const label = scan.severity === "spam" ? "spam" : scan.severity === "severe" ? "abusive language" : "rude language";
    await sb.from("discussion_likes").delete().eq("comment_id", c.id);
    const { error: delErr } = await sb.from("problem_discussions").delete().eq("id", c.id);
    if (delErr) {
      await AI_log("moderation_error", `Could not delete comment ${c.id}: ${delErr.message}`, "error");
      continue;
    }
    removed++;
    await AI_log("moderation_removed", `Deleted ${label} comment (${scan.hits.slice(0, 3).join(", ")}) on "${titleById[c.problem_id] || "a problem"}".`, "warn");

    if (settings.warn_user && c.user_id) {
      const soft = scan.severity === "mild";
      const { error: nErr } = await sb.from("notifications").insert({
        user_id: c.user_id,
        type: "announcement", // user-panel bell compatible
        title: soft ? "⚠️ Please keep discussions friendly" : "⚠️ Your comment was removed",
        message: soft
          ? `Hi! Your comment on "${titleById[c.problem_id] || "a problem"}" was removed because it contained rude language. Please keep PyDebug discussions respectful and kind.`
          : `Hi! Your comment on "${titleById[c.problem_id] || "a problem"}" was automatically removed for ${label} (${scan.hits.slice(0, 3).join(", ")}). Repeated violations may lead to suspension — please keep it clean.`,
        link: "/problems.html",
        is_read: false,
      });
      if (!nErr) {
        warned++;
        await AI_log("warning_sent", `Warned user about removed ${label} comment.`, "info");
      }
    }
  }
  await AI_log("moderation_scan", `Scanned ${comments.length} comments — removed ${removed}, warned ${warned}.`, removed ? "warn" : "success");
  return { scanned: comments.length, removed, warned };
}

// --- Premium mix: mark ~premium_percent of a batch as Premium (hard first) ---
function AI_applyPremiumMix(payloads, settings) {
  const s = settings || AI_getSettings();
  if (!s.premium_mix) {
    payloads.forEach((p) => { p.is_premium = false; });
    return 0;
  }
  const pct = Math.max(0, Math.min(90, Number(s.premium_percent) || 0));
  if (!pct || !payloads.length) {
    payloads.forEach((p) => { p.is_premium = false; });
    return 0;
  }
  const k = Math.min(payloads.length, Math.max(1, Math.round((payloads.length * pct) / 100)));
  const rank = { hard: 0, medium: 1, easy: 2 };
  const order = payloads.map((_, i) => i).sort(
    (a, b) => ((rank[payloads[a].difficulty] ?? 3) - (rank[payloads[b].difficulty] ?? 3)) || a - b
  );
  const chosen = new Set(order.slice(0, k));
  payloads.forEach((p, i) => { p.is_premium = chosen.has(i); });
  return chosen.size;
}

// --- 6b. Generate + insert verified problems (never duplicates) ---
async function AI_generateProblems(count, opts) {
  opts = opts || {};
  const settings = AI_getSettings();
  const n = Math.max(1, Math.min(20, Number(count) || settings.per_run || 3));
  const { fps, maxNum } = await AI_fetchProblemsIndex();
  let nextNum = maxNum;
  const batch = [];
  let skipped = 0;

  // Phase 1: build validated payloads (no inserts yet, so the premium
  // mix can be spread across the whole batch).
  for (let slot = 0; slot < n; slot++) {
    let payload = null;
    for (let attempt = 0; attempt < 30 && !payload; attempt++) {
      const tpl = AI_pickTemplate(opts.mix, opts.difficulty);
      let p;
      try {
        p = tpl.make();
      } catch (e) {
        continue;
      }
      p.type = tpl.type;
      p.topic = tpl.topic;
      p.difficulty = tpl.difficulty;
      const v = AI_validateProblem(p, fps);
      if (!v.ok) continue;
      payload = {
        type: p.type,
        title: p.title,
        description: p.description,
        difficulty: p.difficulty,
        topic: p.topic,
        problem_number: ++nextNum,
        is_premium: false,
        starter_code: p.starter_code,
        expected_output: p.expected_output,
        hints: p.hints,
      };
      payload._proof = p.proof;
      payload._bug = p.bug;
      fps.add(AI_fingerprint(p.starter_code, p.expected_output));
    }
    if (!payload) {
      skipped++;
      continue;
    }
    batch.push(payload);
  }

  // Phase 2: premium mix, then insert.
  const premCount = AI_applyPremiumMix(batch, settings);
  const added = [];
  for (const payload of batch) {
    const { _proof, _bug, ...row } = payload;
    row.status = "published";
    row.created_by = opts.actorId || null;
    row.admin_skip_notification = true; // announcements come from the AI broadcast only
    row.battle_error = row.type === "bug" ? (AI_detectPythonError(row.starter_code).error || "") : "";
    const { error } = await sb.from("problems").insert(row);
    if (error) {
      await AI_log("problem_error", `Insert failed for "${row.title}": ${error.message}`, "error");
      skipped++;
      continue;
    }
    added.push(row);
    await AI_log(
      "problem_added",
      `#${row.problem_number} "${row.title}" [${row.type}/${row.topic}/${row.difficulty}]${row.is_premium ? " ⭐ PREMIUM" : ""}${_bug ? " bug: " + _bug : ""} — ${_proof || "verified"}.`,
      "success"
    );
  }
  if (premCount) {
    await AI_log("premium_mix", `Marked ${premCount}/${batch.length} new problem(s) as ⭐ Premium (${settings.premium_percent}%).`, "info");
  }

  if (!added.length) {
    await AI_log("problem_run", `Tried to add ${n} problem(s) — all skipped (duplicates or errors).`, "warn");
  } else if (opts.announce === undefined ? settings.announce : !!opts.announce) {
    try {
      await AI_broadcastNewProblems(added);
    } catch (e) {
      await AI_log("announce_error", "New-problem broadcast failed: " + e.message, "error");
    }
  }
  return { added, skipped };
}

// --- 6c. Preview ONE problem (validates, never inserts) ---
async function AI_previewProblem() {
  const { fps } = await AI_fetchProblemsIndex();
  for (let attempt = 0; attempt < 30; attempt++) {
    const tpl = AI_pickTemplate();
    const p = tpl.make();
    p.type = tpl.type;
    p.topic = tpl.topic;
    p.difficulty = tpl.difficulty;
    const v = AI_validateProblem(p, fps);
    if (v.ok) return { problem: p, templateId: tpl.id, checks: v.checks };
  }
  // last resort: return something with its (failing) checklist
  const tpl = AI_pickTemplate();
  const p = tpl.make();
  p.type = tpl.type; p.topic = tpl.topic; p.difficulty = tpl.difficulty;
  return { problem: p, templateId: tpl.id, checks: AI_validateProblem(p, fps).checks };
}

// --- 6d. Delete existing duplicates (keeps oldest / lowest number) ---
async function AI_runDedup(opts) {
  opts = opts || {};
  const { rows } = await AI_fetchProblemsIndex();
  const groups = {};
  rows.forEach((r) => {
    const fp = AI_fingerprint(r.starter_code, r.expected_output);
    if (!fp) return;
    (groups[fp] = groups[fp] || []).push(r);
  });
  const dupGroups = Object.values(groups).filter((g) => g.length > 1);
  if (!dupGroups.length) {
    if (!opts.auto) await AI_log("dedup_scan", `Scanned ${rows.length} problems — no duplicates found.`, "success");
    return { scanned: rows.length, groups: 0, removed: [] };
  }
  const removed = [];
  for (const g of dupGroups) {
    g.sort((a, b) =>
      (a.problem_number ?? 1e9) - (b.problem_number ?? 1e9) ||
      new Date(a.created_at) - new Date(b.created_at)
    );
    const keeper = g[0];
    const victims = g.slice(1);
    for (const v of victims) {
      // Clean up children first, then the problem itself.
      try {
        const { data: cmts } = await sb.from("problem_discussions").select("id").eq("problem_id", v.id).limit(500);
        const cIds = (cmts || []).map((c) => c.id);
        if (cIds.length) {
          await sb.from("discussion_likes").delete().in("comment_id", cIds);
          await sb.from("problem_discussions").delete().in("id", cIds);
        }
      } catch (e) { /* table may not exist — ignore */ }
      try { await sb.from("submissions").delete().eq("problem_id", v.id); } catch (e) {}
      const { error } = await sb.from("problems").delete().eq("id", v.id);
      if (error) {
        await AI_log("dedup_error", `Could not delete duplicate "${v.title}": ${error.message}`, "error");
        continue;
      }
      removed.push(v);
      await AI_log("dup_removed", `Deleted duplicate "${v.title}" (#${v.problem_number ?? "?"}) — kept "${keeper.title}" (#${keeper.problem_number ?? "?"}).`, "warn");
    }
  }
  await AI_log("dedup_scan", `Scanned ${rows.length} problems — ${dupGroups.length} duplicate group(s), removed ${removed.length}.`, removed.length ? "warn" : "success");
  return { scanned: rows.length, groups: dupGroups.length, removed };
}

// --- 6d2. Bug error guard: delete Fix-the-Bug problems whose code runs
// WITHOUT raising any Python error (AI-made or admin-added). With
// { dryRun: true } it only reports candidates without deleting.
async function AI_runErrorGuard(opts) {
  opts = opts || {};
  const probs = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("problems")
      .select("id, problem_number, title, type, starter_code")
      .eq("type", "bug")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    (data || []).forEach((r) => probs.push(r));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  const bad = probs.filter((p) => {
    try {
      return !AI_detectPythonError(p.starter_code || "").error;
    } catch (e) {
      return false; // analysis crashed — never delete what we can't judge
    }
  });
  if (!bad.length) {
    if (!opts.auto) await AI_log("errguard_scan", `Scanned ${probs.length} Fix-the-Bug problem(s) — every snippet raises a real error. ✅`, "success");
    return { scanned: probs.length, removed: [], candidates: [] };
  }
  if (opts.dryRun) return { scanned: probs.length, removed: [], candidates: bad };
  const removed = [];
  for (const v of bad) {
    // Clean up children first, then the problem itself (same as dedup).
    try {
      const { data: cmts } = await sb.from("problem_discussions").select("id").eq("problem_id", v.id).limit(500);
      const cIds = (cmts || []).map((c) => c.id);
      if (cIds.length) {
        await sb.from("discussion_likes").delete().in("comment_id", cIds);
        await sb.from("problem_discussions").delete().in("id", cIds);
      }
    } catch (e) { /* table may not exist — ignore */ }
    try { await sb.from("submissions").delete().eq("problem_id", v.id); } catch (e) {}
    const { error } = await sb.from("problems").delete().eq("id", v.id);
    if (error) {
      await AI_log("errguard_error", `Could not delete "${v.title}": ${error.message}`, "error");
      continue;
    }
    removed.push(v);
    await AI_log("bugguard_removed", `Deleted error-free bug code "${v.title}" (#${v.problem_number ?? "?"}) — it runs without raising any Python error.`, "warn");
  }
  await AI_log("errguard_scan", `Scanned ${probs.length} Fix-the-Bug problem(s) — removed ${removed.length} error-free snippet(s).`, removed.length ? "warn" : "success");
  return { scanned: probs.length, removed, candidates: [] };
}

// --- 6e. Broadcast "new AI problems" notification to all users ---
async function AI_broadcastNewProblems(added) {
  const list = added.slice(0, 3).map((p) => `• ${p.is_premium ? "⭐ " : ""}${p.title}`).join("\n");
  const more = added.length > 3 ? `\n…and ${added.length - 3} more!` : "";
  const prem = added.filter((p) => p.is_premium).length;
  const title = `🤖 ${added.length} new problem${added.length === 1 ? "" : "s"} just dropped!`;
  const message = `Fresh challenges are live${prem ? ` (including ${prem} Premium ⭐)` : ""}:\n${list}${more}\nSolve them now to earn XP!`;

  let recipients = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb.from("profiles").select("id").order("created_at", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    (data || []).forEach((r) => recipients.push(r.id));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  const CHUNK = 200;
  let sent = 0;
  for (let i = 0; i < recipients.length; i += CHUNK) {
    const chunk = recipients.slice(i, i + CHUNK).map((uid) => ({
      user_id: uid, type: "new_problem", title, message, link: "/problems.html", is_read: false,
    }));
    const { error } = await sb.from("notifications").insert(chunk);
    if (error) throw error;
    sent += chunk.length;
  }
  await AI_log("announce_sent", `Told ${sent} users about ${added.length} new AI problem(s).`, "success");
  return sent;
}

// --- 6f. Welcome brand-new users (last 24h, not welcomed before) ---
async function AI_runWelcome(opts) {
  opts = opts || {};
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb.from("profiles").select("id, created_at").gte("created_at", since).limit(500);
  if (error) throw error;
  const fresh = data || [];
  if (!fresh.length) {
    if (!opts.auto) await AI_log("welcome_scan", "No new users in the last 24h.", "info");
    return { found: 0, welcomed: 0 };
  }
  const ids = fresh.map((u) => u.id);
  const { data: already } = await sb.from("notifications").select("user_id").in("user_id", ids).eq("title", "👋 Welcome to PyDebug!");
  const welcomedSet = new Set((already || []).map((n) => n.user_id));
  const todo = ids.filter((id) => !welcomedSet.has(id));
  for (let i = 0; i < todo.length; i += 200) {
    const chunk = todo.slice(i, i + 200).map((uid) => ({
      user_id: uid,
      type: "announcement",
      title: "👋 Welcome to PyDebug!",
      message: "Welcome aboard! Start with an Easy problem, fix your first bug and earn XP. Stuck? Use hints — good luck!",
      link: "/problems.html",
      is_read: false,
    }));
    const { error: insErr } = await sb.from("notifications").insert(chunk);
    if (insErr) throw insErr;
  }
  if (todo.length || !opts.auto) {
    await AI_log("welcome_scan", `Welcomed ${todo.length} new user(s) (${fresh.length} joined in 24h).`, todo.length ? "success" : "info");
  }
  return { found: fresh.length, welcomed: todo.length };
}

// --- Stats for the AI Control page (from local log) ---
async function AI_getStats() {
  const logs = await AI_getLogs(500);
  const count = (a) => logs.filter((l) => l.action === a).length;
  return {
    commentsRemoved: count("moderation_removed"),
    warningsSent: count("warning_sent"),
    problemsAdded: count("problem_added"),
    duplicatesRemoved: count("dup_removed"),
    bugGuardRemoved: count("bugguard_removed"),
    premiumAdded: logs.filter((l) => l.action === "problem_added" && String(l.detail || "").includes("⭐")).length,
    announcements: count("announce_sent"),
    lastRuns: AI_getLastRuns(),
    totalActions: logs.length,
  };
}

/* ============================================================
   7. REPORTS — daily digest, health score, difficulty calibration
   (Reports bundle — still 100% local logic, no API keys)
   ============================================================ */



// Exact row count with optional filter fn. Returns null when unreadable.
async function AI_count(table, apply) {
  try {
    let q = sb.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  } catch (e) {
    return null;
  }
}

function AI_solvedOf(row, stCol) {
  const v = String(row[stCol] ?? "").toLowerCase();
  return ["solved", "success", "correct", "passed", "true", "1"].includes(v) || row.is_correct === true;
}

function AI_detectStatusCol(sample) {
  if (typeof detectCol === "function") return detectCol(sample, ["status", "result", "verdict"]);
  if (!sample) return "status";
  for (const c of ["status", "result", "verdict"]) {
    if (Object.prototype.hasOwnProperty.call(sample, c)) return c;
  }
  return "status";
}

// --- 7a. Daily digest: builds, saves (local + cloud), logs, returns it ---
async function AI_buildDigest() {
  const now = Date.now();
  const d1 = new Date(now - 24 * 3600 * 1000).toISOString();
  const d2 = new Date(now - 48 * 3600 * 1000).toISOString();
  const d7 = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

  const [totalUsers, newUsers, prevUsers, totalProblems, newProblems, subs24, subsPrev, comments24] = await Promise.all([
    AI_count("profiles"),
    AI_count("profiles", (q) => q.gte("created_at", d1)),
    AI_count("profiles", (q) => q.gte("created_at", d2).lt("created_at", d1)),
    AI_count("problems"),
    AI_count("problems", (q) => q.gte("created_at", d1)),
    AI_count("submissions", (q) => q.gte("created_at", d1)),
    AI_count("submissions", (q) => q.gte("created_at", d2).lt("created_at", d1)),
    AI_count("problem_discussions", (q) => q.gte("created_at", d1)),
  ]);

  // Solve rate over the last 24h.
  let solveRate = null;
  try {
    const { data: s24 } = await sb.from("submissions").select("*").gte("created_at", d1).order("created_at", { ascending: false }).limit(5000);
    const rows = s24 || [];
    if (rows.length) {
      const st = AI_detectStatusCol(rows[0]);
      solveRate = Math.round((rows.filter((r) => AI_solvedOf(r, st)).length / rows.length) * 100);
    }
  } catch (e) {}

  // Top problem of the week by attempts.
  let topProblem = null;
  try {
    const { data: s7 } = await sb.from("submissions").select("problem_id").gte("created_at", d7).limit(10000);
    const agg = {};
    (s7 || []).forEach((r) => { if (r.problem_id) agg[r.problem_id] = (agg[r.problem_id] || 0) + 1; });
    const top = Object.entries(agg).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const { data: p } = await sb.from("problems").select("id, title").eq("id", top[0]).single();
      topProblem = { title: (p && p.title) || "Unknown problem", attempts: top[1] };
    }
  } catch (e) {}

  // AI's own activity in the last 24h (local log).
  const logs = (await AI_getLogs()).filter((l) => now - new Date(l.t).getTime() < 24 * 3600 * 1000);
  const act = (a) => logs.filter((l) => l.action === a).length;
  const removed24 = act("moderation_removed");
  const added24 = act("problem_added");
  const dups24 = act("dup_removed");

  // Abusive comments visible RIGHT NOW (latest 200).
  let liveFlags = 0;
  try {
    const { data: latest } = await sb.from("problem_discussions").select("content").order("created_at", { ascending: false }).limit(200);
    (latest || []).forEach((c) => { if (AI_scanText(c.content).flagged) liveFlags++; });
  } catch (e) {}

  // Age of the newest problem.
  let newestAgeDays = null;
  try {
    const { data: np } = await sb.from("problems").select("created_at").order("created_at", { ascending: false }).limit(1);
    if (np && np[0] && np[0].created_at) {
      newestAgeDays = Math.floor((now - new Date(np[0].created_at).getTime()) / 86400000);
    }
  } catch (e) {}

  let growthPct = null;
  if (newUsers !== null && prevUsers !== null && prevUsers > 0) {
    growthPct = Math.round(((newUsers - prevUsers) / prevUsers) * 100);
  }

  const highlights = [];
  if (liveFlags > 0) highlights.push(`🚨 ${liveFlags} abusive/spam comment(s) visible right now — the Guard removes them while it is ON.`);
  if (newUsers !== null) {
    highlights.push(newUsers === 0
      ? "📭 No new signups in the last 24h."
      : `🎉 ${newUsers} new user(s) joined in 24h${growthPct !== null ? ` (${growthPct >= 0 ? "+" : ""}${growthPct}% vs previous day)` : ""}.`);
  }
  if (subs24 !== null) {
    highlights.push(subs24 === 0
      ? "💤 No submissions in 24h — users may need a nudge (send a broadcast?)."
      : `⚡ ${subs24} submission(s) in 24h${solveRate !== null ? ` · solve rate ${solveRate}%` : ""}.`);
  }
  if (solveRate !== null && (subs24 || 0) > 0) {
    if (solveRate < 35) highlights.push(`⚠️ Solve rate is low (${solveRate}%) — check difficulty calibration below.`);
    else if (solveRate >= 85) highlights.push(`🌟 Excellent solve rate (${solveRate}%)!`);
  }
  if (removed24 > 0) highlights.push(`🛡️ AI removed ${removed24} abusive comment(s) in 24h.`);
  if (added24 > 0) highlights.push(`🤖 AI added ${added24} new problem(s) in 24h.`);
  if (dups24 > 0) highlights.push(`🧹 AI deleted ${dups24} duplicate problem(s) in 24h.`);
  if (newProblems === 0 && newestAgeDays !== null && newestAgeDays >= 7) {
    highlights.push(`🏭 No new problems for ${newestAgeDays} days — enable the problem factory.`);
  }
  if (topProblem) highlights.push(`🔥 Most attempted (7d): "${topProblem.title}" (${topProblem.attempts} attempts).`);
  if ((comments24 || 0) > 0) highlights.push(`💬 ${comments24} new discussion comment(s) in 24h.`);
  if (!highlights.length) highlights.push("✅ All quiet — panel looks healthy.");

  const digest = {
    generated_at: new Date().toISOString(),
    stats: {
      totalUsers, newUsers, prevUsers, growthPct, totalProblems, newProblems,
      subs24, subsPrev, solveRate, comments24, removed24, added24, dups24,
      liveFlags, topProblem, newestAgeDays,
    },
    highlights,
  };
  await AI_kvSet("digest", digest);
  await AI_log("digest_built", `Digest: ${newUsers ?? "?"} new users, ${subs24 ?? "?"} submissions, solve ${solveRate ?? "?"}%.`, "success");
  return digest;
}

async function AI_getDigest() {
  return await AI_kvGet("digest");
}

// --- 7b. Panel health check: score 0-100 + actionable findings ---
async function AI_healthCheck() {
  const checks = [];
  const push = (status, label, detail, fix) => checks.push({ status, label, detail, fix: fix || null });

  let probs = [];
  try {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await sb.from("problems")
        .select("id,title,type,difficulty,topic,hints,starter_code,expected_output,description,problem_number,created_at")
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      (data || []).forEach((r) => probs.push(r));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
  } catch (e) {
    return { score: 0, checks: [{ status: "bad", label: "Cannot read problems", detail: String((e && e.message) || e), fix: null }], generated_at: new Date().toISOString() };
  }

  if (!probs.length) {
    push("warn", "No problems yet", "Add your first problem, or let the AI factory generate some.", { id: "factory" });
  }

  // Topic coverage.
  const byTopic = {};
  AI_TOPICS.forEach((t) => { byTopic[t] = 0; });
  probs.forEach((p) => {
    const t = String(p.topic || "").toLowerCase();
    if (t in byTopic) byTopic[t]++;
  });
  const thin = AI_TOPICS.filter((t) => byTopic[t] < 3);
  if (probs.length && thin.length === 0) {
    push("ok", "Topic coverage", `All 12 topics have 3+ problems (${probs.length} total).`);
  } else if (probs.length) {
    push("warn", "Thin topics", `${thin.join(", ")} — fewer than 3 problems each.`, { id: "factory" });
  }

  // Difficulty balance.
  const diffs = { easy: 0, medium: 0, hard: 0 };
  probs.forEach((p) => {
    const d = String(p.difficulty || "").toLowerCase();
    if (d in diffs) diffs[d]++;
  });
  if (probs.length) {
    const hardShare = Math.round((diffs.hard / probs.length) * 100);
    const easyShare = Math.round((diffs.easy / probs.length) * 100);
    if (hardShare < 10) push("warn", "Difficulty balance", `Only ${hardShare}% hard problems (easy ${easyShare}%). Add tougher challenges.`, { id: "factory-hard" });
    else if (easyShare > 70) push("warn", "Difficulty balance", `${easyShare}% of problems are easy — add medium/hard variety.`, { id: "factory" });
    else push("ok", "Difficulty balance", `Easy ${diffs.easy} · Medium ${diffs.medium} · Hard ${diffs.hard}.`);
  }

  // Hints coverage.
  const weakHints = probs.filter((p) => !(Array.isArray(p.hints) && p.hints.filter((h) => String(h || "").trim()).length >= 3));
  if (probs.length) {
    if (weakHints.length) push("warn", "Weak hints", `${weakHints.length} problem(s) have fewer than 3 hints.`, { id: "hints" });
    else push("ok", "Hints", "Every problem has 3+ hints.");
  }

  // Missing fields.
  const missing = probs.filter((p) => !String(p.title || "").trim() || !String(p.starter_code || "").trim() || !String(p.expected_output || "").trim());
  if (probs.length) {
    if (missing.length) push("bad", "Incomplete problems", `${missing.length} problem(s) are missing title, code or output.`, { id: "hints" });
    else push("ok", "Complete fields", "Every problem has title, code and output.");
  }

  // Duplicates.
  const seen = {};
  probs.forEach((r) => {
    const fp = AI_fingerprint(r.starter_code, r.expected_output);
    if (!fp) return;
    (seen[fp] = seen[fp] || []).push(r);
  });
  const dupGroups = Object.values(seen).filter((g) => g.length > 1);
  const dupRows = dupGroups.reduce((s, g) => s + g.length - 1, 0);
  if (probs.length) {
    if (dupRows) push("bad", "Duplicates", `${dupRows} duplicate row(s) in ${dupGroups.length} group(s) — oldest copies will be kept.`, { id: "dedup" });
    else push("ok", "Duplicates", "No duplicate problems found.");
  }

  // Fix-the-Bug snippets must raise a real error when run.
  try {
    const bugs = probs.filter((p) => String(p.type || "").toLowerCase() === "bug");
    const noErr = bugs.filter((p) => {
      try { return !AI_detectPythonError(p.starter_code || "").error; }
      catch (e) { return false; }
    });
    if (bugs.length) {
      if (noErr.length) push("bad", "Error-free bug code", `${noErr.length} Fix-the-Bug problem(s) run WITHOUT raising any error.`, { id: "errguard" });
      else push("ok", "Bug code quality", `All ${bugs.length} Fix-the-Bug snippet(s) raise a real error.`);
    }
  } catch (e) { /* detector unavailable — skip */ }

  // Live flagged comments.
  try {
    const { data: latest } = await sb.from("problem_discussions").select("content").order("created_at", { ascending: false }).limit(200);
    const flags = (latest || []).filter((c) => AI_scanText(c.content).flagged).length;
    if (flags) push("bad", "Abusive comments live", `${flags} abusive/spam comment(s) are visible right now.`, { id: "moderation" });
    else push("ok", "Discussions clean", "Latest 200 comments scanned — all clean.");
  } catch (e) {}

  // Unanswered questions (top-level "?" older than 3 days, no reply).
  try {
    const { data: cmts } = await sb.from("problem_discussions").select("id,content,parent_comment_id,created_at").order("created_at", { ascending: false }).limit(500);
    const rows = cmts || [];
    const hasChild = new Set(rows.map((r) => r.parent_comment_id).filter(Boolean).map(String));
    const cutoff = Date.now() - 3 * 86400000;
    const unans = rows.filter((r) =>
      !r.parent_comment_id &&
      String(r.content || "").includes("?") &&
      new Date(r.created_at).getTime() < cutoff &&
      !hasChild.has(String(r.id))
    );
    if (unans.length) push("warn", "Unanswered questions", `${unans.length} question(s) older than 3 days have no reply.`, { id: "discussions" });
    else push("ok", "Q&A", "No stale unanswered questions.");
  } catch (e) {}

  // Inactive users share (skipped when the column is absent).
  try {
    const { data: act } = await sb.from("profiles").select("last_active_date").limit(2000);
    const rows = (act || []).filter((r) => r && r.last_active_date);
    if (rows.length >= 10) {
      const cutoff = Date.now() - 14 * 86400000;
      const inactive = rows.filter((r) => new Date(r.last_active_date).getTime() < cutoff).length;
      const share = Math.round((inactive / rows.length) * 100);
      if (share > 60) push("warn", "Sleeping users", `${share}% of users inactive for 14+ days — send a re-engagement broadcast.`, { id: "broadcast" });
      else push("ok", "User activity", `${100 - share}% of users active in the last 14 days.`);
    }
  } catch (e) {}

  let score = 100;
  checks.forEach((c) => {
    if (c.status === "bad") score -= 15;
    else if (c.status === "warn") score -= 6;
  });
  score = Math.max(0, score);
  return { score, checks, generated_at: new Date().toISOString() };
}

// --- 7c. Difficulty calibration from real solve rates (min 8 attempts) ---
async function AI_calibration() {
  const { data: subs, error } = await sb.from("submissions").select("*").order("created_at", { ascending: false }).limit(10000);
  if (error) throw error;
  const rows = subs || [];
  if (!rows.length) return { suggestions: [], judged: 0 };
  const st = AI_detectStatusCol(rows[0]);
  const agg = {};
  rows.forEach((r) => {
    if (!r.problem_id) return;
    agg[r.problem_id] = agg[r.problem_id] || { a: 0, s: 0 };
    agg[r.problem_id].a++;
    if (AI_solvedOf(r, st)) agg[r.problem_id].s++;
  });
  const ids = Object.keys(agg).filter((id) => agg[id].a >= 8);
  if (!ids.length) return { suggestions: [], judged: 0 };
  const { data: probs } = await sb.from("problems").select("id,title,difficulty").in("id", ids);
  const byId = {};
  (probs || []).forEach((p) => { byId[p.id] = p; });
  const EASIER = { hard: "medium", medium: "easy" };
  const HARDER = { easy: "medium", medium: "hard" };
  const suggestions = [];
  ids.forEach((id) => {
    const p = byId[id];
    if (!p) return;
    const { a, s } = agg[id];
    const rate = Math.round((s / a) * 100);
    const cur = String(p.difficulty || "").toLowerCase();
    let sug = null, reason = "";
    if (rate >= 85 && EASIER[cur]) {
      sug = EASIER[cur];
      reason = `${rate}% solve rate — too easy for '${cur}'`;
    } else if (rate <= 25 && HARDER[cur]) {
      sug = HARDER[cur];
      reason = `${rate}% solve rate — too hard for '${cur}'`;
    }
    if (sug) suggestions.push({ problem_id: id, title: p.title, current: cur, suggested: sug, attempts: a, rate, reason });
  });
  suggestions.sort((x, y) => y.attempts - x.attempts);
  return { suggestions, judged: ids.length };
}

async function AI_applyDifficulty(items) {
  let ok = 0;
  for (const it of items) {
    const { error } = await sb.from("problems").update({ difficulty: it.suggested }).eq("id", it.problem_id);
    if (!error) {
      ok++;
      await AI_log("difficulty_changed", `"${it.title || it.problem_id}" → ${it.suggested} (${it.reason || "calibration"}).`, "success");
    } else {
      await AI_log("difficulty_error", `Could not update ${it.problem_id}: ${error.message}`, "error");
    }
  }
  return ok;
}


/* ============================================================
   CONTENT AI (ported from js/ai-content.js)
   ============================================================ */

// Pick a template, preferring topic+type+difficulty, with graceful fallback.
// Returns { tpl, level } where level = exact | topic-type | topic | type | any.
function AI_pickTemplateFor(topic, diff, mix) {
  const m = mix || AI_getSettings().mix || "both";
  const types = m === "both" ? ["bug", "question"] : [m];
  const levels = [
    ["exact", (t) => t.topic === topic && t.difficulty === diff && types.includes(t.type)],
    ["topic-type", (t) => t.topic === topic && types.includes(t.type)],
    ["topic", (t) => t.topic === topic],
    ["type", (t) => types.includes(t.type)],
    ["any", () => true],
  ];
  for (const [level, f] of levels) {
    const pool = AI_TEMPLATES.filter(f);
    if (pool.length) return { tpl: AI_pick(pool), level };
  }
  return { tpl: AI_pick(AI_TEMPLATES), level: "any" };
}

// --- Fill the thinnest topic x difficulty cells first ---
async function AI_runGapFill(count, opts) {
  opts = opts || {};
  const settings = AI_getSettings();
  const n = Math.max(1, Math.min(20, Number(count) || settings.per_run || 3));

  // Count problems per topic x difficulty cell.
  const cells = {};
  AI_TOPICS.forEach((t) => { cells[t] = { easy: 0, medium: 0, hard: 0 }; });
  try {
    const { data, error } = await sb.from("problems").select("topic, difficulty").limit(5000);
    if (error) throw error;
    (data || []).forEach((p) => {
      const t = String(p.topic || "").toLowerCase();
      const d = String(p.difficulty || "").toLowerCase();
      if (cells[t] && cells[t][d] !== undefined) cells[t][d]++;
    });
  } catch (e) {
    await AI_log("gapfill_error", "Could not read topic map: " + e.message, "error");
    return { added: [], skipped: 0, error: e.message };
  }
  const ranked = [];
  AI_TOPICS.forEach((t) => ["easy", "medium", "hard"].forEach((d) => ranked.push({ topic: t, diff: d, count: cells[t][d] })));
  ranked.sort((a, b) => a.count - b.count);

  const { fps, maxNum } = await AI_fetchProblemsIndex();
  let nextNum = maxNum;
  const batch = [];
  let skipped = 0;
  for (let slot = 0; slot < n; slot++) {
    const cell = ranked[slot % ranked.length];
    let payload = null;
    for (let attempt = 0; attempt < 30 && !payload; attempt++) {
      const { tpl } = AI_pickTemplateFor(cell.topic, cell.diff, opts.mix);
      let p;
      try { p = tpl.make(); } catch (e) { continue; }
      p.type = tpl.type; p.topic = tpl.topic; p.difficulty = tpl.difficulty;
      if (!AI_validateProblem(p, fps).ok) continue;
      payload = {
        type: p.type, title: p.title, description: p.description,
        difficulty: p.difficulty, topic: p.topic, problem_number: ++nextNum,
        is_premium: false, starter_code: p.starter_code,
        expected_output: p.expected_output, hints: p.hints,
        _gap: `${cell.topic}/${cell.diff} (had ${cell.count})`, _bug: p.bug,
      };
      fps.add(AI_fingerprint(p.starter_code, p.expected_output));
    }
    if (!payload) { skipped++; continue; }
    batch.push(payload);
  }
  const premCount = AI_applyPremiumMix(batch, settings);
  const added = [];
  for (const payload of batch) {
    const { _gap, _bug, ...row } = payload;
    row.status = "published";
    row.created_by = opts.actorId || null;
    row.admin_skip_notification = true;
    row.battle_error = row.type === "bug" ? (AI_detectPythonError(row.starter_code).error || "") : "";
    const { error } = await sb.from("problems").insert(row);
    if (error) {
      await AI_log("problem_error", `Gap-fill insert failed for "${row.title}": ${error.message}`, "error");
      skipped++;
      continue;
    }
    added.push(row);
    await AI_log("problem_added", `#${row.problem_number} "${row.title}"${row.is_premium ? " ⭐ PREMIUM" : ""} — gap-fill ${_gap}.`, "success");
  }
  if (premCount) {
    await AI_log("premium_mix", `Gap-fill: marked ${premCount}/${batch.length} problem(s) as ⭐ Premium.`, "info");
  }
  if (!added.length) await AI_log("problem_run", `Gap-fill tried ${n} — all skipped (duplicates).`, "warn");
  return { added, skipped, cells: ranked.slice(0, 5) };
}

// --- Create N variations of one problem (same topic/type/difficulty) ---
async function AI_generateVariations(problemId, n, opts) {
  opts = opts || {};
  n = Math.max(1, Math.min(10, Number(n) || 3));
  const { data: src, error: srcErr } = await sb.from("problems").select("*").eq("id", problemId).single();
  if (srcErr || !src) throw new Error("Source problem not found.");
  const { fps, maxNum } = await AI_fetchProblemsIndex();
  const srcFp = AI_fingerprint(src.starter_code, src.expected_output);
  if (srcFp) fps.add(srcFp);
  let nextNum = maxNum;
  const added = [];
  let skipped = 0;
  for (let slot = 0; slot < n; slot++) {
    let payload = null;
    for (let attempt = 0; attempt < 40 && !payload; attempt++) {
      const { tpl } = AI_pickTemplateFor(src.topic, src.difficulty, src.type);
      let p;
      try { p = tpl.make(); } catch (e) { continue; }
      p.type = tpl.type; p.topic = tpl.topic; p.difficulty = tpl.difficulty;
      if (!AI_validateProblem(p, fps).ok) continue;
      payload = {
        type: p.type, title: p.title, description: p.description,
        difficulty: p.difficulty, topic: p.topic, problem_number: ++nextNum,
        is_premium: !!src.is_premium, starter_code: p.starter_code,
        expected_output: p.expected_output, hints: p.hints,
      };
      fps.add(AI_fingerprint(p.starter_code, p.expected_output));
    }
    if (!payload) { skipped++; continue; }
    payload.status = "published";
    payload.created_by = opts.actorId || null;
    payload.admin_skip_notification = true;
    payload.battle_error = payload.type === "bug" ? (AI_detectPythonError(payload.starter_code).error || "") : "";
    const { error } = await sb.from("problems").insert(payload);
    if (error) { skipped++; continue; }
    added.push(payload);
    await AI_log("problem_added", `#${payload.problem_number} "${payload.title}" — variation of #${src.problem_number ?? "?"} "${src.title}".`, "success");
  }
  return { added, skipped, source: src };
}

// --- Quality report: flags weak problems (missing bits, dup numbers...) ---
async function AI_qualityReport() {
  const probs = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("problems")
      .select("id,problem_number,title,type,difficulty,topic,hints,starter_code,expected_output,description")
      .order("problem_number", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    (data || []).forEach((r) => probs.push(r));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  const numCount = {};
  probs.forEach((p) => {
    if (p.problem_number !== null && p.problem_number !== undefined) {
      numCount[p.problem_number] = (numCount[p.problem_number] || 0) + 1;
    }
  });
  const issues = [];
  probs.forEach((p) => {
    const flags = [];
    if (!String(p.title || "").trim() || String(p.title).trim().length < 8) flags.push("short-title");
    if (!String(p.description || "").trim() || String(p.description).trim().length < 10) flags.push("weak-description");
    if (!String(p.starter_code || "").trim()) flags.push("no-code");
    if (!String(p.expected_output || "").trim()) flags.push("no-output");
    const goodHints = Array.isArray(p.hints) ? p.hints.filter((h) => String(h || "").trim().length >= 8) : [];
    if (goodHints.length < 3) flags.push(`hints:${goodHints.length}/3`);
    if (p.problem_number === null || p.problem_number === undefined) flags.push("no-number");
    else if (numCount[p.problem_number] > 1) flags.push(`dup-number:${p.problem_number}`);
    if (!["easy", "medium", "hard"].includes(String(p.difficulty || "").toLowerCase())) flags.push("bad-difficulty");
    if (!AI_TOPICS.includes(String(p.topic || "").toLowerCase())) flags.push("bad-topic");
    if (String(p.type || "").toLowerCase() === "bug" && String(p.starter_code || "").trim()) {
      try {
        if (!AI_detectPythonError(p.starter_code).error) flags.push("no-error");
      } catch (e) { /* ignore */ }
    }
    if (flags.length) issues.push({ id: p.id, number: p.problem_number, title: p.title, type: p.type, flags });
  });
  await AI_log("quality_run", `Quality scan: ${probs.length} problems, ${issues.length} with issues.`, issues.length ? "warn" : "success");
  return { total: probs.length, issues };
}

// --- Generic-but-useful hint bank (topic x type), used to repair weak hints ---
const AI_HINT_BANK = {
  loops: {
    bug: ["range(a, b) stops BEFORE b — check whether your last value is included.", "Trace the loop by hand: write down the variable's value on each pass.", "Add a temporary print() inside the loop to see what it actually does."],
    question: ["Count how many times the loop body runs — range start, stop and step matter.", "Track the changing variable (total, count...) on paper, one line per iteration.", "Remember: the printed value is the state AFTER the loop finishes."],
  },
  strings: {
    bug: ["Strings are quoted — check every quote, bracket and parenthesis is closed.", "Method names need parentheses to RUN: msg.upper is not the same as msg.upper().", "Indexes start at 0 — the last character is at len(s) - 1, not len(s)."],
    question: ["Write down the string and number each character starting from 0.", "Slicing [a:b] includes index a but stops BEFORE index b.", "upper()/lower()/replace() return NEW strings — the original never changes."],
  },
  lists: {
    bug: ["Valid indexes are 0 to len(list) - 1 — index len(list) always crashes.", "Check whether you are changing the list while looping over it.", "A list and a single item are different types — don't mix them up."],
    question: ["Write out the list with each index numbered, including negative indexes.", "Slicing never crashes — out-of-range slices just give shorter results.", "Comprehensions read right-to-left: the 'if' filters FIRST, then the expression maps."],
  },
  dictionaries: {
    bug: ["KeyError means the key is missing — print the dict's keys to compare spellings.", "Dictionary keys are case-sensitive: 'Ram' and 'ram' are different keys.", "Use .get(key, default) when a key might not exist."],
    question: ["Looping 'for k in d' visits KEYS, not values — use d[k] for values.", ".get(key, default) returns the default instead of crashing on missing keys.", "len(dict) counts key-value pairs, not individual values."],
  },
  functions: {
    bug: ["A function without 'return' always gives back None.", "Arguments match parameters by POSITION — check their order.", "Variables created inside a function disappear when it ends (scope)."],
    question: ["Default arguments are used only when the caller skips them.", "Follow each call step by step, substituting the argument values.", "'return' ends the function immediately — code after it never runs."],
  },
  oop: {
    bug: ["Inside methods, stored data must use self (self.name), not plain names.", "__init__ runs automatically when you create the object — check its assignments.", "Call methods on the OBJECT (s.show()), not on the class."],
    question: ["Trace object creation first: __init__ sets the starting state.", "Each method call updates self — track it like a variable.", "A child's method overrides (replaces) the parent's version."],
  },
  recursion: {
    bug: ["Every recursive function needs a base case that STOPS the calls.", "Check the recursive call moves TOWARD the base case (n-1, not n+1).", "Trace 2-3 levels by hand to see where it goes wrong."],
    question: ["Unroll the calls: fact(3) = 3 * fact(2) = 3 * 2 * fact(1)...", "The base case value bubbles back up through every level.", "Count the levels — depth equals how many times it calls itself."],
  },
  exceptions: {
    bug: ["The 'except' type must match the error actually raised.", "Code AFTER the crashing line inside 'try' is skipped.", "'finally' always runs — even when an error occurs."],
    question: ["Find which line raises first — everything after it in 'try' is skipped.", "Only the matching 'except' block runs; others are ignored.", "'finally' runs no matter what, BEFORE the code after the block."],
  },
  sets: {
    bug: ["Sets reject unhashable items — lists and dicts can never go inside.", "Curly braces with key:value make a DICT, not a set.", "Sets have no order and no duplicates — never index them."],
    question: ["| is union (everything), & is intersection (common items only).", "Duplicates vanish automatically when a set is built.", "len() counts distinct elements; sorted() gives a predictable order."],
  },
  sorting: {
    bug: ["sort() changes the list itself; sorted() returns a NEW list.", "reverse=True flips to descending — check if that's wanted.", "The default sort is ascending: smallest (or A-Z) first."],
    question: ["key=len compares by LENGTH, not alphabetically.", "sorted() never changes the original list.", "Sorting strings is case-sensitive: capitals sort before lowercase."],
  },
  generators: {
    bug: ["A generator can be consumed only ONCE — the second use sees nothing.", "Store list(gen) in a variable if you need the values twice.", "(...) makes a generator, [...] makes a list — brackets matter."],
    question: ["The expression runs once per value, lazily, as list() pulls them.", "range(n) feeds 0..n-1 into the generator expression.", "list(gen) collects every produced value, in order."],
  },
  tuples: {
    bug: ["Tuples are IMMUTABLE — assign via list(t), change, tuple(...) back.", "A one-item tuple needs a comma: (5,) — plain (5) is just a number.", "Unpacking needs EXACTLY matching counts on both sides."],
    question: ["Unpacking assigns by POSITION: first value to first name.", "Indexing works like lists: t[0] is first, t[-1] is last.", "len(), + and * work on tuples just like lists."],
  },
};

function AI_bankHints(topic, type) {
  const t = AI_HINT_BANK[String(topic || "").toLowerCase()];
  if (t && t[type]) return t[type];
  if (t && t.question) return t.question;
  return [
    "Read the code slowly, one line at a time, and predict what each line does.",
    "Try a tiny example by hand before guessing the final answer.",
    "Break the problem into smaller steps — solve each step separately.",
  ];
}

// --- Repair problems that have fewer than 3 good hints ---
async function AI_fixHints() {
  const probs = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("problems").select("id,problem_number,title,topic,type,hints").range(from, from + PAGE - 1);
    if (error) throw error;
    (data || []).forEach((r) => probs.push(r));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  let fixed = 0;
  for (const p of probs) {
    const good = Array.isArray(p.hints) ? p.hints.filter((h) => String(h || "").trim().length >= 8) : [];
    if (good.length >= 3) continue;
    const bank = AI_bankHints(p.topic, p.type);
    const merged = [...good];
    for (const h of bank) {
      if (merged.length >= 3) break;
      if (!merged.some((m) => m.trim().toLowerCase() === h.toLowerCase())) merged.push(h);
    }
    if (merged.length < 3) continue;
    const { error } = await sb.from("problems").update({ hints: merged.slice(0, 3) }).eq("id", p.id);
    if (!error) fixed++;
  }
  await AI_log("hints_fixed", `Hint repair: ${fixed} problem(s) topped up to 3 hints.`, fixed ? "success" : "info");
  return { checked: probs.length, fixed };
}

// --- Bulk import: JSON array or CSV with header ---
function AI_parseCSV(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch === "\r") { /* skip */ }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function AI_parseBulkImport(text, format) {
  const rows = [];
  const errors = [];
  if (format === "json") {
    let arr;
    try {
      arr = JSON.parse(String(text || "").trim());
    } catch (e) {
      return { rows, errors: [{ row: 0, error: "Invalid JSON: " + e.message }] };
    }
    if (!Array.isArray(arr)) return { rows, errors: [{ row: 0, error: "JSON must be an array of objects." }] };
    arr.forEach((o, i) => {
      if (!o || typeof o !== "object") { errors.push({ row: i + 1, error: "Not an object." }); return; }
      rows.push({
        type: String(o.type || "").trim().toLowerCase(),
        title: String(o.title || "").trim(),
        description: String(o.description || "").trim(),
        difficulty: String(o.difficulty || "").trim().toLowerCase(),
        topic: String(o.topic || "").trim().toLowerCase(),
        starter_code: String(o.starter_code ?? o.code ?? ""),
        expected_output: String(o.expected_output ?? o.output ?? ""),
        hints: Array.isArray(o.hints) ? o.hints.map(String) : String(o.hints || "").split("|").map((h) => h.trim()).filter(Boolean),
        is_premium: o.is_premium === true || String(o.is_premium || "").toLowerCase() === "true" || String(o.is_premium) === "1",
        _row: i + 1,
      });
    });
  } else {
    const grid = AI_parseCSV(text);
    if (!grid.length) return { rows, errors: [{ row: 0, error: "Empty CSV." }] };
    const head = grid[0].map((h) => String(h).trim().toLowerCase());
    const need = ["type", "title", "difficulty", "topic", "starter_code", "expected_output"];
    const missing = need.filter((c) => !head.includes(c));
    if (missing.length) return { rows, errors: [{ row: 0, error: "Missing columns: " + missing.join(", ") }] };
    for (let i = 1; i < grid.length; i++) {
      const o = {};
      head.forEach((h, j) => { o[h] = (grid[i][j] ?? "").trim(); });
      const hints = [o.hint1, o.hint2, o.hint3].filter((h) => h && h.trim());
      if (o.hints) o.hints.split("|").map((h) => h.trim()).filter(Boolean).forEach((h) => hints.push(h));
      rows.push({
        type: (o.type || "").toLowerCase(), title: o.title || "", description: o.description || "",
        difficulty: (o.difficulty || "").toLowerCase(), topic: (o.topic || "").toLowerCase(),
        starter_code: o.starter_code || o.code || "", expected_output: o.expected_output || o.output || "",
        hints, is_premium: ["true", "1", "yes"].includes((o.is_premium || "").toLowerCase()),
        _row: i + 1,
      });
    }
  }
  return { rows, errors };
}

// Validate bulk rows vs DB fingerprints (+ intra-batch dup detection).
async function AI_validateBulkRows(rows) {
  const { fps } = await AI_fetchProblemsIndex();
  const seen = new Set();
  return rows.map((p) => {
    // Bulk rows are admin-provided (not generator-computed): mark the output
    // source honestly so the proof check reflects human verification.
    if (p.type === "question" && !p.proof) p.proof = "bulk import — output supplied by admin, verify before import";
    const v = AI_validateProblem(p, fps);
    const fp = AI_fingerprint(p.starter_code, p.expected_output);
    let batchDup = false;
    if (fp) {
      if (seen.has(fp)) batchDup = true;
      seen.add(fp);
    }
    if (batchDup) v.checks.push({ label: "Unique within batch", pass: false });
    v.ok = v.checks.every((c) => c.pass);
    return { row: p._row, title: p.title || "(no title)", ok: v.ok, checks: v.checks, payload: p };
  });
}

async function AI_runBulkImport(validated, opts) {
  opts = opts || {};
  const good = validated.filter((r) => r.ok);
  if (!good.length) return { added: 0 };
  const { maxNum } = await AI_fetchProblemsIndex();
  let nextNum = maxNum;
  let added = 0;
  for (const r of good) {
    const p = r.payload;
    const { error } = await sb.from("problems").insert({
      type: p.type, title: p.title, description: p.description,
      difficulty: p.difficulty, topic: p.topic, problem_number: ++nextNum,
      is_premium: !!p.is_premium, starter_code: p.starter_code,
      expected_output: p.expected_output, hints: p.hints.filter((h) => String(h || "").trim()),
      status: "published", created_by: opts.actorId || null,
      admin_skip_notification: true, battle_error: "",
    });
    if (!error) added++;
  }
  await AI_log("bulk_import", `Bulk import: ${added}/${good.length} valid row(s) inserted.`, added ? "success" : "warn");
  return { added };
}


/* ============================================================
   GROWTH & RETENTION (ported from js/ai-growth.js)
   ============================================================ */

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
    await AI_log("expiry_error", "Could not read premium expiry: " + e.message, "error");
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
  await AI_log("expiry_run", `Premium reminders: ${expiring.length} expiring, ${expired.length} expired, ${sent} notified.`, sent ? "success" : "info");
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
    await AI_log("winback_skip", "last_active_date unavailable: " + e.message, "warn");
    return { found: 0, notified: 0, skipped: true };
  }
  if (!cands.length) {
    if (!opts.auto) await AI_log("winback_run", "No inactive users found.", "info");
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
  await AI_log("winback_run", `Win-back: ${cands.length} inactive, ${sent} nudged.`, sent ? "success" : "info");
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
    await AI_log("stuck_error", "Could not read submissions: " + e.message, "error");
    return { stuck: 0, notified: 0, error: e.message };
  }
  if (!rows.length) {
    if (!opts.auto) await AI_log("stuck_run", "No recent submissions to analyse.", "info");
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
    if (!opts.auto) await AI_log("stuck_run", `Checked ${rows.length} submissions — nobody is stuck.`, "success");
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
  await AI_log("stuck_run", `Stuck-user help: ${stuck.length} stuck, ${sent} encouraged.`, sent ? "success" : "info");
  return { stuck: stuck.length, notified: sent };
}

// --- Leaderboard climb alerts: top-10 entry or 3+ spot climb ---

async function AI_runLeaderboardAlerts(opts) {
  opts = opts || {};
  let board = [];
  try {
    const { data, error } = await sb.from("profiles").select("id, xp").order("xp", { ascending: false }).limit(25);
    if (error) throw error;
    board = (data || []).map((r, i) => ({ id: r.id, xp: Number(r.xp) || 0, rank: i + 1 }));
  } catch (e) {
    await AI_log("leaderboard_skip", "XP leaderboard unavailable: " + e.message, "warn");
    return { alerts: 0, skipped: true };
  }
  // Previous snapshot (cloud first, local fallback).
  let prev = null;
  try {
    prev = await AI_kvGet("leaderboard");
  } catch (e) {}
  const snap = { at: new Date().toISOString(), ranks: {} };
  board.forEach((r) => { snap.ranks[r.id] = r.rank; });
  await AI_kvSet("leaderboard", snap);

  if (!prev || !prev.ranks) {
    await AI_log("leaderboard_run", `Snapshot saved (${board.length} ranked) — alerts start from the next run.`, "info");
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
  await AI_log("leaderboard_run", `Leaderboard: ${items.length} climb alert(s) sent.`, sent ? "success" : "info");
  return { alerts: sent };
}


/* ============================================================
   SAFETY+ (ported from js/ai-safety.js)
   ============================================================ */

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
  const adminId = opts.actorId || null;
  if (!adminId) throw new Error("FAQ auto-helper needs an admin actor.");

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
      await AI_log("faq_error", `Reply failed on ${c.id}: ${insErr.message}`, "error");
      continue;
    }
    replied++;
    await AI_log("faq_replied", `Auto-answered a waiting question (${String(c.content || "").slice(0, 60)}...).`, "success");
  }
  if (!replied && !opts.auto) {
    await AI_log("faq_run", `Checked ${cands.length} waiting question(s) — nothing to answer.`, "info");
  } else if (replied) {
    await AI_log("faq_run", `FAQ helper replied to ${replied} question(s), skipped ${skippedAnswered} already-answered.`, "success");
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
    await AI_log("cheat_run", `Checked ${rows.length} submissions — no copy-paste rings found.`, "success");
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
  await AI_log("cheat_run", `Checked ${rows.length} submissions — ${hits.length} shared-code group(s) need review.`, "warn");
  return { checked: rows.length, hits };
}


/* ============================================================
   8. WATCH TICK — server-side port of the legacy ai-watch.js loop.
   The old panel ran this every minute in the browser while any admin page
   was open. Now the AI Control page pings POST /api/ai { action: "watch" }
   every minute; the server enforces a 55s cross-tab lock via ai_settings and
   skips modules the triggering admin's role is not allowed to perform.
   ============================================================ */

async function AI_runWatchTick(options = {}) {
  const settings = AI_getSettings();
  if (!settings.master) return { ran: false, reason: "master_off" };
  const now = Date.now();
  const lastLock = Number(await AI_kvGet("watch_lock")) || 0;
  if (now - lastLock < 55000) return { ran: false, reason: "rate_limited" };
  await AI_kvSet("watch_lock", now);

  const role = options.role || "superadmin";
  const allowed = (resource, action) => can(role, resource, action);
  const actorId = options.actorId || null;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const last = AI_getLastRuns();
  const ran = [];
  const attempt = async (name, gate, fn, lastRunKey, minAge) => {
    if (!gate) return;
    if (lastRunKey && now - (last[lastRunKey] || 0) <= minAge) return;
    try {
      const result = await fn();
      ran.push({ name, result });
      if (lastRunKey) await AI_setLastRun(lastRunKey);
    } catch (e) {
      console.warn("[own-ai] watch " + name + ":", e.message);
    }
  };

  // 1. Discussion moderation — every tick (cheap scan).
  await attempt("moderation", settings.moderation && allowed("moderation", "delete"), () => AI_runModeration({ auto: true, actorId }));
  // 2. Duplicate cleanup — at most once per hour.
  await attempt("dedup", settings.dedup && allowed("problems", "delete"), () => AI_runDedup({ auto: true }), "dedup", HOUR);
  // 2b. Bug error guard — hourly.
  await attempt("errguard", settings.error_guard && allowed("problems", "delete"), () => AI_runErrorGuard({ auto: true }), "errguard", HOUR);
  // 3. Auto problem generation — per configured interval.
  const hours = Math.min(72, Math.max(1, Number(settings.auto_hours) || 12));
  await attempt("factory", settings.auto_problems && allowed("problems", "create"), () => AI_generateProblems(settings.per_run || 3, { auto: true, actorId, announce: allowed("ai", "notify") ? undefined : false }), "problems", hours * HOUR);
  // 4. Welcome new users — at most once per hour.
  await attempt("welcome", settings.welcome && allowed("ai", "notify"), () => AI_runWelcome({ auto: true }), "welcome", HOUR);
  // 6. Growth + safety daily runners (each at most once per 24h).
  await attempt("expiry", settings.expiry && allowed("ai", "notify"), () => AI_runExpiryReminders({ auto: true }), "expiry", DAY);
  await attempt("winback", settings.winback && allowed("ai", "notify"), () => AI_runWinback({ auto: true }), "winback", DAY);
  await attempt("stuck", settings.stuck && allowed("ai", "notify"), () => AI_runStuckHelp({ auto: true }), "stuck", DAY);
  await attempt("leaderboard", settings.leaderboard && allowed("ai", "notify"), () => AI_runLeaderboardAlerts({ auto: true }), "lead", DAY);
  await attempt("faq", settings.faq && allowed("ai", "notify"), () => AI_runFaqReplies(10, { auto: true, actorId }), "faq", DAY);
  // 5. Daily digest — auto-build once every ~20h while the Guard is ON.
  await attempt("digest", true, () => AI_buildDigest(), "digest", 20 * HOUR);

  return { ran: true, results: ran };
}

/* Pure (no-database) sampler used by the dev server to seed the problem
   library with real engine output. */
function AI_sampleProblems(count, opts = {}) {
  const n = Math.max(1, Math.min(20, Number(count) || 5));
  const fps = new Set();
  const out = [];
  let guard = 0;
  while (out.length < n && guard < n * 80) {
    guard += 1;
    const tpl = AI_pickTemplate(opts.mix, opts.difficulty);
    let p;
    try { p = tpl.make(); } catch (e) { continue; }
    p.type = tpl.type; p.topic = tpl.topic; p.difficulty = tpl.difficulty;
    if (!AI_validateProblem(p, fps).ok) continue; // validates the FULL problem (fixed_code, proof, marker)
    fps.add(AI_fingerprint(p.starter_code, p.expected_output));
    out.push({
      type: p.type, title: p.title, description: p.description,
      difficulty: p.difficulty, topic: p.topic, is_premium: false,
      starter_code: p.starter_code, expected_output: p.expected_output, hints: p.hints,
      battle_error: p.type === "bug" ? (AI_detectPythonError(p.starter_code).error || "") : "",
    });
  }
  return out;
}


/* ============================================================
   PUBLIC API (consumed by api/ai.js)
   ============================================================ */

module.exports = {
  DEFAULTS: AI_DEFAULTS,
  TOPICS: AI_TOPICS,
  TEMPLATES: AI_TEMPLATES,
  loadState: AI_loadState,
  getSettings: AI_getSettings,
  saveSettings: AI_saveSettings,
  validateSettingsPatch: AI_validateSettingsPatch,
  getLastRuns: AI_getLastRuns,
  setLastRun: AI_setLastRun,
  log: AI_log,
  getLogs: AI_getLogs,
  clearLogs: AI_clearLogs,
  getStats: AI_getStats,
  kvGet: AI_kvGet,
  kvSet: AI_kvSet,
  scanText: (text) => AI_scanText(text),
  scanHindi: AI_scanHindi,
  diagnoseCode: AI_diagnoseCode,
  detectPythonError: AI_detectPythonError,
  codeShapeOK: AI_codeShapeOK,
  fingerprint: AI_fingerprint,
  validateProblem: AI_validateProblem,
  pickTemplate: AI_pickTemplate,
  fetchProblemsIndex: AI_fetchProblemsIndex,
  runModeration: AI_runModeration,
  applyPremiumMix: AI_applyPremiumMix,
  generateProblems: AI_generateProblems,
  previewProblem: AI_previewProblem,
  runDedup: AI_runDedup,
  runErrorGuard: AI_runErrorGuard,
  broadcastNewProblems: AI_broadcastNewProblems,
  runWelcome: AI_runWelcome,
  buildDigest: AI_buildDigest,
  getDigest: AI_getDigest,
  healthCheck: AI_healthCheck,
  calibration: AI_calibration,
  applyDifficulty: AI_applyDifficulty,
  runExpiryReminders: AI_runExpiryReminders,
  runWinback: AI_runWinback,
  runStuckHelp: AI_runStuckHelp,
  runLeaderboardAlerts: AI_runLeaderboardAlerts,
  faqReplyFor: AI_faqReplyFor,
  runFaqReplies: AI_runFaqReplies,
  cheatReport: AI_cheatReport,
  pickTemplateFor: AI_pickTemplateFor,
  runGapFill: AI_runGapFill,
  generateVariations: AI_generateVariations,
  qualityReport: AI_qualityReport,
  bankHints: AI_bankHints,
  fixHints: AI_fixHints,
  parseCSV: AI_parseCSV,
  parseBulkImport: AI_parseBulkImport,
  validateBulkRows: AI_validateBulkRows,
  runBulkImport: AI_runBulkImport,
  runWatchTick: AI_runWatchTick,
  sampleProblems: AI_sampleProblems,
  _internals: {
    normToken: AI_normToken, collapseRepeats: AI_collapseRepeats, tokenHits: AI_tokenHits,
    hash: AI_hash, normCode: AI_normCode, solvedOf: AI_solvedOf, detectStatusCol: AI_detectStatusCol,
    notifyMany: AI_notifyMany, recentNotified: AI_recentNotified, countTable: AI_count,
    faqRules: AI_FAQ_RULES, hintBank: AI_HINT_BANK, spamPatterns: AI_SPAM_PATTERNS,
  },
};
