import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

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

test('credit page keeps key out of URL and persistent browser storage', async () => {
  const page = await worker.fetch(new Request('https://api.nixart.io.vn/key'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /type="password"/);
  const script = await (await worker.fetch(new Request('https://api.nixart.io.vn/key/app.js'))).text();
  assert.doesNotMatch(script, /localStorage|sessionStorage|document.cookie|bddevlab/);
  assert.match(script, /Authorization: 'Bearer ' \+ key/);
  assert.match(script, /pagehide/);
  new Function(script);
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
