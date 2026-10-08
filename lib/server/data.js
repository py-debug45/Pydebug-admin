"use strict";

const db = require("../../api/_db");
const { maskEmail, canSeeEmail } = require("./permissions");

function isoDaysAgo(days) {
  return new Date(Date.now() - Number(days) * 86400000).toISOString();
}

function dayKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function safe(operation, fallback) {
  return Promise.resolve().then(operation).catch((error) => {
    console.warn("[admin-read] optional query failed:", error.message);
    return fallback;
  });
}

function inFilter(values) {
  return `(${values.map((value) => `"${String(value).replace(/["\\]/g, "")}"`).join(",")})`;
}

async function profilesByIds(ids, adminRole) {
  const unique = [...new Set((ids || []).filter(Boolean))].slice(0, 200);
  if (!unique.length) return {};
  const { rows } = await db.list("profiles", {
    select: "id,full_name,display_name,email,avatar_url",
    filters: [{ column: "id", op: "in", value: inFilter(unique) }],
    limit: unique.length,
  });
  return Object.fromEntries(rows.map((row) => [row.id, {
    ...row,
    email: canSeeEmail(adminRole) ? row.email : maskEmail(row.email),
  }]));
}

function maskProfile(profile, role) {
  if (!profile) return profile;
  return { ...profile, email: canSeeEmail(role) ? profile.email : maskEmail(profile.email) };
}

/*
 * Signup dates (profiles.created_at) for a set of user ids, as a Map. Used to
 * reconstruct the user app's 20%-for-48h signup-offer price for ledger rows
 * that carry no recorded amount. Only the two columns needed are read; a
 * failure here must never break a page, so callers wrap this in safe().
 */
async function signupDatesByIds(ids, cap = 2000) {
  const unique = [...new Set((ids || []).filter(Boolean))].slice(0, cap);
  const map = new Map();
  for (let offset = 0; offset < unique.length; offset += 200) {
    const chunk = unique.slice(offset, offset + 200);
    const { rows } = await db.list("profiles", {
      select: "id,created_at",
      filters: [{ column: "id", op: "in", value: inFilter(chunk) }],
      limit: chunk.length,
    });
    for (const row of rows) {
      if (row && row.id && row.created_at) map.set(row.id, row.created_at);
    }
  }
  return map;
}

async function boundedList(table, options = {}, cap = 10000) {
  const rows = [];
  const chunkSize = Math.min(1000, cap);
  while (rows.length < cap) {
    const size = Math.min(chunkSize, cap - rows.length);
    const page = await db.list(table, { ...options, limit: size, offset: rows.length, count: false });
    rows.push(...page.rows);
    if (page.rows.length < size) break;
  }
  return { rows, truncated: rows.length >= cap };
}

function aggregateDaily(rows, dateField, valueField, days = 30) {
  const output = [];
  const map = new Map();
  for (const row of rows || []) {
    const key = dayKey(row[dateField]);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + (valueField ? Number(row[valueField] || 0) : 1));
  }
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 86400000).toISOString().slice(0, 10);
    output.push({ date, value: map.get(date) || 0 });
  }
  return output;
}

function revenueByPlan(rows, days = 30) {
  const map = new Map();
  for (const row of rows || []) {
    const key = dayKey(row.created_at);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { monthly: 0, sixmonth: 0, yearly: 0, other: 0 });
    const plan = ["monthly", "sixmonth", "yearly"].includes(row.plan) ? row.plan : "other";
    map.get(key)[plan] += Number(row.amount_paise || 0);
  }
  return Array.from({ length: days }, (_, position) => {
    const date = new Date(Date.now() - (days - 1 - position) * 86400000).toISOString().slice(0, 10);
    return { date, ...(map.get(date) || { monthly: 0, sixmonth: 0, yearly: 0, other: 0 }) };
  });
}

module.exports = {
  isoDaysAgo, dayKey, safe, inFilter, profilesByIds, signupDatesByIds, maskProfile,
  boundedList, aggregateDaily, revenueByPlan,
};
