# Perde

*Türkçe: [README.tr.md](README.tr.md)*

Perde ("curtain" in Turkish) is a Chrome extension that covers content about people you would rather not see. You give it names; it blurs the text, images and video that mention or show them, on every site, before the page is painted.

Everything is decided on your computer. There is no account, no server and no analytics.

## What it covers

| Content | How it is recognised | When it is covered |
|---|---|---|
| Text | The name or one of its other spellings, ignoring case and accents (`DENİZ KARACA'nın` matches `Deniz Karaca`; `Karacaoğlan` does not match `Karaca`) | Before the first paint |
| More than the name, if you want | A setting: only the name (the default), its line or paragraph, or the whole card around it (a search result, a tweet, a video tile with its thumbnail) | Before the first paint |
| Images described in text | Alt text, file name, the link around the image, the caption | Before the first paint |
| Images that only show the person | An on-device face model compares faces with reference faces for that name | The image stays blurred until the check is done, then opens or stays covered |
| Playing video | A frame is checked about twice a second | While the face is on screen; the first moment of a scene can be visible |
| Whole pages | The page title matches | Before the first paint, with "Go back" and "Show anyway" |

Covered content can be blurred, replaced by a grey block, or removed from the page. A click reveals a blurred block unless you turn that off.

## Reference faces without looking at the person

Collecting photos of someone you do not want to see defeats the purpose, so Perde does it for you. When you add a name it looks the person up on Wikipedia, checks on Wikidata that the article is about a human, and reads reference faces from the article's lead photo and from Wikimedia Commons. Photos are only accepted when the face in them clearly matches the lead photo. No photo is shown to you or kept: only 128 numbers per face are stored.

You can turn the lookup off, add your own photos instead, or clear the faces of any name in the settings.

## Install

**From source**

1. Clone this repository: `git clone https://github.com/onatakduman/perde.git`
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select the `perde` folder.

Requires Chrome 123 or later.

## Use

- Click the toolbar icon and type a name, or select a name on any page, right-click and choose **Perde: block**.
- Open **All settings** for other spellings, reference faces, the look of covered content, face sensitivity, paused sites and backup.
- The toolbar badge shows how many blocks are covered on the current page.

## Limits

- An image with no describing text is only caught when the name has reference faces and the face is large and clear enough. Faces smaller than roughly 40 pixels, heavy profile views and masks are often missed.
- Face matching makes mistakes in both directions: look-alikes can be covered and unusual photos can be missed. The sensitivity setting trades one for the other.
- Video is sampled, not analysed frame by frame. Protected (DRM) video and cross-origin video without CORS cannot be read by any extension.
- CSS background images are not checked.
- A name split across elements (`Deniz <b>Karaca</b>`) only matches if the part on its own is listed as another spelling.
- The text in the tab strip cannot be covered.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: the block list and the face references stay in the browser's local extension storage. The only thing sent anywhere is the name you add, to Wikipedia, Wikidata and Wikimedia Commons, and only while the lookup setting is on. Images are compared on your device.

## macOS companion

[`mac/`](mac/) holds a small menu-bar app that applies the same block list to the whole screen (any app, not just the browser) by reading the screen with ScreenCaptureKit and Vision. Export your list from the extension's settings and the app reads the same file. See [mac/README.md](mac/README.md) for what it can and cannot do.

## Project layout

```
perde/                 the extension (load this folder unpacked)
  manifest.json
  shared/common.js     settings, name matching, backup format
  content/             finds and covers content in pages
  background/          context menu, badge, face references, Wikipedia lookup
  offscreen/           hidden page that runs the face model
  popup/  options/     the two pieces of UI
  vendor/face-api/     third-party face model (see THIRD_PARTY_NOTICES.md)
  vendor/fonts/        Instrument Sans, the interface typeface
  _locales/            English and Turkish
mac/                   macOS menu-bar app
tests/                 end-to-end tests
scripts/               packaging and vendoring
```

## Development

```bash
npm install
npx playwright install chromium
npm test            # text, cards, images by context, settings, popup (offline)
npm run test:faces  # face matching and the Wikipedia lookup (needs the network)
npm run package     # dist/perde-v<version>.zip for the Chrome Web Store
npm run vendor      # re-create perde/vendor (face model and fonts) from the npm packages
```

The tests load the unpacked extension into Chromium. Branded Google Chrome no longer accepts `--load-extension`, so they need Chromium or Chrome for Testing; point `CHROMIUM` at a binary to use a specific one.

## Continuous integration and releases

- **CI** (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests: `npm run check`, the end-to-end tests in Chromium, the store package as a build artifact, and `swift build` plus `swift test` for the macOS app.
- **Release** (`.github/workflows/release.yml`) runs when a tag is pushed. Bump `version` in `perde/manifest.json` and `package.json`, commit, then:

  ```bash
  git tag v0.2.2 && git push origin v0.2.2
  ```

  The tag has to match the manifest version. The workflow tests, packages, and creates a GitHub release with `perde-v<version>.zip` attached.
- **Chrome Web Store upload** is an optional third job in the release workflow. It stays off until these exist in the repository settings:
  - variables `CWS_PUBLISHER_ID` (Developer Dashboard, Publisher > Settings) and `CWS_EXTENSION_ID` (the 32-character item id);
  - secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN`, from a Google Cloud OAuth client with the Chrome Web Store API enabled ([guide](https://developer.chrome.com/docs/webstore/using-api)).

  It uploads the package as a draft. Set the variable `CWS_AUTO_PUBLISH` to `true` to also submit it for review. The store listing itself (texts, screenshots, privacy answers) cannot be set through the API and stays in the dashboard.

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
