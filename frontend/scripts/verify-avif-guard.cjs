'use strict';
// Benign in-memory fixtures only. No live URLs, user uploads, or exploit payloads.
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { imageOptimizer, canDecodeAvif, isAvifDecodeSafe } = require('next/dist/server/image-optimizer');
const { defaultConfig } = require('next/dist/server/config-shared');

async function main() {
  assert.equal(require('next/package.json').version, '15.5.25');
  for (const version of [null, 'unknown', '1.22.9', '1.23.1']) assert.equal(isAvifDecodeSafe(version), false);
  assert.equal(isAvifDecodeSafe('1.23.2'), true);
  // This release intentionally retains sharp 0.34.5; its older libheif must
  // never decode AVIF through the optimizer. A future sharp update needs review.
  assert.equal(require('sharp/package.json').version, '0.34.5');
  assert.equal(canDecodeAvif(), false);
  const input = { create: { width: 32, height: 32, channels: 3, background: '#654321' } };
  const avif = await sharp(input).avif().toBuffer();
  const png = await sharp(input).png().toBuffer();
  const optimize = (buffer, name) => imageOptimizer(
    { buffer, etag: 'synthetic-' + name, cacheControl: 'max-age=0' },
    { href: '/' + name, quality: 75, width: 8, mimeType: 'image/webp' },
    defaultConfig,
    { isDev: false, silent: true },
  );
  const guarded = await optimize(avif, 'fixture.avif');
  assert.equal(guarded.contentType, 'image/avif');
  assert.deepEqual(guarded.buffer, avif);
  assert.equal(guarded.etag, 'synthetic-fixture.avif');
  const normal = await optimize(png, 'fixture.png');
  assert.equal(normal.contentType, 'image/webp');
  assert.equal((await sharp(normal.buffer).metadata()).width, 8);
  assert.notDeepEqual(normal.buffer, png);
  console.log(JSON.stringify({ passed: true, next: require('next/package.json').version,
    sharp: require('sharp/package.json').version, libheif: sharp.versions.heif,
    avif: 'unchanged passthrough; unsafe decoder bypassed', png: 'resized to 8px WebP' }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
