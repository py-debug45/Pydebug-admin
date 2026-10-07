#!/usr/bin/env node
"use strict";

/*
 * Full-panel API smoke test against a running dev server.
 *
 *   PYDEBUG_ADMIN_DEV=1 npm run dev          # terminal 1
 *   node scripts/smoke-panel.js [baseUrl]    # terminal 2 (default http://localhost:3000)
 *
 * Logs in as the content editor AND as the superadmin (completing the real
 * TOTP enrollment flow), then exercises every read endpoint, the AI studio
 * preview/publish flow with duplicate assertions, jobs (CSV exports) and a
 * representative set of writes. Exits 1 if anything fails.
 */

const crypto = require("node:crypto");

const BASE = process.argv[2] || "http://localhost:3000";
const results = [];
let failures = 0;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of String(input).toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1000000).padStart(6, "0");
}

async function api(path, { method = "GET", cookie, csrf, body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  headers.Origin = BASE;
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await response.json(); } catch { /* non-json */ }
  return { status: response.status, data, setCookie: response.headers.get("set-cookie") || "" };
}

async function login(email) {
  let loginResult = await api("/api/auth", { method: "POST", body: { action: "login", email, password: "dev-preview" } });
  if (loginResult.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(loginResult.data)}`);
  if (loginResult.data.step === "2fa") {
    // The superadmin was already enrolled by a previous smoke run (the dev
    // store is in-memory). The loopback-only mock exposes a reset for this.
    await resetRootTotp();
    loginResult = await api("/api/auth", { method: "POST", body: { action: "login", email, password: "dev-preview" } });
    if (loginResult.status !== 200) throw new Error(`login retry failed for ${email}: ${JSON.stringify(loginResult.data)}`);
  }
  if (loginResult.data.step === "2fa_setup") {
    const verify = await api("/api/auth", { method: "POST", body: { action: "verify_2fa", challenge: loginResult.data.challenge, code: totpCode(loginResult.data.secret) } });
    if (verify.status !== 200) throw new Error(`totp verify failed: ${JSON.stringify(verify.data)}`);
    return verify;
  }
  return loginResult;
}

function mockUrl() {
  if (process.env.SMOKE_MOCK_URL) return process.env.SMOKE_MOCK_URL;
  try {
    const url = new URL(BASE);
    return `${url.protocol}//127.0.0.1:${(Number(url.port) || 3000) + 1}`;
  } catch {
    return "http://127.0.0.1:3001";
  }
}

async function resetRootTotp() {
  const response = await fetch(`${mockUrl()}/rest/v1/admin_users?email=eq.root@pydebug.local`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ totp_enabled: false, totp_secret_encrypted: null }),
  });
  if (!response.ok) throw new Error(`could not reset dev TOTP state via the mock (${response.status})`);
}

function sessionParts(response) {
  const cookie = response.setCookie.split(";")[0];
  return { cookie, csrf: response.data.csrf };
}

async function expectOk(name, response, extra = (data) => "") {
  const ok = response.status === 200 && response.data?.ok === true;
  record(name, ok, ok ? "" : `${response.status} ${JSON.stringify(response.data).slice(0, 160)}${extra(response.data)}`);
  return response.data?.data;
}

async function expectStatus(name, response, status) {
  record(name, response.status === status, `${response.status} ${JSON.stringify(response.data).slice(0, 160)}`);
  return response;
}

async function main() {
  console.log(`PyDebug admin panel smoke test · ${BASE}`);

  /* ---- content editor pass ---- */
  console.log("\n· content editor (dev@pydebug.local)");
  const editor = sessionParts(await login("dev@pydebug.local"));
  await expectOk("dashboard read", await api(`/api/read?resource=dashboard&action=overview`, { cookie: editor.cookie }));
  const problemsData = await expectOk("problems list", await api(`/api/read?resource=problems&action=list&page_size=10`, { cookie: editor.cookie }));
  const firstProblem = problemsData?.rows?.[0];
  if (firstProblem) await expectOk("problem detail", await api(`/api/read?resource=problems&action=detail&id=${firstProblem.id}`, { cookie: editor.cookie }));
  await expectOk("own audit read", await api(`/api/read?resource=audit&action=list`, { cookie: editor.cookie }));
  await expectOk("editor audit export (own rows only)", await api("/api/jobs", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { job: "export", payload: { resource: "audit" }, reason: "smoke export" } }));
  await expectOk("global search", await api(`/api/read?resource=search&action=list&q=bug`, { cookie: editor.cookie }));
  await expectStatus("editor blocked from users read (RBAC)", await api(`/api/read?resource=users&action=list`, { cookie: editor.cookie }), 403);
  await expectStatus("editor blocked from payments read (RBAC)", await api(`/api/read?resource=payments&action=list`, { cookie: editor.cookie }), 403);
  await expectStatus("editor blocked from AI GET stats is allowed (problems read)", await api(`/api/ai?action=stats`, { cookie: editor.cookie }), 200);

  /* AI flow with premium mix */
  const preview = await expectOk("AI preview (10, quarter premium)", await api("/api/ai", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { action: "preview", payload: { type: "any", difficulty: "any", premium: "quarter", count: 10 } } }));
  const premiumInPreview = preview?.problems?.filter((p) => p.is_premium).length ?? -1;
  record("AI premium mix ≈1 in 4 (10 → 2-3)", premiumInPreview >= 2 && premiumInPreview <= 3, `got ${premiumInPreview}`);
  const firstPublish = await expectOk("AI publish", await api("/api/ai", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { action: "publish", payload: { seed: preview.seed, signature: preview.signature, count: 10, type: "any", difficulty: "any", premium: "quarter", status: "draft" }, reason: "smoke test batch" } }));
  const premiumInserted = firstPublish?.inserted?.filter((p) => p.is_premium).length ?? -1;
  const premiumSkipped = firstPublish?.skipped?.filter((p) => p.is_premium).length ?? 0;
  record("AI publish premium matches preview", premiumInserted + premiumSkipped === premiumInPreview, `preview ${premiumInPreview} vs inserted ${premiumInserted} + skipped ${premiumSkipped}`);
  const republish = await expectOk("AI republish same seed", await api("/api/ai", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { action: "publish", payload: { seed: preview.seed, signature: preview.signature, count: 10, type: "any", difficulty: "any", premium: "quarter" }, reason: "duplicate check" } }));
  record("AI republish blocked all as duplicates", republish?.inserted_count === 0 && republish?.skipped_count === 10, `inserted ${republish?.inserted_count} skipped ${republish?.skipped_count}`);
  const seed4242 = await expectOk("AI preview seed 4242 (seeded problems)", await api("/api/ai", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { action: "preview", payload: { type: "any", difficulty: "any", premium: "quarter", count: 4, seed: 4242 } } }));
  const seeded = await expectOk("AI publish seed 4242 (duplicates refused)", await api("/api/ai", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { action: "publish", payload: { seed: 4242, signature: seed4242.signature, count: 4, type: "any", difficulty: "any", premium: "quarter" }, reason: "seed duplicate check" } }));
  record("seed 4242 fully blocked as duplicate", seeded?.inserted_count === 0 && seeded?.skipped_count === 4, `inserted ${seeded?.inserted_count}`);
  await expectStatus("AI publish without seed rejected", await api("/api/ai", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { action: "publish", payload: { count: 3, signature: "x" }, reason: "no seed" } }), 400);
  await expectStatus("AI publish with stale signature rejected", await api("/api/ai", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { action: "publish", payload: { seed: 12345, signature: "deadbeef", count: 3 }, reason: "stale" } }), 409);

  /* editor writes */
  if (firstProblem) {
    await expectOk("problem edit", await api("/api/write", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { resource: "problems", action: "edit", payload: { id: firstProblem.id, topic: firstProblem.topic || "lists" }, reason: "smoke test touch" } }));
    await expectOk("problem duplicate", await api("/api/write", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { resource: "problems", action: "duplicate", payload: { id: firstProblem.id }, reason: "smoke test copy" } }));
  }
  await expectStatus("editor blocked from user suspend (RBAC)", await api("/api/write", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: { resource: "users", action: "suspend", payload: { id: "00000000-0000-4000-8000-0000000f0000" }, reason: "should be blocked" } }), 403);

  /* ---- superadmin pass (real TOTP enrollment) ---- */
  console.log("\n· superadmin (root@pydebug.local, real TOTP)");
  const root = sessionParts(await login("root@pydebug.local"));
  const dashData = await expectOk("dashboard read", await api(`/api/read?resource=dashboard&action=overview`, { cookie: root.cookie }));
  record("dashboard revenue comes from the payment ledger", (dashData?.kpis?.revenue_30d ?? 0) > 0, "revenue_30d is zero");
  await expectOk("users list", await api(`/api/read?resource=users&action=list`, { cookie: root.cookie }));
  const usersData = await expectOk("users list with filters", await api(`/api/read?resource=users&action=list&plan=premium&inactive=7`, { cookie: root.cookie }));
  const targetUser = usersData?.rows?.[0];
  const anyUser = targetUser || (await api(`/api/read?resource=users&action=list`, { cookie: root.cookie })).data?.data?.rows?.[0];
  if (anyUser) await expectOk("user detail 360°", await api(`/api/read?resource=users&action=detail&id=${anyUser.id}`, { cookie: root.cookie }));
  const paymentsData = await expectOk("payments ledger", await api(`/api/read?resource=payments&action=list`, { cookie: root.cookie }));
  record("payments ledger shows verified purchases", (paymentsData?.rows?.length ?? 0) > 0, "no ledger rows");
  record("payments summary counts income", (paymentsData?.summary?.total_paise ?? 0) > 0, "income total is zero");
  record("payments page lists active premium users", (paymentsData?.active_premium?.length ?? 0) > 0, "no active premium users");
  await expectOk("referrals list", await api(`/api/read?resource=referrals&action=list`, { cookie: root.cookie }));
  await expectOk("battles list", await api(`/api/read?resource=battles&action=list`, { cookie: root.cookie }));
  await expectOk("moderation flags", await api(`/api/read?resource=moderation&action=list`, { cookie: root.cookie }));
  await expectOk("moderation feed", await api(`/api/read?resource=moderation&action=list&tab=feed`, { cookie: root.cookie }));
  await expectOk("push center", await api(`/api/read?resource=push&action=list`, { cookie: root.cookie }));
  await expectOk("emails log", await api(`/api/read?resource=emails&action=list`, { cookie: root.cookie }));
  await expectOk("reports overview", await api(`/api/read?resource=reports&action=overview&from=2020-01-01&to=2030-01-01`, { cookie: root.cookie }));
  await expectOk("settings + team", await api(`/api/read?resource=settings&action=list`, { cookie: root.cookie }));
  await expectOk("audit read_all with column filters", await api(`/api/read?resource=audit&action=list&log_resource=problems&log_action=ai_create`, { cookie: root.cookie }));
  const afterAudit = await api(`/api/read?resource=audit&action=list`, { cookie: root.cookie });
  const auditTotal = await expectOk("audit list shows rows (old zero-row bug)", afterAudit);
  record("audit rows present", (auditTotal?.total ?? 0) > 0, "audit list returned 0 rows");

  /* jobs */
  for (const resource of ["users", "payments", "audit", "problems", "referrals", "reports"]) {
    await expectOk(`export job: ${resource}`, await api("/api/jobs", { method: "POST", cookie: root.cookie, csrf: root.csrf, body: { job: "export", payload: { resource }, reason: "smoke export" } }));
  }
  const payExport = await expectOk("export job: payments ledger rows", await api("/api/jobs", { method: "POST", cookie: root.cookie, csrf: root.csrf, body: { job: "export", payload: { resource: "payments" }, reason: "smoke export" } }));
  record("payments export includes purchases", (payExport?.count ?? 0) > 0, "export returned no rows");

  /* superadmin writes */
  if (anyUser) {
    await expectOk("user warn", await api("/api/write", { method: "POST", cookie: root.cookie, csrf: root.csrf, body: { resource: "users", action: "warn", payload: { id: anyUser.id }, reason: "smoke warn" } }));
    await expectOk("user adjust xp", await api("/api/write", { method: "POST", cookie: root.cookie, csrf: root.csrf, body: { resource: "users", action: "adjust_xp", payload: { id: anyUser.id, delta: 10 }, reason: "smoke xp" } }));
    await expectOk("user restore streak", await api("/api/write", { method: "POST", cookie: root.cookie, csrf: root.csrf, body: { resource: "users", action: "restore_streak", payload: { id: anyUser.id, streak: 5 }, reason: "smoke streak" } }));
  }
  await expectOk("setting set", await api("/api/write", { method: "POST", cookie: root.cookie, csrf: root.csrf, body: { resource: "settings", action: "set", payload: { key: "smoke_flag", value: true }, reason: "smoke setting" } }));
  await expectStatus("CSRF rejection without token", await api("/api/write", { method: "POST", cookie: root.cookie, body: { resource: "settings", action: "set", payload: { key: "x", value: 1 }, reason: "no csrf" } }), 403);
  await expectStatus("unknown read resource is diagnosable", await api(`/api/read?resource=notathing`, { cookie: root.cookie }), 404);
  await expectStatus("missing read resource returns 400", await api(`/api/read`, { cookie: root.cookie }), 400);

  /* logout */
  await expectOk("logout", await api("/api/auth", { method: "POST", cookie: root.cookie, csrf: root.csrf, body: { action: "logout" } }));

  console.log(`\n${failures ? `✗ ${failures} failure(s)` : "✓ all checks passed"} · ${results.length} checks`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nSmoke test crashed: ${error.message}`);
  console.error("Is the dev server running?  PYDEBUG_ADMIN_DEV=1 npm run dev");
  process.exit(1);
});
