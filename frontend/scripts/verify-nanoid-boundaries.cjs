'use strict';
// Each boundary runs in a disposable child with a deadline: a regression must
// fail promptly, never hang a build worker on the old non-secure loop.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
assert.equal(require('nanoid/package.json').version, '3.3.18');
for (const expression of ['n.nanoid(-1)', 'n.nanoid(0)', 'n.customAlphabet("abc", 0)()']) {
  const result = spawnSync(process.execPath, ['-e', `const n=require('nanoid/non-secure'); process.stdout.write(JSON.stringify(${expression}));`], { cwd: process.cwd(), timeout: 2000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '""');
}
const { nanoid, customAlphabet } = require('nanoid/non-secure');
assert.equal(nanoid(6).length, 6); // Actual PostCSS input ID usage.
assert.match(customAlphabet('abc', 12)(), /^[abc]{12}$/);
console.log(JSON.stringify({ passed: true, nanoid: '3.3.18', deadlineMs: 2000, boundaryCases: 3, normalCases: 2 }));
