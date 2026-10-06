"use strict";

const db = require("./_db");
const { send, method, readJson, clientIp, assertSameOrigin, query, cleanText, handleError } = require("../lib/server/http");
const {
  issueSession, clearSession, getSession, issueChallenge, verifyChallenge, sessionSecret,
} = require("../lib/server/session");
const { checkLoginRateLimit, clearLoginRateLimit } = require("../lib/server/rate-limit");
const {
  generateSecret, verifyTotp, encryptSecret, decryptSecret, otpauthUrl,
} = require("../lib/server/totp");
const { ROLES } = require("../lib/server/permissions");
const { withAudit } = require("../lib/server/audit");

const REQUIRED_2FA_ROLES = new Set(["superadmin", "finance"]);

function allowedBootstrapEmails() {
  return new Set(String(process.env.ADMIN_ALLOWED_EMAILS || "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

async function findAdmin(userId) {
  return db.one("admin_users", {
    select: "user_id,email,role,totp_enabled,totp_secret_encrypted,last_login_at",
    filters: [{ column: "user_id", op: "eq", value: userId }],
  });
}

async function bootstrapAdmin(user, ip = null) {
  const email = String(user.email || "").toLowerCase();
  if (!allowedBootstrapEmails().has(email)) return null;
  const result = await db.rpc("bootstrap_first_admin", { p_user_id: user.id, p_email: email, p_ip: ip });
  const created = Array.isArray(result) ? result[0] : result;
  return created || null;
}

async function completeLogin(res, admin, ip = null) {
  const loggedInAt = new Date().toISOString();
  await withAudit({
    admin: { admin_id: admin.user_id, role: admin.role }, resource: "auth",
    action: "login", targetId: admin.user_id, ip,
    oldValue: { last_login_at: admin.last_login_at || null },
    execute: () => db.update("admin_users", { last_login_at: loggedInAt }, {
      filters: [{ column: "user_id", op: "eq", value: admin.user_id }],
    }),
    newValue: { last_login_at: loggedInAt },
  });
  const session = issueSession(res, admin);
  send(res, 200, {
    ok: true,
    user: { id: admin.user_id, email: admin.email, role: admin.role },
    csrf: session.csrf,
    expires_at: session.exp,
  });
}

async function login(req, res, body) {
  const ip = clientIp(req);
  const rate = await checkLoginRateLimit(ip);
  if (!rate.allowed) {
    const error = new Error("Too many login attempts. Try again in 15 minutes.");
    error.status = 429;
    error.code = "rate_limited";
    throw error;
  }
  const email = cleanText(body.email, 320).toLowerCase();
  const password = String(body.password || "");
  if (!email || !password || password.length > 1024) {
    const error = new Error("Email and password are required");
    error.status = 400;
    error.code = "validation_error";
    throw error;
  }
  const authUser = await db.authPassword(email, password);
  let admin = await findAdmin(authUser.id);
  if (!admin) admin = await bootstrapAdmin(authUser, ip);
  if (!admin || !ROLES.includes(admin.role)) {
    const error = new Error("This account is not authorized for the admin panel");
    error.status = 403;
    error.code = "not_admin";
    throw error;
  }
  await clearLoginRateLimit(ip);

  const shouldUse2fa = REQUIRED_2FA_ROLES.has(admin.role) || admin.totp_enabled;
  if (!shouldUse2fa) return completeLogin(res, admin, ip);

  const challenge = issueChallenge({ admin_id: admin.user_id, purpose: admin.totp_enabled ? "verify_2fa" : "setup_2fa" });
  if (admin.totp_enabled) {
    return send(res, 200, { ok: true, step: "2fa", challenge });
  }

  let secret;
  if (admin.totp_secret_encrypted) {
    secret = decryptSecret(admin.totp_secret_encrypted, sessionSecret());
  } else {
    secret = generateSecret();
    const encryptedSecret = encryptSecret(secret, sessionSecret());
    await withAudit({
      admin: { admin_id: admin.user_id, role: admin.role }, resource: "auth",
      action: "totp_setup_started", targetId: admin.user_id, ip,
      oldValue: { totp_enabled: false, totp_secret_encrypted: null },
      execute: () => db.update("admin_users", { totp_secret_encrypted: encryptedSecret }, {
        filters: [{ column: "user_id", op: "eq", value: admin.user_id }],
      }),
      newValue: { totp_enabled: false, totp_secret_encrypted: encryptedSecret },
    });
  }
  return send(res, 200, {
    ok: true,
    step: "2fa_setup",
    challenge,
    secret,
    otpauth_url: otpauthUrl(secret, admin.email),
  });
}

async function confirm2fa(req, res, body) {
  const ip = clientIp(req);
  const rate = await checkLoginRateLimit(ip);
  if (!rate.allowed) {
    const error = new Error("Too many verification attempts. Try again later.");
    error.status = 429;
    error.code = "rate_limited";
    throw error;
  }
  const challenge = verifyChallenge(body.challenge);
  if (!challenge || !["verify_2fa", "setup_2fa"].includes(challenge.purpose)) {
    const error = new Error("The verification challenge is invalid or expired. Please log in again.");
    error.status = 401;
    error.code = "invalid_challenge";
    throw error;
  }
  const admin = await findAdmin(challenge.admin_id);
  if (!admin || !admin.totp_secret_encrypted) {
    const error = new Error("2FA setup was not found. Please log in again.");
    error.status = 401;
    error.code = "invalid_challenge";
    throw error;
  }
  const secret = decryptSecret(admin.totp_secret_encrypted, sessionSecret());
  if (!verifyTotp(secret, body.code)) {
    const error = new Error("Invalid authenticator code");
    error.status = 401;
    error.code = "invalid_totp";
    throw error;
  }
  if (!admin.totp_enabled) {
    await withAudit({
      admin: { admin_id: admin.user_id, role: admin.role }, resource: "auth",
      action: "totp_enabled", targetId: admin.user_id, ip,
      oldValue: { totp_enabled: false },
      execute: () => db.update("admin_users", { totp_enabled: true }, {
        filters: [{ column: "user_id", op: "eq", value: admin.user_id }],
      }),
      newValue: { totp_enabled: true },
    });
    admin.totp_enabled = true;
  }
  await clearLoginRateLimit(ip);
  return completeLogin(res, admin, ip);
}

async function session(req, res) {
  const value = getSession(req);
  if (!value) return send(res, 401, { error: "Authentication required", code: "unauthorized" });
  const admin = await findAdmin(value.admin_id);
  if (!admin) {
    clearSession(res);
    return send(res, 401, { error: "Admin access has been revoked", code: "admin_revoked" });
  }
  if (REQUIRED_2FA_ROLES.has(admin.role) && !admin.totp_enabled) {
    clearSession(res);
    return send(res, 401, { error: "Two-factor authentication is required for this role", code: "two_factor_required" });
  }
  return send(res, 200, {
    ok: true,
    user: { id: admin.user_id, email: admin.email, role: admin.role },
    csrf: value.csrf,
    expires_at: value.exp,
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      method(req, ["GET"]);
      if ((query(req).action || "session") !== "session") {
        const error = new Error("Unknown auth action"); error.status = 404; throw error;
      }
      return await session(req, res);
    }
    method(req, ["POST"]);
    assertSameOrigin(req);
    const body = await readJson(req);
    const action = cleanText(body.action, 40);
    if (action === "login") return await login(req, res, body);
    if (action === "verify_2fa") return await confirm2fa(req, res, body);
    if (action === "logout") {
      clearSession(res);
      return send(res, 200, { ok: true });
    }
    const error = new Error("Unknown auth action"); error.status = 404; throw error;
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports._internals = { allowedBootstrapEmails, REQUIRED_2FA_ROLES, bootstrapAdmin };
