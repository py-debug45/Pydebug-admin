// ai-brain.js — PyDebug OWN-AI: 100% in-browser automation, NO external AI API key.
// The "AI" is a built-in rule engine + verified problem-template engine that runs
// through the existing Supabase client (`sb`) using the admin RLS policies.
//
// Modules:
//   1. Discussion moderation  — scans English comments, deletes abusive ones,
//      sends a warning notification to the offender.
//   2. Auto problem factory   — generates Fix-the-Bug + Predict-Output problems
//      with ALL fields filled + exactly 3 hints. Buggy code always contains a
//      real, verified bug; expected outputs are computed (never guessed).
//   3. Duplicate guard        — never inserts a duplicate; auto-deletes existing
//      duplicates (plus their submissions/discussions).
//   4. Auto notifications     — offender warnings, new-problem alerts, welcome msgs.
//
// Master ON/OFF + per-module toggles live in localStorage (instant) and sync
// best-effort to the `ai_settings` table (Supabase) so every admin device agrees.

/* ============================================================
   1. SETTINGS
   ============================================================ */

const AI_STORE_KEY = "pydebug_ai_settings_v1";
const AI_LOG_KEY = "pydebug_ai_logs_v1";
const AI_LOCK_KEY = "pydebug_ai_lock_v1";
const AI_LASTRUN_KEY = "pydebug_ai_lastrun_v1";

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
  expiry: true,        // premium expiry / expired reminders
  winback: false,      // win-back ping for inactive users
  stuck: true,         // encouragement for stuck users
  leaderboard: false,  // leaderboard climb alerts
  faq: false,          // FAQ auto-helper replies
  hindi: true,         // Hindi/Hinglish abuse filter (English always on)
};

function AI_getSettings() {
  try {
    const raw = localStorage.getItem(AI_STORE_KEY);
    if (!raw) return { ...AI_DEFAULTS };
    return { ...AI_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...AI_DEFAULTS };
  }
}

function AI_saveSettings(patch) {
  const next = { ...AI_getSettings(), ...patch };
  try {
    localStorage.setItem(AI_STORE_KEY, JSON.stringify(next));
  } catch (e) { /* private mode — ignore */ }
  AI_pushSettings(next); // best-effort cloud sync, never throws
  return next;
}

// Best-effort sync to Supabase so ON/OFF state follows the admin account.
// Silently no-ops when the `ai_settings` table doesn't exist yet (SQL not run).
async function AI_pushSettings(settings) {
  try {
    if (typeof sb === "undefined") return;
    await sb.from("ai_settings").upsert(
      { key: "control", value: settings || AI_getSettings(), updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  } catch (e) { /* table missing / offline — localStorage is the fallback */ }
}

async function AI_pullSettings() {
  try {
    if (typeof sb === "undefined") return AI_getSettings();
    const { data, error } = await sb.from("ai_settings").select("value").eq("key", "control").single();
    if (!error && data && data.value) {
      const merged = { ...AI_DEFAULTS, ...data.value };
      try { localStorage.setItem(AI_STORE_KEY, JSON.stringify(merged)); } catch (e) {}
      return merged;
    }
  } catch (e) { /* ignore */ }
  return AI_getSettings();
}

function AI_getLastRuns() {
  try {
    return JSON.parse(localStorage.getItem(AI_LASTRUN_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function AI_setLastRun(name) {
  try {
    const all = AI_getLastRuns();
    all[name] = Date.now();
    localStorage.setItem(AI_LASTRUN_KEY, JSON.stringify(all));
  } catch (e) {}
}

/* ============================================================
   2. ACTIVITY LOG
   ============================================================ */

function AI_log(action, detail, level) {
  const entry = {
    t: new Date().toISOString(),
    level: level || "info",
    action: String(action || ""),
    detail: String(detail || ""),
  };
  try {
    const logs = JSON.parse(localStorage.getItem(AI_LOG_KEY) || "[]");
    logs.unshift(entry);
    localStorage.setItem(AI_LOG_KEY, JSON.stringify(logs.slice(0, 200)));
  } catch (e) {}
  // Best-effort cloud copy (fire-and-forget; never blocks, never throws).
  try {
    if (typeof sb !== "undefined") {
      sb.from("ai_logs").insert({ level: entry.level, action: entry.action, detail: entry.detail })
        .then(() => {}, () => {});
    }
  } catch (e) {}
  return entry;
}

function AI_getLogs() {
  try {
    return JSON.parse(localStorage.getItem(AI_LOG_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function AI_clearLogs() {
  try { localStorage.removeItem(AI_LOG_KEY); } catch (e) {}
}

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

// Small badge HTML used by the Discussions page to highlight abusive rows.
function AI_badgeFor(content) {
  try {
    const r = AI_scanText(content);
    if (!r.flagged) return "";
    const label = r.severity === "spam" ? "Spam" : r.severity === "severe" ? "Abusive" : "Rude";
    const tip = "AI: " + r.hits.slice(0, 3).join(", ");
    return ` <span class="tag tag--failed" title="${String(tip).replace(/"/g, "&quot;")}">⚠️ ${label}</span>`;
  } catch (e) {
    return "";
  }
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

  { id: "bug-loops-offbyone", topic: "loops", type: "bug", difficulty: "easy",
    make() {
      const n = AI_ri(5, 12);
      let total = 0; for (let i = 1; i <= n; i++) total += i;
      return {
        title: `Off-by-one total (1 to ${n})`,
        description: `This program should print the sum of numbers from 1 to ${n}, but it prints the wrong answer. Fix the loop so it prints ${total}.`,
        starter_code: `n = ${n}\ntotal = 0\nfor i in range(1, n):\n    total = total + i\nprint(total)`,
        fixed_code: `n = ${n}\ntotal = 0\nfor i in range(1, n + 1):\n    total = total + i\nprint(total)`,
        expected_output: String(total),
        hints: [
          "In Python, range(a, b) stops BEFORE b — the end value is never included.",
          `Your loop runs i = 1..${n - 1} but you need it to reach ${n}.`,
          "Change range(1, n) to range(1, n + 1) so the last number is included.",
        ],
        bug: "off-by-one (logic)", marker: "range(1, n):",
        proof: `sum(1..${n}) = ${total}, computed by looping in the generator`,
      };
    } },

  { id: "bug-loops-odds", topic: "loops", type: "bug", difficulty: "easy",
    make() {
      const N = AI_pick([6, 8, 10, 12]);
      const evens = []; for (let i = 0; i < N; i += 2) evens.push(String(i));
      return {
        title: `Even numbers printed as odds (below ${N})`,
        description: `This program should print the even numbers below ${N} (one per line), but it prints odd numbers instead. Fix the range.`,
        starter_code: `for i in range(1, ${N}, 2):\n    print(i)`,
        fixed_code: `for i in range(0, ${N}, 2):\n    print(i)`,
        expected_output: evens.join("\n"),
        hints: [
          "range(start, stop, step) begins at 'start' — check where your loop begins.",
          "Starting at 1 with step 2 gives 1, 3, 5... which are odd numbers.",
          `Change the start value from 1 to 0 to get ${evens.join(", ")}.`,
        ],
        bug: "wrong range start (logic)", marker: `range(1, ${N}, 2)`,
        proof: `fixed loop yields exactly ${evens.join(",")}`,
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

  { id: "bug-strings-parens", topic: "strings", type: "bug", difficulty: "easy",
    make() {
      const word = AI_pick(["python", "debug", "coding", "planet", "rocket", "tiger", "laptop", "jungle", "river", "mountain", "window", "garden"]);
      return {
        title: "Missing parentheses on upper()",
        description: `This program should print ${word.toUpperCase()} but instead prints something like <built-in method ...>. Fix the method call.`,
        starter_code: `msg = '${word}'\nprint(msg.upper)`,
        fixed_code: `msg = '${word}'\nprint(msg.upper())`,
        expected_output: word.toUpperCase(),
        hints: [
          "Writing msg.upper without brackets refers to the METHOD itself instead of calling it.",
          "The strange <built-in method ...> output is the method object, not the result.",
          "Add parentheses: print(msg.upper()) to actually call the method.",
        ],
        bug: "missing call parentheses (logic)", marker: "print(msg.upper)",
        proof: `upper() of '${word}' = '${word.toUpperCase()}'`,
      };
    } },

  { id: "bug-sorting-reverse", topic: "sorting", type: "bug", difficulty: "easy",
    make() {
      const base = AI_shuffle([AI_ri(1, 9), AI_ri(10, 19), AI_ri(20, 29), AI_ri(30, 39), AI_ri(40, 49)]);
      const asc = [...base].sort((x, y) => x - y);
      return {
        title: "Sorted backwards (reverse flag)",
        description: `This program should print the list in ASCENDING order, but it prints descending. Fix the sort so it prints ${AI_pyList(asc)}.`,
        starter_code: `nums = ${AI_pyList(base)}\nnums.sort(reverse=True)\nprint(nums)`,
        fixed_code: `nums = ${AI_pyList(base)}\nnums.sort()\nprint(nums)`,
        expected_output: AI_pyList(asc),
        hints: [
          "The sort() method accepts a 'reverse' parameter — check what it is set to.",
          "reverse=True sorts biggest-first (descending), but the task needs ascending.",
          "Remove reverse=True (or set reverse=False) to sort smallest-first.",
        ],
        bug: "wrong reverse flag (logic)", marker: "reverse=True",
        proof: "ascending sort of the input computed by the generator",
      };
    } },

  { id: "bug-functions-noreturn", topic: "functions", type: "bug", difficulty: "easy",
    make() {
      const a = AI_ri(2, 20), b = AI_ri(2, 20);
      return {
        title: `Function prints None instead of ${a + b}`,
        description: `add(${a}, ${b}) should return ${a + b}, but the program prints None. Fix the function so it prints ${a + b}.`,
        starter_code: `def add(a, b):\n    result = a + b\nprint(add(${a}, ${b}))`,
        fixed_code: `def add(a, b):\n    return a + b\nprint(add(${a}, ${b}))`,
        expected_output: String(a + b),
        hints: [
          "A function without a 'return' statement always gives back None.",
          "The sum is calculated but never returned to the caller.",
          "Replace 'result = a + b' with 'return a + b' (or add 'return result').",
        ],
        bug: "missing return (prints None)", marker: "result = a + b",
        proof: `${a} + ${b} = ${a + b}`,
      };
    } },

  { id: "bug-functions-swapped", topic: "functions", type: "bug", difficulty: "medium",
    make() {
      const name = AI_names();
      const msg = AI_pick(["Hello", "Hi", "Welcome", "Good morning"]);
      return {
        title: "Swapped function arguments",
        description: `This program should print "${msg}, ${name}" but the arguments are passed in the wrong order. Fix the function call.`,
        starter_code: `def greet(name, msg):\n    print(msg + ', ' + name)\ngreet('${msg}', '${name}')`,
        fixed_code: `def greet(name, msg):\n    print(msg + ', ' + name)\ngreet('${name}', '${msg}')`,
        expected_output: `${msg}, ${name}`,
        hints: [
          "Arguments are matched to parameters by POSITION: first value goes to 'name'.",
          `Currently name='${msg}' and msg='${name}' — the values are swapped.`,
          `Change the call to greet('${name}', '${msg}').`,
        ],
        bug: "swapped arguments (logic)", marker: `greet('${msg}', '${name}')`,
        proof: `correct order prints '${msg}, ${name}'`,
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

  { id: "bug-generators-consumed", topic: "generators", type: "bug", difficulty: "hard",
    make() {
      const n = AI_ri(3, 8);
      const sq = []; for (let i = 0; i < n; i++) sq.push(i * i);
      return {
        title: "Generator exhausted on second use",
        description: `This program prints the squares list correctly, but then prints 0 instead of ${n}. Fix it (store list(gen) in a variable) so the second line prints ${n}.`,
        starter_code: `gen = (x * x for x in range(${n}))\nprint(list(gen))\nprint(len(list(gen)))`,
        fixed_code: `gen = (x * x for x in range(${n}))\nvals = list(gen)\nprint(vals)\nprint(len(vals))`,
        expected_output: `${AI_pyList(sq)}\n${n}`,
        hints: [
          "A generator can be consumed only ONCE — after list(gen), it is empty.",
          "The second list(gen) therefore produces [] whose length is 0.",
          "Save the list first: vals = list(gen), then print vals and len(vals).",
        ],
        bug: "consumed generator (logic)", marker: "print(len(list(gen)))",
        proof: `squares 0..${n - 1} = ${AI_pyList(sq)}, count ${n}`,
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
    if (p.marker) {
      checks.push({ label: `Bug verified in code (${p.bug || "bug"})`, pass: p.starter_code.includes(p.marker) });
      checks.push({ label: "Bug absent from fixed code", pass: !has(p.fixed_code) || !p.fixed_code.includes(p.marker) });
    }
  } else {
    checks.push({ label: "Output computed (proof attached)", pass: has(p.proof) });
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
    if (!opts.auto) AI_log("moderation_scan", `Scanned ${comments.length} comments — all clean.`, "success");
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
      AI_log("moderation_error", `Could not delete comment ${c.id}: ${delErr.message}`, "error");
      continue;
    }
    removed++;
    AI_log("moderation_removed", `Deleted ${label} comment (${scan.hits.slice(0, 3).join(", ")}) on "${titleById[c.problem_id] || "a problem"}".`, "warn");

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
        AI_log("warning_sent", `Warned user about removed ${label} comment.`, "info");
      }
    }
  }
  AI_log("moderation_scan", `Scanned ${comments.length} comments — removed ${removed}, warned ${warned}.`, removed ? "warn" : "success");
  return { scanned: comments.length, removed, warned };
}

// --- 6b. Generate + insert verified problems (never duplicates) ---
async function AI_generateProblems(count, opts) {
  opts = opts || {};
  const settings = AI_getSettings();
  const n = Math.max(1, Math.min(20, Number(count) || settings.per_run || 3));
  const { fps, maxNum } = await AI_fetchProblemsIndex();
  let nextNum = maxNum;
  const added = [];
  let skipped = 0;

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
    const { _proof, _bug, ...row } = payload;
    const { error } = await sb.from("problems").insert(row);
    if (error) {
      AI_log("problem_error", `Insert failed for "${row.title}": ${error.message}`, "error");
      skipped++;
      continue;
    }
    added.push(row);
    AI_log(
      "problem_added",
      `#${row.problem_number} "${row.title}" [${row.type}/${row.topic}/${row.difficulty}]${_bug ? " bug: " + _bug : ""} — ${_proof || "verified"}.`,
      "success"
    );
  }

  if (!added.length) {
    AI_log("problem_run", `Tried to add ${n} problem(s) — all skipped (duplicates or errors).`, "warn");
  } else if (settings.announce || opts.announce) {
    try {
      await AI_broadcastNewProblems(added);
    } catch (e) {
      AI_log("announce_error", "New-problem broadcast failed: " + e.message, "error");
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
    if (!opts.auto) AI_log("dedup_scan", `Scanned ${rows.length} problems — no duplicates found.`, "success");
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
        AI_log("dedup_error", `Could not delete duplicate "${v.title}": ${error.message}`, "error");
        continue;
      }
      removed.push(v);
      AI_log("dup_removed", `Deleted duplicate "${v.title}" (#${v.problem_number ?? "?"}) — kept "${keeper.title}" (#${keeper.problem_number ?? "?"}).`, "warn");
    }
  }
  AI_log("dedup_scan", `Scanned ${rows.length} problems — ${dupGroups.length} duplicate group(s), removed ${removed.length}.`, removed.length ? "warn" : "success");
  return { scanned: rows.length, groups: dupGroups.length, removed };
}

// --- 6e. Broadcast "new AI problems" notification to all users ---
async function AI_broadcastNewProblems(added) {
  const list = added.slice(0, 3).map((p) => `• ${p.title}`).join("\n");
  const more = added.length > 3 ? `\n…and ${added.length - 3} more!` : "";
  const title = `🤖 ${added.length} new problem${added.length === 1 ? "" : "s"} just dropped!`;
  const message = `Fresh challenges are live:\n${list}${more}\nSolve them now to earn XP!`;

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
  AI_log("announce_sent", `Told ${sent} users about ${added.length} new AI problem(s).`, "success");
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
    if (!opts.auto) AI_log("welcome_scan", "No new users in the last 24h.", "info");
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
    AI_log("welcome_scan", `Welcomed ${todo.length} new user(s) (${fresh.length} joined in 24h).`, todo.length ? "success" : "info");
  }
  return { found: fresh.length, welcomed: todo.length };
}

// --- Stats for the AI Control page (from local log) ---
function AI_getStats() {
  const logs = AI_getLogs();
  const count = (a) => logs.filter((l) => l.action === a).length;
  return {
    commentsRemoved: count("moderation_removed"),
    warningsSent: count("warning_sent"),
    problemsAdded: count("problem_added"),
    duplicatesRemoved: count("dup_removed"),
    announcements: count("announce_sent"),
    lastRuns: AI_getLastRuns(),
    totalActions: logs.length,
  };
}

/* ============================================================
   7. REPORTS — daily digest, health score, difficulty calibration
   (Reports bundle — still 100% local logic, no API keys)
   ============================================================ */

const AI_DIGEST_KEY = "pydebug_ai_digest_v1";

// Generic cloud key-value on the ai_settings table (best-effort).
async function AI_kvSet(key, value) {
  try {
    if (typeof sb === "undefined") return false;
    const { error } = await sb.from("ai_settings").upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    return !error;
  } catch (e) {
    return false;
  }
}

async function AI_kvGet(key) {
  try {
    if (typeof sb === "undefined") return null;
    const { data, error } = await sb.from("ai_settings").select("value").eq("key", key).single();
    if (error || !data) return null;
    return data.value;
  } catch (e) {
    return null;
  }
}

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
  const logs = AI_getLogs().filter((l) => now - new Date(l.t).getTime() < 24 * 3600 * 1000);
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
  try { localStorage.setItem(AI_DIGEST_KEY, JSON.stringify(digest)); } catch (e) {}
  AI_kvSet("digest", digest);
  AI_log("digest_built", `Digest: ${newUsers ?? "?"} new users, ${subs24 ?? "?"} submissions, solve ${solveRate ?? "?"}%.`, "success");
  return digest;
}

async function AI_getDigest() {
  try {
    const raw = localStorage.getItem(AI_DIGEST_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
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
      AI_log("difficulty_changed", `"${it.title || it.problem_id}" → ${it.suggested} (${it.reason || "calibration"}).`, "success");
    } else {
      AI_log("difficulty_error", `Could not update ${it.problem_id}: ${error.message}`, "error");
    }
  }
  return ok;
}
