const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('grouped cards preserve each live package, price and Discord link', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const source = html.slice(html.indexOf('function groupProducts('), html.indexOf('function showVariant('));
  const groupProducts = vm.runInNewContext(source + ';groupProducts');
  const catalog = JSON.parse(html.match(/id="catalog-data">([\s\S]*?)<\/script>/)[1]);
  const grouped = groupProducts(catalog.products);
  assert.equal(grouped.length, catalog.products.length - 6);
  for (const category of ['CapCut', 'OnlyFans', 'R.Finder']) {
    const cards = grouped.filter(p => p.category === category);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].variants.length, 3);
    assert.equal(cards[0].price, Math.min(...cards[0].variants.map(p => p.price)));
    for (const variant of cards[0].variants) {
      assert.deepEqual(variant, catalog.products.find(p => p.id === variant.id));
    }
  }
  const lifetime = grouped.find(product => product.category === 'R.Finder').variants.find(variant => variant.id === 'rfinder-vinh-vien');
  assert.equal(lifetime.price, 250000);
  assert.match(lifetime.description, /không hết hạn/);
  assert.ok(catalog.products.length >= 15);
  assert.ok(!html.includes('filter:grayscale'));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
});
