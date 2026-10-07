"use strict";

/*
 * Shared payment-ledger logic.
 *
 * Source of truth for premium revenue is `payment_grants`: the user app's
 * verify-payment API writes exactly one row per verified Razorpay payment
 * (idempotent). The legacy `payments` table (raw Razorpay rows) is secondary —
 * it is used to enrich each grant with the amount the user ACTUALLY paid and
 * to detect payments that were captured but never credited as premium.
 *
 * Plan list prices mirror the user panel's api/_plans.js (keep in sync):
 * monthly ₹99 / 30 days, six-month ₹499 / 182 days, yearly ₹799 / 365 days.
 *
 * Amount resolution per purchase (first hit wins):
 *   1. an amount column on the payment_grants row itself (amount_paise —
 *      migration 0003 adds it so the user app can record the captured amount;
 *      discounted checkouts then show the real price paid, e.g. ₹79),
 *   2. the matching Razorpay `payments` row (by payment/order id),
 *   3. the plan list price.
 */

const PLANS = Object.freeze({
  monthly: { label: "Monthly", amount_paise: 9900, days: 30 },
  sixmonth: { label: "6-Month", amount_paise: 49900, days: 182 },
  yearly: { label: "Yearly", amount_paise: 79900, days: 365 },
});

const AMOUNT_COLUMNS = ["amount_paise", "paid_paise", "captured_paise", "amount"];

function planLabel(key) {
  return (PLANS[key] && PLANS[key].label) || key || "—";
}

function planListPricePaise(key) {
  return (PLANS[key] && PLANS[key].amount_paise) || 0;
}

function planDays(key) {
  return (PLANS[key] && PLANS[key].days) || 0;
}

function amountFromRow(row) {
  if (!row || typeof row !== "object") return null;
  for (const key of AMOUNT_COLUMNS) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return null;
}

function paymentKey(payment) {
  return payment?.razorpay_payment_id || payment?.payment_id || payment?.id || null;
}

/*
 * Join the entitlement ledger (payment_grants) with the Razorpay ledger
 * (payments) and resolve the actual amount paid for every purchase.
 * Returns rows sorted by created_at desc.
 */
function buildPaymentLedger(grants, payments) {
  const paymentsByKey = new Map();
  for (const payment of payments || []) {
    const key = paymentKey(payment);
    if (key && !paymentsByKey.has(key)) paymentsByKey.set(key, payment);
  }
  return (grants || [])
    .map((grant) => {
      const matched = paymentsByKey.get(grant.payment_id) || paymentsByKey.get(grant.order_id) || null;
      const listPrice = planListPricePaise(grant.plan_key);
      const actual = amountFromRow(grant) ?? amountFromRow(matched) ?? listPrice;
      return {
        payment_id: grant.payment_id || matched?.razorpay_payment_id || matched?.id || null,
        order_id: grant.order_id || matched?.razorpay_order_id || null,
        user_id: grant.user_id || matched?.user_id || null,
        plan_key: grant.plan_key || matched?.plan || null,
        plan_label: planLabel(grant.plan_key || matched?.plan),
        amount_paise: actual,
        list_price_paise: listPrice,
        discount_paise: listPrice && actual < listPrice ? listPrice - actual : 0,
        expires_at: grant.expires_at || null,
        created_at: grant.created_at || matched?.created_at || null,
        source: grant.payment_id || matched ? "razorpay" : "grant",
        razorpay_matched: Boolean(matched),
      };
    })
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
}

/*
 * Razorpay payments with no matching payment_grants row: captured money that
 * never became premium. These are NOT revenue — they are a reconciliation
 * warning (see the Razorpay CSV reconcile job).
 */
function unmatchedPayments(grants, payments) {
  const credited = new Set((grants || []).map((grant) => grant.payment_id).filter(Boolean));
  return (payments || [])
    .filter((payment) => {
      const key = paymentKey(payment);
      return key && !credited.has(key);
    })
    .map((payment) => ({
      payment_id: paymentKey(payment),
      order_id: payment.razorpay_order_id || null,
      user_id: payment.user_id || null,
      plan: payment.plan || null,
      amount_paise: amountFromRow(payment) ?? 0,
      created_at: payment.created_at || null,
    }))
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
}

/* All-time income, recent windows, per-plan mix and paying-user count. */
function summariseLedger(ledger) {
  const rows = ledger || [];
  const now = Date.now();
  const within = (days) => rows.filter((row) => {
    const at = new Date(row.created_at || 0).getTime();
    return Number.isFinite(at) && at >= now - days * 86400000;
  });
  const sum = (list) => list.reduce((total, row) => total + Number(row.amount_paise || 0), 0);
  const byPlan = {};
  for (const row of rows) {
    const key = row.plan_key || "other";
    byPlan[key] = (byPlan[key] || 0) + Number(row.amount_paise || 0);
  }
  return {
    total_paise: sum(rows),
    days30_paise: sum(within(30)),
    days90_paise: sum(within(90)),
    count: rows.length,
    paying_users: new Set(rows.map((row) => row.user_id).filter(Boolean)).size,
    by_plan: byPlan,
  };
}

/* Shape a ledger row for revenueByPlan (expects plan + amount_paise). */
function toPlanRow(row) {
  return { created_at: row.created_at, plan: row.plan_key, amount_paise: row.amount_paise };
}

module.exports = {
  PLANS,
  planLabel,
  planListPricePaise,
  planDays,
  amountFromRow,
  buildPaymentLedger,
  unmatchedPayments,
  summariseLedger,
  toPlanRow,
};
