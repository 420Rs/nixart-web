const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const api = 'https://opq1k99m2f.apps.bot-hosting.cloud/api/storefront';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/api/storefront') {
    try { const response = await fetch(api, { signal: AbortSignal.timeout(10000) }); res.writeHead(response.status, { 'Content-Type': 'application/json' }); return res.end(await response.text()); }
    catch (_) { res.writeHead(503); return res.end('{}'); }
  }
  if (!['/', '/favicon.svg'].includes(url.pathname)) { res.writeHead(404); return res.end(); }
  const file = url.pathname === '/' ? 'index.html' : 'favicon.svg';
  let body = fs.readFileSync(path.join(root, file), 'utf8');
  if (file === 'index.html') body = body.replace(api, '/api/storefront');
  res.writeHead(200, { 'Content-Type': file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
});
server.listen(4180, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4180'));
