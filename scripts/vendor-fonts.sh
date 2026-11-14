#!/bin/bash
# Re-creates perde/vendor/fonts from the published npm package (Instrument Sans, SIL Open Font License).
set -euo pipefail

VERSION="5.3.0"
cd "$(dirname "$0")/.."
target="perde/vendor/fonts"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

(cd "$work" && npm pack "@fontsource-variable/instrument-sans@${VERSION}" --silent >/dev/null && tar -xzf fontsource-variable-instrument-sans-*.tgz)

mkdir -p "$target"
cp "$work/package/files/instrument-sans-latin-wdth-normal.woff2" "$target/instrument-sans-latin.woff2"
cp "$work/package/files/instrument-sans-latin-ext-wdth-normal.woff2" "$target/instrument-sans-latin-ext.woff2"
cp "$work/package/LICENSE" "$target/LICENSE"

echo "Vendored @fontsource-variable/instrument-sans@${VERSION} into $target"
