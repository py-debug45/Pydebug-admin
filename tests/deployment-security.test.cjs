const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const netlify = fs.readFileSync('netlify.toml', 'utf8');
const headers = Object.fromEntries(vercel.headers[0].headers.map(({ key, value }) => [key, value]));
const csp = headers['Content-Security-Policy'];

test('Vercel and Netlify use the same restrictive CSP and transport headers', () => {
  assert.ok(csp);
  assert.ok(netlify.includes(`Content-Security-Policy = "${csp}"`));
  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000');
  assert.match(netlify, /Strict-Transport-Security = "max-age=31536000"/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  const script = csp.match(/script-src ([^;]+)/)[1];
  assert.doesNotMatch(script, /unsafe-inline|unsafe-eval|\*/);
  assert.match(script, /@supabase\/supabase-js@2\.117\.2/);
  assert.match(csp, /connect-src[^;]*https:\/\/cztosbchfqtyzxkhfrby\.supabase\.co/);
  assert.match(csp, /connect-src[^;]*wss:\/\/cztosbchfqtyzxkhfrby\.supabase\.co/);
});

test('login recovery script requires an explicit target and does not set a password by default', () => {
  const sql = fs.readFileSync('supabase-admin-login-fix.sql', 'utf8');
  const config = sql.slice(sql.indexOf('insert into _pydebug_login_fix_cfg'), sql.indexOf('-- Do not show these rows'));
  assert.match(config, /replace-with-admin@example\.invalid/);
  assert.match(config, /''\s+-- blank keeps the current password/);
  assert.match(config, /raise exception/);
  assert.match(sql, /drop table if exists pg_temp\._pydebug_login_fix_cfg/);
  const setup = fs.readFileSync('supabase-admin-setup.sql', 'utf8');
  assert.doesNotMatch(setup, /crypt\('imtiyaj khan 9329'/i);
  assert.doesNotMatch(sql, /crypt\('imtiyaj khan 9329'/i);
  const loginHtml = fs.readFileSync('index.html', 'utf8');
  assert.doesNotMatch(loginHtml, /imtiyaj khan 9329/i);
  assert.match(loginHtml, /not server-enforced MFA/i);
});
