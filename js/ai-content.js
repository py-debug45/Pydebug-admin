// ai-content.js — Content-AI runners (Own-AI, no API keys).
// Loads AFTER ai-brain.js. Modules: topic-gap filler, problem variations,
// quality report, auto hint repair, bulk import (JSON/CSV).

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
    AI_log("gapfill_error", "Could not read topic map: " + e.message, "error");
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
      const numNext = ++nextNum;
      payload = {
        type: p.type, title: p.title, slug: AI_slugFor(p.title, numNext), description: p.description,
        difficulty: p.difficulty, topic: p.topic, problem_number: numNext,
        is_premium: false, admin_skip_notification: true, starter_code: p.starter_code,
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
    const { error } = await sb.from("problems").insert(row);
    if (error) {
      AI_log("problem_error", `Gap-fill insert failed for "${row.title}": ${error.message}`, "error");
      skipped++;
      continue;
    }
    added.push(row);
    AI_log("problem_added", `#${row.problem_number} "${row.title}"${row.is_premium ? " ⭐ PREMIUM" : ""} — gap-fill ${_gap}.`, "success");
  }
  if (premCount) {
    AI_log("premium_mix", `Gap-fill: marked ${premCount}/${batch.length} problem(s) as ⭐ Premium.`, "info");
  }
  if (!added.length) AI_log("problem_run", `Gap-fill tried ${n} — all skipped (duplicates).`, "warn");
  return { added, skipped, cells: ranked.slice(0, 5) };
}

// --- Create N variations of one problem (same topic/type/difficulty) ---
async function AI_generateVariations(problemId, n) {
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
      const numNext = ++nextNum;
      payload = {
        type: p.type, title: p.title, slug: AI_slugFor(p.title, numNext), description: p.description,
        difficulty: p.difficulty, topic: p.topic, problem_number: numNext,
        is_premium: !!src.is_premium, admin_skip_notification: true, starter_code: p.starter_code,
        expected_output: p.expected_output, hints: p.hints,
      };
      fps.add(AI_fingerprint(p.starter_code, p.expected_output));
    }
    if (!payload) { skipped++; continue; }
    const { error } = await sb.from("problems").insert(payload);
    if (error) { skipped++; continue; }
    added.push(payload);
    AI_log("problem_added", `#${payload.problem_number} "${payload.title}" — variation of #${src.problem_number ?? "?"} "${src.title}".`, "success");
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
      .select("id,problem_number,title,slug,type,difficulty,topic,hints,starter_code,expected_output,description")
      .order("problem_number", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    (data || []).forEach((r) => probs.push(r));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  const numCount = {};
  const titleCount = {};
  probs.forEach((p) => {
    if (p.problem_number !== null && p.problem_number !== undefined) {
      numCount[p.problem_number] = (numCount[p.problem_number] || 0) + 1;
    }
    const tk = String(p.title || "").trim().toLowerCase();
    if (tk) titleCount[tk] = (titleCount[tk] || 0) + 1;
  });
  const issues = [];
  probs.forEach((p) => {
    const flags = [];
    const tk = String(p.title || "").trim().toLowerCase();
    if (!tk || tk.length < 8) flags.push("short-title");
    else if (titleCount[tk] > 1) flags.push(`dup-title:${titleCount[tk]}x`);
    if (!String(p.slug || "").trim()) flags.push("no-slug");
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
  AI_log("quality_run", `Quality scan: ${probs.length} problems, ${issues.length} with issues.`, issues.length ? "warn" : "success");
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
  AI_log("hints_fixed", `Hint repair: ${fixed} problem(s) topped up to 3 hints.`, fixed ? "success" : "info");
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

async function AI_runBulkImport(validated) {
  const good = validated.filter((r) => r.ok);
  if (!good.length) return { added: 0 };
  const { maxNum } = await AI_fetchProblemsIndex();
  let nextNum = maxNum;
  let added = 0;
  for (const r of good) {
    const p = r.payload;
    const numNext = ++nextNum;
    const { error } = await sb.from("problems").insert({
      type: p.type, title: p.title, slug: AI_slugFor(p.title, numNext), description: p.description,
      difficulty: p.difficulty, topic: p.topic, problem_number: numNext,
      is_premium: !!p.is_premium, admin_skip_notification: true, starter_code: p.starter_code,
      expected_output: p.expected_output, hints: p.hints.filter((h) => String(h || "").trim()),
    });
    if (!error) added++;
  }
  AI_log("bulk_import", `Bulk import: ${added}/${good.length} valid row(s) inserted.`, added ? "success" : "warn");
  return { added };
}
