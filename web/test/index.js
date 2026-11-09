'use strict';
// `node --test web/test/` 在 Node 24 會把目錄當模組載入，所以這裡把所有 *.test.js 載進同一個程序。
const fs = require('node:fs');
const path = require('node:path');

for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith('.test.js')) require(path.join(__dirname, f));
}
