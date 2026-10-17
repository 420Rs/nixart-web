const API = 'https://opq1k99m2f.apps.bot-hosting.cloud';
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const DISCORD = /^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}$/;
let cached, expires = 0;

function groupFor(category) {
  if (['Google AI', 'ChatGPT', 'Claude', 'Claude API', 'Tripo 3D'].includes(category)) return 'AI';
  if (['Adobe', 'Canva', 'CapCut', 'R.Finder'].includes(category)) return 'Sáng tạo';
  if (category === 'Duolingo') return 'Học tập';
  if (category === 'Dịch vụ web') return 'Dịch vụ';
  return 'Giải trí';
}
function publicProducts(shop, links, banners = [], optimized = []) {
  const products = [];
  for (const row of shop) {
    if (String(row.id).startsWith('preorder-vrts-') || /khóa học|đặt trước/i.test(row.category || '')) continue;
    const price = Number(row.price), buyUrl = links.shop[row.id];
    const bannerId = row.category === 'R.Finder' ? 'rfinder' : row.id;
    if (row.enabled !== true || !ID.test(row.id) || !Number.isSafeInteger(price) || price < 1000 || !DISCORD.test(buyUrl || '')) continue;
    products.push({ id: row.id, title: String(row.title), description: String(row.description || ''),
      price, category: String(row.category), group: groupFor(row.category),
      kind: 'Sản phẩm số', buyUrl,
      imageUrl: banners.includes(bannerId) ? `${API}/shop-banners/${bannerId}.${optimized.includes(bannerId) ? 'webp' : 'png'}` : '' });
  }
  return products;
}
async function getLiveCatalog() {
  if (cached && Date.now() < expires) return cached;
  const sql = require('./database').neon();
  const [shop, posts] = await Promise.all([
    sql`SELECT id,title,category,price,description,enabled FROM shop_products WHERE enabled=TRUE AND id NOT LIKE 'preorder-vrts-%' ORDER BY category,title,id`,
    sql`SELECT category,thread_id FROM shop_forum_posts WHERE guild_id=${process.env.DISCORD_GUILD_ID}`,
  ]);
  const links = structuredClone(require('./content/storefront-links.json'));
  const guild = process.env.DISCORD_GUILD_ID;
  for (const row of shop) {
    const thread = posts.find(p => p.category === row.category)?.thread_id;
    if (!links.shop[row.id] && /^\d{17,20}$/.test(guild || '') && /^\d{17,20}$/.test(thread || '')) links.shop[row.id] = `https://discord.com/channels/${guild}/${thread}`;
  }
  const fs = require('node:fs'), path = require('node:path');
  const files = fs.readdirSync(path.join(__dirname, 'assets', 'shop-banners'));
  const banners = files.filter(n => n.endsWith('.png')).map(n => n.slice(0, -4));
  const optimized = files.filter(n => n.endsWith('.webp')).map(n => n.slice(0, -5));
  cached = { name: 'NIXART', discordUrl: 'https://discord.gg/B8ZXSNdVaR', updatedAt: new Date().toISOString(),
    products: publicProducts(shop, links, banners, optimized) };
  expires = Date.now() + 15000;
  return cached;
}
module.exports = { publicProducts, getLiveCatalog };
