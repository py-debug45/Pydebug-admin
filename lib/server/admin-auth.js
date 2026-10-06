"use strict";

const db = require("../../api/_db");
const { requireSession } = require("./session");

async function requireAdmin(req, options = {}) {
  const session = requireSession(req, options);
  const current = await db.one("admin_users", {
    select: "user_id,email,role,totp_enabled",
    filters: [{ column: "user_id", op: "eq", value: session.admin_id }],
  });
  if (!current) {
    const error = new Error("Admin access has been revoked");
    error.status = 401;
    error.code = "admin_revoked";
    throw error;
  }
  if (["superadmin", "finance"].includes(current.role) && !current.totp_enabled) {
    const error = new Error("Two-factor authentication is required for this role");
    error.status = 401;
    error.code = "two_factor_required";
    throw error;
  }
  return {
    ...session,
    role: current.role,
    email: current.email,
    user_id: current.user_id,
  };
}

module.exports = { requireAdmin };
