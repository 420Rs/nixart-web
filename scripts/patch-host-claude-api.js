const fs = require('node:fs');
const vm = require('node:vm');
const file = 'shop.js';
const source = fs.readFileSync(file, 'utf8');
if (source.includes("require('./claude-api-delivery')")) {
  console.log('Paid delivery guide already installed.');
} else {
  const patches = [
    ["const qcst = require('./qcst');", "const qcst = require('./qcst');\nconst apiDelivery = require('./claude-api-delivery');"],
    ["...(isChatgptProduct(productId) ? {flags:0,embeds:[{description:CHATGPT_DELIVERY_NOTES}]} : {})", "...(isChatgptProduct(productId) ? {flags:0,embeds:[{description:CHATGPT_DELIVERY_NOTES}]} : {}),\n    ...apiDelivery.forProduct(productId)"],
  ];
  let result = source;
  for (const [from, to] of patches) {
    if (result.split(from).length !== 2) throw Error('Unexpected shop source; nothing changed.');
    result = result.replace(from, to);
  }
  new vm.Script(result, { filename: file });
  fs.copyFileSync(file, file + '.before-claude-api');
  fs.writeFileSync(file + '.claude-api.tmp', result);
  fs.renameSync(file + '.claude-api.tmp', file);
  console.log('Paid delivery guide installed; restart required.');
}
