"use strict";

const db = require("./_db");
const { requireAdmin } = require("../lib/server/admin-auth");
const { assertCan, ROLES } = require("../lib/server/permissions");
const { withAudit } = require("../lib/server/audit");
const { send, method, readJson, clientIp, assertSameOrigin, cleanText, requiredText, handleError } = require("../lib/server/http");
const { uuid, identifier, oneOf, integer, boolean } = require("../lib/server/validate");

function filtersId(id) {
  return [{ column: "id", op: "eq", value: id }];
}

async function profile(id) {
  return db.one("profiles", { filters: filtersId(id), required: true, notFoundMessage: "User not found" });
}

async function problem(id) {
  return db.one("problems", { filters: filtersId(id), required: true, notFoundMessage: "Problem not found" });
}

function problemPayload(payload, partial = false) {
  const output = {};
  const put = (key, value) => { if (!partial || value !== undefined) output[key] = value; };
  put("type", payload.type === undefined ? undefined : oneOf(payload.type, ["bug", "question"], "type"));
  put("title", payload.title === undefined ? undefined : requiredText(payload.title, "title", 180));
  put("description", payload.description === undefined ? undefined : requiredText(payload.description, "description", 10000));
  put("difficulty", payload.difficulty === undefined ? undefined : oneOf(payload.difficulty, ["easy", "medium", "hard"], "difficulty"));
  put("topic", payload.topic === undefined ? undefined : requiredText(payload.topic, "topic", 100));
  put("is_premium", payload.is_premium === undefined ? undefined : boolean(payload.is_premium, "is_premium"));
  put("starter_code", payload.starter_code === undefined ? undefined : requiredText(payload.starter_code, "starter_code", 30000));
  put("expected_output", payload.expected_output === undefined ? undefined : cleanText(payload.expected_output, 10000));
  put("battle_error", payload.battle_error === undefined ? undefined : cleanText(payload.battle_error, 500));
  put("status", payload.status === undefined ? undefined : oneOf(payload.status, ["draft", "published", "archived"], "status"));
  if (!partial || payload.hints !== undefined) {
    if (!Array.isArray(payload.hints) || payload.hints.length > 10) {
      const error = new Error("hints must be an array with at most 10 items"); error.status = 400; throw error;
    }
    output.hints = payload.hints.map((hint) => requiredText(hint, "hint", 500));
  }
  if (!partial || payload.notify_users !== undefined) {
    output.admin_skip_notification = payload.notify_users === undefined ? false : !boolean(payload.notify_users, "notify_users");
  }
  return output;
}

async function userWrite(admin, action, payload, reason, ip) {
  const id = uuid(payload.id, "user id");
  if (action === "reveal_email") {
    assertCan(admin, "users", "reveal_email");
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip,
      getOld: () => profile(id),
      execute: (old) => ({ email: old.email }),
      newValue: { email_revealed: true },
    });
  }
  if (action === "edit") {
    assertCan(admin, "users", "edit");
    const displayName = requiredText(payload.display_name, "display_name", 80);
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip,
      getOld: () => profile(id),
      execute: () => db.update("profiles", { display_name: displayName }, { filters: filtersId(id) }),
    });
  }
  if (action === "grant_premium") {
    assertCan(admin, "users", "grant_premium");
    const days = integer(payload.days, { min: 1, max: 3650, name: "days" });
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip,
      getOld: () => profile(id),
      execute: (old) => {
        const current = new Date(old.premium_expires_at || 0).getTime();
        const base = Math.max(Date.now(), Number.isNaN(current) ? 0 : current);
        return db.update("profiles", { is_premium: true, premium_expires_at: new Date(base + days * 86400000).toISOString() }, { filters: filtersId(id) });
      },
    });
  }
  if (action === "revoke_premium") {
    assertCan(admin, "users", "revoke_premium");
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip, destructive: true,
      getOld: () => profile(id),
      execute: () => db.update("profiles", { is_premium: false, premium_expires_at: new Date().toISOString() }, { filters: filtersId(id) }),
    });
  }
  if (["suspend", "unsuspend"].includes(action)) {
    assertCan(admin, "users", "suspend");
    const suspended = action === "suspend";
    const until = payload.until && !Number.isNaN(Date.parse(payload.until)) ? new Date(payload.until).toISOString() : null;
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip, destructive: suspended,
      getOld: () => profile(id),
      execute: () => db.update("profiles", suspended
        ? { status: "suspended", status_reason: reason, status_until: until }
        : { status: "active", status_reason: null, status_until: null }, { filters: filtersId(id) }),
    });
  }
  if (["warn", "mute"].includes(action)) {
    assertCan(admin, "users", action);
    const until = payload.until && !Number.isNaN(Date.parse(payload.until)) ? new Date(payload.until).toISOString() : null;
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip, destructive: true,
      getOld: () => profile(id),
      execute: () => db.update("profiles", { status: action === "warn" ? "warned" : "muted", status_reason: reason, status_until: until }, { filters: filtersId(id) }),
    });
  }
  if (action === "adjust_xp") {
    assertCan(admin, "users", "adjust_xp");
    const delta = integer(payload.delta, { min: -100000, max: 100000, name: "XP delta" });
    if (!delta) { const error = new Error("XP delta cannot be zero"); error.status = 400; throw error; }
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip, destructive: true,
      getOld: () => profile(id),
      execute: (old) => db.update("profiles", { xp: Math.max(0, Number(old.xp || 0) + delta) }, { filters: filtersId(id) }),
    });
  }
  if (action === "reset_progress") {
    assertCan(admin, "users", "reset_progress");
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip, destructive: true,
      getOld: async () => ({ profile: await profile(id), submissions: await db.count("submissions", { filters: [{ column: "user_id", op: "eq", value: id }] }) }),
      execute: async () => {
        await db.remove("submissions", { filters: [{ column: "user_id", op: "eq", value: id }], many: true });
        await Promise.allSettled([
          db.remove("hint_unlocks", { filters: [{ column: "user_id", op: "eq", value: id }], many: true }),
          db.remove("user_achievements", { filters: [{ column: "user_id", op: "eq", value: id }], many: true }),
        ]);
        return db.update("profiles", { xp: 0, streak: 0, daily_bonus_streak: 0 }, { filters: filtersId(id) });
      },
    });
  }
  if (action === "restore_streak") {
    assertCan(admin, "users", "restore_streak");
    const streak = integer(payload.streak, { min: 1, max: 10000, name: "streak" });
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip,
      getOld: () => profile(id),
      execute: () => db.update("profiles", { streak, last_active_date: new Date().toISOString().slice(0, 10) }, { filters: filtersId(id) }),
    });
  }
  if (action === "grant_freeze") {
    assertCan(admin, "users", "grant_freeze");
    const count = integer(payload.count || 1, { min: 1, max: 20, name: "freeze count" });
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip,
      getOld: () => profile(id),
      execute: (old) => db.update("profiles", { streak_freezes: Number(old.streak_freezes || 0) + count }, { filters: filtersId(id) }),
    });
  }
  if (action === "set_battle_invites") {
    assertCan(admin, "users", "set_battle_invites");
    const enabled = boolean(payload.enabled, "enabled");
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip,
      getOld: () => profile(id),
      execute: () => db.update("profiles", { battle_invites_enabled: enabled }, { filters: filtersId(id) }),
    });
  }
  if (action === "test_notification") {
    assertCan(admin, "push", "test_send");
    const title = requiredText(payload.title || "PyDebug test notification", "title", 120);
    const message = requiredText(payload.message || "This is a test from the admin panel.", "message", 500);
    return withAudit({ admin, resource: "push", action, targetId: id, reason, ip,
      getOld: () => profile(id),
      execute: () => db.insert("notifications", { user_id: id, type: "admin_test", title, message, link: null, is_read: false }),
    });
  }
  if (action === "delete") {
    assertCan(admin, "users", "delete");
    if (id === admin.admin_id) { const error = new Error("You cannot delete your own account"); error.status = 400; throw error; }
    return withAudit({ admin, resource: "users", action, targetId: id, reason, ip, destructive: true,
      getOld: () => profile(id),
      execute: async () => { await db.authAdminDelete(id); return { deleted: true, id }; },
    });
  }
  const error = new Error("Unknown users action"); error.status = 404; throw error;
}

async function problemsWrite(admin, action, payload, reason, ip) {
  if (action === "create") {
    assertCan(admin, "problems", "create");
    const values = { ...problemPayload(payload), created_by: admin.admin_id };
    return withAudit({ admin, resource: "problems", action, reason, ip,
      oldValue: null,
      execute: () => db.insert("problems", values),
      getNew: (result) => result,
      targetId: (result) => result?.id || null,
    });
  }
  const id = uuid(payload.id, "problem id");
  if (action === "edit") {
    assertCan(admin, "problems", "edit");
    const values = problemPayload(payload, true);
    if (!Object.keys(values).length) { const error = new Error("No problem fields to update"); error.status = 400; throw error; }
    return withAudit({ admin, resource: "problems", action, targetId: id, reason, ip,
      getOld: () => problem(id), execute: () => db.update("problems", values, { filters: filtersId(id) }),
    });
  }
  if (action === "duplicate") {
    assertCan(admin, "problems", "duplicate");
    return withAudit({ admin, resource: "problems", action, targetId: id, reason, ip,
      getOld: () => problem(id),
      execute: (old) => {
        const { id: ignoredId, created_at: ignoredCreated, updated_at: ignoredUpdated, ...copy } = old;
        return db.insert("problems", { ...copy, title: `${old.title} (Copy)`.slice(0, 180), status: "draft", created_by: admin.admin_id, admin_skip_notification: true });
      },
    });
  }
  if (action === "archive") {
    assertCan(admin, "problems", "archive");
    return withAudit({ admin, resource: "problems", action, targetId: id, reason, ip,
      getOld: () => problem(id), execute: () => db.update("problems", { status: "archived" }, { filters: filtersId(id) }),
    });
  }
  if (action === "delete") {
    assertCan(admin, "problems", "delete");
    return withAudit({ admin, resource: "problems", action, targetId: id, reason, ip, destructive: true,
      getOld: () => problem(id), execute: () => db.remove("problems", { filters: filtersId(id) }),
    });
  }
  const error = new Error("Unknown problems action"); error.status = 404; throw error;
}

async function paymentWrite(admin, action, payload, reason, ip) {
  if (action !== "manual_grant") { const error = new Error("Unknown payments action"); error.status = 404; throw error; }
  assertCan(admin, "payments", "manual_grant");
  const id = uuid(payload.id, "user id");
  const days = integer(payload.days, { min: 1, max: 3650, name: "days" });
  return withAudit({ admin, resource: "payments", action, targetId: id, reason, ip, destructive: true,
    getOld: () => profile(id),
    execute: (old) => {
      const base = Math.max(Date.now(), new Date(old.premium_expires_at || 0).getTime() || 0);
      return db.update("profiles", { is_premium: true, premium_expires_at: new Date(base + days * 86400000).toISOString() }, { filters: filtersId(id) });
    },
  });
}

async function referralsWrite(admin, action, payload, reason, ip) {
  if (action === "invalidate") {
    assertCan(admin, "referrals", "invalidate");
    const id = identifier(payload.id, "signal id");
    const old = () => db.one("referral_account_signals", { filters: filtersId(id), required: true, notFoundMessage: "Signal not found" });
    return withAudit({ admin, resource: "referrals", action, targetId: id, reason, ip, destructive: true,
      getOld: old,
      execute: () => db.update("referral_account_signals", { invalidated_at: new Date().toISOString(), invalid_reason: reason }, { filters: filtersId(id) }),
    });
  }
  if (action === "revoke_reward") {
    assertCan(admin, "referrals", "revoke_reward");
    const id = uuid(payload.id, "user id");
    return withAudit({ admin, resource: "referrals", action, targetId: id, reason, ip, destructive: true,
      getOld: () => profile(id),
      execute: () => db.update("profiles", { referred_premium_until: null, referrer_premium_until: null }, { filters: filtersId(id) }),
    });
  }
  const error = new Error("Unknown referrals action"); error.status = 404; throw error;
}

async function moderationWrite(admin, action, payload, reason, ip) {
  assertCan(admin, "moderation", action === "resolve" ? "resolve" : action);
  const flagId = payload.flag_id ? uuid(payload.flag_id, "flag id") : null;
  const discussionId = uuid(payload.discussion_id, "discussion id");
  const resolution = oneOf(payload.resolution || (action === "delete" ? "deleted" : action === "hide" ? "hidden" : "dismissed"), ["dismissed", "hidden", "deleted", "user_muted"], "resolution");
  const getOld = async () => ({
    discussion: await db.one("problem_discussions", { filters: filtersId(discussionId) }),
    flag: flagId ? await db.one("discussion_flags", { filters: filtersId(flagId) }) : null,
  });
  return withAudit({ admin, resource: "moderation", action, targetId: discussionId, reason, ip, destructive: action !== "resolve" || resolution !== "dismissed",
    getOld,
    execute: async (old) => {
      let discussion = old.discussion;
      if (resolution === "deleted") discussion = await db.remove("problem_discussions", { filters: filtersId(discussionId) });
      if (resolution === "hidden" && discussion) {
        const field = Object.prototype.hasOwnProperty.call(discussion, "content") ? "content" : "body";
        discussion = await db.update("problem_discussions", { [field]: "[Hidden by moderator]" }, { filters: filtersId(discussionId) });
      }
      if (resolution === "user_muted" && discussion) {
        const userId = discussion.user_id || discussion.author_id;
        if (userId) await db.update("profiles", { status: "muted", status_reason: reason }, { filters: filtersId(userId) });
      }
      const flag = flagId ? await db.update("discussion_flags", { resolved_by: admin.admin_id, resolved_at: new Date().toISOString(), resolution }, { filters: filtersId(flagId) }) : null;
      return { discussion, flag, resolution };
    },
  });
}

async function settingsWrite(admin, action, payload, reason, ip) {
  assertCan(admin, "settings", "edit");
  if (action !== "set") { const error = new Error("Unknown settings action"); error.status = 404; throw error; }
  const key = requiredText(payload.key, "key", 80);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) { const error = new Error("Invalid setting key"); error.status = 400; throw error; }
  if (payload.value === undefined) { const error = new Error("value is required"); error.status = 400; throw error; }
  const serialised = JSON.stringify(payload.value);
  if (serialised.length > 20000) { const error = new Error("Setting value is too large"); error.status = 400; throw error; }
  return withAudit({ admin, resource: "settings", action, targetId: key, reason, ip,
    getOld: () => db.one("app_settings", { filters: [{ column: "key", op: "eq", value: key }] }),
    execute: () => db.insert("app_settings", { key, value: payload.value, updated_by: admin.admin_id, updated_at: new Date().toISOString() }, { upsert: true, onConflict: "key" }),
  });
}

async function adminsWrite(admin, action, payload, reason, ip) {
  assertCan(admin, "admins", action);
  if (action === "create") {
    const email = requiredText(payload.email, "email", 320).toLowerCase();
    const role = oneOf(payload.role, ROLES, "role");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { const error = new Error("A valid email is required"); error.status = 400; throw error; }
    const target = await db.one("profiles", { select: "id,email", filters: [{ column: "email", op: "ilike", value: email }], required: true, notFoundMessage: "No PyDebug user with that email was found" });
    return withAudit({ admin, resource: "admins", action, targetId: target.id, reason, ip,
      oldValue: null,
      execute: () => db.insert("admin_users", { user_id: target.id, email, role, created_by: admin.admin_id }),
    });
  }
  const id = uuid(payload.id, "admin id");
  if (action === "edit") {
    const role = oneOf(payload.role, ROLES, "role");
    if (id === admin.admin_id && role !== "superadmin") { const error = new Error("You cannot demote your own account"); error.status = 400; throw error; }
    return withAudit({ admin, resource: "admins", action, targetId: id, reason, ip,
      getOld: () => db.one("admin_users", { filters: [{ column: "user_id", op: "eq", value: id }], required: true }),
      execute: () => db.update("admin_users", { role }, { filters: [{ column: "user_id", op: "eq", value: id }] }),
    });
  }
  if (action === "delete") {
    if (id === admin.admin_id) { const error = new Error("You cannot remove your own admin access"); error.status = 400; throw error; }
    return withAudit({ admin, resource: "admins", action, targetId: id, reason, ip, destructive: true,
      getOld: () => db.one("admin_users", { filters: [{ column: "user_id", op: "eq", value: id }], required: true }),
      execute: async (old) => {
        if (old.role === "superadmin") {
          const total = await db.count("admin_users", { filters: [{ column: "role", op: "eq", value: "superadmin" }] });
          if (total <= 1) { const error = new Error("The final superadmin cannot be removed"); error.status = 400; throw error; }
        }
        return db.remove("admin_users", { filters: [{ column: "user_id", op: "eq", value: id }] });
      },
    });
  }
  const error = new Error("Unknown admins action"); error.status = 404; throw error;
}

module.exports = async function handler(req, res) {
  try {
    method(req, ["POST"]);
    assertSameOrigin(req);
    const admin = await requireAdmin(req, { csrf: true });
    const body = await readJson(req);
    const resource = cleanText(body.resource, 40);
    const action = cleanText(body.action, 40);
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    const reason = cleanText(body.reason, 1000);
    const ip = clientIp(req);
    let data;
    if (resource === "users") data = await userWrite(admin, action, payload, reason, ip);
    else if (resource === "problems") data = await problemsWrite(admin, action, payload, reason, ip);
    else if (resource === "payments") data = await paymentWrite(admin, action, payload, reason, ip);
    else if (resource === "referrals") data = await referralsWrite(admin, action, payload, reason, ip);
    else if (resource === "moderation") data = await moderationWrite(admin, action, payload, reason, ip);
    else if (resource === "settings") data = await settingsWrite(admin, action, payload, reason, ip);
    else if (resource === "admins") data = await adminsWrite(admin, action, payload, reason, ip);
    else { const error = new Error("Unknown write resource"); error.status = 404; throw error; }
    return send(res, 200, { ok: true, data });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports._internals = { userWrite, problemsWrite, paymentWrite, problemPayload };
