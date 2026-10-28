// Optional end-to-end mobile/CSP test; no live Supabase requests are made.
// npm install --no-save --no-package-lock --ignore-scripts @sparticuz/chromium@143.0.0 playwright-core@1.58.1
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium, playwright;
try { chromium = require('@sparticuz/chromium'); playwright = require('playwright-core'); } catch (_) {}
const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const policy = config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;

// The actual HTML, CSS and app JS are loaded; only the SDK/network is stubbed.
const sdkStub = `
window.__rpcCalls = [];
window.__mode = 'fail';
window.supabase = { createClient: function () {
  const user = { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email:'admin@example.test' };
  class Query {
    constructor(table) { this.table = table; }
    select() { return this; } order() { return this; } limit() { return this; }
    in() { return this; } eq() { return this; } range() { return this; }
    insert() { return this; } delete() { return this; }
    maybeSingle() { return Promise.resolve({ data: { id:user.id, is_admin:true, email:user.email }, error:null }); }
    then(resolve, reject) { return Promise.resolve({ data:[], error:null, count:0 }).then(resolve, reject); }
  }
  return {
    auth: {
      getSession: async () => ({ data:{ session: location.pathname.endsWith('/index.html') ? null : { user } }, error:null }),
      getUser: async () => ({ data:{ user }, error:null }), signOut: async () => ({error:null}),
      signInWithPassword: async () => ({ data:{ user:null, session:null }, error:{ code:'invalid_credentials', message:'Invalid login credentials' } })
    },
    from: (table) => new Query(table),
    rpc: async (name, args) => {
      if (name !== 'admin_send_broadcast') return {data:true,error:null};
      window.__rpcCalls.push(args);
      if (window.__mode === 'fail') return { data:null, error:{ message:'Connection lost' } };
      return { data:{ recipients:2, web_push_enabled:args.p_web_push, already_processed:true }, error:null };
    }
  };
} };
`;

test('mobile notification broadcast works under the production CSP', {
  skip: (!chromium || !playwright) && 'Install optional Chromium and Playwright dependencies (see test header)',
}, async (t) => {
  // The packaged Chromium carries NSS libraries for minimal Linux images.
  // Extract them even outside Lambda, where those libraries may be absent.
  const entry = require.resolve('@sparticuz/chromium');
  const { inflate } = require(path.join(path.dirname(entry), 'lambdafs.cjs'));
  const libraryRoot = await inflate(path.resolve(path.dirname(entry), '../../bin/al2023.tar.br'));
  const env = { ...process.env, LD_LIBRARY_PATH: path.join(libraryRoot, 'lib') + ':' + (process.env.LD_LIBRARY_PATH || '') };
  const browser = await playwright.chromium.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args.filter((arg) => arg !== '--disable-web-security' && arg !== '--allow-running-insecure-content'),
    env,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const pageErrors = [];
  const violations = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (/content security policy/i.test(message.text())) violations.push(message.text()); });
  page.on('dialog', (dialog) => dialog.accept());
  await page.addInitScript(() => {
    sessionStorage.setItem('pydebug_admin_totp_v1', 'true');
    window.requestIdleCallback = () => 1; // don't run optional AI automation in the test
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'admin.test') return route.abort();
    const pathname = url.pathname === '/' ? '/notifications.html' : url.pathname;
    if (pathname === '/js/vendor/supabase.min.js') {
      return route.fulfill({ status:200, contentType:'text/javascript', body:sdkStub });
    }
    const relative = pathname.replace(/^\/+/, '');
    const file = path.resolve(relative);
    if (!file.startsWith(process.cwd() + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    const ext = path.extname(file);
    const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
    return route.fulfill({ status:200, contentType:types[ext] || 'application/octet-stream',
      headers:ext === '.html' ? { 'Content-Security-Policy':policy } : {}, body:fs.readFileSync(file) });
  });

  await page.goto('https://admin.test/notifications.html');
  await page.locator('#broadcast-form').waitFor({ state:'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page should fit a phone');
  await page.locator('#broadcast-title').fill('Mobile update');
  await page.locator('#broadcast-message').fill('A test announcement');
  await page.locator('#broadcast-link').fill('//evil.test');
  await page.locator('#broadcast-send-btn').click();
  assert.equal((await page.evaluate(() => window.__rpcCalls.length)), 0);
  assert.match(await page.locator('#app-toast').textContent(), /safe in-app path/i);

  await page.locator('#broadcast-link').fill('/problems');
  await page.locator('#broadcast-audience').selectOption('premium');
  await page.locator('#broadcast-send-btn').click();
  await page.getByText(/Could not confirm the result/).waitFor();
  const first = await page.evaluate(() => window.__rpcCalls[0]);
  assert.equal(first.p_audience, 'premium');
  assert.equal(first.p_web_push, true);
  assert.equal(await page.locator('#broadcast-send-btn').isEnabled(), true);
  await page.evaluate(() => { window.__mode = 'success'; });
  await page.locator('#broadcast-send-btn').click();
  await page.getByText(/Previously processed/).waitFor();
  const calls = await page.evaluate(() => window.__rpcCalls);
  assert.equal(calls[0].p_request_id, calls[1].p_request_id);
  assert.match(await page.locator('#broadcast-progress').textContent(), /delivery is not guaranteed/i);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(violations, []);

  // The CSP must actually block an injected inline script, not just exist.
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__unsafeInlineRan = true';
    document.head.appendChild(script);
  });
  assert.notEqual(await page.evaluate(() => window.__unsafeInlineRan), true);

  // The same production policy must not prevent the login form and its
  // failed-auth feedback from working on mobile. Credentials are mocked.
  await page.goto('https://admin.test/index.html');
  await page.locator('#admin-email').fill('admin@example.test');
  await page.locator('#admin-password').fill('not-a-real-password');
  await page.locator('#login-submit').click();
  await page.getByText('Email or password is wrong').waitFor();
  assert.match(await page.locator('#login-alert').textContent(), /unique PyDebug account password/i);
  assert.deepEqual(pageErrors, []);
});
