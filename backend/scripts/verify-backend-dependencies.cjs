'use strict';
// Local-only synthetic requests. No database, application auth or external URL.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const nestRequire = createRequire(require.resolve('@nestjs/platform-express/package.json'));
const nextTick = () => new Promise(resolve => setImmediate(resolve));
async function checkParser(express, parser, expected) {
  const app = express();
  app.use(parser.json({ limit: '1kb' }));
  app.use(parser.urlencoded({ extended: true, limit: '1kb' }));
  app.post('/fixture', (req, res) => res.json(req.body));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ type: err.type }));
  const server = app.listen(0, '127.0.0.1'); await nextTick();
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  try {
    let response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"fixture"}' });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { name: 'fixture' });
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'names[]=a&names[]=b' });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { names: ['a', 'b'] });
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(1100) }) });
    assert.equal(response.status, 413); assert.equal((await response.json()).type, 'entity.too.large');
    assert.throws(() => parser.json({ limit: 'invalid' }));
    return expected;
  } finally { await new Promise(resolve => server.close(resolve)); }
}
async function main() {
  assert.equal(nestRequire('body-parser/package.json').version, '1.20.6');
  assert.equal(require('body-parser/package.json').version, '2.3.0');
  const parsers = [];
  parsers.push(await checkParser(nestRequire('express'), nestRequire('body-parser'), 'Nest Express4 / body-parser1.20.6'));
  parsers.push(await checkParser(require('express'), require('body-parser'), 'MCP Express5 / body-parser2.3.0'));
  assert.equal(require('multer/package.json').version, '2.3.0');
  const app = nestRequire('express')();
  app.post('/upload', require('multer')({ limits: { fileSize: 16 } }).single('fixture'), (req, res) => res.json({ size: req.file.size }));
  app.use((err, req, res, next) => res.status(400).json({ code: err.code }));
  const server = app.listen(0, '127.0.0.1'); await nextTick();
  try {
    const url = `http://127.0.0.1:${server.address().port}/upload`;
    for (const [size, status] of [[4, 200], [32, 400]]) {
      const form = new FormData(); form.append('fixture', new Blob(['a'.repeat(size)]), 'fixture.txt');
      const response = await fetch(url, { method: 'POST', body: form }); assert.equal(response.status, status);
      assert.deepEqual(await response.json(), status === 200 ? { size } : { code: 'LIMIT_FILE_SIZE' });
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  const yaml = require('js-yaml'); assert.deepEqual(yaml.load(yaml.dump({ openapi: '3.0.0', paths: {} })), { openapi: '3.0.0', paths: {} });
  const Ajv = require('ajv'); const valid = new Ajv().compile({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
  assert.equal(valid({ id: 'fixture' }), true); assert.equal(valid({ id: 1 }), false);
  const { Address4 } = require('ip-address'); assert.equal(new Address4('192.0.2.1').correctForm(), '192.0.2.1');
  const { Hono } = require('hono'); const hono = new Hono(); hono.get('/fixture', c => c.json({ ok: true }));
  assert.deepEqual(await (await hono.request('/fixture')).json(), { ok: true });
  console.log(JSON.stringify({ passed: true, parsers, requestLimits: true, invalidLimitsRejected: true, multipartNormalAndLimit: true, swaggerYaml: true, ajv: true, ipAddress: true, hono: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
