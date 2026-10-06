"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { can, assertCan, maskEmail } = require("../lib/server/permissions");

test("content editor is forbidden from payment reads and mutations", async () => {
  assert.equal(can("content_editor", "payments", "read"), false);
  assert.equal(can("content_editor", "payments", "manual_grant"), false);
  assert.throws(
    () => assertCan({ role: "content_editor" }, "payments", "read"),
    (error) => error.status === 403 && error.code === "forbidden",
  );
  const { payments } = require("../api/read")._internals;
  await assert.rejects(
    payments({ admin_id: "editor-1", role: "content_editor" }, {}),
    (error) => error.status === 403 && error.code === "forbidden",
  );
});

test("content editor can fully manage problems", () => {
  for (const action of ["read", "create", "edit", "duplicate", "archive"]) {
    assert.equal(can("content_editor", "problems", action), true, action);
  }
  assert.equal(can("content_editor", "problems", "delete"), true);
});

test("analyst is read-only and receives a masked email", () => {
  assert.equal(can("analyst", "reports", "read"), true);
  assert.equal(can("analyst", "settings", "edit"), false);
  assert.equal(maskEmail("alice@gmail.com"), "a***@gmail.com");
});

test("support actions and superadmin settings follow the role matrix", () => {
  assert.equal(can("support", "users", "grant_premium"), true);
  assert.equal(can("support", "users", "delete"), false);
  assert.equal(can("support", "push", "test_send"), true);
  assert.equal(can("superadmin", "settings", "edit"), true);
});
