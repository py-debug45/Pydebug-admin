// tests/dom.test.js — headless smoke test: loads every admin page in jsdom against a fake Supabase
// backend and asserts the UI renders correctly with no runtime errors.
const fs = require("fs");
const path = require("path");
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (err) {
  console.log("SKIP: jsdom is not installed. Run `npm install --no-save jsdom` first.");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------- fake DB --
function makeDb() {
  return {
    profiles: [
      { id: "11111111-1111-1111-1111-111111111111", email: "admin@example.com", full_name: "Root Admin", is_admin: true, is_premium: true, premium_expires_at: null, xp: 10, created_at: "2024-01-01" },
      { id: "22222222-2222-2222-2222-222222222222", email: "bob@example.com", full_name: "<img src=x onerror=alert(1)>", is_admin: false, is_premium: true, premium_expires_at: "2000-01-01T00:00:00Z", xp: 5, created_at: "2024-01-02" },
      { id: "33333333-3333-3333-3333-333333333333", email: "carol@example.com", full_name: "Carol", is_admin: false, is_premium: false, premium_expires_at: null, xp: 0, created_at: "2024-01-03" },
    ],
    problems: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Off-by-one <b>loop</b>", type: "bug", difficulty: "easy", topic: "loops", is_premium: false, starter_code: "x", solution_code: "y", expected_output: "z", hints: ["h1"], created_at: "2024-02-01" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Predict this", type: "question", difficulty: "hard", topic: null, is_premium: true, starter_code: "x", solution_code: "", expected_output: "z", hints: null, created_at: "2024-02-02" },
    ],
    payments: [
      { amount_paise: 19900, status: "paid" },
      { amount_paise: 49900, status: "failed" },
      { amount_paise: null, status: "paid" },
    ],
  };
}

function makeSupabaseStub(db, sessionUserId) {
  const filters = [];
  function builder(table) {
    const state = { table, ops: [], count: null, head: false, range: null, single: false };
    const api = {
      select(_cols, opts) { if (opts && opts.count) state.count = opts.count; if (opts && opts.head) state.head = true; return api; },
      eq(col, val) { state.ops.push((r) => r[col] == val); return api; }, // eslint-disable-line eqeqeq -- PostgREST coerces types server-side
      is(col, val) { state.ops.push((r) => r[col] === val); return api; },
      gte(col, val) { state.ops.push((r) => r[col] != null && r[col] >= val); return api; },
      ilike(col, pattern) {
        const body = pattern.replace(/^%|%$/g, "");
        state.ops.push((r) => String(r[col] ?? "").toLowerCase().includes(body.replace(/\\(.)/g, "$1").toLowerCase()));
        return api;
      },
      order() { return api; },
      range(from, to) { state.range = [from, to]; return api; },
      single() { state.single = true; return api; },
      update(vals) { state.update = vals; return api; },
      insert(vals) { state.insert = vals; return api; },
      delete() { state.del = true; return api; },
      then(resolve) { return Promise.resolve(run()).then(resolve); },
    };
    function run() {
      let rows = (db[state.table] || []).filter((r) => state.ops.every((f) => f(r)));
      if (state.insert) { const row = { id: "new-id", ...state.insert }; db[state.table].push(row); return { data: [row], error: null }; }
      if (state.update) { rows.forEach((r) => Object.assign(r, state.update)); return { data: rows.map((r) => ({ id: r.id })), error: null }; }
      if (state.del) { db[state.table] = db[state.table].filter((r) => !rows.includes(r)); return { data: rows.map((r) => ({ id: r.id })), error: null }; }
      const total = rows.length;
      if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
      if (state.single) {
        if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: "no rows" } };
        return { data: rows[0], error: null };
      }
      return { data: state.head ? null : rows, error: null, count: state.count ? total : null };
    }
    return api;
  }
  return {
    createClient: () => ({
      from: (t) => builder(t),
      auth: {
        getSession: async () => ({ data: { session: sessionUserId ? { user: { id: sessionUserId, email: "admin@example.com" } } : null } }),
        getUser: async () => ({ data: { user: { id: sessionUserId } } }),
        signInWithPassword: async () => ({ data: { user: { id: sessionUserId } }, error: null }),
        signOut: async () => ({ error: null }),
      },
    }),
  };
}

// ------------------------------------------------------------- test rig ---
// Newer jsdom dropped ResourceLoader, so inline the local scripts by hand and
// drop the CDN tag (window.supabase is stubbed in beforeParse instead).
function inlineScripts(html) {
  return html
    .replace(/<script src="https:\/\/[^"]+"><\/script>\s*/g, "")
    .replace(/<script src="([^"]+)"><\/script>/g, (_m, src) => {
      // A "</script>" inside a JS comment would close the tag early.
      const code = fs.readFileSync(path.join(ROOT, src), "utf8").replace(/<\/script/gi, "<\\/script");
      return "<script>" + code + "</scr" + "ipt>";
    });
}

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log("  pass  " + name);
  else { failures++; console.log("  FAIL  " + name + (extra ? " — " + extra : "")); }
};

async function loadPage(file, { db, sessionUserId = "11111111-1111-1111-1111-111111111111", search = "" } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(inlineScripts(fs.readFileSync(path.join(ROOT, file), "utf8")), {
    url: "https://admin.test/" + file + search,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.supabase = makeSupabaseStub(db, sessionUserId);
      window.confirm = () => true;
      window.alert = () => { throw new Error("alert() fired — XSS!"); };
      const origAssign = Object.getOwnPropertyDescriptor(window, "location");
      window.__navigations = [];
      // jsdom "Not implemented: navigation" noise -> record instead
      window.__origHref = window.location.href;
    },
  });

  await new Promise((r) => dom.window.addEventListener("load", r, { once: true }));
  await new Promise((r) => setTimeout(r, 250)); // let async DOMContentLoaded work settle
  return { dom, doc: dom.window.document, errors: errors.filter((e) => !/Not implemented: navigation/i.test(e)) };
}

(async () => {
  console.log("\n--- dashboard.html (admin session) ---");
  {
    const db = makeDb();
    const { doc, errors } = await loadPage("dashboard.html", { db });
    const rows = [...doc.querySelectorAll("#problems-tbody tr")];
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("renders one row per problem", rows.length === 2, "got " + rows.length);
    check("admin name filled", doc.getElementById("admin-name").textContent === "Root Admin");
    check("total users stat", doc.getElementById("stat-total-users").textContent === "3");
    check("premium users stat excludes expired", doc.getElementById("stat-premium-users").textContent === "1");
    check("total problems stat", doc.getElementById("stat-total-problems").textContent === "2");
    check("premium problems stat", doc.getElementById("stat-premium-problems").textContent === "1");
    check("revenue counts only successful + ignores null amount", doc.getElementById("stat-revenue").textContent === "₹199");
    check("title with markup is escaped (no injected element)", rows[0].querySelector("b") === null);
    check("title text preserved literally", rows[0].children[0].textContent === "Off-by-one <b>loop</b>");
    check("null topic shows dash", rows[1].children[3].textContent === "-");
    check("difficulty class whitelisted", rows[1].querySelector(".diff--hard") !== null);
    check("edit link points at the row id", rows[0].querySelector("a").getAttribute("href").includes("aaaaaaaa"));
  }

  console.log("\n--- dashboard.html (delete flow) ---");
  {
    const db = makeDb();
    const { dom, doc, errors } = await loadPage("dashboard.html", { db });
    doc.querySelectorAll("#problems-tbody tr")[0].querySelector("button").click();
    await new Promise((r) => setTimeout(r, 250));
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("row removed from DB", db.problems.length === 1);
    check("table re-rendered with 1 row", doc.querySelectorAll("#problems-tbody tr").length === 1);
    check("success toast shown", /deleted/i.test(doc.getElementById("app-toast").textContent));
  }

  console.log("\n--- dashboard.html (search escaping) ---");
  {
    const db = makeDb();
    db.problems.push({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", title: "50% discount bug", type: "bug", difficulty: "easy", topic: "math", is_premium: false, created_at: "2024-03-01" });
    const { dom, doc, errors } = await loadPage("dashboard.html", { db });
    const input = doc.getElementById("admin-search");
    input.value = "50%";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...doc.querySelectorAll("#problems-tbody tr")];
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("wildcard search matches literally", rows.length === 1 && /50% discount/.test(rows[0].textContent), rows.map(r=>r.textContent).join("/"));
  }

  console.log("\n--- dashboard.html (regression: last row of page 2 deleted) ---");
  {
    const db = makeDb();
    db.problems = Array.from({ length: 51 }, (_, i) => ({
      id: `p${i}`, title: `Problem ${i}`, type: "bug", difficulty: "easy",
      topic: "t", is_premium: false, created_at: "2024-01-01",
    }));
    const { dom, doc, errors } = await loadPage("dashboard.html", { db });
    check("page 1 shows a full page of 50", doc.querySelectorAll("#problems-tbody tr").length === 50);

    // Go to page 2 (which holds exactly one row) and delete that row.
    const nextBtn = [...doc.querySelectorAll("#problems-pagination button")].find((b) => /Next/.test(b.textContent));
    check("Next button rendered", !!nextBtn);
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 250));
    check("page 2 shows the single remaining row", doc.querySelectorAll("#problems-tbody tr").length === 1);

    doc.querySelector("#problems-tbody tr button").click();
    await new Promise((r) => setTimeout(r, 300));
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("50 problems left in DB", db.problems.length === 50);
    // The old code left you stranded on an empty page 2.
    const rowsAfter = [...doc.querySelectorAll("#problems-tbody tr")];
    check("auto-fell back to page 1 with rows (was: stuck on an empty page)",
      rowsAfter.length === 50, "got " + rowsAfter.length + " rows: " + rowsAfter.map((r) => r.textContent).join("|").slice(0, 80));
  }

  console.log("\n--- users.html ---");
  {
    const db = makeDb();
    const { doc, errors } = await loadPage("users.html", { db });
    const rows = [...doc.querySelectorAll("#users-tbody tr")];
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("renders one row per user", rows.length === 3, "got " + rows.length);
    check("XSS name not executed", rows[1].querySelector("img") === null);
    check("expired premium labelled", rows[1].querySelector(".tag--expired") !== null);
    check("expired user offered Grant (not Revoke)", /Grant Premium/.test(rows[1].querySelector("button").textContent));
    check("active premium admin offered Revoke", /Revoke Premium/.test(rows[0].querySelector("button").textContent));
    check("current admin marked as (you)", /\(you\)/.test(rows[0].children[4].textContent));

    rows[2].querySelector("button").click();
    await new Promise((r) => setTimeout(r, 250));
    check("grant premium persisted", db.profiles[2].is_premium === true);
    check("table shows Premium after grant", doc.querySelectorAll("#users-tbody tr")[2].querySelector(".tag--premium") !== null);
  }

  console.log("\n--- problem-form.html (new) ---");
  {
    const db = makeDb();
    const { doc, errors } = await loadPage("problem-form.html", { db });
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("heading says Add", doc.getElementById("form-title").textContent === "Add New Problem");
    check("solution field visible for default 'bug' type", doc.getElementById("solution-code-field").hidden === false);
    check("one empty hint row rendered", doc.querySelectorAll(".hint-input-row").length === 1);
  }

  console.log("\n--- problem-form.html (type switch hides solution field) ---");
  {
    const db = makeDb();
    const { dom, doc, errors } = await loadPage("problem-form.html", { db });
    const typeEl = doc.getElementById("problem-type");
    typeEl.value = "question";
    typeEl.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("solution field hidden for 'question'", doc.getElementById("solution-code-field").hidden === true);
    typeEl.value = "bug";
    typeEl.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    check("solution field shown again for 'bug'", doc.getElementById("solution-code-field").hidden === false);
  }

  console.log("\n--- problem-form.html (edit existing) ---");
  {
    const db = makeDb();
    const { doc, errors } = await loadPage("problem-form.html", { db, search: "?id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("heading says Edit", doc.getElementById("form-title").textContent === "Edit Problem");
    check("title prefilled", doc.getElementById("problem-title-input").value === "Off-by-one <b>loop</b>");
    check("difficulty prefilled", doc.getElementById("problem-difficulty-input").value === "easy");
    check("hints prefilled", doc.querySelector(".hint-input").value === "h1");
  }

  console.log("\n--- problem-form.html (integer id schema) ---");
  {
    const db = makeDb();
    db.problems[0].id = 7;
    const { doc, errors } = await loadPage("problem-form.html", { db, search: "?id=7" });
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("integer id loads in Edit mode (was rejected before)", doc.getElementById("form-title").textContent === "Edit Problem");
    check("title prefilled from integer-id row", doc.getElementById("problem-title-input").value === "Off-by-one <b>loop</b>");
  }

  console.log("\n--- problem-form.html (null hints don't crash) ---");
  {
    const db = makeDb();
    const { doc, errors } = await loadPage("problem-form.html", { db, search: "?id=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("null hints -> one blank row", doc.querySelectorAll(".hint-input-row").length === 1);
    check("solution field hidden for question-type row", doc.getElementById("solution-code-field").hidden === true);
  }

  console.log("\n--- index.html (login page, no session) ---");
  {
    const db = makeDb();
    const { doc, errors } = await loadPage("index.html", { db, sessionUserId: null });
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("login form present", doc.getElementById("admin-login-form") !== null);
    check("password toggle wired", doc.querySelector("[data-toggle-password]") !== null);
  }

  console.log("\n--- index.html (?denied=1 shows toast) ---");
  {
    const db = makeDb();
    const { doc, errors } = await loadPage("index.html", { db, sessionUserId: null, search: "?denied=1" });
    check("no runtime errors", errors.length === 0, errors.join(" | "));
    check("denied toast rendered", /admin access/i.test(doc.getElementById("app-toast").textContent));
    check("query flag stripped from URL", !doc.defaultView.location.search.includes("denied"));
  }

  console.log(failures === 0 ? "\n✅ ALL BROWSER SMOKE TESTS PASSED" : `\n❌ ${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})();
