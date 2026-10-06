"use strict";

const crypto = require("node:crypto");
const COOKIE_NAME = "__Host-pydebug_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function sessionSecret() {
  const value = process.env.ADMIN_SESSION_SECRET || "";
  if (value.length < 32) {
    const error = new Error("ADMIN_SESSION_SECRET must be at least 32 characters");
    error.status = 503;
    error.code = "server_not_configured";
    throw error;
  }
  return value;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signature(encoded, secret = sessionSecret()) {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

function signPayload(payload, secret) {
  const encoded = encode(payload);
  return `${encoded}.${signature(encoded, secret)}`;
}

function verifyToken(token, secret = sessionSecret(), nowSeconds = Math.floor(Date.now() / 1000)) {
  const [encoded, supplied, extra] = String(token || "").split(".");
  if (!encoded || !supplied || extra) return null;
  const expected = signature(encoded, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const output = {};
  for (const pair of String(header || "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    output[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return output;
}

function issueSession(res, admin) {
  const now = Math.floor(Date.now() / 1000);
  const csrf = crypto.randomBytes(24).toString("base64url");
  const payload = {
    admin_id: admin.user_id,
    role: admin.role,
    email: admin.email,
    csrf,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const token = signPayload(payload);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
  return payload;
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return verifyToken(token);
}

function requireSession(req, options = {}) {
  const admin = getSession(req);
  if (!admin || !admin.admin_id || !admin.role) {
    const error = new Error("Authentication required");
    error.status = 401;
    error.code = "unauthorized";
    throw error;
  }
  if (options.csrf) {
    const supplied = String(req.headers["x-csrf-token"] || "");
    if (!supplied || supplied.length !== admin.csrf.length
      || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(admin.csrf))) {
      const error = new Error("CSRF validation failed");
      error.status = 403;
      error.code = "csrf_failed";
      throw error;
    }
  }
  return admin;
}

function issueChallenge(data, ttlSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  return signPayload({ ...data, type: "login_challenge", iat: now, exp: now + ttlSeconds });
}

function verifyChallenge(token) {
  const payload = verifyToken(token);
  return payload?.type === "login_challenge" ? payload : null;
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_SECONDS, signPayload, verifyToken, parseCookies,
  issueSession, clearSession, getSession, requireSession,
  issueChallenge, verifyChallenge, sessionSecret,
};
