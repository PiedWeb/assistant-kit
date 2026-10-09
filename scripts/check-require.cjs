// CommonJS consumers (Node >= 22.12) load the package through require(esm):
// fail if an entry point grows a top-level await or a default export.
const assert = require('node:assert/strict');
const path = require('node:path');
const { exports: map } = require('../package.json');

// Entry points checked even before package.json lists them.
const entries = { './audit': './src/audit.js', ...map };

for (const [entry, target] of Object.entries(entries)) {
  if (entry === './package.json') continue;
  const loaded = require(path.join(__dirname, '..', target));
  assert.ok(Object.keys(loaded).length > 0, `${entry} exports nothing`);
  assert.equal(loaded.default, undefined, `${entry} must not have a default export`);
}
process.stdout.write(`require(esm) ok for ${Object.keys(entries).length - 1} entry points\n`);
