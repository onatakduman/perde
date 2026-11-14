#!/bin/bash
# Builds a release binary and assembles build/Perde.app, including the face-api.js files that
# the extension vendors. Those files are copied at build time so that they exist once in git.
set -euo pipefail

cd "$(dirname "$0")/.."
FACE_API_DIR="${FACE_API_DIR:-../perde/vendor/face-api}"
APP="build/Perde.app"

swift build -c release
BINARY="$(swift build -c release --show-bin-path)/Perde"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/Perde"
cp Info.plist "$APP/Contents/Info.plist"

if [ -f "$FACE_API_DIR/face-api.esm.js" ]; then
  mkdir -p "$APP/Contents/Resources/face-api/models"
  cp "$FACE_API_DIR/face-api.esm.js" "$FACE_API_DIR/LICENSE" "$APP/Contents/Resources/face-api/"
  cp "$FACE_API_DIR"/models/ssd_mobilenetv1_model* \
     "$FACE_API_DIR"/models/face_landmark_68_model* \
     "$FACE_API_DIR"/models/face_recognition_model* \
     "$APP/Contents/Resources/face-api/models/"
else
  echo "warning: $FACE_API_DIR/face-api.esm.js not found; the app will blur text only" >&2
fi

# Ad-hoc signature: enough to run locally. macOS ties the Screen Recording permission to the
# signature, so the permission has to be granted again after every rebuild.
codesign --force --sign - "$APP"

echo "Built $(pwd)/$APP"
