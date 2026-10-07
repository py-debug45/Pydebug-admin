"use strict";

const db = require("./_db");
const { requireAdmin } = require("../lib/server/admin-auth");
const { assertCan, can, maskEmail, canSeeEmail } = require("../lib/server/permissions");
const { withAudit } = require("../lib/server/audit");
const { inFilter, safe, boundedList, profilesByIds } = require("../lib/server/data");
const { buildPaymentLedger, unmatchedPayments } = require("../lib/server/payments");
const { send, method, readJson, clientIp, assertSameOrigin, cleanText, requiredText, handleError } = require("../lib/server/http");
const { uuid, oneOf } = require("../lib/server/validate");

async function fetchTimed(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function csvCell(value) {
  let text = value == null ? "" : (typeof value === "object" ? JSON.stringify(value) : String(value));
  // Prevent spreadsheet formula execution when an exported cell is opened.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function maskEmailsDeep(value, role) {
  if (canSeeEmail(role) || value == null) return value;
  if (typeof value === "string") return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email));
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => maskEmailsDeep(item, role));
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    /email/i.test(key) && typeof nested === "string" ? maskEmail(nested) : maskEmailsDeep(nested, role),
  ]));
}

function toCsv(rows) {
  if (!rows.length) return "No data\n";
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `${keys.map(csvCell).join(",")}\n${rows.map((row) => keys.map((key) => csvCell(row[key])).join(",")).join("\n")}\n`;
}

async function broadcast(admin, payload, reason, ip) {
  assertCan(admin, "push", "send");
  const destination = cleanText(payload.url || "/", 500);
  const safeRelative = destination.startsWith("/") && !destination.startsWith("//");
  let safeAbsolute = false;
  try {
    const parsed = new URL(destination);
    safeAbsolute = parsed.protocol === "https:" && (parsed.hostname === "pydebug.in" || parsed.hostname.endsWith(".pydebug.in"));
  } catch {}
  if (!safeRelative && !safeAbsolute) { const error = new Error("URL must be a relative path or an HTTPS pydebug.in URL"); error.status = 400; throw error; }
  const values = {
    title: requiredText(payload.title, "title", 120),
    body: requiredText(payload.body, "body", 500),
    url: destination,
    segment: oneOf(payload.segment || "all", ["all", "free", "premium", "inactive-7d", "streak-at-risk"], "segment"),
    created_by: admin.admin_id,
  };
  return withAudit({ admin, resource: "push", action: "broadcast", reason, ip,
    oldValue: null,
    execute: () => db.insert("push_announcements", values),
    targetId: (result) => result?.id || null,
  });
}

async function testEmail(admin, payload, reason, ip) {
  assertCan(admin, "emails", "test_send");
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { const error = new Error("RESEND_API_KEY is not configured"); error.status = 503; error.code = "service_not_configured"; throw error; }
  const to = requiredText(payload.to || admin.email, "recipient", 320).toLowerCase();
  if (admin.role === "support" && to !== String(admin.email).toLowerCase()) {
    const error = new Error("Support admins may only test-send to their own admin email"); error.status = 403; throw error;
  }
  const subject = requiredText(payload.subject || "PyDebug admin email test", "subject", 160);
  const text = requiredText(payload.text || "This is a test email from PyDebug Admin.", "text", 5000);
  return withAudit({ admin, resource: "emails", action: "test_send", targetId: to, reason, ip,
    oldValue: null,
    execute: async () => {
      const response = await fetchTimed("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "PyDebug <noreply@pydebug.in>", to: [to], subject, text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(data.message || "Resend rejected the email"); error.status = 502; throw error; }
      return { id: data.id, to, subject };
    },
  });
}

function normaliseReconcileRow(row) {
  return {
    payment_id: cleanText(row.payment_id || row.razorpay_payment_id || row.id, 200),
    order_id: cleanText(row.order_id || row.razorpay_order_id, 200),
    amount_paise: Number(row.amount_paise || (Number(row.amount || 0) * 100) || 0),
    status: cleanText(row.status, 50),
  };
}

async function reconcile(admin, payload, reason, ip) {
  assertCan(admin, "payments", "reconcile");
  if (!Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 1000) {
    const error = new Error("Upload between 1 and 1000 reconciliation rows"); error.status = 400; throw error;
  }
  const rows = payload.rows.map(normaliseReconcileRow).filter((row) => row.payment_id);
  const ids = [...new Set(rows.map((row) => row.payment_id))];
  const foundPayments = [];
  const foundGrants = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const [payments, grants] = await Promise.all([
      safe(() => db.list("payments", { filters: [{ column: "razorpay_payment_id", op: "in", value: inFilter(chunk) }], limit: 200 }), { rows: [] }),
      safe(() => db.list("payment_grants", { filters: [{ column: "payment_id", op: "in", value: inFilter(chunk) }], limit: 200 }), { rows: [] }),
    ]);
    foundPayments.push(...payments.rows);
    foundGrants.push(...grants.rows);
  }
  const paymentsById = new Map(foundPayments.map((row) => [row.razorpay_payment_id, row]));
  const grantsById = new Map(foundGrants.map((row) => [row.payment_id, row]));
  const output = rows.map((row) => {
    const payment = paymentsById.get(row.payment_id) || null;
    const grant = grantsById.get(row.payment_id) || null;
    return {
      ...row,
      database_payment: payment,
      payment_grant: grant,
      result: grant ? "credited" : (/paid|captured|success/i.test(row.status) ? "paid_not_credited" : (payment ? "payment_recorded" : "not_found")),
    };
  });
  return withAudit({ admin, resource: "payments", action: "reconcile", reason, ip,
    oldValue: null,
    execute: async () => output,
    newValue: { uploaded: rows.length, payment_rows: foundPayments.length, grants: foundGrants.length, paid_not_credited: output.filter((row) => row.result === "paid_not_credited").length },
  });
}

async function cleanupBattles(admin, payload, reason, ip) {
  assertCan(admin, "battles", "cleanup");
  const hours = Math.min(48, Math.max(1, Number(payload.hours) || 2));
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const stale = await db.list("battles", { filters: [{ column: "finished_at", op: "is", value: "null" }, { column: "created_at", op: "lt", value: cutoff }], limit: 200 });
  return withAudit({ admin, resource: "battles", action: "cleanup", reason, ip, destructive: true,
    oldValue: { ids: stale.rows.map((row) => row.id), cutoff },
    execute: async () => {
      const changed = [];
      for (const row of stale.rows) {
        changed.push(await db.update("battles", { finished_at: new Date().toISOString() }, { filters: [{ column: "id", op: "eq", value: row.id }] }));
      }
      return { cleaned: changed.length, ids: changed.map((row) => row?.id).filter(Boolean) };
    },
  });
}

async function exportData(admin, payload, reason, ip) {
  const resource = oneOf(payload.resource, ["users", "payments", "audit", "problems", "referrals", "reports"], "resource");
  const permissionResource = resource === "audit" ? "audit" : resource;
  if (resource === "audit") assertCan(admin, "audit", can(admin.role, "audit", "read_all") ? "read_all" : "read_own");
  else if (resource === "reports") assertCan(admin, "reports", "export");
  else assertCan(admin, permissionResource, "read");
  const requestedLimit = Math.min(5000, Math.max(1, Number(payload.limit) || 5000));
  const limit = resource === "audit" ? Math.min(500, requestedLimit) : requestedLimit;
  let rows;
  if (resource === "reports") {
    const report = await require("./read")._internals.reports(admin, { from: payload.from, to: payload.to });
    rows = [
      ...report.growth.retention.map((row) => ({ section: "retention", ...row })),
      { section: "revenue_summary", total_paise: report.revenue.total_paise, paying_users: report.revenue.paying_users, arpu_paise: report.revenue.arpu_paise },
      ...Object.entries(report.revenue.plan_mix).map(([plan, amount_paise]) => ({ section: "revenue_plan", plan, amount_paise })),
      ...report.content.hardest.map((row) => ({ section: "hardest_problem", ...row })),
      ...report.content.easiest.map((row) => ({ section: "easiest_problem", ...row })),
      { section: "engagement", ...report.engagement },
      ...report.churn.map((row) => ({ section: "churn_watch", ...row })),
    ];
  } else if (resource === "users") {
    rows = (await boundedList("profiles", { select: "id,full_name,display_name,email,is_premium,premium_expires_at,xp,streak,status,last_active_date,created_at", order: "created_at.desc" }, limit)).rows;
    if (!canSeeEmail(admin.role)) rows = rows.map((row) => ({ ...row, email: maskEmail(row.email) }));
  } else if (resource === "audit") {
    const filters = can(admin.role, "audit", "read_all") ? [] : [{ column: "admin_id", op: "eq", value: admin.admin_id }];
    rows = (await boundedList("admin_audit_log", { select: "id,admin_id,admin_role,resource,action,target_id,reason,ip,created_at", filters, order: "created_at.desc" }, limit)).rows;
  } else if (resource === "payments") {
    // Unified premium ledger: verified purchases (payment_grants) enriched with
    // the actual amount paid, plus captured-but-not-credited Razorpay rows.
    const grants = await safe(() => boundedList("payment_grants", { select: "*", order: "created_at.desc" }, limit), { rows: [] });
    const razorpay = await safe(() => boundedList("payments", { select: "*", order: "created_at.desc" }, limit), { rows: [] });
    const ledger = buildPaymentLedger(grants.rows, razorpay.rows);
    const unmatched = unmatchedPayments(grants.rows, razorpay.rows);
    const profiles = await profilesByIds([...ledger, ...unmatched].map((row) => row.user_id), admin.role);
    rows = [
      ...ledger.map((row) => ({
        record: "purchase",
        user: profiles[row.user_id]?.email || row.user_id,
        payment_id: row.payment_id,
        order_id: row.order_id,
        plan: row.plan_label,
        amount_paise: row.amount_paise,
        list_price_paise: row.list_price_paise,
        discount_paise: row.discount_paise,
        premium_until: row.expires_at,
        created_at: row.created_at,
      })),
      ...unmatched.map((row) => ({
        record: "paid_not_credited",
        user: profiles[row.user_id]?.email || row.user_id,
        payment_id: row.payment_id,
        order_id: row.order_id,
        plan: row.plan,
        amount_paise: row.amount_paise,
        list_price_paise: "",
        discount_paise: 0,
        premium_until: "",
        created_at: row.created_at,
      })),
    ];
  } else {
    const table = resource === "referrals" ? "referrals" : resource;
    const selects = {
      problems: "id,type,title,description,difficulty,topic,is_premium,expected_output,hints,battle_error,status,created_at,updated_at",
      referrals: "*",
    };
    rows = (await boundedList(table, { select: selects[resource] || "*", order: "created_at.desc" }, limit)).rows;
  }
  rows = rows.map((row) => maskEmailsDeep(row, admin.role));
  const csv = toCsv(rows);
  await withAudit({ admin, resource: "reports", action: `export_${resource}`, reason, ip,
    oldValue: null, execute: async () => ({ exported: rows.length }), newValue: { exported: rows.length },
  });
  return { csv, filename: `pydebug-${resource}-${new Date().toISOString().slice(0, 10)}.csv`, count: rows.length };
}

async function rebuild(admin, payload, reason, ip) {
  assertCan(admin, "jobs", "rebuild");
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_DISPATCH_REPO;
  if (!token || !repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    const error = new Error("GITHUB_DISPATCH_TOKEN and GITHUB_DISPATCH_REPO must be configured"); error.status = 503; throw error;
  }
  return withAudit({ admin, resource: "jobs", action: "rebuild", targetId: repo, reason, ip,
    oldValue: null,
    execute: async () => {
      const response = await fetchTimed(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ event_type: cleanText(payload.event_type || "admin-content-rebuild", 100), client_payload: { requested_by: admin.admin_id } }),
      });
      if (!response.ok) { const error = new Error(`GitHub dispatch failed (${response.status})`); error.status = 502; throw error; }
      return { dispatched: true, repository: repo };
    },
  });
}

module.exports = async function handler(req, res) {
  try {
    method(req, ["POST"]);
    assertSameOrigin(req);
    const admin = await requireAdmin(req, { csrf: true });
    const body = await readJson(req);
    const job = cleanText(body.job, 50);
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const reason = cleanText(body.reason, 1000);
    const ip = clientIp(req);
    let data;
    if (job === "broadcast") data = await broadcast(admin, payload, reason, ip);
    else if (job === "test_email") data = await testEmail(admin, payload, reason, ip);
    else if (job === "reconcile_payments") data = await reconcile(admin, payload, reason, ip);
    else if (job === "cleanup_battles") data = await cleanupBattles(admin, payload, reason, ip);
    else if (job === "export") data = await exportData(admin, payload, reason, ip);
    else if (job === "rebuild") data = await rebuild(admin, payload, reason, ip);
    else { const error = new Error("Unknown job"); error.status = 404; throw error; }
    return send(res, 200, { ok: true, data });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports._internals = { csvCell, toCsv, normaliseReconcileRow, exportData };
