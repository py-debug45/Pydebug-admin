"use strict";

const crypto = require("node:crypto");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const text = String(input || "").toUpperCase().replace(/=|\s|-/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter, digits = 6) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function verifyTotp(secret, code, now = Date.now(), window = 1) {
  const supplied = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(supplied)) return false;
  const step = Math.floor(now / 30000);
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = hotp(secret, step + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return true;
  }
  return false;
}

function encryptionKey(sessionSecret) {
  return crypto.createHash("sha256").update(`pydebug-admin-totp:${sessionSecret}`).digest();
}

function encryptSecret(secret, sessionSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(sessionSecret), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptSecret(value, sessionSecret) {
  const [version, ivText, tagText, dataText] = String(value || "").split(".");
  if (version !== "v1" || !ivText || !tagText || !dataText) throw new Error("Invalid encrypted TOTP secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(sessionSecret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}

function otpauthUrl(secret, email) {
  const label = encodeURIComponent(`PyDebug Admin:${email}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent("PyDebug Admin")}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  base32Encode, base32Decode, generateSecret, hotp, verifyTotp,
  encryptSecret, decryptSecret, otpauthUrl,
};
