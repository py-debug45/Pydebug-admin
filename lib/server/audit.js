"use strict";

const defaultDb = require("../../api/_db");

const SECRET_KEYS = /password|secret|token|authorization|cookie|key/i;

function sanitize(value, depth = 0) {
  if (value == null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 4000) return `${value.slice(0, 4000)}…`;
    return value;
  }
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SECRET_KEYS.test(key) ? "[redacted]" : sanitize(nested, depth + 1);
  }
  return output;
}

function requireReason(reason, destructive = false) {
  const value = String(reason || "").trim();
  if (destructive && value.length < 5) {
    const error = new Error("A reason of at least 5 characters is required");
    error.status = 400;
    error.code = "reason_required";
    throw error;
  }
  return value || null;
}

async function insertAudit({ db = defaultDb, admin, resource, action, targetId, oldValue, newValue, reason, ip }) {
  return db.insert("admin_audit_log", {
    admin_id: admin.admin_id,
    admin_role: admin.role,
    resource,
    action,
    target_id: targetId == null ? null : String(targetId),
    old_value: sanitize(oldValue),
    new_value: sanitize(newValue),
    reason: reason || null,
    ip: ip || null,
  });
}

async function withAudit(options) {
  const reason = requireReason(options.reason, options.destructive);
  const oldValue = options.getOld ? await options.getOld() : options.oldValue;
  const result = await options.execute(oldValue);
  const newValue = options.getNew ? await options.getNew(result, oldValue) : (options.newValue === undefined ? result : options.newValue);
  const targetId = typeof options.targetId === "function"
    ? options.targetId(result, oldValue)
    : options.targetId;
  try {
    await insertAudit({ ...options, targetId, oldValue, newValue, reason });
  } catch (cause) {
    const error = new Error("The change was applied, but its audit record could not be written. Stop further admin changes and investigate immediately.");
    error.status = 500;
    error.code = "audit_write_failed";
    error.cause = cause;
    throw error;
  }
  return result;
}

module.exports = { sanitize, requireReason, insertAudit, withAudit };
