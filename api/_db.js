"use strict";

const DEFAULT_TIMEOUT_MS = 15000;

function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) {
    const error = new Error(`Server configuration is missing ${name}`);
    error.status = 503;
    error.code = "server_not_configured";
    throw error;
  }
  return value || "";
}

function serviceHeaders(extra = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    const error = new Error(cause?.name === "AbortError" ? "Database request timed out" : "Database request failed");
    error.status = 502;
    error.code = cause?.name === "AbortError" ? "db_timeout" : "db_unavailable";
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(path, options = {}) {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") params.append(key, String(value));
  }
  const url = `${base}/rest/v1/${path}${params.size ? `?${params}` : ""}`;
  const headers = serviceHeaders(options.headers);
  const response = await fetchWithTimeout(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }, options.timeoutMs);
  const raw = options.method === "HEAD" ? "" : await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.hint || `Database returned ${response.status}`);
    error.status = response.status >= 500 ? 502 : 400;
    error.code = data?.code || "db_error";
    error.details = data;
    throw error;
  }
  return { data, headers: response.headers, status: response.status };
}

function buildQuery(options = {}) {
  const query = { select: options.select || "*" };
  for (const filter of options.filters || []) {
    if (!filter || !filter.column || !filter.op) continue;
    query[filter.column] = `${filter.op}.${filter.value}`;
  }
  if (options.or) query.or = options.or;
  if (options.order) query.order = options.order;
  if (options.limit !== undefined) query.limit = Math.max(0, Number(options.limit));
  if (options.offset !== undefined) query.offset = Math.max(0, Number(options.offset));
  return query;
}

async function list(table, options = {}) {
  const headers = {};
  if (options.count) headers.Prefer = "count=exact";
  const result = await request(table, { query: buildQuery(options), headers });
  const range = result.headers.get("content-range") || "";
  const match = range.match(/\/(\d+|\*)$/);
  return {
    rows: Array.isArray(result.data) ? result.data : [],
    count: match && match[1] !== "*" ? Number(match[1]) : null,
  };
}

async function one(table, options = {}) {
  const result = await list(table, { ...options, limit: 1 });
  if (!result.rows[0] && options.required) {
    const error = new Error(options.notFoundMessage || "Record not found");
    error.status = 404;
    error.code = "not_found";
    throw error;
  }
  return result.rows[0] || null;
}

async function count(table, options = {}) {
  const result = await request(table, {
    method: "HEAD",
    query: buildQuery({ ...options, select: options.select || "*", limit: 1 }),
    headers: { Prefer: "count=exact" },
  });
  const range = result.headers.get("content-range") || "";
  const match = range.match(/\/(\d+|\*)$/);
  return match && match[1] !== "*" ? Number(match[1]) : 0;
}

async function insert(table, body, options = {}) {
  const headers = { Prefer: options.upsert ? "resolution=merge-duplicates,return=representation" : "return=representation" };
  const query = {};
  if (options.onConflict) query.on_conflict = options.onConflict;
  const result = await request(table, { method: "POST", query, headers, body });
  return Array.isArray(result.data) ? (options.many ? result.data : result.data[0]) : result.data;
}

async function update(table, body, options = {}) {
  const result = await request(table, {
    method: "PATCH",
    query: buildQuery({ ...options, select: undefined }),
    headers: { Prefer: "return=representation" },
    body,
  });
  return Array.isArray(result.data) ? (options.many ? result.data : result.data[0]) : result.data;
}

async function remove(table, options = {}) {
  const result = await request(table, {
    method: "DELETE",
    query: buildQuery({ ...options, select: undefined }),
    headers: { Prefer: "return=representation" },
  });
  return Array.isArray(result.data) ? (options.many ? result.data : result.data[0]) : result.data;
}

async function rpc(name, body = {}) {
  const result = await request(`rpc/${name}`, { method: "POST", body });
  return result.data;
}

async function authPassword(email, password) {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const anon = env("SUPABASE_ANON_KEY");
  const response = await fetchWithTimeout(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.user) {
    const error = new Error("Invalid email or password");
    error.status = 401;
    error.code = "invalid_credentials";
    throw error;
  }
  return data.user;
}

async function authAdminDelete(userId) {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const response = await fetchWithTimeout(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: serviceHeaders(),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.message || "Could not delete auth user");
    error.status = 502;
    error.code = "auth_admin_error";
    throw error;
  }
  return true;
}

module.exports = {
  env, request, list, one, count, insert, update, remove, rpc,
  authPassword, authAdminDelete, fetchWithTimeout,
};
