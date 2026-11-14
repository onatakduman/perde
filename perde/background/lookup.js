// Finds a blocked person on Wikipedia so the user never has to collect photos of someone
// they do not want to see: other spellings of the name, and reference faces from public photos.
// The only data that leaves the browser is the name being looked up.
(() => {
  'use strict';

  const { fold, cleanTerm, load } = self.Perde;
  const { describeImage, addDescriptors, patchEntry } = self.PerdeFaces;

  const THUMB_WIDTH = 500; // One of the thumbnail widths Wikimedia serves without resizing on demand.
  const MAX_REFERENCES = 8;
  const MAX_CANDIDATE_PHOTOS = 12;
  const SAME_PERSON_DISTANCE = 0.5; // Stricter than matching: a wrong reference poisons every later match.
  const MAX_ALIASES = 6;
  const HUMAN = 'Q5';

  async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    return response.json();
  }

  function api(host, params) {
    return `https://${host}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`;
  }

  // The first few search hits for the name, with their lead image and Wikidata id.
  async function searchWikipedia(lang, name) {
    const data = await getJson(
      api(`${lang}.wikipedia.org`, {
        action: 'query',
        generator: 'search',
        gsrsearch: name,
        gsrnamespace: '0',
        gsrlimit: '3',
        prop: 'pageimages|pageprops',
        piprop: 'thumbnail',
        pithumbsize: String(THUMB_WIDTH),
        ppprop: 'wikibase_item',
      }),
    );
    return (data.query?.pages ?? [])
      .sort((a, b) => a.index - b.index)
      .map((page) => ({ title: page.title, thumbnail: page.thumbnail?.source ?? null, qid: page.pageprops?.wikibase_item ?? null }))
      .filter((page) => page.qid);
  }

  // Wikidata tells a person apart from a film, a band or a place with the same name.
  async function readWikidata(qids) {
    const data = await getJson(
      api('www.wikidata.org', { action: 'wbgetentities', ids: qids.join('|'), props: 'claims|aliases|labels', languages: 'tr|en' }),
    );
    const people = new Map();
    for (const [qid, entity] of Object.entries(data.entities ?? {})) {
      const isHuman = (entity.claims?.P31 ?? []).some((claim) => claim.mainsnak?.datavalue?.value?.id === HUMAN);
      if (!isHuman) continue;
      const labels = Object.values(entity.labels ?? {}).map((label) => label.value);
      const aliases = Object.values(entity.aliases ?? {}).flatMap((list) => list.map((alias) => alias.value));
      people.set(qid, { labels, aliases });
    }
    return people;
  }

  // A search can return someone else entirely; require a shared word with what the user typed.
  function sharesWord(name, candidates) {
    const words = fold(name).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
    const haystack = ` ${candidates.map((text) => fold(text)).join(' ')} `.replace(/[^\p{L}\p{N}]+/gu, ' ');
    return words.some((word) => haystack.includes(` ${word} `));
  }

  async function findPerson(name) {
    const ui = chrome.i18n.getUILanguage().split('-')[0];
    for (const lang of new Set([ui, 'en', 'tr'])) {
      let pages;
      try {
        pages = await searchWikipedia(lang, name);
      } catch {
        continue;
      }
      if (!pages.length) continue;
      const people = await readWikidata(pages.map((page) => page.qid));
      for (const page of pages) {
        const person = people.get(page.qid);
        if (person && sharesWord(name, [page.title, ...person.labels, ...person.aliases])) {
          return { lang, ...page, ...person };
        }
      }
    }
    return null;
  }

  // More public photos of the same person from Wikimedia Commons.
  async function searchCommons(label) {
    const data = await getJson(
      api('commons.wikimedia.org', {
        action: 'query',
        generator: 'search',
        gsrsearch: `"${label}" filetype:bitmap`,
        gsrnamespace: '6',
        gsrlimit: String(MAX_CANDIDATE_PHOTOS),
        prop: 'imageinfo',
        iiprop: 'url|mime',
        iiurlwidth: String(THUMB_WIDTH),
      }),
    );
    return (data.query?.pages ?? [])
      .sort((a, b) => a.index - b.index)
      .map((page) => page.imageinfo?.[0])
      .filter((info) => info && /^image\/(jpeg|png|webp)$/.test(info.mime))
      .map((info) => info.thumburl || info.url);
  }

  function distance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }

  // The article's lead photo anchors the identity; further photos are kept only when a face in
  // them is clearly the same person, which filters out group shots and namesakes.
  async function collectFaces(person) {
    const accepted = [];
    if (person.thumbnail) {
      try {
        const [face] = await describeImage(person.thumbnail);
        if (face) accepted.push(face.descriptor);
      } catch {
        // No usable lead photo: fall through to Commons.
      }
    }

    let photos = [];
    try {
      photos = await searchCommons(person.labels[0] ?? person.title);
    } catch {
      photos = [];
    }

    for (const url of photos) {
      if (accepted.length >= MAX_REFERENCES) break;
      if (url === person.thumbnail) continue;
      let faces;
      try {
        faces = await describeImage(url);
      } catch {
        continue;
      }
      if (!accepted.length) {
        // No lead photo to compare with: only trust a portrait of exactly one person.
        if (faces.length === 1) accepted.push(faces[0].descriptor);
        continue;
      }
      const same = faces.find((face) => accepted.some((known) => distance(face.descriptor, known) < SAME_PERSON_DISTANCE));
      if (same) accepted.push(same.descriptor);
    }
    return accepted;
  }

  function newAliases(entry, person) {
    const known = new Set([entry.name, ...(entry.aliases ?? [])].map((term) => fold(cleanTerm(term))));
    const found = [];
    for (const candidate of [...person.labels, person.title, ...person.aliases]) {
      const alias = cleanTerm(candidate);
      const key = fold(alias);
      if (alias.length < 4 || known.has(key)) continue;
      known.add(key);
      found.push(alias);
      if (found.length >= MAX_ALIASES) break;
    }
    return found;
  }

  // Looks the entry's name up and stores what was found on the entry itself, including a status
  // the settings page shows: { state: 'pending' | 'done' | 'none' | 'error', title, lang }.
  async function lookupEntry(entryId) {
    const { entries } = await load();
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) return { state: 'none' };

    await patchEntry(entryId, { lookup: { state: 'pending' } });
    try {
      const person = await findPerson(entry.name);
      if (!person) {
        const lookup = { state: 'none' };
        await patchEntry(entryId, { lookup });
        return lookup;
      }

      const descriptors = await collectFaces(person);
      const lookup = { state: 'done', title: person.title, lang: person.lang, faces: descriptors.length };

      // The list may have been edited while the photos were being read.
      const current = (await load()).entries.find((item) => item.id === entryId);
      if (!current) return lookup;
      const aliases = [...(current.aliases ?? []), ...newAliases(current, person)];
      if (descriptors.length) await addDescriptors(entryId, descriptors, { aliases, lookup });
      else await patchEntry(entryId, { aliases, lookup });
      return lookup;
    } catch (error) {
      console.error('[Perde] lookup failed', error);
      const lookup = { state: 'error' };
      await patchEntry(entryId, { lookup });
      return lookup;
    }
  }

  self.PerdeLookup = { lookupEntry };
})();
