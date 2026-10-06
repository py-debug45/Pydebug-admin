"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ai = require("../lib/server/ai-engine");
const { query } = require("../lib/server/http");
const aiApi = require("../api/ai");

const admin = { admin_id: "00000000-0000-4000-8000-000000000001", role: "superadmin" };

test("engine exposes a template inventory that covers both types and all difficulties", () => {
  assert.ok(ai.TEMPLATES.length >= 40, `expected a rich template set, got ${ai.TEMPLATES.length}`);
  const inventory = ai.templateInventory();
  for (const difficulty of ["easy", "medium", "hard"]) {
    assert.ok(inventory.bug[difficulty] > 0, `bug/${difficulty} is missing`);
    assert.ok(inventory.question[difficulty] > 0, `question/${difficulty} is missing`);
  }
});

test("generation is deterministic per seed and filters", () => {
  const a = ai.generateProblems({ seed: 987654, count: 10, type: "any", difficulty: "any" });
  const b = ai.generateProblems({ seed: 987654, count: 10, type: "any", difficulty: "any" });
  assert.deepEqual(a, b);
  assert.equal(a.length, 10);
  const c = ai.generateProblems({ seed: 111222, count: 10, type: "any", difficulty: "any" });
  assert.notDeepEqual(a, c);
});

test("every generated problem is complete, typed and within one batch unique", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const problems = ai.generateProblems({ seed, count: 10, type: "any", difficulty: "any" });
    assert.equal(problems.length, 10, `seed ${seed} did not produce a full batch`);
    const keys = new Set();
    for (const problem of problems) {
      assert.ok(["bug", "question"].includes(problem.type));
      assert.ok(["easy", "medium", "hard"].includes(problem.difficulty));
      assert.match(problem.topic, /^[a-zA-Z ]+$/);
      assert.ok(problem.title.length >= 10 && problem.title.length <= 180);
      assert.ok(problem.description.length >= 40);
      assert.ok(problem.starter_code.endsWith("\n"));
      assert.ok(Array.isArray(problem.hints) && problem.hints.length >= 2 && problem.hints.length <= 10);
      if (problem.type === "bug") {
        assert.ok(problem.battle_error, "bug problems must carry battle_error");
        assert.ok(
          problem.expected_output === problem.battle_error
          || problem.expected_output.startsWith(`${problem.battle_error}:`),
          `expected_output must be the real exception line: ${problem.expected_output}`,
        );
      } else {
        assert.equal(problem.battle_error, undefined, "output problems must not claim an error");
        assert.ok(problem.expected_output.length > 0, "output problems must list the real output");
      }
      for (const key of ai.problemKeys(problem)) {
        assert.ok(!keys.has(key), `duplicate key within one batch: ${key}`);
        keys.add(key);
      }
    }
  }
});

test("filters restrict generation and invalid combinations are rejected", () => {
  const bugs = ai.generateProblems({ seed: 5, count: 8, type: "bug", difficulty: "easy" });
  assert.ok(bugs.length > 0);
  assert.ok(bugs.every((problem) => problem.type === "bug" && problem.difficulty === "easy"));
  const questions = ai.generateProblems({ seed: 5, count: 8, type: "question", difficulty: "any" });
  assert.ok(questions.every((problem) => problem.type === "question"));
  assert.deepEqual(ai.parseFilters({ type: "nonsense", difficulty: "nope" }), { type: "any", difficulty: "any" });
});

test("dedupe helpers agree between generated problems and stored rows", () => {
  const problems = ai.generateProblems({ seed: 777, count: 6, type: "any", difficulty: "any" });
  for (const problem of problems) {
    const rowKeys = ai.keysForRow({ title: problem.title, starter_code: problem.starter_code });
    for (const key of ai.problemKeys(problem)) assert.ok(rowKeys.includes(key));
  }
  // Whitespace or case changes must still count as the same problem.
  const original = problems[0];
  const retyped = ai.keysForRow({ title: original.title.toUpperCase(), starter_code: original.starter_code.replace(/\n/g, "\n\n") });
  assert.ok(ai.problemKeys(original).every((key) => retyped.includes(key)));
});

test("query() merges runtime and URL parameters and survives an empty req.query", () => {
  const fromUrl = query({ url: "/api/read?resource=problems&action=list&page=2" });
  assert.equal(fromUrl.resource, "problems");
  assert.equal(fromUrl.action, "list");
  assert.equal(fromUrl.page, "2");
  const emptyRuntime = query({ url: "/api/read?resource=dashboard", query: {} });
  assert.equal(emptyRuntime.resource, "dashboard");
  const runtimeOnly = query({ url: "/api/read", query: { resource: "users" } });
  assert.equal(runtimeOnly.resource, "users");
  const repeated = query({ url: "/api/read?resource=users&resource=problems" });
  assert.equal(repeated.resource, "problems");
});

test("preview returns a signed, seeded batch without touching the database", async () => {
  const data = await aiApi._internals.preview(admin, { type: "any", difficulty: "any", count: 6 });
  assert.equal(data.count, 6);
  assert.ok(Number.isInteger(data.seed));
  assert.match(data.signature, /^[0-9a-f]{32}$/);
  const again = await aiApi._internals.preview(admin, { type: "any", difficulty: "any", count: 6, seed: data.seed });
  assert.deepEqual(again.problems, data.problems);
  assert.equal(again.signature, data.signature);
  await assert.rejects(
    aiApi._internals.preview({ role: "analyst" }, { count: 3 }),
    (error) => error.status === 403,
  );
});

test("publish inserts only problems that are not already in the library", async () => {
  const db = require("../api/_db");
  const originalList = db.list;
  const originalInsert = db.insert;
  const previewData = await aiApi._internals.preview(admin, { type: "any", difficulty: "any", count: 6, seed: 31415 });
  // Pretend the library already contains the second generated problem.
  const existing = [previewData.problems[1]];
  const insertedProblems = [];
  const auditRows = [];
  try {
    db.list = async (table, options = {}) => {
      assert.equal(table, "problems");
      const offset = Number(options.offset || 0);
      const limit = Number(options.limit || 1000);
      return { rows: existing.slice(offset, offset + limit), count: existing.length };
    };
    db.insert = async (table, row) => {
      if (table === "admin_audit_log") { auditRows.push(row); return row; }
      assert.equal(table, "problems");
      insertedProblems.push(row);
      return { id: `00000000-0000-4000-8000-00000000${String(insertedProblems.length).padStart(4, "0")}`, ...row };
    };
    const result = await aiApi._internals.publish(
      admin,
      { seed: previewData.seed, signature: previewData.signature, count: 6, type: "any", difficulty: "any", status: "draft", skip: [3] },
      "AI studio weekly batch",
      "127.0.0.1",
    );
    assert.equal(result.inserted_count, 4);
    assert.equal(result.skipped_count, 2);
    assert.deepEqual(result.skipped.map((row) => row.reason).sort(), ["duplicate", "excluded_by_admin"]);
    assert.ok(insertedProblems.every((row) => row.status === "draft" && row.created_by === admin.admin_id));
    assert.ok(insertedProblems.every((row) => row.admin_skip_notification === true));
    assert.equal(auditRows.length, 4);
    assert.ok(auditRows.every((row) => row.resource === "problems" && row.action === "ai_create"));
  } finally {
    db.list = originalList;
    db.insert = originalInsert;
  }
});

test("publish rejects a preview whose signature no longer matches", async () => {
  const db = require("../api/_db");
  const originalList = db.list;
  try {
    db.list = async () => ({ rows: [], count: 0 });
    await assert.rejects(
      aiApi._internals.publish(admin, { seed: 271828, signature: "deadbeef", count: 3, type: "any", difficulty: "any" }, "stale preview", "127.0.0.1"),
      (error) => error.status === 409 && error.code === "preview_expired",
    );
  } finally {
    db.list = originalList;
  }
});

test("generated problems behave exactly as advertised under a real Python interpreter", { skip: !pythonAvailable() }, async () => {
  const problems = [
    ...ai.generateProblems({ seed: 20260101, count: 6, type: "bug", difficulty: "any" }),
    ...ai.generateProblems({ seed: 20260102, count: 6, type: "question", difficulty: "any" }),
  ];
  for (const problem of problems) {
    const run = runPython(problem.starter_code);
    if (problem.type === "bug") {
      assert.equal(run.ok, false, `bug code must really crash:\n${problem.starter_code}`);
      const lastLine = run.stderr.trim().split("\n").pop();
      assert.equal(lastLine, problem.expected_output);
      assert.ok(lastLine.startsWith(`${problem.battle_error}:`) || lastLine === problem.battle_error);
    } else {
      assert.equal(run.ok, true, `output code must run cleanly:\n${problem.starter_code}\n${run.stderr}`);
      assert.equal(run.stdout.replace(/\n$/, ""), problem.expected_output);
    }
  }
});

function pythonAvailable() {
  try {
    execFileSync("python3", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function runPython(code) {
  const file = path.join(os.tmpdir(), `pydebug-ai-test-${process.pid}-${Math.random().toString(36).slice(2)}.py`);
  try {
    fs.writeFileSync(file, code, "utf8");
    try {
      const stdout = execFileSync("python3", ["-I", file], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, stdout, stderr: "" };
    } catch (error) {
      return { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
    }
  } finally {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
}
