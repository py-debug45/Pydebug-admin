"use strict";

const { requireAdmin } = require("../lib/server/admin-auth");
const { assertCan, can } = require("../lib/server/permissions");
const { withAudit } = require("../lib/server/audit");
const { send, method, readJson, clientIp, assertSameOrigin, query, cleanText, handleError } = require("../lib/server/http");
const { oneOf, integer, uuid } = require("../lib/server/validate");
const ownAi = require("../lib/server/own-ai");

/*
 * PyDebug Own-AI endpoint — the legacy admin panel's "AI Control Center",
 * ported onto the v2 server-only architecture. The whole engine lives in
 * lib/server/own-ai.js and runs entirely on this server: no AI provider, no
 * API key, no outbound network call of any kind. State (master switch,
 * module toggles, factory settings, last-run timestamps, activity log) lives
 * in the ai_settings / ai_logs tables (see db/migrations/0004_own_ai.sql).
 *
 * GET  /api/ai?action=settings|logs|bell|digest|stats   (ai.read)
 * POST /api/ai { action, payload, reason }              (ai.control + the
 *        underlying resource permission for each action; notifications also
 *        need ai.notify). Manual mutations are audit-logged; the automated
 *        watch tick records itself in ai_logs like the legacy panel did.
 *
 * POST actions:
 *   save_settings   { patch }                 master switch + module toggles
 *   watch           {}                        one guarded background tick
 *   scan            {}                        moderation scan (moderation.delete)
 *   generate        { count?, mix?, difficulty?, announce? }   (problems.create)
 *   preview         {}                        one validated problem, no writes
 *   dedup           {}                        delete duplicate problems (problems.delete)
 *   errguard        { dryRun? }               delete error-free bug code (problems.delete)
 *   welcome         {}                        welcome new users (ai.notify)
 *   digest          { build? }                daily digest (get cached / build)
 *   health          {}                        panel health score (read-only)
 *   calibrate       {}                        difficulty suggestions (read-only)
 *   calibrate_apply { items }                 apply suggestions (problems.edit)
 *   expiry|winback|stuck|leaderboard {}       growth runs (ai.notify)
 *   faq             { limit? }                FAQ auto-helper (ai.notify)
 *   cheat           {}                        copy-paste report (read-only)
 *   gap             { count?, mix? }          topic gap filler (problems.create)
 *   variations      { problem_id, count? }    variations of one problem (problems.create)
 *   quality         {}                        content quality report (read-only)
 *   hints           {}                        auto-fix weak hints (problems.edit)
 *   bulk_validate   { text, format }          validate JSON/CSV rows (read-only)
 *   bulk_import     { text, format }          import valid rows (problems.create)
 *   test_text       { text }                  moderation filter tester (read-only)
 *   diagnose        { code }                  local code diagnostic lab (read-only)
 *   clear_logs      {}                        clear the AI activity log
 *   bell_read       {}                        mark the topbar AI bell as read
 */

function intInRange(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/* ---------------------------------------------------------------- reads -- */

async function readSettings(admin) {
  assertCan(admin, "ai", "read");
  const { settings, lastRuns } = await ownAi.loadState();
  const stats = await ownAi.getStats();
  return { settings, last_runs: lastRuns, stats, topics: ownAi.TOPICS };
}

async function readLogs(admin, q) {
  assertCan(admin, "ai", "read");
  const limit = intInRange(q.limit, 100, 1, 500);
  const level = cleanText(q.level, 20);
  let logs = await ownAi.getLogs(limit);
  if (["info", "success", "warn", "error"].includes(level)) logs = logs.filter((entry) => entry.level === level);
  return { logs };
}

async function readBell(admin) {
  assertCan(admin, "ai", "read");
  const { settings } = await ownAi.loadState();
  const seen = Number(await ownAi.kvGet(`bell_seen:${admin.admin_id}`)) || 0;
  const logs = await ownAi.getLogs(200);
  const items = logs.filter((entry) => ["warn", "error"].includes(entry.level)).slice(0, 15);
  const unread = items.filter((entry) => new Date(entry.t).getTime() > seen).length;
  return { master: settings.master === true, unread, items };
}

async function readDigest(admin) {
  assertCan(admin, "ai", "read");
  return { digest: await ownAi.getDigest() };
}

async function readStats(admin) {
  assertCan(admin, "ai", "read");
  await ownAi.loadState();
  return { stats: await ownAi.getStats(), last_runs: ownAi.getLastRuns() };
}

/* --------------------------------------------------------------- actions -- */

// Wrap a mutating AI action in the immutable admin audit log.
function audited(admin, action, reason, ip, options) {
  return withAudit({
    admin,
    resource: "ai",
    action,
    reason,
    ip,
    oldValue: null,
    targetId: options.targetId || null,
    destructive: options.destructive === true,
    execute: options.execute,
    getNew: options.getNew || ((result) => result),
  });
}

async function actSaveSettings(admin, payload, reason, ip) {
  const patch = payload.patch && typeof payload.patch === "object" ? payload.patch : payload;
  const clean = ownAi.validateSettingsPatch(patch); // throws 400 on a bad shape
  return audited(admin, "save_settings", reason, ip, {
    execute: () => ownAi.saveSettings(clean),
    getNew: (result) => ({ changed: result.changed, settings: result.settings }),
  });
}

async function actWatch(admin) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  // Automated background tick: results are recorded in ai_logs by the engine
  // itself (exactly like the legacy panel), not in the admin audit log.
  return ownAi.runWatchTick({ actorId: admin.admin_id, role: admin.role });
}

async function actScan(admin, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "moderation", "delete");
  await ownAi.loadState();
  return audited(admin, "scan", reason, ip, {
    destructive: true,
    execute: () => ownAi.runModeration({ auto: false, actorId: admin.admin_id }),
    getNew: (result) => ({ scanned: result.scanned, removed: result.removed, warned: result.warned }),
  });
}

async function actGenerate(admin, payload, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "create");
  await ownAi.loadState();
  const count = intInRange(payload.count, ownAi.getSettings().per_run || 3, 1, 20);
  const mix = payload.mix ? oneOf(payload.mix, ["bug", "question", "both"], "mix") : undefined;
  const difficulty = payload.difficulty ? oneOf(payload.difficulty, ["mixed", "easy", "medium", "hard"], "difficulty") : undefined;
  // Announcements are user-facing: roles without ai.notify generate quietly.
  const announce = can(admin.role, "ai", "notify") ? payload.announce : false;
  return audited(admin, "generate", reason, ip, {
    destructive: true,
    execute: () => ownAi.generateProblems(count, { auto: false, actorId: admin.admin_id, mix, difficulty, announce }),
    getNew: (result) => ({ added: result.added.length, skipped: result.skipped, titles: result.added.map((row) => row.title) }),
  });
}

async function actPreview(admin) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  const { problem, templateId, checks } = await ownAi.previewProblem();
  return { problem, template_id: templateId, checks };
}

async function actDedup(admin, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "delete");
  await ownAi.loadState();
  return audited(admin, "dedup", reason, ip, {
    destructive: true,
    execute: () => ownAi.runDedup({ auto: false }),
    getNew: (result) => ({ scanned: result.scanned, groups: result.groups, removed: result.removed.length }),
  });
}

async function actErrguard(admin, payload, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "delete");
  await ownAi.loadState();
  const dryRun = payload.dry_run === true || payload.dryRun === true;
  if (dryRun) {
    const scan = await ownAi.runErrorGuard({ auto: false, dryRun: true });
    return { dry_run: true, scanned: scan.scanned, candidates: scan.candidates };
  }
  return audited(admin, "errguard", reason, ip, {
    destructive: true,
    execute: () => ownAi.runErrorGuard({ auto: false }),
    getNew: (result) => ({ scanned: result.scanned, removed: result.removed.length }),
  });
}

function notifyAction(name, runner, lastRunKey) {
  return async (admin, payload, reason, ip) => {
    assertCan(admin, "ai", "control");
    assertCan(admin, "ai", "notify");
    await ownAi.loadState();
    const result = await audited(admin, name, reason, ip, {
      destructive: true,
      execute: () => runner(admin, payload),
      getNew: (value) => value,
    });
    await ownAi.setLastRun(lastRunKey);
    return result;
  };
}

const actWelcome = notifyAction("welcome", (admin) => ownAi.runWelcome({ auto: false }), "welcome");
const actExpiry = notifyAction("expiry", () => ownAi.runExpiryReminders({ auto: false }), "expiry");
const actWinback = notifyAction("winback", () => ownAi.runWinback({ auto: false }), "winback");
const actStuck = notifyAction("stuck", () => ownAi.runStuckHelp({ auto: false }), "stuck");
const actLeaderboard = notifyAction("leaderboard", () => ownAi.runLeaderboardAlerts({ auto: false }), "lead");
const actFaq = notifyAction("faq", (admin, payload) => ownAi.runFaqReplies(intInRange(payload.limit, 10, 1, 25), { auto: false, actorId: admin.admin_id }), "faq");

async function actDigest(admin, payload, reason, ip) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  if (payload.build === true) {
    return audited(admin, "digest", reason, ip, {
      execute: () => ownAi.buildDigest(),
      getNew: (digest) => ({ generated_at: digest.generated_at }),
    });
  }
  return { digest: await ownAi.getDigest() };
}

async function actHealth(admin) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  return ownAi.healthCheck();
}

async function actCalibrate(admin) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  return ownAi.calibration();
}

async function actCalibrateApply(admin, payload, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "edit");
  await ownAi.loadState();
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 100) {
    const error = new Error("items must be an array of 1-100 suggestions");
    error.status = 400; error.code = "validation_error";
    throw error;
  }
  const items = payload.items.map((item) => ({
    problem_id: uuid(item.problem_id, "problem id"),
    suggested: oneOf(item.suggested, ["easy", "medium", "hard"], "suggested difficulty"),
    title: cleanText(item.title, 180),
    reason: cleanText(item.reason, 200),
  }));
  return audited(admin, "calibrate_apply", reason, ip, {
    execute: () => ownAi.applyDifficulty(items),
    getNew: (updated) => ({ updated, items: items.map((item) => item.problem_id) }),
  });
}

async function actCheat(admin) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  return ownAi.cheatReport();
}

async function actGap(admin, payload, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "create");
  await ownAi.loadState();
  const count = intInRange(payload.count, 3, 1, 20);
  const mix = payload.mix ? oneOf(payload.mix, ["bug", "question", "both"], "mix") : undefined;
  return audited(admin, "gap", reason, ip, {
    destructive: true,
    execute: () => ownAi.runGapFill(count, { auto: false, actorId: admin.admin_id, mix }),
    getNew: (result) => ({ added: result.added.length, skipped: result.skipped, cells: result.cells }),
  });
}

async function actVariations(admin, payload, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "create");
  await ownAi.loadState();
  const problemId = uuid(payload.problem_id, "problem id");
  const count = intInRange(payload.count, 3, 1, 10);
  return audited(admin, "variations", reason, ip, {
    targetId: problemId,
    destructive: true,
    execute: () => ownAi.generateVariations(problemId, count, { actorId: admin.admin_id }),
    getNew: (result) => ({ added: result.added.length, skipped: result.skipped }),
  });
}

async function actQuality(admin) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  return ownAi.qualityReport();
}

async function actHints(admin, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "edit");
  await ownAi.loadState();
  return audited(admin, "hints", reason, ip, {
    destructive: true,
    execute: () => ownAi.fixHints(),
    getNew: (result) => ({ checked: result.checked, fixed: result.fixed }),
  });
}

async function actBulkValidate(admin, payload) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  const format = oneOf(payload.format || "json", ["json", "csv"], "format");
  const { rows, errors } = ownAi.parseBulkImport(cleanText(payload.text, 200000), format);
  const verdicts = await ownAi.validateBulkRows(rows);
  return {
    format,
    errors,
    verdicts: verdicts.map(({ payload: rowPayload, ...verdict }) => verdict),
    valid: verdicts.filter((verdict) => verdict.ok).length,
    total: verdicts.length,
  };
}

async function actBulkImport(admin, payload, reason, ip) {
  assertCan(admin, "ai", "control");
  assertCan(admin, "problems", "create");
  await ownAi.loadState();
  const format = oneOf(payload.format || "json", ["json", "csv"], "format");
  const { rows, errors } = ownAi.parseBulkImport(cleanText(payload.text, 200000), format);
  if (errors.length && !rows.length) {
    const error = new Error(errors[0].error);
    error.status = 400; error.code = "validation_error";
    throw error;
  }
  const verdicts = await ownAi.validateBulkRows(rows);
  return audited(admin, "bulk_import", reason, ip, {
    destructive: true,
    execute: () => ownAi.runBulkImport(verdicts, { actorId: admin.admin_id }),
    getNew: (result) => ({ added: result.added, invalid: verdicts.filter((verdict) => !verdict.ok).length, parse_errors: errors }),
  });
}

async function actTestText(admin, payload) {
  assertCan(admin, "ai", "control");
  await ownAi.loadState();
  const text = cleanText(payload.text, 2000);
  if (!text) {
    const error = new Error("text is required");
    error.status = 400; error.code = "validation_error";
    throw error;
  }
  return { scan: ownAi.scanText(text) };
}

async function actDiagnose(admin, payload) {
  assertCan(admin, "ai", "control");
  const code = cleanText(payload.code, 30000);
  if (!code.trim()) {
    const error = new Error("code is required");
    error.status = 400; error.code = "validation_error";
    throw error;
  }
  return { report: ownAi.diagnoseCode(code) };
}

async function actClearLogs(admin, reason, ip) {
  assertCan(admin, "ai", "control");
  return audited(admin, "clear_logs", reason, ip, {
    destructive: true,
    execute: () => ownAi.clearLogs(),
    getNew: () => ({ cleared: true }),
  });
}

async function actBellRead(admin) {
  assertCan(admin, "ai", "control");
  await ownAi.kvSet(`bell_seen:${admin.admin_id}`, Date.now());
  return { ok: true };
}

const ACTIONS = {
  save_settings: (admin, payload, reason, ip) => actSaveSettings(admin, payload, reason, ip),
  watch: (admin) => actWatch(admin),
  scan: (admin, payload, reason, ip) => actScan(admin, reason, ip),
  generate: (admin, payload, reason, ip) => actGenerate(admin, payload, reason, ip),
  preview: (admin) => actPreview(admin),
  dedup: (admin, payload, reason, ip) => actDedup(admin, reason, ip),
  errguard: (admin, payload, reason, ip) => actErrguard(admin, payload, reason, ip),
  welcome: (admin, payload, reason, ip) => actWelcome(admin, payload, reason, ip),
  expiry: (admin, payload, reason, ip) => actExpiry(admin, payload, reason, ip),
  winback: (admin, payload, reason, ip) => actWinback(admin, payload, reason, ip),
  stuck: (admin, payload, reason, ip) => actStuck(admin, payload, reason, ip),
  leaderboard: (admin, payload, reason, ip) => actLeaderboard(admin, payload, reason, ip),
  faq: (admin, payload, reason, ip) => actFaq(admin, payload, reason, ip),
  digest: (admin, payload, reason, ip) => actDigest(admin, payload, reason, ip),
  health: (admin) => actHealth(admin),
  calibrate: (admin) => actCalibrate(admin),
  calibrate_apply: (admin, payload, reason, ip) => actCalibrateApply(admin, payload, reason, ip),
  cheat: (admin) => actCheat(admin),
  gap: (admin, payload, reason, ip) => actGap(admin, payload, reason, ip),
  variations: (admin, payload, reason, ip) => actVariations(admin, payload, reason, ip),
  quality: (admin) => actQuality(admin),
  hints: (admin, payload, reason, ip) => actHints(admin, reason, ip),
  bulk_validate: (admin, payload) => actBulkValidate(admin, payload),
  bulk_import: (admin, payload, reason, ip) => actBulkImport(admin, payload, reason, ip),
  test_text: (admin, payload) => actTestText(admin, payload),
  diagnose: (admin, payload) => actDiagnose(admin, payload),
  clear_logs: (admin, payload, reason, ip) => actClearLogs(admin, reason, ip),
  bell_read: (admin) => actBellRead(admin),
};

const READS = {
  settings: (admin) => readSettings(admin),
  logs: (admin, q) => readLogs(admin, q),
  bell: (admin) => readBell(admin),
  digest: (admin) => readDigest(admin),
  stats: (admin) => readStats(admin),
};

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      method(req, ["GET"]);
      const admin = await requireAdmin(req);
      const q = query(req);
      const action = cleanText(q.action || "settings", 40);
      const read = READS[action];
      if (!read) {
        const error = new Error("Unknown AI read action");
        error.status = 404; error.code = "not_found";
        throw error;
      }
      return send(res, 200, { ok: true, data: await read(admin, q) });
    }
    method(req, ["POST"]);
    assertSameOrigin(req);
    const admin = await requireAdmin(req, { csrf: true });
    const body = await readJson(req);
    const action = cleanText(body.action, 40);
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const reason = cleanText(body.reason, 1000);
    const ip = clientIp(req);
    const run = ACTIONS[action];
    if (!run) {
      const error = new Error("Unknown AI action");
      error.status = 404; error.code = "not_found";
      throw error;
    }
    return send(res, 200, { ok: true, data: await run(admin, payload, reason, ip) });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports._internals = {
  ACTIONS, READS,
  actSaveSettings, actWatch, actScan, actGenerate, actPreview, actDedup, actErrguard,
  actWelcome, actExpiry, actWinback, actStuck, actLeaderboard, actFaq, actDigest,
  actHealth, actCalibrate, actCalibrateApply, actCheat, actGap, actVariations,
  actQuality, actHints, actBulkValidate, actBulkImport, actTestText, actDiagnose,
  actClearLogs, actBellRead, intInRange,
};
