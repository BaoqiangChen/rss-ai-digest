#!/usr/bin/env sh
# Builds dist/rss-ai-digest-<version>.xpi from the add-on files (tests and tooling excluded).
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p dist
OUT="dist/rss-ai-digest-$VERSION.xpi"
rm -f "$OUT"
zip -r -X -q "$OUT" manifest.json background.js lib options popup icons README.md
echo "Built $OUT"
