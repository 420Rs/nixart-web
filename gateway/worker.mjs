const UPSTREAM = 'https://api.bddevlab.online';
const ROUTES = new Map([
  ['/v1/messages', 'POST'],
  ['/v1/messages/count_tokens', 'POST'],
  ['/v1/models', 'GET'],
]);
const error = (status, type, message) => Response.json(
  { type: 'error', error: { type, message } },
  { status, headers: { 'Cache-Control': 'no-store' } },
);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ service: 'NIXART API', status: 'ok' },
        { headers: { 'Cache-Control': 'no-store' } });
    }
    const method = ROUTES.get(url.pathname);
    if (!method) return error(404, 'not_found_error', 'Endpoint not found.');
    if (request.method !== method) return error(405, 'invalid_request_error', 'Method not allowed.');
    const authorization = request.headers.get('Authorization');
    const apiKey = request.headers.get('x-api-key');
    if (!/^Bearer\s+\S+$/i.test(authorization || '') && !apiKey?.trim()) {
      return error(401, 'authentication_error', 'Provide your individual API key.');
    }
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (['authorization', 'x-api-key', 'content-type', 'accept', 'user-agent'].includes(name)
          || /^(anthropic-|x-claude-code-|x-stainless-)/.test(name)) headers.set(name, value);
    }
    try {
      // Each customer owns an upstream key and quota; never insert a shared master key.
      const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
        method, headers, body: method === 'POST' ? request.body : undefined,
        redirect: 'manual', signal: request.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return error(502, 'api_error', 'Upstream endpoint redirected; contact NIXART.');
      }
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete('set-cookie');
      responseHeaders.delete('location');
      responseHeaders.set('Cache-Control', 'no-store');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');
      // Relay SSE directly, including pings, tool calls, thinking and usage events.
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch {
      return error(502, 'api_error', 'Upstream unavailable; retry later.');
    }
  },
};
