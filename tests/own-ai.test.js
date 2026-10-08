"use strict";

/*
 * Tests for the Own-AI Control Center port: the engine (lib/server/own-ai.js)
 * and its API surface (api/ai.js). The engine's Supabase-style queries run
 * against a small in-memory PostgREST fake (the same ops the dev-server mock
 * supports), so factory, guards, moderation, reports and the watch tick are
 * exercised end-to-end. A real-CPython cross-check runs when python3 exists.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ownAi = require("../lib/server/own-ai");
const aiApi = require("../api/ai");
const db = require("../api/_db");

const ADMIN = { admin_id: "00000000-0000-4000-8000-000000000001", role: "superadmin", email: "root@pydebug.local" };
const EDITOR = { admin_id: "00000000-0000-4000-8000-000000000002", role: "content_editor", email: "dev@pydebug.local" };
const MODERATOR = { admin_id: "00000000-0000-4000-8000-000000000003", role: "moderator", email: "mod@pydebug.local" };
const ANALYST = { admin_id: "00000000-0000-4000-8000-000000000004", role: "analyst", email: "analyst@pydebug.local" };
const FINANCE = { admin_id: "00000000-0000-4000-8000-000000000005", role: "finance", email: "finance@pydebug.local" };

/* ---------------- in-memory PostgREST fake ---------------- */

function loose(stored, value) {
  if (stored === null || stored === undefined) return value === null;
  if (typeof stored === "boolean") return value === stored;
  if (typeof stored === "number") return Number(value) === stored;
  return String(value) === String(stored);
}

function parseIn(raw) {
  return String(raw).replace(/^\(/, "").replace(/\)$/, "").split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
}

function makeFakeDb(seed = {}) {
  const tables = new Map();
  for (const [name, rows] of Object.entries(seed)) tables.set(name, rows.map((row) => ({ ...row })));
  const rows = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };
  const parse = (raw) => (raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw);
  function matches(row, filter) {
    const stored = row[filter.column];
    const op = filter.op;
    const value = filter.value;
    if (op === "eq") return loose(stored, parse(value));
    if (op === "neq") return !loose(stored, parse(value));
    if (op === "in") return parseIn(value).some((item) => loose(stored, parse(item)));
    if (op === "is") return stored === null || stored === undefined ? value === "null" : String(stored) === String(value);
    if (op === "ilike") return String(stored ?? "").toLowerCase().includes(String(value).replace(/\*/g, "").toLowerCase());
    if (["gte", "lte", "gt", "lt"].includes(op)) {
      const a = typeof stored === "number" ? stored : (Date.parse(stored) || String(stored ?? ""));
      const b = typeof value === "number" ? value : (Date.parse(value) || String(value ?? ""));
      if (typeof a === "number" && typeof b === "number") {
        if (op === "gte") return a >= b;
        if (op === "lte") return a <= b;
        if (op === "gt") return a > b;
        return a < b;
      }
      const sa = String(a); const sb = String(b);
      if (op === "gte") return sa >= sb;
      if (op === "lte") return sa <= sb;
      if (op === "gt") return sa > sb;
      return sa < sb;
    }
    return true;
  }
  function applyFilters(table, filters = []) {
    return rows(table).filter((row) => filters.every((filter) => matches(row, filter)));
  }
  function sortRows(list, order) {
    if (!order) return list;
    const [column, direction] = String(order).split(".");
    const sorted = [...list].sort((a, b) => {
      const av = a[column] ?? ""; const bv = b[column] ?? "";
      return av === bv ? 0 : (av > bv ? 1 : -1);
    });
    return direction === "desc" ? sorted.reverse() : sorted;
  }
  const fake = {
    tables,
    async list(table, options = {}) {
      let result = applyFilters(table, options.filters || []);
      result = sortRows(result, options.order);
      const count = result.length;
      const offset = Number(options.offset || 0);
      const limit = options.limit === undefined ? undefined : Number(options.limit);
      const paged = limit === undefined ? result.slice(offset) : result.slice(offset, offset + limit);
      return { rows: paged, count };
    },
    async count(table, options = {}) {
      return applyFilters(table, options.filters || []).length;
    },
    async insert(table, body, options = {}) {
      const list = Array.isArray(body) ? body : [body];
      const inserted = list.map((item) => {
        if (options.upsert && options.onConflict) {
          const existing = rows(table).find((row) => row[options.onConflict] === item[options.onConflict]);
          if (existing) { Object.assign(existing, item); return existing; }
        }
        const row = { id: `fake-${table}-${rows(table).length + 1}`, created_at: new Date().toISOString(), ...item };
        rows(table).push(row);
        return row;
      });
      return Array.isArray(body) ? inserted : inserted[0];
    },
    async update(table, values, options = {}) {
      const targets = applyFilters(table, options.filters || []);
      targets.forEach((row) => Object.assign(row, values));
      return targets;
    },
    async remove(table, options = {}) {
      const targets = new Set(applyFilters(table, options.filters || []));
      const kept = rows(table).filter((row) => !targets.has(row));
      tables.set(table, kept);
      return [...targets];
    },
  };
  return fake;
}

/* Swap api/_db for the fake for the duration of a test. */
function withFakeDb(seed, fn) {
  return async () => {
    const fake = makeFakeDb(seed);
    const originals = {};
    for (const key of ["list", "count", "insert", "update", "remove"]) {
      originals[key] = db[key];
      db[key] = fake[key].bind(fake);
    }
    try {
      await fn(fake);
    } finally {
      for (const key of Object.keys(originals)) db[key] = originals[key];
    }
  };
}

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function seedLibrary() {
  return {
    ai_settings: [],
    ai_logs: [],
    admin_audit_log: [],
    problems: [
      { id: "p-dup-1", type: "question", title: "Same problem", description: "d", difficulty: "easy", topic: "lists", is_premium: false, starter_code: "print('hello world')", expected_output: "hello world", hints: ["a", "b", "c"], problem_number: 1, created_at: iso(10 * DAY) },
      { id: "p-dup-2", type: "question", title: "Same problem", description: "d", difficulty: "easy", topic: "lists", is_premium: false, starter_code: "print('hello world')", expected_output: "hello world", hints: ["a", "b", "c"], problem_number: 2, created_at: iso(5 * DAY) },
      { id: "p-badbug", type: "bug", title: "Error-free bug", description: "d", difficulty: "easy", topic: "strings", is_premium: false, starter_code: "print('this runs fine')", expected_output: "this runs fine", hints: ["a", "b", "c"], problem_number: 3, created_at: iso(3 * DAY) },
      { id: "p-goodbug", type: "bug", title: "Real bug", description: "d", difficulty: "easy", topic: "strings", is_premium: false, starter_code: "n = '5'\nfor i in range(n):\n    print(i)", expected_output: "0\n1", hints: ["a", "b", "c"], problem_number: 4, created_at: iso(2 * DAY) },
    ],
    problem_discussions: [
      { id: "c-abuse", problem_id: "p-goodbug", user_id: "u-bad", content: "you fucking idiot, this is shit", created_at: iso(1 * DAY) },
      { id: "c-nice", problem_id: "p-goodbug", user_id: "u-nice", content: "Nice problem, thanks!", created_at: iso(1 * DAY) },
    ],
    discussion_likes: [{ id: "l1", comment_id: "c-abuse", user_id: "u-nice" }],
    profiles: [
      { id: "u-bad", display_name: "Bad User", email: "bad@example.com", xp: 10, created_at: iso(30 * DAY), last_active_date: iso(1 * DAY).slice(0, 10) },
      { id: "u-nice", display_name: "Nice User", email: "nice@example.com", xp: 20, created_at: iso(20 * DAY), last_active_date: iso(1 * DAY).slice(0, 10) },
    ],
    submissions: [],
    notifications: [],
  };
}

/* ---------------- engine: pure functions ---------------- */

test("moderation scanner flags abuse, leet, spam and Hindi; passes clean text", () => {
  assert.deepEqual(ownAi.scanText("Nice solution, thanks!"), { flagged: false, severity: null, hits: [] });
  assert.equal(ownAi.scanText("you are a fucking idiot").flagged, true);
  assert.equal(ownAi.scanText("you are a fucking idiot").severity, "severe");
  assert.equal(ownAi.scanText("sh1t this code").severity, "severe");
  assert.equal(ownAi.scanText("Earn money fast, click https://spam.example.com now").severity, "spam");
  assert.equal(ownAi.scanText("teri maa ka bhosda").flagged, true);
  assert.equal(ownAi.scanText("tum chutiya ho").flagged, true);
  assert.equal(ownAi.scanText("").flagged, false);
});

test("fingerprint ignores whitespace and case, and refuses tiny snippets", () => {
  const a = ownAi.fingerprint("print(  'hello'  )", "hello");
  const b = ownAi.fingerprint("print('hello')", "hello");
  assert.equal(a, b);
  assert.equal(ownAi.fingerprint("x = 1", "1"), null, "short snippets are never duplicates");
});

test("validateProblem accepts a real bug problem and rejects broken ones", () => {
  const fps = new Set();
  const good = {
    type: "bug", title: "TypeError: range gets text", description: "Fix the range call so it prints 0 to 4, one per line.",
    topic: "loops", difficulty: "easy",
    starter_code: "n = '5'\nfor i in range(n):\n    print(i)", fixed_code: "n = 5\nfor i in range(n):\n    print(i)",
    expected_output: "0\n1\n2\n3\n4", hints: ["range() needs an integer.", "n holds text, not a number.", "Remove the quotes around 5."],
    bug: "TypeError", marker: "n = '5'", proof: "fixed prints 0..4",
  };
  assert.equal(ownAi.validateProblem(good, fps).ok, true);
  const noError = { ...good, starter_code: "print('fine')", fixed_code: "print('fine')" };
  assert.equal(ownAi.validateProblem(noError, fps).ok, false, "bug code that raises no error must fail");
  const noProof = {
    type: "question", title: "Print hello", description: "Print hello to the console.", topic: "strings", difficulty: "easy",
    starter_code: "print('hello world')", expected_output: "hello world", hints: ["Use the print function.", "Strings are quoted.", "Check the output text."],
  };
  assert.equal(ownAi.validateProblem(noProof, fps).ok, false, "question without a computed-output proof must fail");
});

test("static detector finds real Python errors and passes clean code", () => {
  assert.equal(ownAi.detectPythonError("x = 1\nprint(x)").error, null);
  assert.equal(ownAi.detectPythonError("n = '5'\nfor i in range(n):\n    print(i)").error, "TypeError");
  assert.equal(ownAi.detectPythonError("nums = [1, 2]\nfor i in range(3):\n    print(nums[i])").error, "IndexError");
  const report = ownAi.diagnoseCode("items = [3, 1, 2]\nordered = items.sort()\nprint(ordered)");
  assert.ok(report.diagnostics.some((d) => /sort/i.test(d.message)), "sort() returning None must be diagnosed");
  const bad = ownAi.diagnoseCode("n = '5'\nfor i in range(n):\n    print(i)");
  assert.equal(bad.ok, false, "code with a real error is not ok");
});

test("premium mix marks roughly the configured share, hardest first", () => {
  const batch = ownAi.sampleProblems(10);
  const settings = { ...ownAi.DEFAULTS, premium_mix: true, premium_percent: 30 };
  const marked = ownAi.applyPremiumMix(batch, settings);
  assert.ok(marked >= 2 && marked <= 4, `30% of 10 should mark 2-4, got ${marked}`);
  assert.equal(batch.filter((p) => p.is_premium).length, marked);
  const off = ownAi.applyPremiumMix(ownAi.sampleProblems(6), { ...ownAi.DEFAULTS, premium_mix: false });
  assert.equal(off, 0);
});

test("bulk import parses JSON and CSV and validates every row", () => {
  const json = ownAi.parseBulkImport(JSON.stringify([
    { type: "question", title: "Print hello", difficulty: "easy", topic: "strings", starter_code: "print('hello world')", expected_output: "hello world", hints: ["a", "b", "c"] },
    { type: "bug", title: "Broken", difficulty: "easy", topic: "strings", starter_code: "print('fine')", expected_output: "fine", hints: ["a", "b", "c"] },
  ]), "json");
  assert.equal(json.errors.length, 0);
  assert.equal(json.rows.length, 2);
  const csv = ownAi.parseBulkImport("type,title,difficulty,topic,starter_code,expected_output,hint1,hint2,hint3\nquestion,Print hi,easy,strings,print('hi there'),hi there,a,b,c", "csv");
  assert.equal(csv.errors.length, 0);
  assert.equal(csv.rows.length, 1);
  assert.equal(csv.rows[0].hints.length, 3);
  const bad = ownAi.parseBulkImport("not json", "json");
  assert.ok(bad.errors.length >= 1);
});

test("sampleProblems produce complete, validated problem rows", () => {
  const samples = ownAi.sampleProblems(10);
  assert.equal(samples.length, 10);
  for (const problem of samples) {
    assert.ok(["bug", "question"].includes(problem.type));
    assert.ok(["easy", "medium", "hard"].includes(problem.difficulty));
    assert.ok(ownAi.TOPICS.includes(problem.topic));
    assert.ok(problem.title.length >= 10);
    assert.ok(problem.description.length >= 20);
    assert.equal(problem.hints.length, 3, "factory problems always carry exactly 3 hints");
    assert.ok(problem.starter_code.length > 10);
    assert.ok(problem.expected_output.length > 0);
    if (problem.type === "bug") assert.ok(problem.battle_error.length > 0, "bug rows carry the detected error class");
    else assert.equal(problem.battle_error, "");
  }
});

/* ---------------- engine + API against the fake DB ---------------- */

test("settings load with defaults, save through the API and survive a reload", withFakeDb({ ai_settings: [], ai_logs: [], admin_audit_log: [] }, async (fake) => {
  const before = await aiApi._internals.actSaveSettings(ADMIN, { patch: { master: true, per_run: 7, bogus_key: "x" } }, "enable guard", "127.0.0.1");
  assert.equal(before.settings.master, true);
  assert.equal(before.settings.per_run, 7);
  assert.equal(before.settings.bogus_key, undefined, "unknown keys are never stored");
  assert.deepEqual(before.changed.sort(), ["master", "per_run"]);
  const { settings } = await ownAi.loadState();
  assert.equal(settings.master, true);
  assert.equal(settings.per_run, 7);
  assert.equal(fake.tables.get("admin_audit_log").length, 1, "settings save is audit-logged");
  assert.equal(fake.tables.get("admin_audit_log")[0].resource, "ai");
  assert.equal(fake.tables.get("admin_audit_log")[0].action, "save_settings");
  assert.throws(() => ownAi.validateSettingsPatch("nope"), (error) => error.status === 400);
}));

test("moderation scan deletes the abusive comment, warns the offender and logs it", withFakeDb(seedLibrary(), async (fake) => {
  await ownAi.loadState();
  const result = await aiApi._internals.actScan(ADMIN, "test scan", "127.0.0.1");
  assert.equal(result.scanned, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.warned, 1);
  assert.deepEqual(fake.tables.get("problem_discussions").map((c) => c.id), ["c-nice"]);
  assert.equal(fake.tables.get("discussion_likes").length, 0, "likes of removed comments go too");
  const warnings = fake.tables.get("notifications").filter((n) => /removed/i.test(n.title));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].user_id, "u-bad");
  assert.ok(fake.tables.get("ai_logs").some((l) => l.action === "moderation_removed"));
  assert.ok(fake.tables.get("admin_audit_log").some((a) => a.action === "scan" && a.resource === "ai"));
}));

test("factory generate inserts validated problems with the new-panel columns", withFakeDb(seedLibrary(), async (fake) => {
  await ownAi.loadState();
  const result = await aiApi._internals.actGenerate(ADMIN, { count: 4 }, "test batch", "127.0.0.1");
  assert.equal(result.added.length, 4);
  assert.equal(result.skipped, 0);
  const inserted = fake.tables.get("problems").filter((p) => !["p-dup-1", "p-dup-2", "p-badbug", "p-goodbug"].includes(p.id));
  assert.equal(inserted.length, 4);
  for (const row of inserted) {
    assert.equal(row.status, "published");
    assert.equal(row.created_by, ADMIN.admin_id);
    assert.equal(row.admin_skip_notification, true);
    assert.equal(row.hints.length, 3);
    if (row.type === "bug") assert.ok(row.battle_error.length > 0);
  }
  const problemNumbers = inserted.map((p) => p.problem_number);
  assert.equal(new Set(problemNumbers).size, 4, "problem numbers are unique");
  assert.ok(Math.max(...problemNumbers) > 4, "numbering continues past the seeded max");
  assert.ok(fake.tables.get("ai_logs").some((l) => l.action === "problem_added"));
}));

test("duplicate guard removes the newer duplicate and its children", withFakeDb(seedLibrary(), async (fake) => {
  await ownAi.loadState();
  const result = await aiApi._internals.actDedup(ADMIN, "test dedup", "127.0.0.1");
  assert.equal(result.scanned, 4);
  assert.equal(result.groups, 1);
  assert.equal(result.removed.length, 1);
  const ids = fake.tables.get("problems").map((p) => p.id).sort();
  assert.deepEqual(ids, ["p-badbug", "p-dup-1", "p-goodbug"], "the OLDEST duplicate survives");
  assert.ok(fake.tables.get("ai_logs").some((l) => l.action === "dup_removed"));
}));

test("bug error-guard deletes error-free bug problems (dry run first)", withFakeDb(seedLibrary(), async (fake) => {
  await ownAi.loadState();
  const dry = await aiApi._internals.actErrguard(ADMIN, { dry_run: true }, "dry", "127.0.0.1");
  assert.equal(dry.dry_run, true);
  assert.equal(dry.candidates.length, 1, "only p-badbug runs clean");
  assert.equal(fake.tables.get("problems").length, 4, "dry run deletes nothing");
  const result = await aiApi._internals.actErrguard(ADMIN, {}, "test errguard", "127.0.0.1");
  assert.equal(result.removed.length, 1);
  assert.ok(!fake.tables.get("problems").some((p) => p.id === "p-badbug"));
  assert.ok(fake.tables.get("problems").some((p) => p.id === "p-goodbug"), "real bugs survive");
}));

test("watch tick is a no-op while the master switch is OFF and rate-limits repeat calls", withFakeDb(seedLibrary(), async () => {
  await ownAi.loadState();
  const off = await aiApi._internals.actWatch(ADMIN);
  assert.deepEqual(off, { ran: false, reason: "master_off" });
  await ownAi.saveSettings({ master: true, moderation: true });
  await ownAi.loadState();
  const first = await aiApi._internals.actWatch(ADMIN);
  assert.equal(first.ran, true);
  assert.ok(first.results.some((r) => r.name === "moderation"), "moderation runs on every tick");
  const second = await aiApi._internals.actWatch(ADMIN);
  assert.equal(second.ran, false);
  assert.equal(second.reason, "rate_limited", "cross-tab lock: one tick per 55s");
}));

test("health check scores the panel and offers fix actions", withFakeDb(seedLibrary(), async () => {
  await ownAi.loadState();
  const health = await aiApi._internals.actHealth(ADMIN);
  assert.ok(health.score >= 0 && health.score <= 100);
  assert.ok(health.checks.length >= 5);
  const dupCheck = health.checks.find((c) => /duplicate/i.test(c.label));
  assert.ok(dupCheck && dupCheck.status === "bad", "seeded duplicates are reported");
  assert.equal(dupCheck.fix.id, "dedup");
  const abuseCheck = health.checks.find((c) => /abusive/i.test(c.label));
  assert.ok(abuseCheck && abuseCheck.status === "bad");
  assert.equal(abuseCheck.fix.id, "moderation");
}));

test("daily digest builds, caches and reports highlights", withFakeDb(seedLibrary(), async (fake) => {
  await ownAi.loadState();
  const digest = await aiApi._internals.actDigest(ADMIN, { build: true }, "test digest", "127.0.0.1");
  assert.ok(digest.generated_at);
  assert.ok(digest.stats.totalProblems >= 4);
  assert.ok(Array.isArray(digest.highlights) && digest.highlights.length >= 1);
  const cached = await ownAi.getDigest();
  assert.equal(cached.generated_at, digest.generated_at, "digest is cached in ai_settings");
  assert.ok(fake.tables.get("ai_logs").some((l) => l.action === "digest_built"));
}));

test("calibration suggests difficulty changes from real solve rates", withFakeDb({
  ai_settings: [], ai_logs: [], admin_audit_log: [],
  problems: [
    { id: "00000000-0000-4000-8000-0000000e0001", type: "question", title: "Too easy", difficulty: "hard", topic: "lists", starter_code: "print(1)", expected_output: "1", hints: ["a", "b", "c"], problem_number: 1, created_at: iso(9 * DAY) },
    { id: "00000000-0000-4000-8000-0000000e0002", type: "question", title: "Too hard", difficulty: "medium", topic: "lists", starter_code: "print(1)", expected_output: "1", hints: ["a", "b", "c"], problem_number: 2, created_at: iso(9 * DAY) },
  ],
  submissions: [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `s-easy-${i}`, user_id: `u-${i}`, problem_id: "00000000-0000-4000-8000-0000000e0001", status: "solved", created_at: iso(1 * DAY) })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `s-hard-${i}`, user_id: `u-${i}`, problem_id: "00000000-0000-4000-8000-0000000e0002", status: "attempted", created_at: iso(1 * DAY) })),
  ],
  problem_discussions: [], profiles: [], notifications: [],
}, async () => {
  await ownAi.loadState();
  const calib = await aiApi._internals.actCalibrate(ADMIN);
  assert.equal(calib.judged, 2);
  const tooEasy = calib.suggestions.find((s) => s.problem_id === "00000000-0000-4000-8000-0000000e0001");
  const tooHard = calib.suggestions.find((s) => s.problem_id === "00000000-0000-4000-8000-0000000e0002");
  assert.equal(tooEasy.suggested, "medium", "100% solve rate on a hard problem suggests medium");
  assert.equal(tooHard.suggested, "hard", "0% solve rate on a medium problem suggests hard");
  const applied = await aiApi._internals.actCalibrateApply(ADMIN, { items: [{ problem_id: "00000000-0000-4000-8000-0000000e0002", suggested: "hard", title: "Too hard", reason: "0% solve rate" }] }, "apply calibration", "127.0.0.1");
  assert.equal(applied, 1);
}));

test("bulk import inserts only valid rows", withFakeDb(seedLibrary(), async (fake) => {
  await ownAi.loadState();
  const text = JSON.stringify([
    { type: "question", title: "Imported question", description: "Predict what this program prints.", difficulty: "easy", topic: "strings", starter_code: "print('imported ok')", expected_output: "imported ok", hints: ["Use the print function.", "Strings are quoted text.", "Check the exact output."] },
    { type: "bug", title: "Imported broken bug", description: "Fix the bug so it prints.", difficulty: "easy", topic: "strings", starter_code: "print('no error here')", expected_output: "no error here", hints: ["This code runs cleanly.", "A bug must raise an error.", "Check the detector output."] },
  ]);
  const report = await aiApi._internals.actBulkValidate(ADMIN, { text, format: "json" });
  assert.equal(report.total, 2);
  assert.equal(report.valid, 1, "the error-free bug row is rejected");
  const result = await aiApi._internals.actBulkImport(ADMIN, { text, format: "json" }, "test import", "127.0.0.1");
  assert.equal(result.added, 1);
  const imported = fake.tables.get("problems").find((p) => p.title === "Imported question");
  assert.ok(imported);
  assert.equal(imported.status, "published");
  assert.equal(imported.created_by, ADMIN.admin_id);
}));

test("preview returns a fully validated problem without inserting anything", withFakeDb(seedLibrary(), async (fake) => {
  await ownAi.loadState();
  const preview = await aiApi._internals.actPreview(ADMIN);
  assert.ok(preview.problem.title);
  assert.ok(preview.template_id);
  assert.ok(preview.checks.every((c) => c.pass), `all checks pass: ${preview.checks.filter((c) => !c.pass).map((c) => c.label)}`);
  assert.equal(fake.tables.get("problems").length, 4, "preview writes nothing");
}));

test("test_text and diagnose run through the API", withFakeDb({ ai_settings: [], ai_logs: [], admin_audit_log: [] }, async () => {
  await ownAi.loadState();
  const { scan } = await aiApi._internals.actTestText(ADMIN, { text: "you fucking idiot" });
  assert.equal(scan.flagged, true);
  assert.equal(scan.severity, "severe");
  const { report } = await aiApi._internals.actDiagnose(ADMIN, { code: "n = '5'\nfor i in range(n):\n    print(i)" });
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((d) => d.message.includes("TypeError")));
  await assert.rejects(() => aiApi._internals.actTestText(ADMIN, { text: "   " }), (error) => error.status === 400);
}));

test("bell reports unread warn/error entries and bell_read marks them seen", withFakeDb({ ai_settings: [], ai_logs: [], admin_audit_log: [] }, async (fake) => {
  await ownAi.saveSettings({ master: true });
  await ownAi.log("moderation_removed", "test warning", "warn");
  await ownAi.log("problem_added", "test problem", "success");
  const bell = await aiApi._internals.READS.bell(ADMIN);
  assert.equal(bell.master, true);
  assert.equal(bell.unread, 1, "only warn/error entries are unread");
  await aiApi._internals.actBellRead(ADMIN);
  const after = await aiApi._internals.READS.bell(ADMIN);
  assert.equal(after.unread, 0);
  assert.ok(fake.tables.get("ai_settings").some((row) => row.key === `bell_seen:${ADMIN.admin_id}`));
}));

test("logs read and clear_logs works with audit", withFakeDb({ ai_settings: [], ai_logs: [], admin_audit_log: [] }, async (fake) => {
  await ownAi.log("test_action", "hello", "info");
  const { logs } = await aiApi._internals.READS.logs(ADMIN, { limit: 10 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, "test_action");
  await aiApi._internals.actClearLogs(ADMIN, "test clear", "127.0.0.1");
  assert.equal(fake.tables.get("ai_logs").length, 0);
  const clearAudit = fake.tables.get("admin_audit_log").find((a) => a.action === "clear_logs");
  assert.ok(clearAudit && clearAudit.resource === "ai" && clearAudit.reason === "test clear");
}));

/* ---------------- RBAC ---------------- */

test("AI reads need ai.read; every POST action needs ai.control plus its resource gate", withFakeDb({ ai_settings: [], ai_logs: [], admin_audit_log: [] }, async () => {
  await assert.rejects(() => aiApi._internals.READS.settings(FINANCE), (error) => error.status === 403);
  // analyst may read settings
  const settings = await aiApi._internals.READS.settings(ANALYST);
  assert.ok(settings.settings);
  // but no control actions
  await assert.rejects(() => aiApi._internals.actWatch(ANALYST), (error) => error.status === 403);
  await assert.rejects(() => aiApi._internals.actScan(ANALYST, {}, "x", "ip"), (error) => error.status === 403);
  await assert.rejects(() => aiApi._internals.actGenerate(ANALYST, {}, "x", "ip"), (error) => error.status === 403);
  // editor: problems.create yes, moderation.delete no, ai.notify no
  await ownAi.loadState();
  await assert.rejects(() => aiApi._internals.actScan(EDITOR, {}, "x", "ip"), (error) => error.status === 403);
  await assert.rejects(() => aiApi._internals.actWelcome(EDITOR, {}, "x", "ip"), (error) => error.status === 403);
  const generated = await aiApi._internals.actGenerate(EDITOR, { count: 1 }, "editor batch", "ip");
  assert.equal(generated.added.length, 1);
  // moderator: moderation + notify yes, problems.create no
  await assert.rejects(() => aiApi._internals.actGenerate(MODERATOR, { count: 1 }, "x", "ip"), (error) => error.status === 403);
  await ownAi.saveSettings({ welcome: true });
  await ownAi.loadState();
}));

test("watch tick skips modules the triggering role may not perform", withFakeDb(seedLibrary(), async () => {
  await ownAi.saveSettings({ master: true, moderation: true, dedup: true, auto_problems: true, per_run: 1, welcome: true });
  await ownAi.loadState();
  const result = await aiApi._internals.actWatch(EDITOR); // content_editor: no moderation.delete, no ai.notify
  assert.equal(result.ran, true);
  const names = result.results.map((r) => r.name);
  assert.ok(!names.includes("moderation"), "editor tick must skip moderation");
  assert.ok(!names.includes("welcome"), "editor tick must skip notify jobs");
  assert.ok(names.includes("factory") || names.includes("dedup"), "editor may run factory/dedup");
}));

/* ---------------- real CPython cross-check ---------------- */

function pythonAvailable() {
  try {
    execFileSync("python3", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function runPython(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pydebug-own-ai-"));
  const file = path.join(dir, "main.py");
  try {
    fs.writeFileSync(file, code, "utf8");
    try {
      const stdout = execFileSync("python3", ["-I", file], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], cwd: dir });
      return { ok: true, stdout, stderr: "" };
    } catch (error) {
      return { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test("generated problems behave exactly as advertised under a real Python interpreter", { skip: !pythonAvailable() }, () => {
  const fps = new Set();
  const problems = [];
  let guard = 0;
  while (problems.length < 12 && guard < 400) {
    guard += 1;
    const tpl = ownAi.pickTemplate("both", "mixed");
    let p;
    try { p = tpl.make(); } catch { continue; }
    p.type = tpl.type; p.topic = tpl.topic; p.difficulty = tpl.difficulty;
    if (!ownAi.validateProblem(p, fps).ok) continue;
    fps.add(ownAi.fingerprint(p.starter_code, p.expected_output));
    problems.push(p);
  }
  assert.equal(problems.length, 12);
  for (const problem of problems) {
    if (problem.type === "bug") {
      const run = runPython(problem.starter_code);
      assert.equal(run.ok, false, `bug code must really crash:\n${problem.starter_code}`);
      const detected = ownAi.detectPythonError(problem.starter_code);
      const lastLine = run.stderr.trim().split("\n").pop();
      assert.ok(
        lastLine.startsWith(`${detected.error}:`) || lastLine === detected.error,
        `detected ${detected.error} but python said: ${lastLine}`,
      );
      const fixed = runPython(problem.fixed_code);
      assert.equal(fixed.ok, true, `fixed code must run clean:\n${problem.fixed_code}\n${fixed.stderr}`);
      assert.equal(fixed.stdout.replace(/\n$/, ""), problem.expected_output);
    } else {
      const run = runPython(problem.starter_code);
      assert.equal(run.ok, true, `output code must run clean:\n${problem.starter_code}\n${run.stderr}`);
      assert.equal(run.stdout.replace(/\n$/, ""), problem.expected_output);
    }
  }
});
