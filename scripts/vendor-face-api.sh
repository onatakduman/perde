#!/bin/bash
# Re-creates perde/vendor/face-api from the published npm package, so anyone can check that the
# vendored files are the unmodified upstream build.
set -euo pipefail

VERSION="1.7.15"
cd "$(dirname "$0")/.."
target="perde/vendor/face-api"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

(cd "$work" && npm pack "@vladmandic/face-api@${VERSION}" --silent >/dev/null && tar -xzf vladmandic-face-api-*.tgz)

mkdir -p "$target/models"
cp "$work/package/dist/face-api.esm.js" "$work/package/LICENSE" "$target/"
for model in ssd_mobilenetv1_model face_landmark_68_model face_recognition_model; do
  cp "$work/package/model/$model.bin" "$work/package/model/$model-weights_manifest.json" "$target/models/"
done

echo "Vendored @vladmandic/face-api@${VERSION} into $target"
