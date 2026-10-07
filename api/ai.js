"use strict";

const crypto = require("node:crypto");
const db = require("./_db");
const { requireAdmin } = require("../lib/server/admin-auth");
const { assertCan } = require("../lib/server/permissions");
const { withAudit } = require("../lib/server/audit");
const { send, method, readJson, clientIp, assertSameOrigin, cleanText, handleError } = require("../lib/server/http");
const { boundedList } = require("../lib/server/data");
const ai = require("../lib/server/ai-engine");

/*
 * PyDebug Local AI endpoint. The generator itself lives in
 * lib/server/ai-engine.js and runs entirely on this server: no AI provider,
 * no API key, no outbound network call of any kind.
 *
 * Actions:
 *   preview — generate a seeded batch of problems without writing anything.
 *   publish — re-generate the exact previewed batch (seed + signature) and
 *             insert the problems that are not already in the library.
 *             Titles and starter code are normalized and compared with up to
 *             5,000 existing problems, so a problem is never added twice.
 */

const DEDUPE_SCAN_CAP = 5000;

function intInRange(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function seedFrom(value, { required = false } = {}) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff) return parsed;
  if (required) {
    const error = new Error("A valid preview seed is required");
    error.status = 400;
    error.code = "invalid_seed";
    throw error;
  }
  return crypto.randomInt(1, 0xffffffff);
}

async function existingProblemKeys() {
  const { rows } = await boundedList("problems", {
    select: "title,starter_code",
    order: "created_at.desc",
  }, DEDUPE_SCAN_CAP);
  const keys = new Set();
  for (const row of rows) {
    for (const key of ai.keysForRow(row)) keys.add(key);
  }
  return keys;
}

async function preview(admin, payload) {
  assertCan(admin, "problems", "create");
  const filters = ai.parseFilters(payload);
  const premium = ai.parsePremiumMode(payload.premium);
  const count = intInRange(payload.count, 5, 1, ai.MAX_BATCH);
  const seed = seedFrom(payload.seed);
  const problems = ai.generateProblems({ seed, count, ...filters, premium });
  if (!problems.length) {
    const error = new Error("The generator could not produce unique problems for this request");
    error.status = 503;
    error.code = "generation_exhausted";
    throw error;
  }
  return {
    engine: ai.engineLabel(),
    seed,
    signature: ai.batchSignature(problems),
    count: problems.length,
    premium,
    premium_count: problems.filter((problem) => problem.is_premium).length,
    problems,
  };
}

async function publish(admin, payload, reason, ip) {
  assertCan(admin, "problems", "create");
  const filters = ai.parseFilters(payload);
  const premium = ai.parsePremiumMode(payload.premium);
  const count = intInRange(payload.count, 1, 1, ai.MAX_BATCH);
  const seed = seedFrom(payload.seed, { required: true });
  const status = payload.status === "published" ? "published" : "draft";
  const notify = payload.notify_users === true;
  const skip = Array.isArray(payload.skip)
    ? [...new Set(payload.skip.map((index) => Math.floor(Number(index))).filter((index) => Number.isInteger(index) && index >= 0 && index < ai.MAX_BATCH))]
    : [];

  // Regenerate the exact batch the admin previewed. The signature proves the
  // engine produced the same problems; if templates changed since the preview,
  // the admin is asked to regenerate instead of publishing something unseen.
  const problems = ai.generateProblems({ seed, count, ...filters, premium });
  if (!problems.length) {
    const error = new Error("The generator could not produce unique problems for this request");
    error.status = 503;
    error.code = "generation_exhausted";
    throw error;
  }
  if (cleanText(payload.signature, 64) !== ai.batchSignature(problems)) {
    const error = new Error("This preview is no longer valid — generate the problems again");
    error.status = 409;
    error.code = "preview_expired";
    throw error;
  }

  const existing = await existingProblemKeys();
  const inserted = [];
  const skipped = [];

  for (let index = 0; index < problems.length; index += 1) {
    const problem = problems[index];
    if (skip.includes(index)) {
      skipped.push({ index, title: problem.title, is_premium: problem.is_premium === true, reason: "excluded_by_admin" });
      continue;
    }
    if (ai.problemKeys(problem).some((key) => existing.has(key))) {
      skipped.push({ index, title: problem.title, is_premium: problem.is_premium === true, reason: "duplicate" });
      continue;
    }
    const values = {
      type: problem.type,
      title: problem.title,
      description: problem.description,
      difficulty: problem.difficulty,
      topic: problem.topic,
      is_premium: problem.is_premium === true,
      starter_code: problem.starter_code,
      expected_output: problem.expected_output,
      hints: problem.hints,
      battle_error: problem.battle_error || "",
      status,
      created_by: admin.admin_id,
      admin_skip_notification: !notify,
    };
    const row = await withAudit({
      admin,
      resource: "problems",
      action: "ai_create",
      reason,
      ip,
      oldValue: null,
      execute: () => db.insert("problems", values),
      getNew: (result) => ({ title: problem.title, type: problem.type, difficulty: problem.difficulty, template: problem.template, status }),
      targetId: (result) => result?.id || null,
    });
    for (const key of ai.problemKeys(problem)) existing.add(key);
    inserted.push({
      index,
      id: row?.id || null,
      title: problem.title,
      type: problem.type,
      difficulty: problem.difficulty,
      topic: problem.topic,
      is_premium: problem.is_premium === true,
      battle_error: problem.battle_error || null,
      status,
    });
  }

  return {
    engine: ai.engineLabel(),
    seed,
    status,
    premium_count: inserted.filter((row) => row.is_premium).length,
    inserted_count: inserted.length,
    skipped_count: skipped.length,
    inserted,
    skipped,
  };
}

async function stats(admin) {
  assertCan(admin, "problems", "read");
  return {
    engine: ai.engineLabel(),
    templates: ai.TEMPLATES.length,
    inventory: ai.templateInventory(),
    max_batch: ai.MAX_BATCH,
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      method(req, ["GET"]);
      const admin = await requireAdmin(req);
      return send(res, 200, { ok: true, data: await stats(admin) });
    }
    method(req, ["POST"]);
    assertSameOrigin(req);
    const admin = await requireAdmin(req, { csrf: true });
    const body = await readJson(req);
    const action = cleanText(body.action, 40);
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const reason = cleanText(body.reason, 1000);
    const ip = clientIp(req);
    let data;
    if (action === "preview") data = await preview(admin, payload);
    else if (action === "publish") data = await publish(admin, payload, reason, ip);
    else { const error = new Error("Unknown AI action"); error.status = 404; error.code = "not_found"; throw error; }
    return send(res, 200, { ok: true, data });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports._internals = { preview, publish, intInRange, seedFrom };
