// Run from the bot host root after uploading the storefront module and handler.
const fs = require('node:fs');
const file = 'bot-api.js';
const original = fs.readFileSync(file, 'utf8');
if (original.includes("'/api/storefront':") && original.includes('(png|webp)')) {
  console.log('Storefront routes already installed.');
} else {
  let next = original;
  const changes = [
    ["  '/api/catalog': './netlify/functions/catalog',", "  '/api/catalog': './netlify/functions/catalog',\n  '/api/storefront': './netlify/functions/storefront-catalog',"],
    ["\\.png$/);", "\\.(png|webp)$/);"],
    ["banner[1]+'.png'", "banner[1]+'.'+banner[2]"],
    ["'Content-Type':'image/png'", "'Content-Type':'image/'+banner[2]"],
  ];
  for (const [from, to] of changes) {
    if (next.split(from).length !== 2) throw Error('Unexpected host source; no files changed.');
    next = next.replace(from, to);
  }
  fs.copyFileSync(file, file + '.before-storefront');
  fs.writeFileSync(file + '.storefront.tmp', next);
  fs.renameSync(file + '.storefront.tmp', file);
  console.log('Storefront routes installed; restart required.');
}
