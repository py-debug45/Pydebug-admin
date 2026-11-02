const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const brainSource = fs.readFileSync(path.join(ROOT, 'js/ai-brain.js'), 'utf8');
const interviewSource = fs.readFileSync(path.join(ROOT, 'js/ai-interview.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(ROOT, 'js/ai-content.js'), 'utf8');

function makeContext(sb) {
  const values = new Map();
  const context = vm.createContext({
    console,
    Math,
    Date,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    JSON,
    RegExp,
    Promise,
    setTimeout,
    clearTimeout,
    sb,
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });
  vm.runInContext(brainSource, context);
  vm.runInContext(interviewSource, context);
  vm.runInContext(contentSource, context);
  return context;
}

function makeOne(context, id) {
  return vm.runInContext(`AI_INTERVIEW_TEMPLATES.find((tpl) => tpl.id === ${JSON.stringify(id)}).make()`, context);
}

function validateOne(context, problem) {
  context.__candidate = problem;
  const result = vm.runInContext('AI_validateInterviewProblem(__candidate)', context);
  delete context.__candidate;
  return result;
}

test('Interview Studio has broad, unique and correctly categorised blueprint coverage', () => {
  const context = makeContext();
  const stats = vm.runInContext('AI_getInterviewLibraryStats()', context);
  const templates = vm.runInContext('AI_INTERVIEW_TEMPLATES.map(({ id, topic, pattern, difficulty }) => ({ id, topic, pattern, difficulty }))', context);
  const topics = vm.runInContext('AI_TOPICS', context);
  const labels = vm.runInContext('AI_INTERVIEW_PATTERN_LABELS', context);

  assert.ok(stats.templates >= 28);
  assert.ok(stats.patterns >= 17);
  assert.ok(stats.byDifficulty.easy >= 6);
  assert.ok(stats.byDifficulty.medium >= 12);
  assert.ok(stats.byDifficulty.hard >= 5);
  assert.equal(new Set(templates.map((tpl) => tpl.id)).size, templates.length);
  for (const tpl of templates) {
    assert.ok(topics.includes(tpl.topic), `${tpl.id} has an unknown topic`);
    assert.ok(labels[tpl.pattern], `${tpl.id} has an unknown pattern`);
    assert.ok(['easy', 'medium', 'hard'].includes(tpl.difficulty));
  }
});

test('every blueprint passes the strict pre-insert contract across random variants', () => {
  const context = makeContext();
  const ids = vm.runInContext('AI_INTERVIEW_TEMPLATES.map((tpl) => tpl.id)', context);
  let generated = 0;
  for (const id of ids) {
    for (let variant = 0; variant < 6; variant++) {
      const problem = makeOne(context, id);
      const result = validateOne(context, problem);
      const failures = result.checks.filter((check) => !check.pass).map((check) => check.label);
      assert.equal(failures.length, 0, `${id}, variant ${variant}: ${failures.join(', ')}`);
      assert.equal(result.score, 100);
      assert.equal(problem.type, 'coding');
      assert.ok(problem.test_cases.length >= 8);
      assert.equal(new Set(problem.test_cases.map((item) => item.call)).size, problem.test_cases.length);
      assert.equal(problem.public_test_count, 2);
      assert.equal(problem.hints.length, 3);
      assert.equal(problem.rubric.reduce((sum, item) => sum + item.weight, 0), 100);
      assert.equal(problem.expected_output, problem.test_cases[0].expected);
      assert.notEqual(problem.solution_code, problem.starter_code);
      generated++;
    }
  }
  assert.ok(generated >= 168);
});

test('reference Python solutions pass every generated judge case in a real Python runtime', (t) => {
  const available = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (available.error && available.error.code === 'ENOENT') {
    t.skip('python3 is not installed in this test environment');
    return;
  }
  assert.equal(available.status, 0, available.stderr);

  const context = makeContext();
  const ids = vm.runInContext('AI_INTERVIEW_TEMPLATES.map((tpl) => tpl.id)', context);
  const problems = [];
  for (const id of ids) {
    for (let variant = 0; variant < 3; variant++) {
      const problem = makeOne(context, id);
      problems.push({ id, variant, solution: problem.solution_code, tests: problem.test_cases });
    }
  }
  const payload = Buffer.from(JSON.stringify(problems), 'utf8').toString('base64');
  const runner = `
import base64
import json
problems = json.loads(base64.b64decode('${payload}'))
failures = []
executed = 0
for problem in problems:
    namespace = {}
    try:
        exec(problem['solution'], namespace)
        for case in problem['tests']:
            executed += 1
            try:
                actual = str(eval(case['call'], namespace))
                if actual != case['expected']:
                    failures.append((problem['id'], problem['variant'], case['call'], case['expected'], actual))
            except Exception as exc:
                failures.append((problem['id'], problem['variant'], case['call'], case['expected'], f'{type(exc).__name__}: {exc}'))
    except Exception as exc:
        failures.append((problem['id'], problem['variant'], 'compile reference', 'clean compile', f'{type(exc).__name__}: {exc}'))
print(f'executed={executed} failures={len(failures)}')
for failure in failures[:40]:
    print(failure)
raise SystemExit(1 if failures else 0)
`;
  const result = spawnSync('python3', ['-'], { input: runner, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
  assert.match(result.stdout, /executed=[5-9][0-9]{2,} failures=0/);
});

test('pattern, difficulty and company-style controls produce the requested original practice track', () => {
  const context = makeContext();
  const patterns = vm.runInContext('Object.keys(AI_INTERVIEW_PATTERN_LABELS)', context);
  for (const pattern of patterns) {
    context.__options = { pattern, difficulty: 'mixed', track: 'mixed' };
    const problem = vm.runInContext('AI_buildInterviewProblem(__options).problem', context);
    assert.equal(problem.pattern, pattern);
  }
  for (const difficulty of ['easy', 'medium', 'hard']) {
    context.__options = { pattern: 'all', difficulty, track: 'google' };
    const problem = vm.runInContext('AI_buildInterviewProblem(__options).problem', context);
    assert.equal(problem.difficulty, difficulty);
    assert.equal(problem.track, 'google');
    assert.match(problem.description, /Google-style pattern track/);
    assert.match(problem.description, /original company-pattern practice challenge/);
    assert.match(problem.description, /not a company-issued or endorsed interview question/);
    assert.doesNotMatch(problem.description, /80\s*%|90\s*%|guaranteed selection/i);
  }
  delete context.__options;
});

test('quality gate rejects shallow tests, missing references and fabricated success claims', () => {
  const context = makeContext();
  const problem = makeOne(context, 'interview-pair-with-target');
  problem.test_cases = problem.test_cases.slice(0, 2);
  problem.solution_code = '';
  problem.description += '\nThis real question from Google gives a 90% guarantee of selection.';
  const result = validateOne(context, problem);
  assert.equal(result.ok, false);
  const failedLabels = result.checks.filter((check) => !check.pass).map((check) => check.label);
  assert.ok(failedLabels.includes('At least 8 functional tests'));
  assert.ok(failedLabels.includes('Independent reference solution present'));
  assert.ok(failedLabels.includes('No fabricated company attribution or success guarantee'));
});

test('draft generation inserts complete Write-Code rows without broadcasting them', async () => {
  const rows = [];
  const notifications = [];
  const sb = {
    from(table) {
      return {
        select() {
          return {
            order() {
              return {
                range: async (from, to) => ({ data: table === 'problems' ? rows.slice(from, to + 1) : [], error: null }),
              };
            },
          };
        },
        insert(row) {
          if (table === 'problems') rows.push({ ...row, created_at: new Date().toISOString() });
          if (table === 'notifications') notifications.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const context = makeContext(sb);
  const beforePreview = rows.length;
  const preview = await vm.runInContext("AI_previewInterviewProblem({ pattern: 'hashing', difficulty: 'easy', track: 'mixed' })", context);
  assert.equal(preview.score, 100);
  assert.equal(rows.length, beforePreview, 'preview must never insert');

  const result = await vm.runInContext("AI_generateInterviewProblems(3, { pattern: 'all', difficulty: 'medium', track: 'amazon', status: 'draft', premium: false })", context);
  assert.equal(result.added.length, 3);
  assert.equal(result.skipped, 0);
  assert.equal(rows.length, 3);
  assert.equal(notifications.length, 0);
  for (const row of rows) {
    assert.equal(row.type, 'coding');
    assert.equal(row.status, 'draft');
    assert.equal(row.admin_skip_notification, true);
    assert.ok(row.slug.includes(String(row.problem_number)));
    assert.ok(row.test_cases.length >= 8);
    assert.match(row.solution_code, /^def solve\(/);
    assert.equal(row.is_premium, false);
  }
});

test('coding fingerprints use the full judge suite instead of rejecting fresh shared scaffolds', () => {
  const context = makeContext();
  const first = makeOne(context, 'interview-pair-with-target');
  const second = makeOne(context, 'interview-pair-with-target');
  second.starter_code = first.starter_code;
  second.expected_output = first.expected_output;
  second.test_cases = first.test_cases.map((item) => ({ ...item }));
  context.__first = first;
  context.__second = second;
  assert.equal(
    vm.runInContext('AI_problemFingerprint(__first)', context),
    vm.runInContext('AI_problemFingerprint(__second)', context),
    'identical suites must remain duplicates',
  );
  second.test_cases.push({ call: 'solve([9, 1], 10)', expected: '[0, 1]' });
  assert.notEqual(
    vm.runInContext('AI_problemFingerprint(__first)', context),
    vm.runInContext('AI_problemFingerprint(__second)', context),
    'a genuinely different suite is fresh even when scaffold and sample output match',
  );
  delete context.__first;
  delete context.__second;
});

test('Dashboard variations keep Write-Code pattern, difficulty and Premium state as reviewable drafts', async () => {
  const seedContext = makeContext();
  const source = makeOne(seedContext, 'interview-first-unique-char');
  Object.assign(source, {
    id: 'source-coding', problem_number: 1, created_at: '2026-01-01T00:00:00Z',
    is_premium: true, status: 'published', slug: 'first-unique-1',
  });
  const rows = [source];
  const sb = {
    from(table) {
      return {
        select(columns) {
          return {
            eq() {
              return { single: async () => ({ data: table === 'problems' ? source : null, error: null }) };
            },
            order() {
              return { range: async (from, to) => ({ data: table === 'problems' ? rows.slice(from, to + 1) : [], error: null }) };
            },
          };
        },
        insert(row) {
          if (table === 'problems') rows.push({ ...row, created_at: new Date().toISOString() });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const context = makeContext(sb);
  const result = await vm.runInContext("AI_generateVariations('source-coding', 2)", context);
  assert.equal(result.added.length, 2);
  assert.equal(result.source.id, 'source-coding');
  for (const row of result.added) {
    assert.equal(row.type, 'coding');
    assert.equal(row.difficulty, source.difficulty);
    assert.equal(row.topic, source.topic);
    assert.equal(row.status, 'draft');
    assert.equal(row.is_premium, true);
    assert.match(row.description, /Core pattern: Hash Map \/ Frequency Counting/);
    assert.ok(row.test_cases.length >= 8);
  }
});

test('Interview Studio UI hooks, lazy-load order and additive migration stay connected', () => {
  const html = fs.readFileSync(path.join(ROOT, 'ai.html'), 'utf8');
  const common = fs.readFileSync(path.join(ROOT, 'js/admin-common.js'), 'utf8');
  const migration = fs.readFileSync(path.join(ROOT, 'db/migrations/20261102_interview_studio.sql'), 'utf8');
  for (const id of [
    'ai-interview-studio', 'ai-interview-track', 'ai-interview-pattern',
    'ai-interview-difficulty', 'ai-interview-count', 'ai-interview-status',
    'ai-btn-interview-preview', 'ai-btn-interview-generate', 'ai-interview-preview',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /<script src="js\/admin-interview\.js" defer><\/script>/);
  assert.ok(common.indexOf('"js/ai-interview.js"') > common.indexOf('"js/ai-brain.js"'));
  assert.ok(common.indexOf('"js/ai-interview.js"') < common.indexOf('"js/ai-content.js"'));
  assert.match(migration, /add column if not exists test_cases/i);
  assert.match(migration, /add column if not exists solution_code/i);
  assert.doesNotMatch(migration, /drop\s+(table|column)/i);
});
