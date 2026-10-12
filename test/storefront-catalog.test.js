const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicProducts } = require('../storefront-catalog');
test('storefront publishes sale-ready products and verified purchase URLs without private fields', () => {
  const url = 'https://discord.com/channels/1514539301625659392/1558680872486572084';
  const products = publicProducts([
    { id: 'google-ai', title: 'Google AI', category: 'Google AI', price: '30000', enabled: true, supplier_secret: 'PRIVATE', stock: 'PRIVATE' },
    { id: 'disabled', title: 'Disabled', price: 20000, enabled: false },
    { id: 'unsafe', title: 'Unsafe', price: 20000, enabled: true },
    { id: 'preorder-vrts-ab12', title: 'Course preorder', category: 'Khóa học đặt trước', price: 350000, enabled: true },
    { id: 'course', title: 'Course', category: 'Khóa học', price: 40000, enabled: true },
  ], { shop: { 'google-ai': url, disabled: url, unsafe: 'javascript:alert(1)', 'preorder-vrts-ab12': url, course: url } }, ['google-ai']);
  assert.equal(products.length, 1);
  assert.equal(products[0].price, 30000);
  assert.equal(products[0].group, 'AI');
  assert.equal(products[0].buyUrl, url);
  assert.match(products[0].imageUrl, /shop-banners\/google-ai\.png$/);
  assert.equal(JSON.stringify(products).includes('PRIVATE'), false);
});
