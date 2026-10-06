"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withAudit, sanitize, requireReason } = require("../lib/server/audit");

const admin = { admin_id: "00000000-0000-4000-8000-000000000001", role: "superadmin" };

test("every successful mutation records old/new values in the audit log", async () => {
  const inserted = [];
  const db = { insert: async (table, row) => { inserted.push({ table, row }); return row; } };
  let changed = false;
  const result = await withAudit({
    db, admin, resource: "users", action: "adjust_xp", targetId: "user-1",
    reason: "Support correction", ip: "127.0.0.1",
    getOld: async () => ({ xp: 10 }),
    execute: async () => { changed = true; return { xp: 25 }; },
  });
  assert.equal(changed, true);
  assert.deepEqual(result, { xp: 25 });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].table, "admin_audit_log");
  assert.deepEqual(inserted[0].row.old_value, { xp: 10 });
  assert.deepEqual(inserted[0].row.new_value, { xp: 25 });
  assert.equal(inserted[0].row.reason, "Support correction");
});

test("mutation surfaces a critical error if audit insertion fails", async () => {
  const db = { insert: async () => { throw new Error("database offline"); } };
  await assert.rejects(
    withAudit({ db, admin, resource: "settings", action: "set", execute: async () => ({ value: true }) }),
    (error) => error.code === "audit_write_failed" && error.status === 500,
  );
});

test("destructive mutations require a meaningful reason", () => {
  assert.throws(() => requireReason("no", true), (error) => error.code === "reason_required");
  assert.equal(requireReason("Customer requested deletion", true), "Customer requested deletion");
});

test("audit sanitizer redacts secrets recursively", () => {
  const value = sanitize({ email: "a@b.com", password: "bad", nested: { access_token: "secret", ok: 1 } });
  assert.equal(value.password, "[redacted]");
  assert.equal(value.nested.access_token, "[redacted]");
  assert.equal(value.nested.ok, 1);
});
