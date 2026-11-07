const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the saved-views module is wired into Trash and Audit', () => {
  for (const page of ['trash.html', 'audit.html']) {
    const html = read(page);
    assert.match(html, /js\/admin-saved-views\.js/, `${page} must load the module`);
    assert.match(html, /id="saved-view-select"/, `${page} needs the dropdown`);
    assert.match(html, /id="saved-view-save"/, `${page} needs the save button`);
    assert.match(html, /id="saved-view-delete"/, `${page} needs the delete button`);
  }

  const mod = read('js/admin-saved-views.js');
  assert.match(mod, /window\.AdminSavedViews\s*=/, 'module must expose AdminSavedViews');
  assert.match(mod, /from\(TABLE\)/, 'module must read/write the saved_views table');
  assert.match(mod, /admin_id: me/, 'new views must be owned by the signed-in admin');

  for (const script of ['js/admin-trash.js', 'js/admin-audit.js']) {
    assert.match(read(script), /AdminSavedViews\.init\(/, `${script} must initialise saved views`);
  }
});

test('saved views are writable by the panel but scoped to the author', () => {
  const sql = read('db/migrations/20261107_saved_views_ui.sql');
  assert.match(sql, /grant select, insert, update, delete on public\.saved_views to authenticated/i);
  assert.match(sql, /for insert to authenticated[\s\S]*admin_id = auth\.uid\(\)/i);
  assert.match(sql, /for delete to authenticated[\s\S]*using \(admin_id = auth\.uid\(\)\)/i);
  assert.doesNotMatch(sql, /grant[\s\S]*public\.saved_views to anon/i);
});
