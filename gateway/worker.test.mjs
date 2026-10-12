import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

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
