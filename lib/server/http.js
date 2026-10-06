"use strict";

const net = require("node:net");
const MAX_BODY_BYTES = 1024 * 1024;

function setSecurityHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function send(res, status, body) {
  setSecurityHeaders(res);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function method(req, allowed) {
  if (!allowed.includes(req.method)) {
    const error = new Error("Method not allowed");
    error.status = 405;
    error.code = "method_not_allowed";
    throw error;
  }
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const candidate = forwarded || req.socket?.remoteAddress || "";
  const normalized = candidate.startsWith("::ffff:") ? candidate.slice(7) : candidate;
  return net.isIP(normalized) ? normalized : null;
}

function assertSameOrigin(req) {
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    const error = new Error("Cross-site request blocked");
    error.status = 403;
    error.code = "csrf_origin";
    throw error;
  }
  const origin = req.headers.origin;
  if (!origin) return;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  try {
    if (new URL(origin).host !== host) throw new Error("mismatch");
  } catch {
    const error = new Error("Origin check failed");
    error.status = 403;
    error.code = "csrf_origin";
    throw error;
  }
}

function query(req) {
  // Merge the runtime-parsed query object with the raw URL search params.
  // Some proxies/runtimes hand over an empty (but truthy) req.query when the
  // query string was re-encoded, which previously made reads 404 with
  // "Unknown read resource or action". The URL is always parsed as a fallback
  // and repeated params keep their last value.
  const merged = {};
  try {
    const url = new URL(req.url || "", "http://local");
    for (const [key, value] of url.searchParams.entries()) {
      if (value !== "") merged[key] = value;
    }
  } catch { /* keep whatever the runtime provided */ }
  const runtime = req.query && typeof req.query === "object" && !Array.isArray(req.query) ? req.query : {};
  for (const [key, value] of Object.entries(runtime)) {
    const current = merged[key];
    if (current === undefined || current === null || current === "") {
      merged[key] = Array.isArray(value) ? String(value[value.length - 1]) : value;
    }
  }
  return merged;
}

function pagination(q) {
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(q.page_size, 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function cleanText(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function requiredText(value, name, max = 500) {
  const text = cleanText(value, max);
  if (!text) {
    const error = new Error(`${name} is required`);
    error.status = 400;
    error.code = "validation_error";
    throw error;
  }
  return text;
}

function handleError(res, error) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error("[admin-api]", error);
  send(res, status, {
    error: status >= 500 ? "Internal server error" : error.message,
    code: error.code || (status >= 500 ? "internal_error" : "request_error"),
  });
}

module.exports = {
  send, method, readJson, clientIp, assertSameOrigin, query, pagination,
  cleanText, requiredText, handleError,
};
