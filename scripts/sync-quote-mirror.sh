#!/usr/bin/env bash
# Sync the PURE quote render graph from the backend (canonical) into the
# frontend, byte for byte. There is no shared package in this repo yet, and the
# public share page must server-render the SAME template the PDF prints — so
# the files are vendored, and `backend/src/quotes-render/mirror.spec.ts` fails
# the build the moment the two copies drift.
#
# The frontend mirror keeps the backend's DIRECTORY SHAPE under
# frontend/lib/quotes/ so every relative import inside these files resolves
# unchanged — that is what makes byte-identity possible.
#
#   backend/src/brand-ops/x.ts       →  frontend/lib/quotes/brand-ops/x.ts
#   backend/src/quotes-render/y.ts   →  frontend/lib/quotes/quotes-render/y.ts
#
# Usage: scripts/sync-quote-mirror.sh   (from anywhere; paths are repo-relative)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/backend/src"
DST="$ROOT/frontend/lib/quotes"

FILES=(
  "brand-ops/brand-ops.types.ts"
  "brand-ops/brand-tokens.ts"
  "quotes-render/quote-model.ts"
  "quotes-render/quote-view.ts"
  "quotes-render/fixtures/orderpad.fixture.ts"
  "quotes-render/template/html.ts"
  "quotes-render/template/md.ts"
  "quotes-render/template/styles.ts"
  "quotes-render/template/script.ts"
  "quotes-render/template/document.ts"
)

for f in "${FILES[@]}"; do
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
  echo "  mirrored $f"
done

echo "Mirror synced into frontend/lib/quotes (${#FILES[@]} files)."
