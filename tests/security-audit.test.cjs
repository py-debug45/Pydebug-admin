const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walkClientFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git') || entry.name === 'node_modules' || entry.name === '_site' || entry.name === 'tests') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkClientFiles(full, out);
    } else if (/\.(html|js|mjs|cjs|css|json)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('zero private keys or service_role secrets exist in any frontend HTML/JS/CSS file', () => {
  const files = walkClientFiles(ROOT);
  assert.ok(files.length > 20, 'Expected to scan client bundle files');

  const forbiddenPatterns = [
    { name: 'SUPABASE_SERVICE_ROLE_KEY', re: /SUPABASE_SERVICE_ROLE_KEY/i },
    { name: 'RAZORPAY_KEY_SECRET', re: /RAZORPAY_KEY_SECRET/i },
    { name: 'VAPID_PRIVATE_KEY', re: /VAPID_PRIVATE_KEY/i },
    { name: 'RESEND_API_KEY', re: /RESEND_API_KEY/i },
    { name: 'Supabase secret key (sb_secret_)', re: /\bsb_secret_[A-Za-z0-9_-]+/ },
    { name: 'Resend live key (re_)', re: /\bre_[A-Za-z0-9_]{20,}/ },
    { name: 'Exposed NEXT_PUBLIC_ secret', re: /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE)/i },
    { name: 'Exposed VITE_ secret', re: /VITE_[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE)/i },
  ];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, 'utf8');

    for (const { name, re } of forbiddenPatterns) {
      assert.doesNotMatch(content, re, `Forbidden secret pattern "${name}" found in ${rel}`);
    }

    // Decode every JWT-shaped string in client files and guarantee role !== 'service_role'
    for (const m of content.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
      const payloadJson = Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);
      assert.notEqual(
        payload.role,
        'service_role',
        `CRITICAL: service_role JWT found in ${rel}`
      );
      assert.equal(payload.role, 'anon', `Expected only anon JWT in ${rel}`);
    }
  }
});

test('all protected admin pages verify Supabase JWT session and profiles.is_admin === true', () => {
  const commonJs = fs.readFileSync(path.join(ROOT, 'js', 'admin-common.js'), 'utf8');
  assert.match(commonJs, /sb\.auth\.getSession\(\)/, 'Expected Supabase JWT session check in requireAdmin');
  assert.match(commonJs, /profile\.is_admin\s*===\s*true/, 'Expected strict profiles.is_admin === true check in requireAdmin');

  const publicAuthPages = new Set(['index.html', 'reset-password.html']);
  const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && !publicAuthPages.has(f));
  assert.ok(htmlFiles.length >= 14);

  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8');
    assert.match(html, /admin-protected/, `${htmlFile} must carry admin-protected body class`);
    assert.match(html, /js\/admin-boot\.js/, `${htmlFile} must load admin-boot.js lock screen guard`);
    assert.match(html, /js\/admin-common\.js/, `${htmlFile} must load admin-common.js`);
  }
});

test('hosting configs block public static access to .env*, .sql, and .md files', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(vercel.outputDirectory, '_site');
  assert.match(vercel.buildCommand, /cp \*\.html _site\//);
  assert.doesNotMatch(vercel.buildCommand, /\.sql|\.md|\.env/);

  const rewriteSources = (vercel.rewrites || []).map((r) => r.source).join('\n');
  assert.match(rewriteSources, /\.env/);
  assert.match(rewriteSources, /\.sql/);
  assert.match(rewriteSources, /\.md/);

  const vercelIgnore = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8');
  assert.match(vercelIgnore, /^\.env$/m);
  assert.match(vercelIgnore, /^\*\.sql$/m);
  assert.match(vercelIgnore, /^\*\.md$/m);

  const netlify = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(netlify, /publish\s*=\s*"_site"/);
  assert.match(netlify, /from\s*=\s*"\/\.env\*"[\s\S]*?status\s*=\s*404/);
  assert.match(netlify, /from\s*=\s*"\/\*\.sql"[\s\S]*?status\s*=\s*404/);
  assert.match(netlify, /from\s*=\s*"\/\*\.md"[\s\S]*?status\s*=\s*404/);

  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
});

test('Founder Quick Tools expose all four 1-tap external pydebug.in studio links', () => {
  const commonJs = fs.readFileSync(path.join(ROOT, 'js', 'admin-common.js'), 'utf8');
  assert.match(commonJs, /https:\/\/pydebug\.in\/reel-studio/);
  assert.match(commonJs, /Open 9:16 Reel & DM Studio/);
  assert.match(commonJs, /https:\/\/pydebug\.in\/today/);
  assert.match(commonJs, /Today's Wordle Challenge/);
  assert.match(commonJs, /https:\/\/pydebug\.in\/mock-test/);
  assert.match(commonJs, /Live Mock Test/);
  assert.match(commonJs, /https:\/\/pydebug\.in\/leaderboard/);
  assert.match(commonJs, /Campus Leaderboard/);
});
