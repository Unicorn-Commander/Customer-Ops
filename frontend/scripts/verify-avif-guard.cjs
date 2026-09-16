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
  // This release uses the fixed decoder explicitly accepted by Next 15.5.25.
  // Keep the unsafe-version boundaries above even when the live decoder is safe.
  assert.equal(sharp.versions.sharp, '0.35.4');
  assert.equal(sharp.versions.heif, '1.23.2');
  assert.equal(canDecodeAvif(), true);
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
  assert.equal(guarded.contentType, 'image/webp');
  assert.notDeepEqual(guarded.buffer, avif);
  assert.equal((await sharp(guarded.buffer).metadata()).width, 8);
  const normal = await optimize(png, 'fixture.png');
  assert.equal(normal.contentType, 'image/webp');
  assert.equal((await sharp(normal.buffer).metadata()).width, 8);
  assert.notDeepEqual(normal.buffer, png);
  console.log(JSON.stringify({ passed: true, next: require('next/package.json').version,
    sharp: sharp.versions.sharp, libheif: sharp.versions.heif,
    avif: 'resized to 8px WebP with fixed libheif 1.23.2', png: 'resized to 8px WebP' }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
