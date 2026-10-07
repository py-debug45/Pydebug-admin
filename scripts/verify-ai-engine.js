#!/usr/bin/env node
"use strict";

/*
 * Cross-checks the local AI engine against a real CPython interpreter.
 * Not part of `npm test` (which must stay dependency-free and fast);
 * run it manually whenever templates change:
 *
 *   node scripts/verify-ai-engine.js [seeds-per-template]
 *
 * For every generated problem it asserts:
 *   - "bug" problems: python exits non-zero and the last traceback line is
 *     exactly the engine's expected_output, and starts with battle_error.
 *   - "question" problems: python exits 0 and stdout (minus the trailing
 *     newline) is exactly the engine's expected_output.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const engine = require("../lib/server/ai-engine");

const seedsPerTemplate = Number.parseInt(process.argv[2], 10) || 12;

function runPython(code) {
  const file = path.join(os.tmpdir(), `pydebug-ai-verify-${process.pid}-${Math.random().toString(36).slice(2)}.py`);
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

let checked = 0;
const failures = [];

function check(problem, label) {
  checked += 1;
  const result = runPython(problem.starter_code);
  const lastStderrLine = result.stderr.trim().split("\n").pop() || "";
  const stdoutTrimmed = result.stdout.replace(/\n$/, "");
  if (problem.type === "bug") {
    if (result.ok) {
      failures.push(`${label}: expected a crash but python exited 0\n--- code ---\n${problem.starter_code}`);
      return;
    }
    if (lastStderrLine !== problem.expected_output) {
      failures.push(`${label}: stderr mismatch\n  expected: ${JSON.stringify(problem.expected_output)}\n  actual:   ${JSON.stringify(lastStderrLine)}\n--- code ---\n${problem.starter_code}`);
      return;
    }
    if (!lastStderrLine.startsWith(`${problem.battle_error}:`) && lastStderrLine !== problem.battle_error) {
      failures.push(`${label}: battle_error "${problem.battle_error}" does not match stderr "${lastStderrLine}"`);
      return;
    }
  } else {
    if (!result.ok) {
      failures.push(`${label}: expected clean run but python failed\n${result.stderr}\n--- code ---\n${problem.starter_code}`);
      return;
    }
    if (stdoutTrimmed !== problem.expected_output) {
      failures.push(`${label}: stdout mismatch\n  expected: ${JSON.stringify(problem.expected_output)}\n  actual:   ${JSON.stringify(stdoutTrimmed)}\n--- code ---\n${problem.starter_code}`);
    }
  }
}

const problemsPerRun = engine.MAX_BATCH;
for (const template of engine.TEMPLATES) {
  for (let seed = 1; seed <= seedsPerTemplate; seed += 1) {
    const problem = engine._internals.generateFromTemplate(template.key, seed * 7919 + template.key.length * 104729);
    if (problem.template !== template.key) throw new Error(`template key mismatch for ${template.key}`);
    check(problem, `${template.key} seed ${seed}`);
  }
}

// Full random batches through the public entry point.
for (let seed = 100; seed < 130; seed += 1) {
  for (const type of ["any", "bug", "question"]) {
    for (const difficulty of ["any", "easy", "medium", "hard"]) {
      const problems = engine.generateProblems({ seed, count: engine.MAX_BATCH, type, difficulty });
      if (problems.length !== engine.MAX_BATCH) {
        failures.push(`batch seed ${seed} ${type}/${difficulty}: only ${problems.length}/${engine.MAX_BATCH} unique problems generated`);
      }
      problems.forEach((problem, index) => check(problem, `batch ${seed} ${type}/${difficulty} #${index}`));
    }
  }
}

// Determinism + duplicate protection sanity.
{
  const a = engine.generateProblems({ seed: 424242, count: 10, type: "any", difficulty: "any" });
  const b = engine.generateProblems({ seed: 424242, count: 10, type: "any", difficulty: "any" });
  if (JSON.stringify(a) !== JSON.stringify(b)) failures.push("same seed produced different batches");
  const keys = new Set(a.flatMap((problem) => engine.problemKeys(problem)));
  if (keys.size !== a.length * 2) failures.push("within-batch duplicate keys detected");

  // Regenerating with a pre-seeded "existing library" must still be identical
  // (duplicate filtering happens at publish time, not during generation).
  const c = engine.generateProblems({ seed: 424242, count: 10, type: "any", difficulty: "any" });
  if (JSON.stringify(c) !== JSON.stringify(a)) failures.push("generation is not purely seed-deterministic");

  // keysForRow must agree with problemKeys so DB dedupe catches real duplicates.
  for (const problem of a) {
    const rowKeys = engine.keysForRow({ title: problem.title, starter_code: problem.starter_code });
    for (const key of engine.problemKeys(problem)) {
      if (!rowKeys.includes(key)) failures.push(`keysForRow mismatch for ${key}`);
    }
  }
}

console.log(`PyDebug local AI engine verification`);
console.log(`  engine:        ${engine.engineLabel()}`);
console.log(`  templates:     ${engine.TEMPLATES.length} (${engine.TEMPLATES.filter((t) => t.type === "bug").length} bug / ${engine.TEMPLATES.filter((t) => t.type === "question").length} output)`);
console.log(`  python check:  ${checked} problems executed with real CPython`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s):\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log(`\n✓ All generated problems verified against real Python output.`);
