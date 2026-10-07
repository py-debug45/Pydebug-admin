"use strict";

const db = require("./_db");
const { requireAdmin } = require("../lib/server/admin-auth");
const { assertCan, can, canSeeEmail, maskEmail } = require("../lib/server/permissions");
const { send, method, query, pagination, cleanText, handleError } = require("../lib/server/http");
const {
  isoDaysAgo, safe, inFilter, profilesByIds, maskProfile, boundedList, aggregateDaily, revenueByPlan, dayKey,
} = require("../lib/server/data");
const { uuid, UUID_RE } = require("../lib/server/validate");

const PROFILE_FIELDS = "id,full_name,email,display_name,avatar_url,is_premium,premium_expires_at,xp,streak,streak_freezes,last_active_date,referral_code,referral_count,referral_qualified_count,status,status_reason,status_until,battle_invites_enabled,battle_plays,battle_wins,created_at";
const PROBLEM_FIELDS = "id,type,title,description,difficulty,topic,is_premium,starter_code,expected_output,hints,battle_error,status,created_at,updated_at,created_by,admin_skip_notification";

function searchTerm(value) {
  return cleanText(value, 120).replace(/[,%()\\]/g, " ").replace(/\s+/g, " ").trim();
}

function maskEmailsDeep(value, role) {
  if (canSeeEmail(role) || value == null) return value;
  if (typeof value === "string") return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email));
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => maskEmailsDeep(item, role));
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
    if (/email/i.test(key) && typeof nested === "string") return [key, maskEmail(nested)];
    return [key, maskEmailsDeep(nested, role)];
  }));
}

function dateRangeFilters(q, field = "created_at") {
  const filters = [];
  if (q.from && !Number.isNaN(Date.parse(q.from))) filters.push({ column: field, op: "gte", value: new Date(q.from).toISOString() });
  if (q.to && !Number.isNaN(Date.parse(q.to))) {
    const to = new Date(q.to); to.setUTCHours(23, 59, 59, 999);
    filters.push({ column: field, op: "lte", value: to.toISOString() });
  }
  return filters;
}

async function dashboard(admin) {
  assertCan(admin, "dashboard", "read");
  const today = new Date().toISOString().slice(0, 10);
  const start30 = isoDaysAgo(30);
  const start7 = isoDaysAgo(7);
  const premiumFilters = [
    { column: "is_premium", op: "eq", value: "true" },
  ];
  const [totalUsers, signupsToday, signups7, signups30, dau, premium, streaks,
    recentProfiles, recentPayments, recentSubmissions, battlesToday, pushSubscribers,
    latestReminder, pushFailures, recentBattles] = await Promise.all([
    safe(() => db.count("profiles"), 0),
    safe(() => db.count("profiles", { filters: [{ column: "created_at", op: "gte", value: `${today}T00:00:00.000Z` }] }), 0),
    safe(() => db.count("profiles", { filters: [{ column: "created_at", op: "gte", value: start7 }] }), 0),
    safe(() => db.count("profiles", { filters: [{ column: "created_at", op: "gte", value: start30 }] }), 0),
    safe(() => db.count("profiles", { filters: [{ column: "last_active_date", op: "eq", value: today }] }), 0),
    safe(() => db.count("profiles", { filters: premiumFilters, or: `(premium_expires_at.is.null,premium_expires_at.gt.${new Date().toISOString()})` }), 0),
    safe(() => db.count("profiles", { filters: [{ column: "streak", op: "gte", value: 3 }] }), 0),
    safe(() => boundedList("profiles", { select: "id,display_name,full_name,email,created_at", filters: [{ column: "created_at", op: "gte", value: start30 }], order: "created_at.desc" }, 10000), { rows: [] }),
    safe(() => boundedList("payments", { select: "id,user_id,plan,amount_paise,razorpay_payment_id,created_at", filters: [{ column: "created_at", op: "gte", value: start30 }], order: "created_at.desc" }, 10000), { rows: [] }),
    safe(() => boundedList("submissions", { select: "id,user_id,problem_id,status,solved_at,created_at", filters: [{ column: "created_at", op: "gte", value: start30 }], order: "created_at.desc" }, 10000), { rows: [] }),
    safe(() => db.count("battles", { filters: [{ column: "created_at", op: "gte", value: `${today}T00:00:00.000Z` }] }), 0),
    safe(() => db.count("push_subscriptions"), 0),
    safe(() => db.one("streak_reminder_log", { select: "created_at", order: "created_at.desc" }), null),
    safe(() => boundedList("push_event_log", { select: "created_at,status,event,error", filters: [{ column: "created_at", op: "gte", value: isoDaysAgo(1) }], order: "created_at.asc" }, 5000), { rows: [] }),
    safe(() => db.list("battles", { select: "id,challenger_id,opponent_id,difficulty,finished_at,created_at", order: "created_at.desc", limit: 8 }), { rows: [] }),
  ]);

  const paymentRows = recentPayments.rows;
  const submissionRows = recentSubmissions.rows;
  const revenueAllowed = can(admin.role, "payments", "read");
  const cutoffFor = (days) => days === 1
    ? new Date(`${today}T00:00:00.000Z`).getTime()
    : Date.now() - days * 86400000;
  const revenueFor = (days) => paymentRows
    .filter((row) => new Date(row.created_at).getTime() >= cutoffFor(days))
    .reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);
  const solvesFor = (days) => submissionRows.filter((row) => row.status === "solved"
    && new Date(row.solved_at || row.created_at).getTime() >= cutoffFor(days)).length;
  const failureCount = pushFailures.rows.filter((row) => /fail|error/i.test(`${row.status || ""} ${row.event || ""} ${row.error || ""}`)).length;
  const reminderAgeHours = latestReminder?.created_at ? (Date.now() - new Date(latestReminder.created_at).getTime()) / 3600000 : null;

  const canReadUsers = can(admin.role, "users", "read");
  const recent = [
    ...recentProfiles.rows.slice(0, 5).map((row) => ({ type: "signup", at: row.created_at, text: canReadUsers ? `${row.display_name || row.full_name || (canSeeEmail(admin.role) ? row.email : maskEmail(row.email)) || "New learner"} joined` : "A new learner joined" })),
    ...submissionRows.slice(0, 5).map((row) => ({ type: row.status === "solved" ? "solve" : "attempt", at: row.solved_at || row.created_at, text: row.status === "solved" ? "A problem was solved" : "A problem was attempted" })),
    ...(revenueAllowed ? paymentRows.slice(0, 4).map((row) => ({ type: "payment", at: row.created_at, text: `${row.plan || "Premium"} payment · ₹${(Number(row.amount_paise || 0) / 100).toLocaleString("en-IN")}` })) : []),
    ...recentBattles.rows.slice(0, 4).map((row) => ({ type: "battle", at: row.created_at, text: `${row.difficulty || ""} battle ${row.finished_at ? "finished" : "started"}` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 12);

  return {
    kpis: {
      total_users: totalUsers, signups_today: signupsToday, signups_7d: signups7,
      signups_30d: signups30, dau, active_premium: premium,
      revenue_today: revenueAllowed ? revenueFor(1) : null,
      revenue_7d: revenueAllowed ? revenueFor(7) : null,
      revenue_30d: revenueAllowed ? revenueFor(30) : null,
      solves_today: solvesFor(1), battles_today: battlesToday,
      push_subscribers: can(admin.role, "push", "read") ? pushSubscribers : null,
      streaks_3_plus: streaks,
    },
    charts: {
      signups: aggregateDaily(recentProfiles.rows, "created_at", null, 30),
      solves: aggregateDaily(submissionRows.filter((row) => row.status === "solved"), "solved_at", null, 30),
      revenue: revenueAllowed ? revenueByPlan(paymentRows, 30) : [],
    },
    alerts: [
      ...(reminderAgeHours === null || reminderAgeHours > 25 ? [{ level: "warning", text: reminderAgeHours === null ? "No streak reminder run was found" : `Streak reminder cron last ran ${Math.floor(reminderAgeHours)}h ago` }] : []),
      ...(failureCount >= 10 ? [{ level: "danger", text: `${failureCount} push failures were logged in the last 24h` }] : []),
    ],
    recent,
  };
}

async function usersList(admin, q) {
  assertCan(admin, "users", "read");
  const { page, pageSize, offset } = pagination(q);
  const filters = dateRangeFilters(q);
  if (["active", "warned", "muted", "suspended"].includes(q.status)) filters.push({ column: "status", op: "eq", value: q.status });
  if (q.plan === "premium") filters.push({ column: "is_premium", op: "eq", value: "true" });
  if (q.plan === "free") filters.push({ column: "is_premium", op: "eq", value: "false" });
  if (["7", "30"].includes(q.inactive)) filters.push({ column: "last_active_date", op: "lt", value: isoDaysAgo(Number(q.inactive)).slice(0, 10) });
  const term = searchTerm(q.search);
  const userClauses = term ? [`email.ilike.*${term}*`, `full_name.ilike.*${term}*`, `display_name.ilike.*${term}*`, `referral_code.ilike.*${term}*`] : [];
  if (UUID_RE.test(term)) userClauses.push(`id.eq.${term}`);
  const or = userClauses.length ? `(${userClauses.join(",")})` : undefined;
  const result = await db.list("profiles", {
    select: PROFILE_FIELDS, filters, or, order: q.sort === "xp" ? "xp.desc" : "created_at.desc",
    limit: pageSize, offset, count: true,
  });
  return { rows: result.rows.map((row) => maskProfile(row, admin.role)), total: result.count ?? 0, page, page_size: pageSize };
}

async function userDetail(admin, q) {
  assertCan(admin, "users", "read");
  const id = uuid(q.id);
  const profile = await db.one("profiles", { select: PROFILE_FIELDS, filters: [{ column: "id", op: "eq", value: id }], required: true, notFoundMessage: "User not found" });
  const allowed = (resource) => can(admin.role, resource, "read");
  const emptyRows = () => Promise.resolve({ rows: [] });
  const auditFilters = [{ column: "target_id", op: "eq", value: id }];
  if (!can(admin.role, "audit", "read_all")) auditFilters.push({ column: "admin_id", op: "eq", value: admin.admin_id });
  const [payments, grants, submissions, hints, referrals, signals, battles, achievements, notifications, audit] = await Promise.all([
    allowed("payments") ? safe(() => db.list("payments", { filters: [{ column: "user_id", op: "eq", value: id }], order: "created_at.desc", limit: 50 }), { rows: [] }) : emptyRows(),
    allowed("payments") ? safe(() => db.list("payment_grants", { filters: [{ column: "user_id", op: "eq", value: id }], order: "created_at.desc", limit: 50 }), { rows: [] }) : emptyRows(),
    safe(() => db.list("submissions", { filters: [{ column: "user_id", op: "eq", value: id }], order: "created_at.desc", limit: 100 }), { rows: [] }),
    safe(() => db.list("hint_unlocks", { filters: [{ column: "user_id", op: "eq", value: id }], limit: 100 }), { rows: [] }),
    allowed("referrals") ? safe(() => db.list("referrals", { or: `(referrer_id.eq.${id},referred_id.eq.${id})`, order: "created_at.desc", limit: 100 }), { rows: [] }) : emptyRows(),
    allowed("referrals") ? safe(() => db.list("referral_account_signals", { filters: [{ column: "user_id", op: "eq", value: id }], order: "created_at.desc", limit: 100 }), { rows: [] }) : emptyRows(),
    allowed("battles") ? safe(() => db.list("battles", { or: `(challenger_id.eq.${id},opponent_id.eq.${id})`, order: "created_at.desc", limit: 100 }), { rows: [] }) : emptyRows(),
    safe(() => db.list("user_achievements", { filters: [{ column: "user_id", op: "eq", value: id }], order: "unlocked_at.desc", limit: 100 }), { rows: [] }),
    allowed("push") ? safe(() => db.list("notifications", { filters: [{ column: "user_id", op: "eq", value: id }], order: "created_at.desc", limit: 50 }), { rows: [] }) : emptyRows(),
    safe(() => db.list("admin_audit_log", { filters: auditFilters, order: "created_at.desc", limit: 100 }), { rows: [] }),
  ]);
  return maskEmailsDeep({
    profile: maskProfile(profile, admin.role),
    payments: payments.rows, payment_grants: grants.rows, submissions: submissions.rows,
    hint_unlocks: hints.rows, referrals: referrals.rows, referral_signals: signals.rows,
    battles: battles.rows, achievements: achievements.rows, notifications: notifications.rows,
    audit: audit.rows,
  }, admin.role);
}

async function problemsList(admin, q) {
  assertCan(admin, "problems", "read");
  const { page, pageSize, offset } = pagination(q);
  const filters = [];
  if (["bug", "question"].includes(q.type)) filters.push({ column: "type", op: "eq", value: q.type });
  if (["easy", "medium", "hard"].includes(q.difficulty)) filters.push({ column: "difficulty", op: "eq", value: q.difficulty });
  if (["draft", "published", "archived"].includes(q.status)) filters.push({ column: "status", op: "eq", value: q.status });
  if (q.access === "premium") filters.push({ column: "is_premium", op: "eq", value: "true" });
  if (q.access === "free") filters.push({ column: "is_premium", op: "eq", value: "false" });
  const term = searchTerm(q.search);
  const or = term ? `(title.ilike.*${term}*,topic.ilike.*${term}*)` : undefined;
  const result = await db.list("problems", { select: PROBLEM_FIELDS, filters, or, order: "created_at.desc", limit: pageSize, offset, count: true });
  const ids = result.rows.map((row) => row.id);
  const stats = ids.length ? await safe(() => db.list("admin_problem_stats", { filters: [{ column: "id", op: "in", value: inFilter(ids) }], limit: ids.length }), { rows: [] }) : { rows: [] };
  const byId = Object.fromEntries(stats.rows.map((row) => [row.id, row]));
  return { rows: result.rows.map((row) => ({ ...row, ...(byId[row.id] || { attempt_count: 0, solve_count: 0, success_rate: 0 }) })), total: result.count ?? 0, page, page_size: pageSize };
}

async function problemDetail(admin, q) {
  assertCan(admin, "problems", "read");
  return db.one("problems", { select: PROBLEM_FIELDS, filters: [{ column: "id", op: "eq", value: uuid(q.id) }], required: true, notFoundMessage: "Problem not found" });
}

async function payments(admin, q) {
  assertCan(admin, "payments", "read");
  const { page, pageSize, offset } = pagination(q);
  const filters = dateRangeFilters(q);
  if (q.plan) filters.push({ column: "plan", op: "eq", value: searchTerm(q.plan) });
  const term = searchTerm(q.search);
  const or = term ? `(razorpay_payment_id.ilike.*${term}*,razorpay_order_id.ilike.*${term}*)` : undefined;
  const result = await db.list("payments", { filters, or, order: "created_at.desc", limit: pageSize, offset, count: true });
  const profiles = await profilesByIds(result.rows.map((row) => row.user_id), admin.role);
  const recent = await safe(() => boundedList("payments", { select: "plan,amount_paise,created_at", filters: [{ column: "created_at", op: "gte", value: isoDaysAgo(90) }], order: "created_at.asc" }, 10000), { rows: [] });
  const totals = recent.rows.reduce((acc, row) => {
    const amount = Number(row.amount_paise || 0);
    acc.total += amount;
    if (new Date(row.created_at) >= new Date(isoDaysAgo(30))) acc.days30 += amount;
    acc.by_plan[row.plan || "other"] = (acc.by_plan[row.plan || "other"] || 0) + amount;
    return acc;
  }, { total: 0, days30: 0, by_plan: {} });
  return { rows: result.rows.map((row) => maskEmailsDeep({ ...row, user: profiles[row.user_id] || null }, admin.role)), total: result.count ?? 0, page, page_size: pageSize, summary: totals, daily: revenueByPlan(recent.rows, 30) };
}

async function referrals(admin, q) {
  assertCan(admin, "referrals", "read");
  const { page, pageSize, offset } = pagination(q);
  const openOnly = q.status !== "all";
  const signals = await db.list("referral_account_signals", {
    filters: openOnly ? [{ column: "invalidated_at", op: "is", value: "null" }] : [],
    order: "created_at.desc", limit: pageSize, offset, count: true,
  });
  const top = await db.list("profiles", { select: "id,display_name,full_name,email,referral_count,referral_qualified_count", order: "referral_qualified_count.desc", limit: 20 });
  const referralRows = await safe(() => boundedList("referrals", { select: "*", order: "created_at.desc" }, 10000), { rows: [] });
  const profiles = await profilesByIds([...signals.rows.map((row) => row.user_id), ...top.rows.map((row) => row.id)], admin.role);
  const qualified = referralRows.rows.filter((row) => row.qualified_at || row.status === "qualified").length;
  return {
    queue: signals.rows.map((row) => maskEmailsDeep({ ...row, user: profiles[row.user_id] || null }, admin.role)),
    total: signals.count ?? 0, page, page_size: pageSize,
    funnel: { referred: referralRows.rows.length, qualified, converted: referralRows.rows.filter((row) => row.premium_at || row.converted_at).length },
    top: top.rows.map((row) => ({ ...maskProfile(row, admin.role), ...(profiles[row.id] || {}) })),
  };
}

async function battles(admin, q) {
  assertCan(admin, "battles", "read");
  const { page, pageSize, offset } = pagination(q);
  const filters = dateRangeFilters(q);
  if (["easy", "medium", "hard"].includes(q.difficulty)) filters.push({ column: "difficulty", op: "eq", value: q.difficulty });
  const result = await db.list("battles", { filters, order: "created_at.desc", limit: pageSize, offset, count: true });
  const recent = await safe(() => boundedList("battles", { select: "id,difficulty,finished_at,created_at", filters: [{ column: "created_at", op: "gte", value: isoDaysAgo(30) }], order: "created_at.asc" }, 10000), { rows: [] });
  const problems = await safe(() => boundedList("problems", { select: "id,difficulty,status,battle_error", filters: [{ column: "status", op: "eq", value: "published" }], order: "created_at.asc" }, 10000), { rows: [] });
  const mix = { easy: 0, medium: 0, hard: 0 };
  recent.rows.forEach((row) => { if (mix[row.difficulty] !== undefined) mix[row.difficulty] += 1; });
  const pool = { easy: 0, medium: 0, hard: 0 };
  problems.rows.forEach((row) => { if (pool[row.difficulty] !== undefined) pool[row.difficulty] += 1; });
  const completed = recent.rows.filter((row) => row.finished_at).length;
  return { rows: result.rows, total: result.count ?? 0, page, page_size: pageSize, metrics: { battles_30d: recent.rows.length, completion_rate: recent.rows.length ? Math.round(completed * 1000 / recent.rows.length) / 10 : 0, difficulty_mix: mix, question_pool: pool, daily: aggregateDaily(recent.rows, "created_at", null, 30) } };
}

async function moderation(admin, q) {
  assertCan(admin, "moderation", "read");
  const { page, pageSize, offset } = pagination(q);
  const tab = q.tab === "feed" ? "feed" : "flags";
  if (tab === "feed") {
    const term = searchTerm(q.search);
    const discussions = await db.list("problem_discussions", { filters: term ? [{ column: "content", op: "ilike", value: `*${term}*` }] : [], order: "created_at.desc", limit: pageSize, offset, count: true });
    const profiles = await profilesByIds(discussions.rows.map((row) => row.user_id || row.author_id), admin.role);
    return { tab, rows: discussions.rows.map((row) => maskEmailsDeep({ ...row, user: profiles[row.user_id || row.author_id] || null }, admin.role)), total: discussions.count ?? 0, page, page_size: pageSize };
  }
  const flags = await db.list("discussion_flags", { filters: q.status === "resolved" ? [{ column: "resolved_at", op: "not.is", value: "null" }] : [{ column: "resolved_at", op: "is", value: "null" }], order: "created_at.desc", limit: pageSize, offset, count: true });
  return { tab, rows: flags.rows.map((row) => maskEmailsDeep(row, admin.role)), total: flags.count ?? 0, page, page_size: pageSize };
}

async function push(admin, q) {
  assertCan(admin, "push", "read");
  const { page, pageSize, offset } = pagination(q);
  const announcements = await db.list("push_announcements", { order: "created_at.desc", limit: pageSize, offset, count: true });
  const logs = await safe(() => db.list("push_broadcast_log", { order: "created_at.desc", limit: 200 }), { rows: [] });
  const events = await safe(() => db.list("push_event_log", { order: "created_at.desc", limit: 500 }), { rows: [] });
  return maskEmailsDeep({ rows: announcements.rows, total: announcements.count ?? 0, page, page_size: pageSize, delivery: logs.rows, events: events.rows }, admin.role);
}

async function emails(admin, q) {
  assertCan(admin, "emails", "read");
  const { page, pageSize, offset } = pagination(q);
  const result = await db.list("lifecycle_email_log", { filters: dateRangeFilters(q), order: "created_at.desc", limit: pageSize, offset, count: true });
  return { rows: result.rows.map((row) => maskEmailsDeep(row, admin.role)), total: result.count ?? 0, page, page_size: pageSize };
}

function retentionReport(profiles, submissions) {
  const activity = new Map();
  for (const row of submissions) {
    if (!row.user_id) continue;
    if (!activity.has(row.user_id)) activity.set(row.user_id, new Set());
    const key = dayKey(row.created_at || row.solved_at);
    if (key) activity.get(row.user_id).add(key);
  }
  const cohorts = new Map();
  for (const profile of profiles) {
    const cohort = dayKey(profile.created_at);
    if (!cohort) continue;
    if (!cohorts.has(cohort)) cohorts.set(cohort, { cohort, users: 0, d1: 0, d7: 0, d30: 0 });
    const item = cohorts.get(cohort); item.users += 1;
    const dates = activity.get(profile.id) || new Set();
    for (const [label, days] of [["d1", 1], ["d7", 7], ["d30", 30]]) {
      const target = new Date(new Date(cohort).getTime() + days * 86400000).toISOString().slice(0, 10);
      if (dates.has(target)) item[label] += 1;
    }
  }
  return [...cohorts.values()].sort((a, b) => b.cohort.localeCompare(a.cohort)).slice(0, 30).map((row) => ({
    cohort: row.cohort, users: row.users,
    d1: row.users ? Math.round(row.d1 * 1000 / row.users) / 10 : 0,
    d7: row.users ? Math.round(row.d7 * 1000 / row.users) / 10 : 0,
    d30: row.users ? Math.round(row.d30 * 1000 / row.users) / 10 : 0,
  }));
}

async function reports(admin, q) {
  assertCan(admin, "reports", "read");
  const from = q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : isoDaysAgo(90);
  const to = q.to && !Number.isNaN(Date.parse(q.to)) ? new Date(`${q.to}T23:59:59.999Z`).toISOString() : new Date().toISOString();
  const filters = [{ column: "created_at", op: "gte", value: from }, { column: "created_at", op: "lte", value: to }];
  const [profiles, submissions, paymentsRows, problemsRows] = await Promise.all([
    safe(() => boundedList("profiles", { select: "id,created_at,last_active_date,streak,is_premium,premium_expires_at", filters, order: "created_at.asc" }, 10000), { rows: [] }),
    safe(() => boundedList("submissions", { select: "id,user_id,problem_id,status,created_at,solved_at", filters, order: "created_at.asc" }, 20000), { rows: [] }),
    safe(() => boundedList("payments", { select: "user_id,plan,amount_paise,created_at", filters, order: "created_at.asc" }, 10000), { rows: [] }),
    safe(() => boundedList("problems", { select: "id,title,difficulty,topic", order: "created_at.asc" }, 10000), { rows: [] }),
  ]);
  const stats = new Map(problemsRows.rows.map((row) => [row.id, { ...row, attempts: 0, solves: 0 }]));
  submissions.rows.forEach((row) => {
    const item = stats.get(row.problem_id); if (!item) return;
    item.attempts += 1; if (row.status === "solved") item.solves += 1;
  });
  const content = [...stats.values()].filter((row) => row.attempts).map((row) => ({ ...row, success_rate: Math.round(row.solves * 1000 / row.attempts) / 10 })).sort((a, b) => a.success_rate - b.success_rate);
  const totalRevenue = paymentsRows.rows.reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);
  const payingUsers = new Set(paymentsRows.rows.map((row) => row.user_id)).size;
  const planMix = {};
  paymentsRows.rows.forEach((row) => { planMix[row.plan || "other"] = (planMix[row.plan || "other"] || 0) + Number(row.amount_paise || 0); });
  const expiring = await safe(() => db.list("profiles", { select: "id,display_name,email,premium_expires_at", filters: [{ column: "is_premium", op: "eq", value: "true" }, { column: "premium_expires_at", op: "gte", value: new Date().toISOString() }, { column: "premium_expires_at", op: "lte", value: new Date(Date.now() + 7 * 86400000).toISOString() }], order: "premium_expires_at.asc", limit: 200 }), { rows: [] });
  return {
    range: { from, to },
    growth: { signups: aggregateDaily(profiles.rows, "created_at", null, 30), retention: retentionReport(profiles.rows, submissions.rows) },
    revenue: { total_paise: totalRevenue, paying_users: payingUsers, arpu_paise: payingUsers ? Math.round(totalRevenue / payingUsers) : 0, plan_mix: planMix, daily: revenueByPlan(paymentsRows.rows, 30) },
    content: { hardest: content.slice(0, 10), easiest: [...content].reverse().slice(0, 10) },
    engagement: { submissions: submissions.rows.length, solves: submissions.rows.filter((row) => row.status === "solved").length, active_users: new Set(submissions.rows.map((row) => row.user_id)).size },
    churn: expiring.rows.map((row) => maskProfile(row, admin.role)),
  };
}

async function settings(admin) {
  assertCan(admin, "settings", "read");
  const [settingsRows, admins] = await Promise.all([
    db.list("app_settings", { order: "key.asc", limit: 200 }),
    db.list("admin_users", { select: "user_id,email,role,totp_enabled,created_by,created_at,last_login_at", order: "created_at.asc", limit: 200 }),
  ]);
  return { settings: settingsRows.rows, admins: admins.rows };
}

async function audit(admin, q) {
  const canAll = can(admin.role, "audit", "read_all");
  assertCan(admin, "audit", canAll ? "read_all" : "read_own");
  const { page, pageSize, offset } = pagination(q);
  const filters = dateRangeFilters(q);
  if (!canAll) filters.push({ column: "admin_id", op: "eq", value: admin.admin_id });
  else if (q.admin) filters.push({ column: "admin_id", op: "eq", value: uuid(q.admin, "admin") });
  // Column filters deliberately read log_resource/log_action: the router-level
  // resource/action params select the endpoint and must never be treated as
  // column values (they previously collided and emptied or broke the page).
  if (q.log_resource) filters.push({ column: "resource", op: "eq", value: searchTerm(q.log_resource) });
  if (q.log_action) filters.push({ column: "action", op: "eq", value: searchTerm(q.log_action) });
  const result = await db.list("admin_audit_log", { filters, order: "created_at.desc", limit: pageSize, offset, count: true });
  return { rows: result.rows.map((row) => maskEmailsDeep(row, admin.role)), total: result.count ?? 0, page, page_size: pageSize };
}

async function globalSearch(admin, q) {
  const term = searchTerm(q.q);
  if (term.length < 2) return { users: [], problems: [], payments: [] };
  const operations = [];
  const userSearchClauses = [`email.ilike.*${term}*`, `display_name.ilike.*${term}*`, `full_name.ilike.*${term}*`];
  if (UUID_RE.test(term)) userSearchClauses.push(`id.eq.${term}`);
  operations.push(can(admin.role, "users", "read") ? safe(() => db.list("profiles", { select: "id,display_name,full_name,email,status", or: `(${userSearchClauses.join(",")})`, limit: 8 }), { rows: [] }) : Promise.resolve({ rows: [] }));
  operations.push(can(admin.role, "problems", "read") ? safe(() => db.list("problems", { select: "id,title,difficulty,status", or: `(title.ilike.*${term}*,topic.ilike.*${term}*)`, limit: 8 }), { rows: [] }) : Promise.resolve({ rows: [] }));
  operations.push(can(admin.role, "payments", "read") ? safe(() => db.list("payments", { select: "id,razorpay_payment_id,plan,amount_paise,created_at", or: `(razorpay_payment_id.ilike.*${term}*,razorpay_order_id.ilike.*${term}*)`, limit: 8 }), { rows: [] }) : Promise.resolve({ rows: [] }));
  const [users, problemsRows, paymentRows] = await Promise.all(operations);
  return { users: users.rows.map((row) => maskProfile(row, admin.role)), problems: problemsRows.rows, payments: paymentRows.rows };
}

module.exports = async function handler(req, res) {
  try {
    method(req, ["GET"]);
    const admin = await requireAdmin(req);
    const q = query(req);
    const resource = cleanText(q.resource, 40);
    const action = cleanText(q.action || "list", 40);
    let data;
    if (resource === "dashboard") data = await dashboard(admin);
    else if (resource === "users" && action === "list") data = await usersList(admin, q);
    else if (resource === "users" && action === "detail") data = await userDetail(admin, q);
    else if (resource === "problems" && action === "list") data = await problemsList(admin, q);
    else if (resource === "problems" && action === "detail") data = await problemDetail(admin, q);
    else if (resource === "payments") data = await payments(admin, q);
    else if (resource === "referrals") data = await referrals(admin, q);
    else if (resource === "battles") data = await battles(admin, q);
    else if (resource === "moderation") data = await moderation(admin, q);
    else if (resource === "push") data = await push(admin, q);
    else if (resource === "emails") data = await emails(admin, q);
    else if (resource === "reports") data = await reports(admin, q);
    else if (resource === "settings") data = await settings(admin);
    else if (resource === "audit") data = await audit(admin, q);
    else if (resource === "search") data = await globalSearch(admin, q);
    else {
      const error = resource
        ? new Error(`Unknown read resource or action: ${resource}/${action}`)
        : new Error("Missing resource parameter — the request reached the API without its query string");
      error.status = resource ? 404 : 400;
      error.code = resource ? "not_found" : "missing_resource";
      throw error;
    }
    return send(res, 200, { ok: true, data });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports._internals = { searchTerm, usersList, dashboard, payments, reports };
