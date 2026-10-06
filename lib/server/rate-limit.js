"use strict";

const crypto = require("node:crypto");

async function upstash(path, body) {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Upstash ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function loginKey(ip) {
  const hash = crypto.createHash("sha256").update(String(ip || "unknown")).digest("hex").slice(0, 24);
  return `pydebug:admin:login:${hash}`;
}

async function checkLoginRateLimit(ip) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn("[admin-auth] Redis is not configured; login rate limiting is fail-open");
    return { allowed: true, remaining: null, degraded: true };
  }
  const key = loginKey(ip);
  try {
    const data = await upstash("/pipeline", [["INCR", key], ["EXPIRE", key, 900, "NX"]]);
    const count = Number(data?.[0]?.result || 0);
    return { allowed: count <= 5, remaining: Math.max(0, 5 - count), degraded: false };
  } catch (error) {
    console.warn("[admin-auth] Redis rate limiter failed open:", error.message);
    return { allowed: true, remaining: null, degraded: true };
  }
}

async function clearLoginRateLimit(ip) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return;
  try {
    await upstash("/pipeline", [["DEL", loginKey(ip)]]);
  } catch (error) {
    console.warn("[admin-auth] Could not clear login rate limit:", error.message);
  }
}

module.exports = { checkLoginRateLimit, clearLoginRateLimit };
