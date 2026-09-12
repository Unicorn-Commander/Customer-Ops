import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The PURE render graph is vendored into the frontend byte for byte (there is
 * no shared package in this repo yet, and the public share page must
 * server-render the SAME template the PDF prints). This test fails the build
 * the moment the copies drift; `scripts/sync-quote-mirror.sh` re-syncs them.
 *
 * The mirror keeps the backend's directory shape under frontend/lib/quotes/ so
 * every relative import inside these files resolves unchanged — which is what
 * makes byte-identity possible in the first place.
 *
 * When the frontend tree is not checked out next to the backend (e.g. an image
 * build), the test is skipped rather than failing.
 */
const MIRRORED = [
  'brand-ops/brand-ops.types.ts',
  'brand-ops/brand-tokens.ts',
  'quotes-render/quote-model.ts',
  'quotes-render/quote-view.ts',
  'quotes-render/fixtures/orderpad.fixture.ts',
  'quotes-render/template/html.ts',
  'quotes-render/template/md.ts',
  'quotes-render/template/styles.ts',
  'quotes-render/template/script.ts',
  'quotes-render/template/document.ts',
];

const backendSrc = join(__dirname, '..');
const frontendMirror = join(__dirname, '..', '..', '..', 'frontend', 'lib', 'quotes');

describe('frontend mirror of the pure quote render graph', () => {
  const present = existsSync(frontendMirror);
  (present ? it : it.skip).each(MIRRORED)('%s is byte-identical in frontend/lib/quotes', (rel) => {
    const canonical = readFileSync(join(backendSrc, rel), 'utf8');
    const mirrored = readFileSync(join(frontendMirror, rel), 'utf8');
    expect(mirrored).toBe(canonical);
  });

  (present ? it : it.skip)('the mirror carries nothing that imports a server runtime', () => {
    for (const rel of MIRRORED) {
      const source = readFileSync(join(frontendMirror, rel), 'utf8');
      expect(source).not.toMatch(/from '@nestjs|require\(|node:fs|node:path|node:crypto/);
    }
  });
});
