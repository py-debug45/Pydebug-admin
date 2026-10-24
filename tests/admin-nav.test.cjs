// Regression guard for the admin sidebar / mobile drawer.
// The panel's menu is injected by js/admin-common.js, so a typo in that list
// (or an icon name that does not exist) shows up as a blank or emoji row on
// every page — this test keeps the canonical menu honest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const common = fs.readFileSync(path.join(ROOT, 'js', 'admin-common.js'), 'utf8');
const icons = fs.readFileSync(path.join(ROOT, 'js', 'admin-icons.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');

const navSource = common.slice(
  common.indexOf('const ADMIN_NAV_ITEMS'),
  common.indexOf('];', common.indexOf('const ADMIN_NAV_ITEMS'))
);

const entries = [...navSource.matchAll(/href: "([^"]+)", label: "([^"]+)", icon: "([^"]+)"/g)]
  .map(([, href, label, icon]) => ({ href, label, icon }));

test('every admin page is in the canonical sidebar exactly once', () => {
  assert.ok(entries.length >= 14, `expected the full workspace nav, got ${entries.length}`);
  const hrefs = entries.map((e) => e.href);
  assert.equal(new Set(hrefs).size, hrefs.length, 'duplicate href in ADMIN_NAV_ITEMS');
  for (const page of [
    'dashboard.html', 'insights.html', 'certificates.html', 'arenas.html',
    'community.html', 'submissions.html', 'payments.html', 'coupons.html',
    'discussions.html', 'notifications.html', 'ai.html', 'audit.html',
    'problem-form.html', 'users.html',
  ]) {
    assert.ok(hrefs.includes(page), `sidebar is missing ${page}`);
    assert.ok(fs.existsSync(path.join(ROOT, page)), `${page} does not exist`);
  }
});

test('sidebar labels are plain text — no emoji or text glyphs mixed into the menu', () => {
  // ▥ ◈ ✦ ⚔ </> ₹ ◌ and friends rendered at wildly different sizes next to
  // full-colour emoji; each row now uses an SVG icon from admin-icons.js.
  assert.doesNotMatch(navSource, /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}]/u);
  for (const entry of entries) {
    assert.match(entry.label, /^[\x20-\x7E]+$/, `${entry.href} label must be ASCII text`);
  }
});

test('every sidebar icon name exists in the SVG icon set', () => {
  for (const entry of entries) {
    assert.match(
      icons,
      new RegExp(`\\b${entry.icon}: *['"]<`),
      `icon "${entry.icon}" for ${entry.href} is not defined in admin-icons.js`
    );
  }
  // Rows are rendered as icon + label span so long names ellipsize.
  assert.match(common, /class="admin-nav-label"/);
  assert.match(common, /window\.adminIcon\(item\.icon/);
});

test('mobile drawer keeps its own header, close control and scrolling link list', () => {
  assert.match(common, /className = "admin-sidebar__close"/, 'drawer needs an in-drawer close button');
  assert.match(common, /className = "admin-sidebar__head"/, 'drawer needs a pinned header');
  assert.match(common, /closeBtn\.addEventListener\("click", \(\) => setOpen\(false\)\)/);

  // Only the nav may scroll; header + account row stay reachable.
  const mobile = css.slice(css.indexOf('@media (max-width: 860px)'));
  assert.match(mobile, /\.admin-sidebar \{[\s\S]*?overflow: hidden;/, 'drawer itself must not scroll');
  assert.match(mobile, /\.admin-sidebar nav \{[\s\S]*?overflow-y: auto;/, 'link list must scroll');
  assert.match(mobile, /\.admin-sidebar__quick \{ display: none; \}/, 'quick tools already live in the top bar on phones');
  assert.match(mobile, /body\.admin-nav-open \.admin-mobile-menu \{[^}]*visibility: hidden/,
    'floating hamburger must step aside while the drawer is open');
});
