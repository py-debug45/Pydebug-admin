"use strict";

const ROLES = Object.freeze([
  "superadmin", "content_editor", "support", "finance", "moderator", "analyst",
]);

const RULES = Object.freeze({
  dashboard: {
    read: ["superadmin", "content_editor", "support", "finance", "moderator", "analyst"],
  },
  users: {
    read: ["superadmin", "support", "finance", "moderator", "analyst"],
    reveal_email: ["superadmin", "support", "finance"],
    edit: ["superadmin", "support"],
    grant_premium: ["superadmin", "support", "finance"],
    revoke_premium: ["superadmin", "finance"],
    suspend: ["superadmin", "support"],
    warn: ["superadmin", "moderator"],
    mute: ["superadmin", "moderator"],
    adjust_xp: ["superadmin", "support"],
    reset_progress: ["superadmin"],
    restore_streak: ["superadmin", "support"],
    grant_freeze: ["superadmin", "support"],
    set_battle_invites: ["superadmin", "support"],
    delete: ["superadmin"],
  },
  problems: {
    read: ["superadmin", "content_editor", "support", "moderator", "analyst"],
    create: ["superadmin", "content_editor"],
    edit: ["superadmin", "content_editor"],
    duplicate: ["superadmin", "content_editor"],
    archive: ["superadmin", "content_editor"],
    delete: ["superadmin", "content_editor"],
  },
  payments: {
    read: ["superadmin", "support", "finance", "analyst"],
    reconcile: ["superadmin", "finance"],
    manual_grant: ["superadmin", "finance"],
  },
  referrals: {
    read: ["superadmin", "support", "finance", "moderator", "analyst"],
    invalidate: ["superadmin", "moderator"],
    revoke_reward: ["superadmin"],
  },
  moderation: {
    read: ["superadmin", "support", "moderator", "analyst"],
    resolve: ["superadmin", "moderator"],
    hide: ["superadmin", "moderator"],
    delete: ["superadmin", "moderator"],
  },
  battles: {
    read: ["superadmin", "support", "moderator", "analyst"],
    cleanup: ["superadmin"],
  },
  push: {
    read: ["superadmin", "analyst"],
    send: ["superadmin"],
    test_send: ["superadmin", "support"],
  },
  emails: {
    read: ["superadmin", "analyst"],
    test_send: ["superadmin", "support"],
  },
  reports: {
    read: ["superadmin", "finance", "analyst"],
    export: ["superadmin", "finance", "analyst"],
  },
  settings: {
    read: ["superadmin"],
    edit: ["superadmin"],
  },
  admins: {
    read: ["superadmin"],
    create: ["superadmin"],
    edit: ["superadmin"],
    delete: ["superadmin"],
  },
  audit: {
    read_all: ["superadmin", "analyst"],
    read_own: ROLES,
  },
  jobs: {
    rebuild: ["superadmin"],
  },
});

function can(role, resource, action) {
  if (!ROLES.includes(role)) return false;
  const allowed = RULES[resource]?.[action];
  return Array.isArray(allowed) && allowed.includes(role);
}

function assertCan(admin, resource, action) {
  if (!admin || !can(admin.role, resource, action)) {
    const error = new Error("You do not have permission to perform this action");
    error.status = 403;
    error.code = "forbidden";
    throw error;
  }
}

function canSeeEmail(role) {
  return ["superadmin", "support", "finance"].includes(role);
}

function maskEmail(email) {
  const value = String(email || "");
  const at = value.indexOf("@");
  if (at <= 0) return value ? "***" : "";
  return `${value[0]}***${value.slice(at)}`;
}

module.exports = { ROLES, RULES, can, assertCan, canSeeEmail, maskEmail };
