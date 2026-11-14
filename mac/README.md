# Perde for Mac

A small menu-bar app that applies your Perde block list to the whole screen. Wherever a blocked
person's name or face appears, in any app, Perde lays a blur patch over it.

It is the companion of the Perde browser extension in [`../perde`](../perde) and reads the block
list that the extension exports. Everything happens on your Mac: nothing is uploaded and the app
makes no network requests.

> Status: early. The text and face pipelines are tested on image files (see
> [Checking it from the command line](#checking-it-from-the-command-line)); the live
> capture-and-overlay path has had little real-world use so far.

## How it works

1. ScreenCaptureKit captures every display about three times a second, at half Retina resolution.
   Perde's own overlay is left out of the capture.
2. Vision recognises the text in each frame. A line is covered when it contains a blocked name or
   alias. Matching follows the extension exactly (`fold` and `buildMatcher` in
   [`../perde/shared/common.js`](../perde/shared/common.js)): case and accents are ignored, a name
   must stand as a whole word, and a space or hyphen in a name matches any run of spaces and hyphens.
3. Vision finds faces. Each face is cropped and described by face-api.js, the same library and
   models the extension uses, running in a hidden web view. The 128-number descriptor is compared
   with the reference faces in the block list; a Euclidean distance below `faceThreshold` is a match.
4. A transparent, click-through window on each display shows a blur patch over every match. A
   patch stays for about a second after its last sighting so that it does not flicker.

## Build and run

Requires macOS 14 or later and Xcode (or the Swift 5.9+ toolchain). There are no third-party
packages.

```sh
cd mac
./scripts/build-app.sh        # builds build/Perde.app
open build/Perde.app
```

The script builds a release binary, copies the face-api.js library and models from
`../perde/vendor/face-api` into the app bundle, and signs the bundle ad hoc. Set `FACE_API_DIR`
to take those files from somewhere else. Without them the app still works, for text only.

During development `swift run Perde` runs the app straight from the package; it then finds the
face-api files in the repository checkout (or in `PERDE_FACE_API_DIR`). `swift test` runs the
unit tests.

## The block list

1. In the extension's settings, press **Export to file**. This downloads `perde-blocklist.json`.
2. In the Perde menu choose **Open Block List Folder**
   (`~/Library/Application Support/Perde/`).
3. Move the file there, keeping its name.

The app watches the file and reloads it whenever it changes; **Reload Block List** does the same
by hand. Export again after changing the list in the extension.

The file looks like this. Unknown keys are ignored, and `faces` may be missing or empty:

```jsonc
{
  "format": "perde-blocklist",
  "version": 1,
  "faceThreshold": 0.55,
  "entries": [
    { "id": "…", "name": "Deniz Karaca", "aliases": ["Karaca"], "enabled": true, "faces": [[/* 128 numbers */]] }
  ]
}
```

## Screen Recording permission

Perde has to see the screen to find names and faces, so macOS asks for the Screen Recording
permission. The app never requests it by itself: the menu shows **Grant Screen Recording
Permission…**, and the system prompt appears when you choose that. Then switch Perde on under
System Settings → Privacy & Security → Screen & System Audio Recording; if macOS offers to quit
and reopen the app, accept.

- The build is signed ad hoc, and macOS ties the permission to the signature. After rebuilding
  the app you have to grant it again (remove the old Perde entry from the list first if the
  switch seems to have no effect).
- While Perde is watching, macOS shows its screen-recording indicator in the menu bar and may
  remind you from time to time that the app can record the screen.

## Menu

| Item | Meaning |
| --- | --- |
| Enabled | Switches watching and all patches on or off. |
| Block list: N names, N face references | What was loaded, or why nothing was. |
| Face matching: … | Whether faces are being compared. If the face model cannot be loaded, the reason is shown here and Perde carries on with text only. |
| Watching N displays | The capture state, or the permission request while permission is missing. |
| Reload Block List / Open Block List Folder | See above. |

If patches should be plain grey boxes instead of blur:
`defaults write io.github.perde.mac solidCover -bool YES`, then restart the app.

## Checking it from the command line

The same binary can run each half of the pipeline on an image file. These commands do not
capture the screen and need no permission.

```sh
BIN=build/Perde.app/Contents/MacOS/Perde     # or .build/release/Perde

# Text: lists every recognised line and marks the ones that would be covered.
$BIN --test-ocr screenshot.png --blocklist blocklist.json

# Faces: prints the descriptor of the largest face as a JSON array of 128 numbers…
$BIN --describe photo.jpg

# …and compares every face in a photo with the block list, printing the distance.
$BIN --test-face photo.jpg --blocklist blocklist.json
```

Without `--blocklist` the commands read `~/Library/Application Support/Perde/perde-blocklist.json`.

## Known limits

- **Delay.** A patch appears one capture interval (about a third of a second) plus recognition
  time after the content does, so a name or face can be visible for a moment. While scrolling,
  patches trail behind the content. This is a cover, not a guarantee.
- **It reads pixels, not apps.** Text is found by OCR: very small, low-contrast or decorative
  text can be missed or misread. The whole recognised line is covered, not just the name.
- **Faces.** Recognition is only as good as face-api.js and the reference photos. Faces need to
  be roughly frontal and at least about 40 points wide on screen; profiles, tiny thumbnails and
  covered faces are missed. At most eight faces per frame are checked, and a verdict on a face
  that has not moved is reused for two seconds.
- **First launch with faces.** WebKit has to compile the model's WebGL shaders once, which took
  about 40 seconds on an Apple silicon Mac. The menu says so while it happens, and text is
  covered meanwhile. Later launches take a second or two.
- **Protected video.** DRM-protected video (most streaming services) is black to screen
  capture, so Perde cannot see what is in it.
- **Screenshots and screen sharing.** The overlay asks macOS to leave it out of screenshots,
  recordings and shared screens, so assume those show the uncovered content.
- **System screens.** The lock screen, the login window and other system UI above ordinary
  windows are neither captured nor covered.
- **Energy.** A screen that keeps changing is recognised three times a second, which costs CPU
  and battery. A still screen costs almost nothing.

## Source layout

| File | Role |
| --- | --- |
| `Sources/Perde/PerdeApp.swift` | Entry point: menu-bar app, or one of the test commands. |
| `Sources/Perde/App.swift` | Status item, menu, permission, and when capture runs. |
| `Sources/Perde/BlockList.swift` | Reads `perde-blocklist.json`; the name matcher. |
| `Sources/Perde/Capture.swift` | ScreenCaptureKit streams, one per display. |
| `Sources/Perde/FrameScanner.swift` | Frame → boxes to cover; face detection and comparison. |
| `Sources/Perde/TextScanner.swift` | Text recognition and line matching. |
| `Sources/Perde/FaceMatcher.swift` | face-api.js in a hidden web view, served on a private URL scheme. |
| `Sources/Perde/Overlay.swift` | Overlay windows, patches and coordinate conversion. |
| `Sources/Perde/TestCommands.swift` | `--test-ocr`, `--describe`, `--test-face`. |

face-api.js and its models are MIT licensed (Vladimir Mandic); see `../perde/vendor/face-api/LICENSE`.
