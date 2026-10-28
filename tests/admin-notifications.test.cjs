const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const source = fs.readFileSync('js/admin-notifications.js', 'utf8');

function harness(response) {
  const elements = {
    'broadcast-title': { value: 'An announcement' },
    'broadcast-message': { value: 'Practice today' },
    'broadcast-link': { value: '/problems' },
    'broadcast-type': { value: 'announcement' },
    'broadcast-audience': { value: 'premium' },
    'broadcast-also-push': { checked: true },
    'broadcast-send-btn': { disabled: false, textContent: 'Send broadcast' },
    'broadcast-progress': { textContent: '' },
    'broadcast-form': { resets: 0, reset() { this.resets += 1; } },
  };
  const calls = [];
  const messages = [];
  const store = new Map();
  let nextId = 1;
  const ctx = vm.createContext({
    onAdminReady: () => {},
    document: { getElementById: (id) => elements[id] },
    window: { crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}` } },
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
    confirm: () => true,
    showToast: (message, tone) => messages.push({ message, tone }),
    writeAdminAudit: async () => {},
    sb: { rpc: async (name, args) => { calls.push({ name, args }); return response(calls.length, args); } },
    console,
  });
  vm.runInContext(source, ctx);
  vm.runInContext('currentNotifAdmin = { id: "admin-1" }; refreshNotificationsPage = async () => {};', ctx);
  return { ctx, elements, calls, messages, store };
}

const success = (_, args) => ({ data: { recipients: 3, web_push_enabled: args.p_web_push, already_processed: false }, error: null });
const submit = (ctx) => ctx.sendBroadcast({ preventDefault() {} });

test('broadcast paths reject external redirects and unsafe encodings', () => {
  const { ctx } = harness(success);
  for (const path of ['//evil.test', '/\\evil.test', '/%2Fevil.test', '/%5cevil.test', '/page%0Aheader', 'https://evil.test', '/bad path']) {
    assert.equal(ctx.isSafeBroadcastLink(path), false, path);
  }
  for (const path of ['', '/', '/problem?id=7#answer', '/mock-test?x=a%20b']) {
    assert.equal(ctx.isSafeBroadcastLink(path), true, path);
  }
});

test('broadcast sends a single scoped RPC and reports a request, not guaranteed delivery', async () => {
  const { ctx, calls, elements } = harness(success);
  await submit(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'admin_send_broadcast');
  assert.equal(calls[0].args.p_audience, 'premium');
  assert.equal(calls[0].args.p_web_push, true);
  assert.match(calls[0].args.p_request_id, /^[0-9a-f-]{36}$/);
  assert.match(elements['broadcast-progress'].textContent, /3 bell notifications created/);
  assert.match(elements['broadcast-progress'].textContent, /push was enabled.*delivery is not guaranteed/i);
  assert.equal(elements['broadcast-form'].resets, 1);
  assert.equal(elements['broadcast-send-btn'].disabled, false);
});

test('unchecked push reports the separate learner-tab delivery path', async () => {
  const { ctx, calls, elements } = harness(success);
  elements['broadcast-also-push'].checked = false;
  await submit(ctx);
  assert.equal(calls[0].args.p_web_push, false);
  assert.match(elements['broadcast-progress'].textContent, /No server-side push was requested/);
  assert.match(elements['broadcast-progress'].textContent, /learner tabs may still initiate push/);
});

test('a failed or lost response is visible and the same request ID is used on retry', async () => {
  const { ctx, calls, elements, store } = harness((attempt, args) => attempt === 1
    ? { data: null, error: { message: 'Connection lost' } }
    : { data: { recipients: 3, web_push_enabled: args.p_web_push, already_processed: true }, error: null });
  await submit(ctx);
  assert.match(elements['broadcast-progress'].textContent, /Could not confirm.*Retry with the same contents/i);
  assert.equal(elements['broadcast-send-btn'].disabled, false);
  assert.equal(elements['broadcast-form'].resets, 0);
  assert.equal(store.size, 1);
  // Simulate a page reload in the same browser tab.
  vm.runInContext('pendingBroadcast = null;', ctx);
  await submit(ctx);
  assert.equal(calls[0].args.p_request_id, calls[1].args.p_request_id);
  assert.match(elements['broadcast-progress'].textContent, /Previously processed/);
  assert.equal(store.size, 0);
});

test('missing migration, malformed response and invalid input fail without a false success', async () => {
  const missing = harness(() => ({ data: null, error: { code: 'PGRST202', message: 'function not found' } }));
  await submit(missing.ctx);
  assert.match(missing.elements['broadcast-progress'].textContent, /Database update required.*Nothing was sent/);
  assert.equal(missing.elements['broadcast-form'].resets, 0);

  const malformed = harness(() => ({ data: { recipients: 2, web_push_enabled: false }, error: null }));
  await submit(malformed.ctx);
  assert.match(malformed.elements['broadcast-progress'].textContent, /Could not confirm/i);
  assert.equal(malformed.elements['broadcast-form'].resets, 0);

  const invalid = harness(success);
  invalid.elements['broadcast-link'].value = '//evil.test';
  await submit(invalid.ctx);
  assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.messages.at(-1).tone, 'error');
});

test('an audit logging failure cannot turn a saved broadcast into a retry', async () => {
  const { ctx, elements } = harness(success);
  ctx.writeAdminAudit = async () => { throw new Error('audit temporarily down'); };
  await submit(ctx);
  assert.match(elements['broadcast-progress'].textContent, /3 bell notifications created/);
  assert.equal(elements['broadcast-form'].resets, 1);
});
