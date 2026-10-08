"use strict";

/*
 * Unit tests for the shared payment-ledger logic (lib/server/payments.js).
 *
 * The ledger joins the user app's verified-payment record (payment_grants)
 * with the legacy Razorpay table (payments) and resolves the ACTUAL amount
 * paid per purchase: grant row amount → matching Razorpay payment → 20%
 * signup offer (purchase within 48h of signup) → plan list price. Discounted
 * checkouts must show the real price paid (e.g. ₹79, not the ₹99 list price).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PLANS,
  SIGNUP_DISCOUNT_RATE,
  SIGNUP_DISCOUNT_WINDOW_MS,
  planLabel,
  planListPricePaise,
  amountFromRow,
  signupDiscountPricePaise,
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

test("signup offer: purchase within 48h of signup falls back to the discounted price", () => {
  assert.equal(SIGNUP_DISCOUNT_RATE, 0.2);
  assert.equal(SIGNUP_DISCOUNT_WINDOW_MS, 48 * 3600 * 1000);
  const signups = new Map([["u1", "2026-10-01T00:00:00.000Z"]]);
  const ledger = buildPaymentLedger(
    [{ payment_id: "pay_s1", user_id: "u1", plan_key: "monthly", created_at: "2026-10-02T00:00:00.000Z" }], // 24h after signup
    [],
    signups,
  );
  assert.equal(ledger[0].amount_paise, 7900, "₹79 (20% off ₹99, rounded to the whole rupee)");
  assert.equal(ledger[0].list_price_paise, 9900);
  assert.equal(ledger[0].discount_paise, 2000);
  assert.equal(ledger[0].discount_source, "signup_offer");
});

test("signup offer prices round down to whole rupees for every plan", () => {
  assert.equal(signupDiscountPricePaise(9900), 7900, "monthly ₹99 → ₹79");
  assert.equal(signupDiscountPricePaise(49900), 39900, "six-month ₹499 → ₹399");
  assert.equal(signupDiscountPricePaise(79900), 63900, "yearly ₹799 → ₹639");
  assert.equal(signupDiscountPricePaise(0), null);
  assert.equal(signupDiscountPricePaise(null), null);
});

test("signup offer: no discount after the 48h window, at the boundary, or before signup", () => {
  const signups = new Map([["u1", "2026-10-01T00:00:00.000Z"]]);
  const after = buildPaymentLedger(
    [{ payment_id: "pay_s2", user_id: "u1", plan_key: "monthly", created_at: "2026-10-04T00:00:01.000Z" }], // 73h after signup
    [],
    signups,
  );
  assert.equal(after[0].amount_paise, 9900, "list price once the window closes");
  assert.equal(after[0].discount_paise, 0);
  assert.equal(after[0].discount_source, null);
  const boundary = buildPaymentLedger(
    [{ payment_id: "pay_s3", user_id: "u1", plan_key: "monthly", created_at: "2026-10-03T00:00:00.000Z" }], // exactly 48h
    [],
    signups,
  );
  assert.equal(boundary[0].amount_paise, 7900, "exactly 48h still gets the offer");
  const skew = buildPaymentLedger(
    [{ payment_id: "pay_s4", user_id: "u1", plan_key: "monthly", created_at: "2026-09-30T23:00:00.000Z" }], // before signup (clock skew)
    [],
    signups,
  );
  assert.equal(skew[0].amount_paise, 9900, "a purchase timestamped before signup gets no offer");
  const unknown = buildPaymentLedger(
    [{ payment_id: "pay_s5", user_id: "uX", plan_key: "monthly", created_at: "2026-10-02T00:00:00.000Z" }], // unknown signup date
    [],
    signups,
  );
  assert.equal(unknown[0].amount_paise, 9900, "unknown signup date → list price");
});

test("signup offer never overrides a recorded amount", () => {
  const signups = new Map([["u1", "2026-10-01T00:00:00.000Z"]]);
  const recorded = buildPaymentLedger(
    [{ payment_id: "pay_s6", user_id: "u1", plan_key: "monthly", amount_paise: 9900, created_at: "2026-10-02T00:00:00.000Z" }],
    [],
    signups,
  );
  assert.equal(recorded[0].amount_paise, 9900, "recorded full price wins over the offer");
  assert.equal(recorded[0].discount_source, null);
  const recordedRazorpay = buildPaymentLedger(
    [{ payment_id: "pay_s7", user_id: "u1", plan_key: "monthly", created_at: "2026-10-02T00:00:00.000Z" }],
    [{ razorpay_payment_id: "pay_s7", amount_paise: 7900, created_at: "2026-10-02T00:00:00.000Z" }],
    signups,
  );
  assert.equal(recordedRazorpay[0].amount_paise, 7900, "recorded Razorpay amount wins");
  assert.equal(recordedRazorpay[0].discount_source, null);
});

test("signup offer accepts a plain object map and skips non-plan grants", () => {
  const ledger = buildPaymentLedger(
    [{ payment_id: "pay_s8", user_id: "u1", plan_key: "referral_reward", created_at: "2026-10-02T00:00:00.000Z" }],
    [],
    { u1: "2026-10-01T00:00:00.000Z" },
  );
  assert.equal(ledger[0].amount_paise, 0, "non-plan grants stay non-revenue");
  assert.equal(ledger[0].discount_source, null);
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
