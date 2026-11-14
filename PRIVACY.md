# Privacy Policy for Perde

Last updated: 14 November 2026

Perde is a browser extension that covers content about people you choose. It has no server, no account and no analytics. This page says exactly what it stores and what it sends.

## What is stored, and where

All of the following is kept in the browser's local extension storage on your device (`chrome.storage.local`). It is not synced to other devices and is never sent to the developer.

- **Your block list**: the names you add and their other spellings.
- **Reference faces**: for each name, up to 20 face descriptors. A descriptor is a list of 128 numbers computed from a photo; the photos themselves are not kept.
- **Your settings**: the look of covered content, face sensitivity, the sites where you paused the extension, and the other switches on the settings page.

## What the extension reads

To do its job the extension reads the text and images of the pages you visit. This happens inside your browser. Page content is not stored and is not sent anywhere.

To compare faces, the extension downloads an image a second time from the address the page itself loaded it from, and checks it with a face model that runs on your device. The image is not sent to any other party.

## What is sent off your device

One thing: **the names you add**, and only while "Look new names up on Wikipedia" is on (it is on by default; you can turn it off on the settings page).

When you add a name, or press "Search Wikipedia" for one, the name is sent as a search query to:

- Wikipedia (`*.wikipedia.org`), to find the article about the person;
- Wikidata (`www.wikidata.org`), to confirm the article is about a human and to read other spellings;
- Wikimedia Commons (`commons.wikimedia.org`, `upload.wikimedia.org`), to read public photos of the person, from which reference faces are computed on your device.

These services are run by the Wikimedia Foundation and see the request like any other visit to their sites. Their privacy policy: https://foundation.wikimedia.org/wiki/Policy:Privacy_policy

Nothing else is transmitted. The extension does not use cookies of its own, does not track what you browse, and does not contain advertising or analytics code.

## Sharing and selling

No data is shared with or sold to anyone. The developer never receives any of your data.

## Keeping and deleting data

Data stays until you remove it. You can:

- remove a name, or clear its reference faces, on the settings page;
- export everything to a file, or replace everything by importing a file;
- delete everything by removing the extension from Chrome.

## Changes to this policy

If the extension starts to store or send anything else, this page is updated in the same release and the change is noted in the release notes.

## Contact

Questions and requests: open an issue at https://github.com/onatakduman/perde/issues.
