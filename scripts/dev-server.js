#!/usr/bin/env node
"use strict";

/*
 * Local development server for the PyDebug admin console.
 *
 *   PYDEBUG_ADMIN_DEV=1 npm run dev          (or: node scripts/dev-server.js)
 *
 * It serves the static admin UI and wires /api/* to the REAL serverless
 * handlers (api/auth.js, api/read.js, api/write.js, api/jobs.js, api/ai.js).
 * Instead of Supabase, a tiny in-memory PostgREST-compatible mock runs on
 * the loopback interface, so the full panel — including the AI studio —
 * works with zero configuration and zero production credentials.
 *
 * This script is for local development only; Vercel never deploys it.
 * Demo accounts (any password works):
 *   dev@pydebug.local   -> content_editor (no 2FA, full problems + AI studio)
 *   root@pydebug.local  -> superadmin (real TOTP enrollment on first login)
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

if (process.env.PYDEBUG_ADMIN_DEV !== "1") {
  console.error("Refusing to start: set PYDEBUG_ADMIN_DEV=1 to acknowledge this is the local mock-data server.");
  console.error("  PYDEBUG_ADMIN_DEV=1 npm run dev");
  process.exit(1);
}

const ROOT = path.normalize(path.join(__dirname, ".."));
const PORT = Number(process.env.PORT) || 3000;
const MOCK_PORT = Number(process.env.DEV_MOCK_PORT) || (PORT + 1);

process.env.SUPABASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.SUPABASE_ANON_KEY = "dev-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dev-service-role-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(36).toString("base64url");
if (!process.env.ADMIN_ALLOWED_EMAILS) process.env.ADMIN_ALLOWED_EMAILS = "";

const ai = require("../lib/server/ai-engine");

/* ------------------------------------------------------------------ *
 * In-memory tables + seed data.
 * ------------------------------------------------------------------ */
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const DAY = 86400000;

const ROOT_ADMIN_ID = "00000000-0000-4000-8000-root000000001";
const DEV_ADMIN_ID = "00000000-0000-4000-8000-dev00000000001";

const users = [
  ["Aarav Sharma", "aarav@example.com", 25, 12, 1240, "active"],
  ["Priya Nair", "priya@example.com", 14, 7, 980, "active"],
  ["Rohan Gupta", "rohan@example.com", 9, 4, 610, "active"],
  ["Sneha Iyer", "sneha@example.com", 6, 2, 340, "warned"],
  ["Kabir Khan", "kabir@example.com", 31, 21, 2210, "active"],
  ["Meera Pillai", "meera@example.com", 3, 1, 150, "active"],
  ["Dev Joshi", "dev@example.com", 18, 9, 870, "muted"],
  ["Ananya Ray", "ananya@example.com", 44, 30, 3120, "active"],
].map(([name, email, streakDays, joinedDays, xp, status], index) => ({
  id: `00000000-0000-4000-8000-user${String(index).padStart(4, "0")}`,
  full_name: name,
  email,
  display_name: name.split(" ")[0],
  avatar_url: null,
  is_premium: index % 3 === 0,
  premium_expires_at: index % 3 === 0 ? iso(-90 * DAY) : null,
  xp,
  streak: streakDays,
  streak_freezes: index % 4,
  last_active_date: new Date(now - (index % 3) * DAY).toISOString().slice(0, 10),
  referral_code: `PYD${1000 + index}`,
  referral_count: index % 5,
  referral_qualified_count: Math.max(0, (index % 5) - 1),
  status,
  status_reason: status === "active" ? null : "dev preview sample",
  status_until: null,
  battle_invites_enabled: true,
  battle_plays: index * 3,
  battle_wins: index,
  created_at: iso(joinedDays * DAY),
}));

// Seed problems from the local AI engine itself so shapes always stay in sync.
// Fixed seed 4242: reusing it in the AI studio shows duplicate-blocking live.
const seededAi = ai.generateProblems({ seed: 4242, count: 4, type: "any", difficulty: "any" });
const seededAi2 = ai.generateProblems({ seed: 909, count: 3, type: "bug", difficulty: "easy" });
const problems = [...seededAi, ...seededAi2].map((problem, index) => ({
  id: `00000000-0000-4000-8000-prob${String(index).padStart(4, "0")}`,
  ...problem,
  is_premium: index % 4 === 0,
  status: index < 5 ? "published" : "draft",
  created_by: DEV_ADMIN_ID,
  admin_skip_notification: true,
  created_at: iso((index + 2) * DAY),
  updated_at: iso(index * DAY),
}));

const payments = Array.from({ length: 12 }, (_, index) => {
  const plan = ["monthly", "sixmonth", "yearly"][index % 3];
  return {
    id: `00000000-0000-4000-8000-paym${String(index).padStart(4, "0")}`,
    user_id: users[index % users.length].id,
    plan,
    amount_paise: plan === "monthly" ? 9900 : plan === "sixmonth" ? 49900 : 89900,
    razorpay_payment_id: `pay_dev_${1000 + index}`,
    razorpay_order_id: `order_dev_${1000 + index}`,
    status: "captured",
    created_at: iso((index * 2 + 1) * DAY),
  };
});

const submissions = [];
problems.forEach((problem, problemIndex) => {
  users.forEach((user, userIndex) => {
    if ((problemIndex + userIndex) % 3 !== 0) return;
    const solved = (problemIndex + userIndex) % 2 === 0;
    submissions.push({
      id: crypto.randomUUID(),
      user_id: user.id,
      problem_id: problem.id,
      status: solved ? "solved" : "attempted",
      solved_at: solved ? iso((userIndex % 5) * DAY + 3600000) : null,
      created_at: iso((userIndex % 5) * DAY),
    });
  });
});

const tables = new Map(Object.entries({
  profiles: users,
  problems,
  payments,
  submissions,
  admin_users: [
    { user_id: ROOT_ADMIN_ID, email: "root@pydebug.local", role: "superadmin", totp_enabled: false, totp_secret_encrypted: null, created_by: null, created_at: iso(60 * DAY), last_login_at: null },
    { user_id: DEV_ADMIN_ID, email: "dev@pydebug.local", role: "content_editor", totp_enabled: false, totp_secret_encrypted: null, created_by: ROOT_ADMIN_ID, created_at: iso(60 * DAY), last_login_at: null },
  ],
  admin_audit_log: [],
  app_settings: [
    { key: "maintenance_mode", value: false, updated_at: iso(3 * DAY) },
    { key: "daily_challenge_enabled", value: true, updated_at: iso(5 * DAY) },
  ],
  battles: [],
  push_subscriptions: users.slice(0, 4).map((user, index) => ({
    id: crypto.randomUUID(), user_id: user.id, endpoint: `https://dev-push/${index}`, created_at: iso(index * DAY),
  })),
  push_event_log: [],
  push_announcements: [],
  streak_reminder_log: [{ created_at: iso(2 * 3600000) }],
  notifications: [],
  discussion_flags: [],
  referral_signals: [],
  hint_unlocks: [],
  user_achievements: [],
}));

const authByEmail = new Map([
  ["root@pydebug.local", ROOT_ADMIN_ID],
  ["dev@pydebug.local", DEV_ADMIN_ID],
]);

/* ------------------------------------------------------------------ *
 * Tiny PostgREST-compatible mock.
 * ------------------------------------------------------------------ */
function rows(table) {
  if (!tables.has(table)) tables.set(table, []);
  return tables.get(table);
}

function parseValue(raw) {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function matchesOp(stored, op, raw) {
  const value = parseValue(raw);
  if (op === "is") return stored === null ? value === null : String(stored) === String(value);
  if (op === "in") {
    const list = String(raw).replace(/^\(/, "").replace(/\)$/, "").split(",").map((item) => item.trim());
    return list.some((item) => looseEquals(stored, parseValue(item)));
  }
  if (op === "ilike") {
    const pattern = String(raw).split("*").join("").toLowerCase();
    return String(stored ?? "").toLowerCase().includes(pattern);
  }
  if (op === "eq") return looseEquals(stored, value);
  if (op === "gte" || op === "lte") {
    const a = typeof stored === "number" ? stored : Date.parse(stored) || stored;
    const b = typeof value === "number" ? value : Date.parse(value) || value;
    if (typeof a === "number" && typeof b === "number") return op === "gte" ? a >= b : a <= b;
    return op === "gte" ? String(a) >= String(b) : String(a) <= String(b);
  }
  return true; // unknown op: permissive
}

function looseEquals(stored, value) {
  if (stored === null || stored === undefined) return value === null;
  if (typeof stored === "boolean") return value === stored;
  if (typeof stored === "number") return Number(value) === stored;
  return String(value) === String(stored);
}

function applyFilters(allRows, params) {
  const clauses = [];
  for (const [key, rawValue] of params.entries()) {
    if (["select", "order", "limit", "offset", "or", "on_conflict"].includes(key)) continue;
    const match = String(rawValue).match(/^([a-z]+)\.(.*)$/i);
    if (!match) continue;
    clauses.push({ key, op: match[1].toLowerCase(), raw: match[2] });
  }
  const orRaw = params.get("or");
  return allRows.filter((row) => {
    const every = clauses.every(({ key, op, raw }) => matchesOp(row[key], op, raw));
    if (!every) return false;
    if (!orRaw) return true;
    const inner = orRaw.replace(/^\(/, "").replace(/\)$/, "");
    return inner.split(",").some((clause) => {
      const separator = clause.indexOf(".");
      if (separator < 0) return true;
      const key = clause.slice(0, separator).trim();
      const rest = clause.slice(separator + 1);
      const opMatch = rest.match(/^([a-z]+)\.(.*)$/i);
      if (!opMatch) return true;
      return matchesOp(row[key], opMatch[1].toLowerCase(), opMatch[2]);
    });
  });
}

function statsView(params) {
  const grouped = new Map();
  for (const submission of rows("submissions")) {
    const entry = grouped.get(submission.problem_id) || { attempts: 0, solves: 0 };
    entry.attempts += 1;
    if (submission.status === "solved") entry.solves += 1;
    grouped.set(submission.problem_id, entry);
  }
  let out = [...grouped.entries()].map(([id, { attempts, solves }]) => ({
    id,
    attempt_count: attempts,
    solve_count: solves,
    success_rate: attempts ? Math.round((100 * solves) / attempts * 10) / 10 : 0,
  }));
  const idFilter = params.get("id");
  if (idFilter && idFilter.startsWith("in.")) {
    const list = idFilter.slice(3).replace(/^\(/, "").replace(/\)$/, "").split(",").map((item) => item.trim());
    out = out.filter((row) => list.includes(row.id));
  }
  return out;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  const params = url.searchParams;

  if (url.pathname === "/auth/v1/token") {
    const body = await readBody(req);
    const email = String(body.email || "").toLowerCase();
    const id = authByEmail.get(email) || crypto.randomUUID();
    return json(res, 200, { access_token: "dev", token_type: "bearer", user: { id, email } });
  }
  if (url.pathname === "/rest/v1/rpc/bootstrap_first_admin") return json(res, 200, null);

  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  if (!table) return json(res, 404, { message: "unknown mock route" });

  const isStats = table === "admin_problem_stats";
  const all = isStats ? statsView(params) : rows(table);
  const filtered = applyFilters(all, params);

  const order = params.get("order");
  if (order) {
    const [column, direction] = order.split(".");
    filtered.sort((a, b) => {
      const av = a[column] ?? ""; const bv = b[column] ?? "";
      const result = av === bv ? 0 : (av > bv ? 1 : -1);
      return direction === "desc" ? -result : result;
    });
  }
  const limit = Number(params.get("limit") || 0);
  const offset = Number(params.get("offset") || 0);
  const paged = filtered.slice(offset, limit ? offset + limit : undefined);
  const rangeEnd = filtered.length ? `${offset + paged.length - 1}` : "*";
  const rangeHeaders = { "Content-Range": `${offset}-${rangeEnd}/${filtered.length}` };

  if (req.method === "GET" || req.method === "HEAD") {
    if (req.method === "HEAD") { res.writeHead(200, rangeHeaders); return res.end(); }
    return json(res, 200, paged, rangeHeaders);
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    const list = Array.isArray(body) ? body : [body];
    const inserted = list.map((item) => ({
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      ...item,
    }));
    if (isStats) return json(res, 405, { message: "read-only view" });
    rows(table).push(...inserted);
    return json(res, 201, Array.isArray(body) ? inserted : inserted[0]);
  }
  if (req.method === "PATCH") {
    const body = await readBody(req);
    const targets = applyFilters(rows(table), params);
    targets.forEach((row) => Object.assign(row, body, { updated_at: new Date().toISOString() }));
    return json(res, 200, targets);
  }
  if (req.method === "DELETE") {
    const tableRows = rows(table);
    const targets = new Set(applyFilters(tableRows, params));
    const removed = tableRows.filter((row) => targets.has(row));
    tables.set(table, tableRows.filter((row) => !targets.has(row)));
    return json(res, 200, removed);
  }
  return json(res, 405, { message: "method not allowed" });
});

/* ------------------------------------------------------------------ *
 * Static file server + /api router to the real handlers.
 * ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

const handlers = {
  "/api/auth": require("../api/auth"),
  "/api/read": require("../api/read"),
  "/api/write": require("../api/write"),
  "/api/jobs": require("../api/jobs"),
  "/api/ai": require("../api/ai"),
};

const appServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://local`);
  const pathname = decodeURIComponent(url.pathname);

  if (handlers[pathname]) {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    return handlers[pathname](req, res);
  }

  let filePath = pathname === "/" ? "/index.html" : pathname;
  if (!path.extname(filePath) && fs.existsSync(path.join(ROOT, `${filePath}.html`))) filePath += ".html";
  const absolute = path.normalize(path.join(ROOT, filePath));
  if (!absolute.startsWith(ROOT) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  const type = MIME[path.extname(absolute)] || "application/octet-stream";
  const cache = pathname.startsWith("/css/") || pathname.startsWith("/js/")
    ? "public, max-age=0, must-revalidate" : "no-store, max-age=0";
  // No X-Frame-Options here on purpose: the dev server is meant to be embedded
  // in a local preview iframe. Production framing rules come from vercel.json.
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  fs.createReadStream(absolute).pipe(res);
});

mockServer.listen(MOCK_PORT, "127.0.0.1", () => {
  appServer.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("  PyDebug Admin · local development server (mock data)");
    console.log("  ─────────────────────────────────────────────────────");
    console.log(`  Panel:     http://localhost:${PORT}  (or the live preview URL)`);
    console.log(`  Mock API:  http://127.0.0.1:${MOCK_PORT}  (in-memory Supabase stand-in)`);
    console.log("  Logins (any password):");
    console.log("    dev@pydebug.local    content_editor — straight in, full AI studio");
    console.log("    root@pydebug.local   superadmin — real TOTP enrollment on first login");
    console.log("  Tip: open the AI studio and reuse seed 4242 to watch duplicate");
    console.log("       blocking refuse to re-add the seeded problems.");
    console.log("  All data is in-memory and resets on restart. Dev only — never deploy.");
    console.log("");
  });
});
