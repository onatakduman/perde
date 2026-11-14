#!/bin/bash
# Builds the ZIP that is uploaded to the Chrome Web Store: the contents of perde/ and nothing else.
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(node -p "require('./perde/manifest.json').version")
output="dist/perde-v${version}.zip"

mkdir -p dist
rm -f "$output"
(cd perde && zip -r -q "../$output" . -x "*.DS_Store" -x "*.map")

echo "Packaged $output ($(du -h "$output" | cut -f1))"
