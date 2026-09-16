'use strict';
// All files contain synthetic CSS; no application data or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const nextRequire = createRequire(require.resolve('next/package.json'));
const postcss = nextRequire('postcss');
assert.equal(nextRequire('postcss/package.json').version, '8.5.23');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-postcss-'));
try {
  const cssDir = path.join(root, 'css'); fs.mkdirSync(cssDir);
  const map = { version: 3, sources: ['fixture.css'], sourcesContent: ['.fixture { color: red }'], names: [], mappings: 'AAAA' };
  fs.writeFileSync(path.join(cssDir, 'same.map'), JSON.stringify(map));
  fs.writeFileSync(path.join(root, 'outside.map'), JSON.stringify(map));
  const parse = annotation => postcss.parse(`.fixture { color: red }\n/*# sourceMappingURL=${annotation} */`, { from: path.join(cssDir, 'input.css') });
  assert.equal(parse('same.map').source.input.map.text, JSON.stringify(map));
  assert.equal(parse('../outside.map').source.input.map, undefined);
  const inline = Buffer.from(JSON.stringify(map)).toString('base64');
  assert.equal(parse('data:application/json;base64,' + inline).source.input.map.text, JSON.stringify(map));
  const plugin = { postcssPlugin: 'synthetic-custom-property', Declaration(decl) { if (decl.prop === 'color') decl.value = 'var(--brand)'; } };
  const result = postcss([plugin]).process('.fixture { color: red; display: flex }', { from: 'fixture.css', to: 'result.css', map: { inline: false } });
  assert.match(result.css, /color: var\(--brand\)/);
  assert.match(result.css, /display: flex/);
  assert.ok(result.map.toJSON().sources.includes('fixture.css'));
  console.log(JSON.stringify({ passed: true, postcss: postcss().version, sameDirectoryMap: true, parentDirectoryMapRejected: true, inlineMap: true, pluginTransform: true, outputMap: true }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
