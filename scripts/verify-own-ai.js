#!/usr/bin/env node
"use strict";

/*
 * Cross-checks the Own-AI engine (lib/server/own-ai.js — the ported legacy
 * "AI Control Center" problem factory) against a real CPython interpreter.
 * Not part of `npm test` (which must stay dependency-free and fast); run it
 * manually whenever templates change:
 *
 *   node scripts/verify-own-ai.js [runs-per-template]
 *
 * For every generated problem it asserts, with a real python3:
 *   - "bug" problems: python exits non-zero, the last traceback line matches
 *     the error the static detector found, and the fixed reference code runs
 *     cleanly and prints exactly the expected_output.
 *   - "question" problems: python exits 0 and stdout (minus the trailing
 *     newline) is exactly the engine's expected_output.
 * Every snippet runs in a fresh temporary directory (some fixed-code samples
 * create files, which must not leak between runs).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const engine = require("../lib/server/own-ai");

const runsPerTemplate = Number.parseInt(process.argv[2], 10) || 12;

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

let checked = 0;
const failures = [];

function check(problem, label) {
  checked += 1;
  if (problem.type === "bug") {
    const run = runPython(problem.starter_code);
    const lastLine = run.stderr.trim().split("\n").pop() || "";
    const detected = engine.detectPythonError(problem.starter_code).error;
    if (run.ok) {
      failures.push(`${label}: expected a crash but python exited 0\n--- code ---\n${problem.starter_code}`);
      return;
    }
    if (detected && !(lastLine.startsWith(`${detected}:`) || lastLine === detected)) {
      failures.push(`${label}: detector said ${detected} but python said "${lastLine}"\n--- code ---\n${problem.starter_code}`);
      return;
    }
    if (problem.fixed_code) {
      const fixed = runPython(problem.fixed_code);
      if (!fixed.ok) {
        failures.push(`${label}: fixed code crashes: ${fixed.stderr.trim().split("\n").pop()}\n--- fixed ---\n${problem.fixed_code}`);
        return;
      }
      if (fixed.stdout.replace(/\n$/, "") !== problem.expected_output) {
        failures.push(`${label}: fixed output mismatch\n  expected: ${JSON.stringify(problem.expected_output)}\n  actual:   ${JSON.stringify(fixed.stdout.replace(/\n$/, ""))}\n--- fixed ---\n${problem.fixed_code}`);
      }
    }
  } else {
    const run = runPython(problem.starter_code);
    if (!run.ok) {
      failures.push(`${label}: expected clean run but python failed\n${run.stderr}\n--- code ---\n${problem.starter_code}`);
      return;
    }
    if (run.stdout.replace(/\n$/, "") !== problem.expected_output) {
      failures.push(`${label}: stdout mismatch\n  expected: ${JSON.stringify(problem.expected_output)}\n  actual:   ${JSON.stringify(run.stdout.replace(/\n$/, ""))}\n--- code ---\n${problem.starter_code}`);
    }
  }
}

// Every template, several randomized runs each, through the full validator.
for (const template of engine.TEMPLATES) {
  let made = 0;
  let attempts = 0;
  while (made < runsPerTemplate && attempts < runsPerTemplate * 30) {
    attempts += 1;
    const problem = template.make();
    problem.type = template.type;
    problem.topic = template.topic;
    problem.difficulty = template.difficulty;
    const validation = engine.validateProblem(problem, new Set());
    if (!validation.ok) {
      failures.push(`${template.id}: validator rejected a template output: ${validation.checks.filter((c) => !c.pass).map((c) => c.label).join(" | ")}`);
      continue;
    }
    made += 1;
    check(problem, `${template.id} run ${made}`);
  }
  if (made < runsPerTemplate) failures.push(`${template.id}: only produced ${made}/${runsPerTemplate} valid problems`);
}

// Full random batches through the public sampler.
for (let batch = 0; batch < 10; batch += 1) {
  const problems = engine.sampleProblems(10);
  if (problems.length !== 10) failures.push(`batch ${batch}: only ${problems.length}/10 unique valid problems`);
  problems.forEach((problem, index) => check({ ...problem, fixed_code: problem.type === "bug" ? problem.fixed_code : undefined }, `batch ${batch} #${index}`));
}

// Determinism-free sanity: fingerprints dedupe retyped code.
{
  const a = engine.fingerprint("print(  'hello'  )", "hello");
  const b = engine.fingerprint("print('hello')", "hello");
  if (a !== b) failures.push("fingerprint must ignore whitespace");
  if (engine.fingerprint("x = 1", "1") !== null) failures.push("short snippets must never fingerprint");
}

console.log("PyDebug Own-AI engine verification (legacy AI Control Center port)");
console.log(`  engine:        lib/server/own-ai.js`);
console.log(`  templates:     ${engine.TEMPLATES.length} (${engine.TEMPLATES.filter((t) => t.type === "bug").length} bug / ${engine.TEMPLATES.filter((t) => t.type === "question").length} output)`);
console.log(`  python check:  ${checked} problems executed with real CPython`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s):\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log(`\n✓ All generated problems verified against real Python output.`);
