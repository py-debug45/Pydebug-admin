// tests/logic.test.js — zero-dependency unit tests for the pure helper
// functions in js/. Run with:  node tests/logic.test.js

// Extract & exercise the pure helper logic from the source files.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const ctx = { console, document: undefined, window: undefined, Number, String, Math, Date, JSON };
vm.createContext(ctx);

const common = read("js/admin-common.js")
  .replace(/document\.addEventListener[\s\S]*$/, "");
vm.runInContext(common, ctx);

const utils = read("js/utils.js")
  .replace(/document\.addEventListener[\s\S]*$/, "");
vm.runInContext(utils, ctx);

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
};

// --- isPastLastPage: the bug that stranded admins on an empty page ---------
eq("page2 empty after deleting its last row -> go back", ctx.isPastLastPage(50, 50, 1), true);
eq("page1 empty table -> stay", ctx.isPastLastPage(0, 0, 0), false);
eq("page0 never goes back", ctx.isPastLastPage(0, 0, 0), false);
eq("page1 still has rows -> stay", ctx.isPastLastPage(80, 50, 1), false);
eq("null count -> stay", ctx.isPastLastPage(null, 50, 1), false);

// --- escapeLikePattern: search strings with wildcards ----------------------
eq("percent escaped", ctx.escapeLikePattern("50% off"), "50\\% off");
eq("underscore escaped", ctx.escapeLikePattern("a_b"), "a\\_b");
eq("backslash escaped", ctx.escapeLikePattern("a\\b"), "a\\\\b");
eq("contains wraps", ctx.likeContains("loop"), "%loop%");

// --- isPremiumUser: expiry awareness --------------------------------------
const future = new Date(Date.now() + 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();
eq("lifetime premium", ctx.isPremiumUser({ is_premium: true, premium_expires_at: null }), true);
eq("active premium", ctx.isPremiumUser({ is_premium: true, premium_expires_at: future }), true);
eq("expired premium", ctx.isPremiumUser({ is_premium: true, premium_expires_at: past }), false);
eq("free user", ctx.isPremiumUser({ is_premium: false }), false);
eq("garbage expiry treated as lifetime", ctx.isPremiumUser({ is_premium: true, premium_expires_at: "not-a-date" }), true);
eq("null profile", ctx.isPremiumUser(null), false);

// --- errorText ------------------------------------------------------------
eq("supabase error", ctx.errorText({ message: "boom" }), "boom");
eq("thrown error", ctx.errorText(new Error("net down")), "net down");
eq("null error", ctx.errorText(null), "Unknown error");

// --- problem id validation ------------------------------------------------
const formSrc = read("js/admin-problem-form.js");
const idCtx = {};
vm.createContext(idCtx);
vm.runInContext(formSrc.match(/const UUID_RE[\s\S]*?^}/m)[0], idCtx);
eq("uuid id accepted", idCtx.isValidProblemId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), true);
eq("integer id accepted (bigserial schemas)", idCtx.isValidProblemId("42"), true);
eq("junk id rejected", idCtx.isValidProblemId("abc"), false);
eq("injection-ish id rejected", idCtx.isValidProblemId("1 or 1=1"), false);

// --- hints normalisation --------------------------------------------------
const hintsCtx = { JSON, Array, String };
vm.createContext(hintsCtx);
vm.runInContext(formSrc.match(/function normaliseHints[\s\S]*?^}/m)[0], hintsCtx);
eq("array hints", hintsCtx.normaliseHints(["a", "b"]), ["a", "b"]);
eq("json-string hints", hintsCtx.normaliseHints('["a","b"]'), ["a", "b"]);
eq("plain-string hint", hintsCtx.normaliseHints("just one"), ["just one"]);
eq("null hints", hintsCtx.normaliseHints(null), []);

console.log(fails === 0 ? "\nALL LOGIC TESTS PASSED" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
