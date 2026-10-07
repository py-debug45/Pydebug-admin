"use strict";

/*
 * Unit tests for the shared payment-ledger logic (lib/server/payments.js).
 *
 * The ledger joins the user app's verified-payment record (payment_grants)
 * with the legacy Razorpay table (payments) and resolves the ACTUAL amount
 * paid per purchase: grant row amount → matching Razorpay payment → plan list
 * price. Discounted checkouts must show the real price paid (e.g. ₹79, not
 * the ₹99 list price).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PLANS,
  planLabel,
  planListPricePaise,
  amountFromRow,
  buildPaymentLedger,
  unmatchedPayments,
  summariseLedger,
} = require("../lib/server/payments");

test("plan list prices mirror the user panel's plans", () => {
  assert.equal(planListPricePaise("monthly"), 9900);
  assert.equal(planListPricePaise("sixmonth"), 49900);
  assert.equal(planListPricePaise("yearly"), 79900);
  assert.equal(planLabel("monthly"), "Monthly");
  assert.equal(planLabel("referral_reward"), "referral_reward", "unknown plans keep their key as label");
  assert.equal(planListPricePaise("unknown"), 0);
  assert.equal(PLANS.monthly.days, 30);
});

test("amountFromRow reads the first present amount column", () => {
  assert.equal(amountFromRow({ amount_paise: 7900 }), 7900);
  assert.equal(amountFromRow({ paid_paise: "7900" }), 7900);
  assert.equal(amountFromRow({ captured_paise: 100 }), 100);
  assert.equal(amountFromRow({ amount: 50 }), 50);
  assert.equal(amountFromRow({ amount_paise: 0, amount: 7900 }), 7900, "zero is not a valid amount");
  assert.equal(amountFromRow({}), null);
  assert.equal(amountFromRow(null), null);
});

test("ledger prefers the amount recorded on the grant row", () => {
  const ledger = buildPaymentLedger(
    [{ payment_id: "pay_1", user_id: "u1", plan_key: "sixmonth", amount_paise: 39900, created_at: "2026-10-01T00:00:00.000Z", expires_at: "2027-03-31T00:00:00.000Z" }],
    [{ razorpay_payment_id: "pay_1", amount_paise: 49900, created_at: "2026-10-01T00:00:00.000Z" }],
  );
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amount_paise, 39900, "discounted price paid on the grant wins");
  assert.equal(ledger[0].list_price_paise, 49900);
  assert.equal(ledger[0].discount_paise, 10000);
  assert.equal(ledger[0].source, "razorpay");
});

test("ledger falls back to the matching Razorpay payment amount (discount-aware)", () => {
  const ledger = buildPaymentLedger(
    [{ payment_id: "pay_2", order_id: "order_2", user_id: "u2", plan_key: "monthly", created_at: "2026-10-02T00:00:00.000Z", expires_at: "2026-11-01T00:00:00.000Z" }],
    [{ razorpay_payment_id: "pay_2", razorpay_order_id: "order_2", user_id: "u2", plan: "monthly", amount_paise: 7900, created_at: "2026-10-02T00:00:00.000Z" }],
  );
  assert.equal(ledger[0].amount_paise, 7900, "₹79 paid, not the ₹99 list price");
  assert.equal(ledger[0].discount_paise, 2000);
  assert.equal(ledger[0].razorpay_matched, true);
});

test("ledger falls back to the plan list price when no amount exists anywhere", () => {
  const ledger = buildPaymentLedger(
    [{ payment_id: "pay_3", user_id: "u3", plan_key: "yearly", created_at: "2026-10-03T00:00:00.000Z", expires_at: "2027-10-03T00:00:00.000Z" }],
    [],
  );
  assert.equal(ledger[0].amount_paise, 79900);
  assert.equal(ledger[0].discount_paise, 0);
  assert.equal(ledger[0].razorpay_matched, false);
});

test("ledger sorts newest first and marks grant-only rows", () => {
  const ledger = buildPaymentLedger(
    [
      { payment_id: "pay_old", user_id: "u1", plan_key: "monthly", created_at: "2026-01-01T00:00:00.000Z" },
      { payment_id: "pay_new", user_id: "u2", plan_key: "yearly", created_at: "2026-10-01T00:00:00.000Z" },
    ],
    [],
  );
  assert.deepEqual(ledger.map((row) => row.payment_id), ["pay_new", "pay_old"]);
  const grantOnly = buildPaymentLedger(
    [{ user_id: "u9", plan_key: "referral_reward", created_at: "2026-10-05T00:00:00.000Z", expires_at: "2026-10-12T00:00:00.000Z" }],
    [],
  );
  assert.equal(grantOnly[0].source, "grant");
  assert.equal(grantOnly[0].plan_label, "referral_reward");
  assert.equal(grantOnly[0].amount_paise, 0, "non-plan grants are not revenue");
});

test("unmatchedPayments flags captured Razorpay money with no premium credit", () => {
  const unmatched = unmatchedPayments(
    [{ payment_id: "pay_1" }, { payment_id: "pay_2" }],
    [
      { razorpay_payment_id: "pay_1", amount_paise: 9900, created_at: "2026-10-01T00:00:00.000Z" },
      { razorpay_payment_id: "pay_9", amount_paise: 79900, user_id: "u7", plan: "yearly", created_at: "2026-10-04T00:00:00.000Z" },
    ],
  );
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].payment_id, "pay_9");
  assert.equal(unmatched[0].amount_paise, 79900);
});

test("summariseLedger computes all-time income, windows, plan mix and paying users", () => {
  const now = Date.now();
  const ledger = buildPaymentLedger(
    [
      { payment_id: "p1", user_id: "u1", plan_key: "yearly", created_at: new Date(now - 10 * 86400000).toISOString() },
      { payment_id: "p2", user_id: "u2", plan_key: "monthly", amount_paise: 7900, created_at: new Date(now - 40 * 86400000).toISOString() },
      { payment_id: "p3", user_id: "u1", plan_key: "monthly", created_at: new Date(now - 100 * 86400000).toISOString() },
    ],
    [],
  );
  const summary = summariseLedger(ledger);
  assert.equal(summary.total_paise, 79900 + 7900 + 9900, "all-time income");
  assert.equal(summary.days30_paise, 79900, "only the 10-day-old purchase is in the 30d window");
  assert.equal(summary.days90_paise, 79900 + 7900);
  assert.equal(summary.count, 3);
  assert.equal(summary.paying_users, 2);
  assert.deepEqual(summary.by_plan, { yearly: 79900, monthly: 7900 + 9900 });
});
