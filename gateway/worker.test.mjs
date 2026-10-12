import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { runInNewContext } from 'node:vm';

test('model failures and vendor HTTP errors become branded errors without changing status', async t => {
  const request = () => new Request('https://api.nixart.io.vn/v1/messages', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer fixture-key' } });
  const cases = [
    [503, { error: { message: 'No available channel for model bad-model. Contact admin bddevlab https://api.bddevlab.online/key', code: 'model_not_found' } }, 'invalid_request_error', /\/model/],
    [503, { error: { message: 'Unavailable, contact bddevlab admin' } }, 'overloaded_error', /tạm thời/],
    [401, { error: { type: 'authentication_error', message: 'bddevlab invalid private-key' } }, 'authentication_error', /key/],
    [429, { error: { message: 'bddevlab limited' } }, 'rate_limit_error', /tần suất/],
    [400, { error: { message: 'bddevlab invalid request private-value' } }, 'invalid_request_error', /cấu hình/],
    [400, { error: { message: 'prompt is too long: 600000 exceeds 200000 bddevlab' } }, 'invalid_request_error', /prompt is too long.*\/compact/],
    [500, '<html>contact admin bddevlab private-key</html>', 'api_error', /NIXART/],
  ];
  for (const [status, payload, type, message] of cases) {
    t.mock.method(globalThis, 'fetch', async () => typeof payload === 'string' ? new Response(payload, { status }) : Response.json(payload, { status, headers: { 'Retry-After': '5' } }));
    const response = await worker.fetch(request()), text = await response.text(), data = JSON.parse(text);
    assert.equal(response.status, status);
    assert.equal(data.type, 'error'); assert.equal(data.error.type, type); assert.match(data.error.message, message);
    assert.doesNotMatch(text, /bddevlab|private-key|private-value|bad-model|https:\/\//);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (typeof payload !== 'string') assert.equal(response.headers.get('retry-after'), '5');
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ type: 'message', content: [{ type: 'text', text: 'Normal answer' }] }));
  assert.deepEqual(await (await worker.fetch(request())).json(), { type: 'message', content: [{ type: 'text', text: 'Normal answer' }] });
});

test('SSE error events are sanitized across byte splits while tool and thinking frames stay intact', async t => {
  const normal = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Tiếng Việt 🐱"}}\r\n\r\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"test\\":true}"}}\n\n';
  const vendorError = 'event: error\r\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Contact bddevlab admin https://api.bddevlab.online"},"vendor":"private metadata"}\r\n\r\n';
  const bytes = new TextEncoder().encode(normal + vendorError);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); },
  }), { headers: { 'Content-Type': 'text/event-stream', 'Content-Length': String(bytes.length) } }));
  const response = await worker.fetch(new Request('https://api.nixart.io.vn/v1/messages', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer fixture-key' } }));
  assert.equal(response.headers.has('content-length'), false);
  const text = await response.text();
  assert.equal(text.slice(0, normal.length), normal);
  assert.doesNotMatch(text, /bddevlab|private metadata|api\.bddevlab/);
  assert.match(text, /event: error\ndata: .*overloaded_error.*NIXART/);
});

test('malformed and unnamed SSE errors never expose raw vendor text', async t => {
  for (const event of ['event: error\ndata: contact bddevlab admin\n\n',
    'data: {"error":{"message":"Unknown model. Contact bddevlab","code":"model_not_found"}}\n\n']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(event, { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await worker.fetch(new Request('https://api.nixart.io.vn/v1/models', { headers: { Authorization: 'Bearer fixture-key' } }));
    const text = await response.text();
    assert.doesNotMatch(text, /bddevlab/); assert.match(text, /event: error/); assert.match(text, /NIXART/);
  }
});

test('credit lookup uses a fixed authenticated read endpoint and exact credit units', async t => {
  let calls = 0, incoming, options;
  const quota = { total_granted: 45000000, total_available: 23312345, total_used: 21687655, unlimited_quota: false, expires_at: 0, name: 'private customer', secret: 'must not return' };
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls++; incoming = url; options = init; return Response.json({ success: true, data: quota }); });
  const request = (headers = {}) => new Request('https://api.nixart.io.vn/api/key/usage?destination=https://evil.example', { method: 'POST', headers });
  assert.equal((await worker.fetch(request())).status, 401);
  assert.equal((await worker.fetch(request({ Authorization: 'Bearer fixture-key', Origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls, 0);
  const response = await worker.fetch(request({ Authorization: 'Bearer fixture-key', Origin: 'https://api.nixart.io.vn', Cookie: 'private-cookie' }));
  assert.equal(incoming, 'https://api.bddevlab.online/api/usage/token/');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { remaining: 233.12345, used: 216.87655, granted: 450, unlimited: false, expiresAt: 0 });
  quota.unlimited_quota = true; quota.expires_at = 1800000000;
  assert.equal((await (await worker.fetch(request({ Authorization: 'Bearer fixture-key' }))).json()).unlimited, true);
  delete quota.total_available;
  assert.equal((await worker.fetch(request({ Authorization: 'Bearer fixture-key' }))).status, 502);
});

test('credit errors conceal provider details, redirects and malformed responses', async t => {
  const request = () => new Request('https://api.nixart.io.vn/api/key/usage', { method: 'POST', headers: { Authorization: 'Bearer fixture-key' } });
  for (const status of [401, 403, 429, 302, 500]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('vendor secret key details', { status, headers: { Location: 'https://evil.example' } }));
    const response = await worker.fetch(request());
    assert.equal(response.status, [401, 403, 429].includes(status) ? status : 502);
    assert.equal(response.headers.has('location'), false);
    assert.doesNotMatch(await response.text(), /vendor|secret|evil/);
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false }));
  assert.equal((await worker.fetch(request())).status, 502);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('vendor offline'); });
  assert.equal((await worker.fetch(request())).status, 502);
});

test('credit page keeps key out of URL and cookies', async () => {
  const page = await worker.fetch(new Request('https://api.nixart.io.vn/key'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /type="password"/);
  const script = await (await worker.fetch(new Request('https://api.nixart.io.vn/key/app.js'))).text();
  assert.doesNotMatch(script, /sessionStorage|document.cookie|bddevlab/);
  assert.match(script, /Authorization: 'Bearer ' \+ key/);
  assert.match(script, /pagehide/);
  new Function(script);
});

test('remembered keys survive reload, opt-out and clear remove them; bar handles limits', async () => {
  const script = await (await worker.fetch(new Request('https://api.nixart.io.vn/key/app.js'))).text();
  const storage = new Map();
  let usage = { remaining: 225, granted: 450, used: 225, unlimited: false, expiresAt: 0 }, calls = 0;
  const browser = () => {
    const elements = new Map();
    const element = id => {
      if (!elements.has(id)) elements.set(id, { value: '', checked: true, hidden: true, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {}, focus() {} });
      return elements.get(id);
    };
    runInNewContext(script, {
      document: { getElementById: element, hidden: false }, window: { addEventListener() {} },
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      fetch: async (_url, options) => { calls++; assert.match(options.headers.Authorization, /^Bearer fixture-key$/); return Response.json(usage); },
      AbortController, setTimeout, clearTimeout, setInterval() {}, Intl, Date,
    });
    return element;
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  let ui = browser();
  ui('key').value = 'fixture-key';
  ui('lookup').handlers.submit({ preventDefault() {} });
  await settle();
  assert.equal(ui('credit-bar').value, 50);
  assert.equal(ui('percentage').textContent, '50%');
  assert.equal(storage.get('nixart.credit.apiKey'), 'fixture-key');
  ui = browser(); await settle();
  assert.equal(ui('key').value, 'fixture-key');
  assert.equal(ui('result').hidden, false);
  assert.equal(calls, 2);
  ui('remember').checked = false; ui('remember').handlers.change();
  assert.equal(storage.has('nixart.credit.apiKey'), false);
  ui = browser(); await settle();
  assert.equal(ui('remember').checked, false);
  assert.equal(ui('key').value, ''); assert.equal(calls, 2);
  ui('key').value = 'fixture-key'; ui('remember').checked = true;
  usage = { ...usage, remaining: -2 };
  ui('lookup').handlers.submit({ preventDefault() {} }); await settle();
  assert.equal(ui('credit-bar').value, 0);
  ui('clear').handlers.click();
  assert.equal(storage.has('nixart.credit.apiKey'), false);
  assert.equal(ui('key').value, ''); assert.equal(ui('result').hidden, true);
  usage = { ...usage, unlimited: true };
  ui('key').value = 'fixture-key'; ui('lookup').handlers.submit({ preventDefault() {} }); await settle();
  assert.equal(ui('credit-bar').hidden, true); assert.equal(ui('percentage').textContent, 'Không giới hạn');
  usage = { ...usage, unlimited: false, granted: 0 };
  ui('lookup').handlers.submit({ preventDefault() {} }); await settle();
  assert.equal(ui('credit-bar').hidden, true); assert.equal(ui('percentage').textContent, 'Chưa có hạn mức');
});

test('individual keys and Messages stream pass through; no anonymous calls or credential redirects', async t => {
  let calls = 0, incoming, options, controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++; incoming = url; options = init;
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'private=value' } });
  });
  const anonymous = await worker.fetch(new Request('https://api.nixart.io.vn/v1/messages', { method: 'POST' }));
  assert.equal(anonymous.status, 401);
  assert.equal((await worker.fetch(new Request('https://api.nixart.io.vn/admin'))).status, 404);
  assert.equal(calls, 0);
  const payload = JSON.stringify({ model: 'claude-opus-5[1m]', stream: true, messages: [{ role: 'user', content: 'Xin chào' }] });
  const response = await worker.fetch(new Request('https://api.nixart.io.vn/v1/messages?beta=true', {
    method: 'POST', body: payload, headers: { Authorization: 'Bearer customer-test-key',
      'anthropic-beta': 'new-feature', 'anthropic-version': '2023-06-01', Cookie: 'do-not-forward' },
  }));
  assert.equal(incoming, 'https://api.bddevlab.online/v1/messages?beta=true');
  assert.equal(options.headers.get('authorization'), 'Bearer customer-test-key');
  assert.equal(options.headers.get('anthropic-beta'), 'new-feature');
  assert.equal(options.headers.has('cookie'), false);
  assert.equal(await new Response(options.body).text(), payload);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const encoder = new TextEncoder(), reader = response.body.getReader();
  controller.enqueue(encoder.encode('event: ping\ndata: {}\n\n'));
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ping/);
  controller.enqueue(encoder.encode('event: message_stop\ndata: {}\n\n')); controller.close();
  assert.match(new TextDecoder().decode((await reader.read()).value), /message_stop/);
  assert.equal((await reader.read()).done, true);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }));
  const redirected = await worker.fetch(new Request('https://api.nixart.io.vn/v1/models', { headers: { 'x-api-key': 'customer-test-key' } }));
  assert.equal(redirected.status, 502);
  assert.equal(redirected.headers.has('location'), false);
});
