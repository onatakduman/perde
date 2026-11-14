# Third-party notices

Perde bundles the following third-party software. The files are unmodified copies from the published npm package; `scripts/vendor-face-api.sh` re-creates them.

## @vladmandic/face-api 1.7.15

- Files: `perde/vendor/face-api/face-api.esm.js` and `perde/vendor/face-api/models/*`
- Source: https://github.com/vladmandic/face-api
- License: MIT, Copyright (c) Vladimir Mandic. Full text in `perde/vendor/face-api/LICENSE`.
- A maintained fork of face-api.js (MIT, Copyright (c) 2018 Vincent Mühler).

The bundle includes:

### TensorFlow.js

- Source: https://github.com/tensorflow/tfjs
- License: Apache License 2.0, Copyright Google LLC. https://www.apache.org/licenses/LICENSE-2.0

### Model weights

- `ssd_mobilenetv1_model`: SSD MobileNet V1 face detector, from face-api.js (MIT).
- `face_landmark_68_model`: 68-point face landmark model, from face-api.js (MIT).
- `face_recognition_model`: a ResNet-34-like network that turns a face into 128 numbers. The weights are a port of the face recognition model from dlib (http://dlib.net) by Davis E. King, which he released into the public domain (CC0).

## Instrument Sans

- Files: `perde/vendor/fonts/*.woff2` (from `@fontsource-variable/instrument-sans` 5.3.0; `scripts/vendor-fonts.sh` re-creates them)
- Source: https://github.com/Instrument/instrument-sans
- License: SIL Open Font License 1.1, Copyright 2022 The Instrument Sans Project Authors. Full text in `perde/vendor/fonts/LICENSE`.

## Test fixtures

The tests in `tests/faces.cjs` download public-domain portraits from Wikimedia Commons when they run. No image is stored in this repository.
