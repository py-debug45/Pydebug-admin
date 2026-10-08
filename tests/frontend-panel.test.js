"use strict";

/*
 * Frontend regression tests for the admin panel shell (js/admin.js) and page
 * module (js/pages.js). Both files are browser IIFEs, so they are evaluated
 * in a Node vm context with a minimal DOM shim and a capturing fetch stub.
 *
 * These tests pin down two production incidents:
 *  1. The sidebar never linked to the AI Control page (/ai.html) even though
 *     the page, its handler and /api/ai all existed.
 *  2. An older pages.js built the audit page's read URL from page state that
 *     contained `resource`/`action` keys, which emptied the router params and
 *     made /api/read answer "Missing resource parameter — the request reached
 *     the API without its query string". A.read must always send the real
 *     resource/action and drop empty filter values.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

const PAYMENTS_FIXTURE = {
  rows: [{
    payment_id: "pay_test_1",
    order_id: "order_test_1",
    user_id: "u1",
    plan_key: "monthly",
    plan_label: "Monthly",
    amount_paise: 7900,
    list_price_paise: 9900,
    discount_paise: 2000,
    discount_source: "signup_offer",
    expires_at: "2026-11-06T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    source: "razorpay",
    razorpay_matched: true,
    user: { id: "u1", display_name: "Test User", email: "test@example.com" },
  }],
  total: 1,
  page: 1,
  page_size: 50,
  summary: { total_paise: 7900, days30_paise: 7900, days90_paise: 7900, count: 1, paying_users: 1, by_plan: { monthly: 7900 } },
  daily: [{ date: "2026-10-07", monthly: 7900, sixmonth: 0, yearly: 0, other: 0 }],
  active_premium: [{ id: "u1", display_name: "Test User", email: "test@example.com", premium_expires_at: "2026-11-06T00:00:00.000Z" }],
  unmatched_payments: [],
};

function loadPanel(role = "content_editor", page = "audit") {
  const requests = [];
  const app = { innerHTML: "" };
  const pageContent = { innerHTML: "" };
  const sandbox = {
    console,
    URLSearchParams,
    URL,
    Blob: class Blob {},
    FormData: class FormData {},
    setTimeout,
    clearTimeout,
    navigator: {},
    history: { replaceState() {} },
    location: { replace() {}, search: "" },
    document: {
      body: { dataset: { page } },
      addEventListener() {},
      getElementById: (id) => (id === "app" ? app : id === "page-content" ? pageContent : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, append() {}, click() {}, remove() {} }),
    },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      let data = { rows: [], total: 0, page: 1, page_size: 50 };
      try {
        const parsed = new URL(String(url), "http://local");
        if (parsed.pathname === "/api/read" && parsed.searchParams.get("resource") === "payments") data = PAYMENTS_FIXTURE;
      } catch { /* keep the default shape */ }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true, data }),
      };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "admin.js"), "utf8"), sandbox, { filename: "js/admin.js" });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "pages.js"), "utf8"), sandbox, { filename: "js/pages.js" });
  sandbox.window.Admin.state.session = {
    id: "00000000-0000-4000-8000-00000000a002",
    email: "dev@pydebug.local",
    role,
  };
  return {
    sandbox,
    Admin: sandbox.window.Admin,
    AdminPages: sandbox.window.AdminPages,
    requests,
    app,
    pageContent,
    document: sandbox.document,
  };
}

function readCalls(requests) {
  return requests
    .filter((entry) => entry.url.startsWith("/api/read?"))
    .map((entry) => {
      const [pathname, search = ""] = entry.url.split("?");
      return { pathname, params: new URLSearchParams(search) };
    });
}

test("sidebar renders an AI Control link for roles with ai read", async () => {
  const { AdminPages, app } = loadPanel("content_editor");
  await AdminPages.init("audit");
  assert.ok(app.innerHTML.includes('href="/ai.html"'), "sidebar should link to /ai.html");
  assert.ok(app.innerHTML.includes("AI Control"), "sidebar should label the link AI Control");
});

test("sidebar hides the AI Control link for roles without ai read", async () => {
  const { AdminPages, app } = loadPanel("finance");
  await AdminPages.init("audit");
  assert.ok(!app.innerHTML.includes('href="/ai.html"'), "finance has no ai access, so no AI Control link");
});

test("audit page reads /api/read with resource=audit and action=list", async () => {
  const { AdminPages, requests } = loadPanel("content_editor");
  await AdminPages.init("audit");
  const reads = readCalls(requests);
  assert.ok(reads.length >= 1, "audit page should call /api/read");
  assert.equal(reads[0].pathname, "/api/read");
  assert.equal(reads[0].params.get("resource"), "audit");
  assert.equal(reads[0].params.get("action"), "list");
  assert.equal(reads[0].params.get("page"), "1");
  assert.equal(reads[0].params.get("page_size"), "50");
});

test("read() always sends resource/action even when page state contains those keys", async () => {
  const { Admin, requests } = loadPanel();
  // The old audit page state carried resource:""/action:"" keys; they must
  // never be able to empty the router params again.
  await Admin.read("audit", "list", { resource: "", action: "", admin: "", page: 1, page_size: 50 });
  const [call] = readCalls(requests);
  assert.ok(call, "a /api/read request was made");
  assert.equal(call.params.get("resource"), "audit");
  assert.equal(call.params.get("action"), "list");
  assert.equal(call.params.get("page"), "1");
  assert.equal(call.params.get("admin"), null, "empty filter values are omitted from the query string");
});

test("AI Control page renders for roles with ai read", async () => {
  const panel = loadPanel("content_editor", "ai");
  await panel.AdminPages.init("ai");
  assert.ok(panel.app.innerHTML.includes("AI Control Center"), "AI Control shell should render");
  assert.ok(panel.pageContent.innerHTML.includes("AI modules"), "the Own-AI module toggles should render");
  assert.equal(readCalls(panel.requests).length, 0, "AI Control loads everything through /api/ai, not /api/read");
});

test("payments page shows income, the purchase ledger and the actual amount paid", async () => {
  const panel = loadPanel("finance", "payments");
  await panel.AdminPages.init("payments");
  const html = panel.pageContent.innerHTML;
  assert.ok(html.includes("Total income"), "total income KPI should render");
  assert.ok(html.includes("₹79"), "the actual discounted amount paid (₹79) should render, not the ₹99 list price");
  assert.ok(html.includes("list ₹99"), "the list price should be shown next to a discounted purchase");
  assert.ok(html.includes("20% signup offer"), "the signup-offer source should be labelled on the row");
  assert.ok(html.includes("Test User"), "the buying user should be shown");
  assert.ok(html.includes("Active premium users"), "the active premium users section should render");
  assert.ok(html.includes("Premium purchases"), "the purchase ledger table should render");
  const [call] = readCalls(panel.requests);
  assert.ok(call, "payments page should call /api/read");
  assert.equal(call.params.get("resource"), "payments");
  assert.equal(call.params.get("action"), "list");
});
