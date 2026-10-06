"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { signPayload, verifyToken, parseCookies } = require("../lib/server/session");
const { generateSecret, hotp, verifyTotp, encryptSecret, decryptSecret } = require("../lib/server/totp");

const SECRET = "test-session-secret-that-is-longer-than-thirty-two-characters";

test("signed admin session accepts a valid payload and rejects tampering", () => {
  const now = 2_000_000_000;
  const token = signPayload({ admin_id: "admin-1", role: "superadmin", exp: now + 60 }, SECRET);
  assert.equal(verifyToken(token, SECRET, now).role, "superadmin");
  const [payload, signature] = token.split(".");
  const tampered = `${payload.slice(0, -1)}A.${signature}`;
  assert.equal(verifyToken(tampered, SECRET, now), null);
});

test("expired admin session is rejected", () => {
  const token = signPayload({ admin_id: "admin-1", role: "support", exp: 99 }, SECRET);
  assert.equal(verifyToken(token, SECRET, 100), null);
});

test("cookie parser handles the HttpOnly session cookie among other cookies", () => {
  const cookies = parseCookies("theme=dark; __Host-pydebug_admin=abc.def; hello=world");
  assert.equal(cookies["__Host-pydebug_admin"], "abc.def");
});

test("RFC 6238 code verifies only inside the configured time window", () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const code = hotp(secret, Math.floor(now / 30000));
  assert.equal(verifyTotp(secret, code, now), true);
  assert.equal(verifyTotp(secret, code, now + 120000), false);
  assert.equal(verifyTotp(secret, "123"), false);
});

test("TOTP secret encryption round-trips and is authenticated", () => {
  const encrypted = encryptSecret("JBSWY3DPEHPK3PXP", SECRET);
  assert.notEqual(encrypted.includes("JBSWY3DPEHPK3PXP"), true);
  assert.equal(decryptSecret(encrypted, SECRET), "JBSWY3DPEHPK3PXP");
  const parts = encrypted.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.throws(() => decryptSecret(parts.join("."), SECRET));
});
