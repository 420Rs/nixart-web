const { getLiveCatalog } = require('../../storefront-catalog');
const ORIGINS = new Set(['https://nixart.io.vn', 'https://www.nixart.io.vn']);
exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=15', Vary: 'Origin' };
  if (ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: { ...headers, Allow: 'GET, OPTIONS' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  try { return { statusCode: 200, headers, body: JSON.stringify(await getLiveCatalog()) }; }
  catch (error) {
    console.error('Storefront catalog unavailable:', error.code || error.name);
    return { statusCode: 503, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'Danh mục tạm thời chưa cập nhật được.' }) };
  }
};
