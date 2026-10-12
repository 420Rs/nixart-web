const UPSTREAM = 'https://api.bddevlab.online';
const CREDIT_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Credit API — NIXART</title><link rel="stylesheet" href="/key/style.css"><script defer src="/key/app.js"></script></head>
<body><header><a href="https://nixart.io.vn/" class="brand">NIXART<span> / API</span></a><a href="https://nixart.io.vn/">Về shop ↗</a></header>
<main><p class="eyebrow">TÀI KHOẢN API</p><h1>Credit của bạn.</h1><p class="intro">Theo dõi số dư, lượng đã dùng và thời hạn của key tại NIXART.</p>
<form id="lookup"><label for="key">API key</label><div class="input-row"><input id="key" type="password" placeholder="Dán key được shop gửi riêng" autocomplete="off" spellcheck="false" required maxlength="512"><button type="button" id="reveal" aria-label="Hiện API key">Hiện</button></div><label class="remember"><input id="remember" type="checkbox" checked>Nhớ key trên thiết bị này</label><div class="actions"><button id="submit" type="submit">Kiểm tra credit ↗</button><button id="clear" type="button" class="secondary">Xóa key</button></div></form>
<p class="privacy">Bật nhớ key để tự kiểm tra khi tải lại trang. Bỏ chọn nếu dùng thiết bị chung. Nút Xóa key sẽ xóa cả key đã lưu.</p><p id="storage-note" class="privacy" hidden></p><p id="status" role="status" aria-live="polite">Nhập key để xem số dư.</p>
<section id="result" hidden aria-label="Số dư credit"><div class="balance"><p>CREDIT CÒN LẠI</p><strong id="remaining">—</strong><span>Credit</span></div><div class="credit-meter"><div class="meter-label"><span>Mức credit còn lại</span><strong id="percentage">—</strong></div><progress id="credit-bar" max="100" value="0" aria-label="Phần trăm credit còn lại"></progress></div><div class="details"><div><span>Đã sử dụng</span><strong id="used">—</strong></div><div><span>Tổng hạn mức</span><strong id="granted">—</strong></div><div><span>Hết hạn</span><strong id="expiry">—</strong></div></div><p class="updated" id="updated"></p><p class="updated">Tự cập nhật mỗi 30 giây khi tab đang mở.</p></section>
</main><footer>NIXART / Digital essentials.</footer></body></html>`;
const CREDIT_CSS = `:root{color-scheme:dark;font-family:Arial,Helvetica,sans-serif;background:#090909;color:#f5f5f5}*{box-sizing:border-box}body{margin:0}a{color:inherit;text-decoration:none}header{max-width:1120px;margin:auto;padding:30px 32px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #282828;font-size:13px}.brand{font-size:20px;font-weight:800;letter-spacing:2px}.brand span{font-size:11px;color:#999;font-weight:400}main{max-width:780px;margin:80px auto 100px;padding:0 32px}.eyebrow{letter-spacing:3px;font-size:11px;color:#aaa}h1{font-size:clamp(38px,7vw,66px);letter-spacing:-3px;line-height:1.1;margin:18px 0}.intro{color:#aaa;font-size:16px;line-height:1.7;margin-bottom:38px}label{display:block;font-size:13px;margin-bottom:10px}.input-row{display:flex;border:1px solid #444;background:#111}.input-row:focus-within{outline:1px solid #fff}input{min-width:0;flex:1;padding:18px;background:transparent;border:0;color:#fff;outline:none;font-size:14px}button{font:inherit;cursor:pointer;padding:14px 20px;border:1px solid #eee;background:#eee;color:#090909;font-size:13px}button:focus-visible,a:focus-visible{outline:2px solid #fff;outline-offset:4px}button:disabled{opacity:.5;cursor:wait}#reveal{background:transparent;color:#ccc;border:0;padding:12px;font-size:12px}.actions{display:flex;gap:10px;margin-top:16px}.secondary{background:transparent;color:#ccc;border-color:#444}.privacy,.updated{font-size:12px;line-height:1.7;color:#888}.privacy{margin:20px 0 30px}#status{font-size:13px;color:#bbb;line-height:1.6}section{border-top:1px solid #333;margin-top:24px;padding-top:30px}.balance p{font-size:11px;letter-spacing:2px;color:#aaa}.balance strong{font-size:clamp(48px,9vw,76px);font-weight:500;letter-spacing:-3px}.balance>span{font-size:12px;color:#888;margin-left:12px}.details{display:grid;grid-template-columns:1fr 1fr 1.3fr;border-top:1px solid #333;border-bottom:1px solid #333;margin:28px 0 18px;padding:24px 0;gap:16px}.details span,.details strong{display:block}.details span{font-size:12px;color:#999;margin-bottom:10px}.details strong{font-size:16px;font-weight:400}.updated{margin:4px 0}footer{border-top:1px solid #282828;padding:25px 32px;font-size:11px;letter-spacing:1px;color:#777;text-align:center}[hidden]{display:none!important}@media(max-width:550px){header{padding:24px}main{margin:50px auto 60px;padding:0 24px}h1{letter-spacing:-2px}.details{grid-template-columns:1fr 1fr}.details>div:last-child{grid-column:1/-1}input{padding:16px 12px}}`;
const METER_CSS = `.remember{display:flex;align-items:center;gap:10px;margin:18px 0;color:#bbb;font-size:12px}.remember input{flex:none;width:16px;height:16px;margin:0;accent-color:#fff}.credit-meter{margin-top:26px}.meter-label{display:flex;justify-content:space-between;gap:12px;color:#aaa;font-size:12px;margin-bottom:12px}.meter-label strong{color:#fff;font-weight:400}progress{display:block;width:100%;height:10px;border:0;appearance:none;background:#303030;border-radius:2px;overflow:hidden}progress::-webkit-progress-bar{background:#303030}progress::-webkit-progress-value{background:#f5f5f5;transition:width .3s}progress::-moz-progress-bar{background:#f5f5f5}`;
const CREDIT_JS = `const $ = id => document.getElementById(id);
const formatter = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 4 });
const STORAGE_KEY = 'nixart.credit.apiKey';
function saveKey(key) {
  try {
    localStorage.setItem(STORAGE_KEY + '.remember', String($('remember').checked));
    if ($('remember').checked && key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
    $('storage-note').hidden = true;
  } catch {
    $('storage-note').textContent = 'Trình duyệt đang chặn lưu key. Bạn vẫn có thể kiểm tra credit trong tab này.';
    $('storage-note').hidden = false;
  }
}
let activeKey = '', controller, generation = 0;
function reset() { generation++; controller?.abort(); activeKey = ''; $('result').hidden = true; }
async function lookup(key) {
  if (controller) return;
  const version = generation;
  controller = new AbortController();
  const timer = setTimeout(() => controller?.abort(), 20000);
  $('submit').disabled = true; $('status').textContent = 'Đang kiểm tra…';
  try {
    const response = await fetch('/api/key/usage', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, cache: 'no-store', signal: controller.signal });
    const data = await response.json();
    if (version !== generation) return;
    if (!response.ok) throw new Error(data.error?.message || 'Chưa thể kiểm tra credit. Thử lại sau.');
    activeKey = key;
    $('remaining').textContent = data.unlimited ? '∞' : formatter.format(data.remaining);
    $('used').textContent = formatter.format(data.used) + ' Credit';
    $('granted').textContent = data.unlimited ? 'Không giới hạn' : formatter.format(data.granted) + ' Credit';
    const percentage = data.granted > 0 ? Math.min(100, Math.max(0, data.remaining / data.granted * 100)) : 0;
    $('credit-bar').hidden = data.unlimited || data.granted <= 0;
    $('credit-bar').value = percentage;
    $('percentage').textContent = data.unlimited ? 'Không giới hạn' : data.granted <= 0 ? 'Chưa có hạn mức' : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(percentage) + '%';
    $('expiry').textContent = data.expiresAt === 0 ? 'Không thời hạn' : new Date(data.expiresAt * 1000).toLocaleString('vi-VN');
    $('updated').textContent = 'Cập nhật lúc ' + new Date().toLocaleTimeString('vi-VN');
    $('result').hidden = false; $('status').textContent = 'Đã cập nhật số dư.';
  } catch (error) {
    if (version !== generation) return;
    activeKey = ''; $('result').hidden = true;
    $('status').textContent = error.name === 'AbortError' ? 'Kết nối quá lâu. Bấm kiểm tra để thử lại.' : error.message;
  } finally { clearTimeout(timer); controller = undefined; $('submit').disabled = false; }
}
$('lookup').addEventListener('submit', event => { event.preventDefault(); const key = $('key').value.trim(); if (!key || controller) return; reset(); saveKey(key); lookup(key); });
$('key').addEventListener('input', () => { reset(); saveKey(''); $('status').textContent = 'Bấm kiểm tra để xem số dư.'; });
$('remember').addEventListener('change', () => saveKey($('key').value.trim()));
$('clear').addEventListener('click', () => { reset(); saveKey(''); $('key').value = ''; $('key').type = 'password'; $('reveal').textContent = 'Hiện'; $('reveal').setAttribute('aria-label', 'Hiện API key'); $('status').textContent = 'Đã xóa key.'; $('key').focus(); });
$('reveal').addEventListener('click', () => { const show = $('key').type === 'password'; $('key').type = show ? 'text' : 'password'; $('reveal').textContent = show ? 'Ẩn' : 'Hiện'; $('reveal').setAttribute('aria-label', show ? 'Ẩn API key' : 'Hiện API key'); });
setInterval(() => { if (activeKey && !document.hidden && !controller) lookup(activeKey); }, 30000);
function restoreKey() {
  try {
    $('remember').checked = localStorage.getItem(STORAGE_KEY + '.remember') !== 'false';
    const savedKey = localStorage.getItem(STORAGE_KEY);
    if ($('remember').checked && savedKey && /^\\S{1,512}$/.test(savedKey)) { $('key').value = savedKey; lookup(savedKey); }
  } catch { /* Lookup still works when browser storage is unavailable. */ }
}
window.addEventListener('pagehide', () => { reset(); $('key').value = ''; });
window.addEventListener('pageshow', event => { if (event.persisted) restoreKey(); });
restoreKey();`;
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
async function creditUsage(request) {
  if (request.method !== 'POST') return error(405, 'invalid_request_error', 'Method not allowed.');
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return error(403, 'invalid_request_error', 'Truy cập trang kiểm tra credit của NIXART.');
  const authorization = request.headers.get('Authorization');
  if (!/^Bearer\s+\S{1,512}$/i.test(authorization || '')) return error(401, 'authentication_error', 'Nhập API key được shop gửi riêng.');
  try {
    const response = await fetch(UPSTREAM + '/api/usage/token/', {
      method: 'GET', headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const status = [401, 403, 429].includes(response.status) ? response.status : 502;
      return error(status, 'api_error', status === 429 ? 'Tra cứu quá nhanh. Vui lòng thử lại sau.' : status === 401 || status === 403 ? 'Key không hợp lệ hoặc không thể tra cứu. Liên hệ NIXART để kiểm tra.' : 'Chưa thể lấy số dư. Vui lòng thử lại sau.');
    }
    const json = await response.json(), data = json.data;
    const validNumber = value => typeof value === 'number' && Number.isFinite(value);
    if (json.success === false || !data || !['total_available', 'total_used', 'total_granted', 'expires_at'].every(field => validNumber(data[field])) || data.total_used < 0 || data.total_granted < 0 || !Number.isInteger(data.expires_at) || data.expires_at < 0 || ![true, false, 0, 1].includes(data.unlimited_quota)) throw new Error('Invalid usage response');
    // Same unit conversion as the supplier's balance page: 100,000 quota per credit.
    return Response.json({ remaining: data.total_available / 100000, used: data.total_used / 100000,
      granted: data.total_granted / 100000, unlimited: Boolean(data.unlimited_quota), expiresAt: data.expires_at },
    { headers: securityHeaders });
  } catch { return error(502, 'api_error', 'Chưa thể lấy số dư. Vui lòng thử lại sau.'); }
}
const ROUTES = new Map([
  ['/v1/messages', 'POST'],
  ['/v1/messages/count_tokens', 'POST'],
  ['/v1/models', 'GET'],
]);
const error = (status, type, message) => Response.json(
  { type: 'error', error: { type, message } },
  { status, headers: securityHeaders },
);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/key/usage') return creditUsage(request);
    const asset = new Map([['/key', [CREDIT_HTML, 'text/html']], ['/key/', [CREDIT_HTML, 'text/html']],
      ['/key/style.css', [CREDIT_CSS + METER_CSS, 'text/css']], ['/key/app.js', [CREDIT_JS, 'application/javascript']]]).get(url.pathname);
    if (asset) {
      if (request.method !== 'GET') return error(405, 'invalid_request_error', 'Method not allowed.');
      return new Response(asset[0], { headers: { ...securityHeaders, 'Content-Type': asset[1] + '; charset=utf-8' } });
    }
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
