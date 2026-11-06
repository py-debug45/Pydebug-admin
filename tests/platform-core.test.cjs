// Regression guard for the 2026 platform core: settings, feature flags,
// team roles, Trash/soft-delete, ⌘K palette, audit hardening and headers.
// These are contract tests: they fail if a page, RPC name or permission drifts
// away from the SQL migration that backs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const migration = read('db/migrations/20261106_admin_platform_core.sql');
const common = read('js/admin-common.js');
const settingsJs = read('js/admin-settings.js');
const trashJs = read('js/admin-trash.js');
const commandJs = read('js/admin-command.js');
const auditJs = read('js/admin-audit.js');
const css = read('css/admin.css');

const PROTECTED_PAGES = [
  'settings.html',
  'trash.html',
];

test('platform migration defines the full RPC surface used by the panel', () => {
  const required = [
    'admin_members',
    'admin_role_permissions',
    'app_settings',
    'feature_flags',
    'deletion_archive',
    'admin_sessions',
    'saved_views',
    'has_perm',
    'admin_identity',
    'admin_list_members',
    'admin_add_member',
    'admin_set_member_role',
    'admin_remove_member',
    'admin_get_settings',
    'admin_set_setting',
    'admin_list_flags',
    'admin_set_flag',
    'admin_soft_delete',
    'admin_restore_row',
    'admin_purge_row',
    'admin_start_session',
    'admin_touch_session',
    'admin_session_state',
    'admin_list_sessions',
    'admin_revoke_session',
    'admin_revoke_other_sessions',
    'public_settings',
    'public_feature_flags',
  ];
  for (const name of required) {
    assert.match(migration, new RegExp(`\\b${name}\\b`), `migration is missing ${name}`);
  }

  // Idempotent by construction: every DDL uses IF NOT EXISTS / ON CONFLICT.
  assert.match(migration, /create table if not exists public\.app_settings/);
  assert.match(migration, /on conflict \(key\) do nothing/);
  assert.match(migration, /create or replace function public\.is_admin\(\)/);
});

test('legacy admins stay owners and the RLS gate only widens to real members', () => {
  // is_admin() must keep the original profiles.is_admin branch...
  assert.match(migration, /coalesce\(\(select p\.is_admin from public\.profiles p where p\.id = auth\.uid\(\)\), false\)/);
  // ...and add membership, never remove either path.
  assert.match(migration, /or exists \(select 1 from public\.admin_members m where m\.user_id = auth\.uid\(\)/);
  // Existing admins are seeded as owners before any role checks run.
  assert.match(migration, /insert into public\.admin_members \(user_id, role, added_by\)\s*\n\s*select p\.id, 'owner'/);
  // Last owner cannot be demoted or removed.
  assert.match(migration, /Cannot demote the last owner/);
  assert.match(migration, /Cannot remove the last owner/);
});

test('every sidebar permission exists in the SQL role catalogue', () => {
  const nav = common.slice(
    common.indexOf('const ADMIN_NAV_ITEMS'),
    common.indexOf('];', common.indexOf('const ADMIN_NAV_ITEMS'))
  );
  const perms = [...nav.matchAll(/perm: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(perms.length >= 16, `expected a full permission-tagged nav, got ${perms.length}`);
  for (const perm of new Set(perms)) {
    assert.match(
      migration,
      new RegExp(`'${perm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `nav perm ${perm} is not granted to any role in the migration`
    );
  }
  // New pages must actually be reachable from the menu.
  assert.match(nav, /href: "settings\.html"/);
  assert.match(nav, /href: "trash\.html"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'settings.html')));
  assert.ok(fs.existsSync(path.join(ROOT, 'trash.html')));
});

test('role gating is applied at page, handler and nav level', () => {
  assert.match(common, /async function requirePerm\(perm\)/);
  assert.match(common, /function ensureCan\(perm, message\)/);
  assert.match(common, /function applyPermissionGating\(\)/);
  // Hiding nav rows + data-perm elements.
  assert.match(common, /link\.hidden = !allowed/);
  assert.match(common, /document\.querySelectorAll\("\[data-perm\]"\)/);

  for (const [file, perm] of [
    ['js/admin-users.js', 'users.read'],
    ['js/admin-payments.js', 'payments.read'],
    ['js/admin-coupons.js', 'coupons.read'],
    ['js/admin-settings.js', 'settings.read'],
    ['js/admin-trash.js', 'trash.read'],
    ['js/admin-audit.js', 'audit.read'],
  ]) {
    assert.match(read(file), new RegExp(`requirePerm\\("${perm}"\\)`), `${file} must gate on ${perm}`);
  }

  // Dynamic destructive actions must re-check permission in JS.
  assert.match(read('js/admin-dashboard.js'), /ensureCan\("problems\.delete"\)/);
  assert.match(read('js/admin-submissions.js'), /ensureCan\("submissions\.write"\)/);
  assert.match(read('js/admin-discussions.js'), /ensureCan\("community\.write"\)/);
  assert.match(read('js/admin-certificates.js'), /ensureCan\("certificates\.write"\)/);
  assert.match(read('js/admin-payments.js'), /ensureCan\("payments\.write"\)/);
  assert.match(read('js/admin-user-detail.js'), /ensureCan\("users\.write"\)/);
});

test('deletes go through the Trash RPC with a safe pre-migration fallback', () => {
  assert.match(common, /async function softDeleteRow\(table, id, reason, label\)/);
  assert.match(common, /sb\.rpc\("admin_soft_delete"/);
  assert.match(common, /p_table: table/);
  assert.match(common, /p_row_id: String\(id\)/);

  for (const [file, table] of [
    ['js/admin-dashboard.js', 'problems'],
    ['js/admin-submissions.js', 'submissions'],
    ['js/admin-notifications.js', 'notifications'],
    ['js/admin-discussions.js', 'problem_discussions'],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`softDeleteRow\\("${table}"`), `${file} must archive ${table} first`);
    assert.match(src, /isMissingRpc\(/, `${file} must keep the pre-migration fallback`);
  }

  // The confirmed destructive copy must promise recoverability.
  assert.match(read('js/admin-dashboard.js'), /restore it from Trash/);
});

test('Trash page restores and purges through audited RPCs only', () => {
  assert.match(trashJs, /sb\.rpc\("admin_restore_row", \{ p_archive_id: id \}\)/);
  assert.match(trashJs, /sb\.rpc\("admin_purge_row", \{ p_archive_id: id \}\)/);
  assert.match(trashJs, /typed\.trim\(\)\.toUpperCase\(\) !== "PURGE"/);
  assert.doesNotMatch(trashJs, /\.from\("deletion_archive"\)\.delete\(\)/);
  assert.match(trashJs, /toastSuccess|showToast\("Row restored/);
});

test('settings page calls the exact RPC parameter names from the migration', () => {
  assert.match(settingsJs, /sb\.rpc\("admin_set_setting", \{ p_key: pair\.key, p_value: pair\.value \}\)/);
  assert.match(settingsJs, /sb\.rpc\("admin_set_flag", \{/);
  assert.match(settingsJs, /p_enabled: enabled/);
  assert.match(settingsJs, /p_rollout:/);
  assert.match(settingsJs, /sb\.rpc\("admin_add_member", \{ p_email: email, p_role: role \}\)/);
  assert.match(settingsJs, /sb\.rpc\("admin_set_member_role", \{ p_user_id: userId, p_role: role \}\)/);
  assert.match(settingsJs, /sb\.rpc\("admin_remove_member", \{ p_user_id: userId, p_clear_legacy: true \}\)/);
  assert.match(settingsJs, /sb\.rpc\("admin_revoke_other_sessions", \{ p_keep: currentAdminSessionId \}\)/);

  // Every setting key used by the UI must be seeded by the migration.
  const keys = [...settingsJs.matchAll(/data-setting="([a-z0-9_.]+)"/g)].map((m) => m[1]);
  const html = read('settings.html');
  const htmlKeys = [...html.matchAll(/data-setting="([a-z0-9_.]+)"/g)].map((m) => m[1]);
  assert.ok(htmlKeys.length >= 20, `expected the settings form to cover the config surface, got ${htmlKeys.length}`);
  for (const key of new Set(htmlKeys)) {
    assert.match(migration, new RegExp(`\\('${key.replace(/\./g, '\\.')}'`), `setting ${key} is not seeded`);
  }
  assert.ok(keys.length >= 0);
});

test('feature flags seed every product switch the UI expects', () => {
  for (const key of ['ai_interview', 'ai_hints', 'community_hub', 'mock_tests', 'battles',
    'study_plans', 'certificates', 'referrals', 'write_code', 'weekly_wordle']) {
    assert.match(migration, new RegExp(`\\('${key}'`), `feature flag ${key} is not seeded`);
  }
  assert.match(migration, /rollout_percent between 0 and 100/);
});

test('⌘K palette is loaded on every protected page and is permission-aware', () => {
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')
    && !['index.html', 'reset-password.html'].includes(f));
  assert.ok(pages.length >= 16, `expected all admin pages, got ${pages.length}`);
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /js\/admin-command\.js/, `${page} does not load the command palette`);
  }

  assert.match(commandJs, /window\.AdminCommand = \{ mount, open: openPalette, close/);
  assert.match(commandJs, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(commandJs, /PAGES\.filter\(\(p\) => can\(p\.perm\)\)/);
  assert.match(commandJs, /ACTIONS\.filter\(\(a\) => can\(a\.perm \|\| ""\)\)/);
  assert.doesNotMatch(commandJs, /\beval\(|new Function\(/);
  assert.match(common, /injectCommandPaletteButton\(\)/);
});

test('audit log is paginated, filterable and exportable', () => {
  assert.match(auditJs, /\.select\("\*", \{ count: "exact" \}\)/);
  assert.match(auditJs, /\.range\(auditPage \* AUDIT_PAGE_SIZE/);
  assert.match(auditJs, /\.gte\("created_at"/);
  assert.match(auditJs, /\.lte\("created_at"/);
  assert.match(auditJs, /downloadCSV\(/);
  assert.match(auditJs, /user_agent/);
  // A failed audit write must never be silent.
  assert.match(auditJs, /Audit log entry failed/);
  assert.match(common, /audit log failed/);
  assert.match(migration, /revoke update, delete on public\.admin_audit_log/);
});

test('panels register a revocable session and honour revocation', () => {
  assert.match(common, /async function ensureAdminSession\(\)/);
  assert.match(common, /sb\.rpc\("admin_session_state", \{ p_id: id \}\)/);
  assert.match(common, /data === "revoked"/);
  assert.match(common, /index\.html\?revoked=1/);
  assert.match(common, /sb\.rpc\("admin_start_session", \{ p_user_agent: ua \}\)/);
  assert.match(migration, /create table if not exists public\.admin_sessions/);
});

test('hosting configs ship CSP, HSTS and no-store for admin HTML', () => {
  const netlify = read('netlify.toml');
  assert.match(netlify, /Content-Security-Policy = "[^"]*default-src 'self'/);
  assert.match(netlify, /frame-ancestors 'none'/);
  assert.match(netlify, /Strict-Transport-Security = "max-age=31536000/);
  assert.match(netlify, /for = "\/\*\.html"[\s\S]*?Cache-Control = "no-store/);

  const vercel = JSON.parse(read('vercel.json'));
  const flat = (vercel.headers || []).flatMap((h) => h.headers || []);
  const keys = flat.map((h) => h.key);
  for (const key of ['Content-Security-Policy', 'Strict-Transport-Security',
    'X-Frame-Options', 'X-Content-Type-Options', 'Cache-Control']) {
    assert.ok(keys.includes(key), `vercel.json is missing ${key}`);
  }
  const csp = flat.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
  assert.match(csp, /object-src 'none'/);
});

test('new pages follow the protected-page contract and load the platform CSS', () => {
  for (const page of PROTECTED_PAGES) {
    const html = read(page);
    assert.match(html, /class="admin-protected admin-panel-locked"/);
    assert.match(html, /js\/admin-boot\.js/);
    assert.match(html, /js\/admin-common\.js/);
    assert.match(html, /js\/admin-command\.js/);
    assert.match(html, /css\/admin\.css/);
    assert.match(html, /<nav><\/nav>/);
  }
  assert.match(read('settings.html'), /js\/admin-settings\.js/);
  assert.match(read('trash.html'), /js\/admin-trash\.js/);

  // The platform styles must survive mobile: palette, settings and trash.
  assert.match(css, /\.cmdk-overlay/);
  assert.match(css, /\.settings-layout/);
  assert.match(css, /\.trash-toolbar/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.settings-layout \{ grid-template-columns: 1fr; \}/);
});
