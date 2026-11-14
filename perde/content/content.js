// Finds text, images and video that mention or show a blocked person and covers them,
// text and described images before they are painted, faces as soon as the model has answered.
(() => {
  'use strict';

  if (globalThis.__perdeContentLoaded) return;
  globalThis.__perdeContentLoaded = true;

  const { load, buildMatcher, hostKey, usesFaces, t } = globalThis.Perde;

  const ATTR = 'data-perde';
  const REVEALED = 'data-perde-revealed';
  const WRAP = 'data-perde-wrap';
  const CHECK = 'data-perde-check'; // An image waiting for the face model's answer.
  const UI_ATTR = 'data-perde-ui';
  const PAGE_ATTR = 'data-perde-page';
  const PENDING_ATTR = 'data-perde-pending';

  const TASK_BUDGET_MS = 50; // A task longer than this counts as a long task.
  const MAX_CARD_TEXT = 1200; // A card (tweet, search result, video tile) holds less text than this.
  const MAX_BLOCK_TEXT = 3000; // Never blur a block with more text than this; wrap the matching text instead.
  const MAX_CARD_AREA = 0.3; // ...and takes up less of the window than this.
  const MIN_FACE_IMAGE = 64; // Smaller images cannot hold a recognisable face.
  const VIDEO_SAMPLE_MS = 600; // How often a playing video is checked.
  const VIDEO_FRAME_SIDE = 480; // Frames are scaled down to this before they are sent to the model.
  const VIDEO_CLEAN_FRAMES = 3; // Consecutive clean frames before a video is uncovered again.

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'select', 'svg', 'math', 'head']);
  const SKIP_SELECTOR =
    'script, style, noscript, template, textarea, select, svg, math, head, ' +
    `[contenteditable]:not([contenteditable="false"]), [${UI_ATTR}]`;
  const CARD_SELECTOR = 'article, li, tr, figure, blockquote, [role="article"], [role="listitem"], [role="row"]';
  const MEDIA_SELECTOR = 'img, video, picture, canvas';
  const OBSERVED_ATTRIBUTES = ['alt', 'title', 'aria-label', 'src', 'srcset', 'poster', 'href'];

  // Element rules of content.css, repeated for shadow roots, where the page-level stylesheet does not reach.
  const SHADOW_CSS = `
    [${ATTR}="blur"]:not([${REVEALED}]) { filter: blur(var(--perde-radius, 16px)) !important; cursor: pointer !important; user-select: none !important; }
    [${ATTR}="cover"]:not([${REVEALED}]) { filter: contrast(0) !important; background-color: #808080 !important; cursor: pointer !important; user-select: none !important; }
    [${ATTR}="hide"] { display: none !important; }
    [${CHECK}] { filter: blur(var(--perde-radius, 16px)) !important; }
    ::highlight(perde-cover) { color: transparent; background-color: #808080; }
    ::highlight(perde-hide) { color: transparent; }
  `;

  const root = document.documentElement;
  const isTop = window === window.top;

  let settings = null;
  let matcher = null;
  let active = false;
  let faceOn = false; // Face matching is on and at least one name has reference faces.

  let imageState = new WeakMap(); // img -> { src, verdict: 'pending' | 'match' | 'clean' | 'skip' }
  const videoState = new WeakMap(); // video -> { busy, clean, unreadable }
  const videoTimers = new Map(); // video -> interval id, only while it plays
  const faceCoveredVideos = new WeakSet();
  const nearViewport = new IntersectionObserver(onImagesNearViewport, { rootMargin: '600px' });

  // Names covered on their own are drawn with the CSS Custom Highlight API: a Range per match,
  // so the page's own elements and text nodes are never wrapped, split or moved.
  const canHighlight = typeof Highlight === 'function' && Boolean(CSS.highlights);
  const highlights = new Map(); // "cover", "hide" or "blur:<text colour>" -> Highlight
  const MAX_BLUR_COLOURS = 32; // Beyond this many text colours on one page, the rest share a grey.
  let blurSheet = null; // One ::highlight() rule per text colour, shared with every shadow root.
  const nameRanges = new Map(); // Text node -> its Range objects
  const revealedText = new WeakSet(); // Text nodes the user uncovered by clicking

  const shadowRoots = []; // WeakRef<ShadowRoot>
  const knownShadowRoots = new WeakSet();
  const revealed = new WeakSet();
  const rechecks = new Set();
  let queue = [];
  let queueHead = 0;
  let processing = false;

  let shadowSheet = null;
  let pageBlocked = false;
  let pageRevealedTitle = null;
  let noticeHost = null;
  let toastHost = null;
  let toastTimer = 0;
  let countTimer = 0;
  let lastSentCount = -1;

  // ---------------------------------------------------------------- startup

  // Keep the page invisible until the block list has been read, so nothing flashes unblurred.
  root.setAttribute(PENDING_ATTR, '');
  const pendingTimer = setTimeout(clearPending, 400);

  function clearPending() {
    clearTimeout(pendingTimer);
    root.removeAttribute(PENDING_ATTR);
  }

  const observer = new MutationObserver(onMutations);

  init();

  async function init() {
    try {
      await reload();
      chrome.storage.onChanged.addListener(onStorageChanged);
      chrome.runtime.onMessage.addListener(onMessage);
      window.addEventListener('click', onClick, true);
      window.addEventListener('auxclick', onClick, true);
    } catch (error) {
      console.warn('[Perde] could not start', error);
    } finally {
      clearPending();
    }
  }

  async function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    try {
      await reload();
    } catch (error) {
      teardown();
    }
  }

  async function reload() {
    settings = await load();
    matcher = buildMatcher(settings.entries);
    const paused = settings.pausedHosts.includes(hostKey(location.hostname));
    const shouldRun = settings.enabled && !paused && matcher !== null;

    stop();
    faceOn = shouldRun && usesFaces(settings);
    root.style.setProperty('--perde-radius', `${settings.blurRadius}px`);
    if (shouldRun) start();
    scheduleCount();
  }

  function start() {
    active = true;
    observer.observe(root, observerOptions());
    for (const shadow of liveShadowRoots()) observer.observe(shadow, observerOptions());
    enqueue(root);
    for (const shadow of liveShadowRoots()) pushQueue(shadow);
    process();
  }

  function stop() {
    active = false;
    observer.disconnect();
    queue = [];
    queueHead = 0;
    rechecks.clear();
    for (const scope of [document, ...liveShadowRoots()]) {
      for (const el of scope.querySelectorAll(`[${ATTR}]`)) unmark(el);
      for (const el of scope.querySelectorAll(`[${CHECK}]`)) el.removeAttribute(CHECK);
    }
    for (const highlight of highlights.values()) highlight.clear();
    nameRanges.clear();
    nearViewport.disconnect();
    imageState = new WeakMap(); // Answers still on their way now belong to no image and are dropped.
    for (const timer of videoTimers.values()) clearInterval(timer);
    videoTimers.clear();
    setPageBlocked(false);
  }

  // The extension was reloaded or removed: this script can no longer reach it, so undo everything.
  function teardown() {
    stop();
    clearPending();
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('auxclick', onClick, true);
  }

  function observerOptions() {
    return { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: OBSERVED_ATTRIBUTES };
  }

  // ---------------------------------------------------------------- observing

  function onMutations(records) {
    if (!chrome.runtime?.id) {
      teardown();
      return;
    }
    if (!active) return;

    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) enqueue(node);
      } else if (record.type === 'characterData') {
        enqueue(record.target);
      } else {
        const el = record.target;
        if (el.localName === 'img' || el.localName === 'video') {
          enqueue(el);
        } else if (el.localName === 'a') {
          for (const media of el.querySelectorAll('img, video')) enqueue(media);
        }
      }
    }
    process();
  }

  function enqueue(node) {
    if (node.nodeType !== 1 && node.nodeType !== 3) return;
    if (node.nodeType === 3) uncoverNames(node); // Its text changed: whatever was covered in it is stale.
    if (!node.isConnected) return;

    const el = node.nodeType === 1 ? node : node.parentElement;
    if (el) {
      // Something changed inside a covered block: check that block again instead of covering twice.
      const container = el.closest(`[${ATTR}]`);
      if (container) {
        rechecks.add(container);
        return;
      }
      if (el.closest(SKIP_SELECTOR)) return;
    }
    pushQueue(node);
  }

  function pushQueue(node) {
    queue.push(node);
  }

  function nextQueued() {
    if (queueHead >= queue.length) {
      queue = [];
      queueHead = 0;
      return null;
    }
    return queue[queueHead++];
  }

  // Runs synchronously inside the mutation callback (before the next paint) and only
  // yields when a single pass takes longer than the task budget.
  async function process() {
    if (processing) return;
    processing = true;
    let deadline = performance.now() + TASK_BUDGET_MS;
    try {
      while (active) {
        if (rechecks.size) {
          const containers = [...rechecks];
          rechecks.clear();
          for (const container of containers) {
            if (!container.isConnected) continue;
            unmark(container);
            deadline = await scan(container, deadline);
          }
          continue;
        }
        const node = nextQueued();
        if (!node) break;
        if (node.isConnected) deadline = await scan(node, deadline);
      }
    } catch (error) {
      console.warn('[Perde] scan failed', error);
    } finally {
      processing = false;
    }
    for (const node of nameRanges.keys()) {
      if (!node.isConnected) uncoverNames(node); // The page removed the text; let its ranges go.
    }
    checkPage();
    scheduleCount();
  }

  function yieldToMain() {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ---------------------------------------------------------------- scanning

  const walkerFilter = {
    acceptNode(node) {
      if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
      return isSkipped(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  };

  function isSkipped(el) {
    if (SKIP_TAGS.has(el.localName)) return true;
    if (el.hasAttribute(ATTR) || el.hasAttribute(UI_ATTR)) return true;
    const editable = el.getAttribute('contenteditable');
    return editable !== null && editable !== 'false';
  }

  async function scan(start, deadline) {
    if (start.nodeType === 3) {
      checkText(start);
      return deadline;
    }
    if (start.nodeType === 1) {
      if (isSkipped(start)) return deadline;
      if (visitElement(start)) return deadline;
    }

    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkerFilter);
    let node = walker.nextNode();
    while (node && active) {
      const marked = node.nodeType === 3 ? checkText(node) : visitElement(node);
      if (marked) {
        // The covered block encloses the whole subtree being scanned: nothing left to do.
        if (marked === start || !start.contains(marked)) return deadline;
        walker.currentNode = marked;
        node = nextOutside(walker);
      } else {
        node = walker.nextNode();
      }
      if (performance.now() >= deadline) {
        await yieldToMain();
        deadline = performance.now() + TASK_BUDGET_MS;
      }
    }
    return deadline;
  }

  // Next node in document order that is not inside the walker's current node.
  function nextOutside(walker) {
    for (;;) {
      const sibling = walker.nextSibling();
      if (sibling) return sibling;
      if (!walker.parentNode()) return null;
    }
  }

  function visitElement(el) {
    if (el.shadowRoot) adoptShadowRoot(el.shadowRoot);
    const name = el.localName;
    if (name !== 'img' && name !== 'video') return null;
    if (mediaMatches(el)) return mark(mediaContainer(el));
    if (!faceOn) return null;
    if (name === 'img') return watchImage(el);
    if (settings.faceVideo) watchVideo(el);
    return null;
  }

  function mediaContainer(el) {
    return el.closest('picture, figure') ?? el;
  }

  function checkText(node) {
    const value = node.nodeValue;
    if (value.length < matcher.minLength || !matcher.test(value)) return null;
    if (settings.scope === 'name' && canHighlight) {
      coverNames(node);
      return null;
    }
    return mark(containerForText(node));
  }

  // ---------------------------------------------------------------- covering a name on its own

  // A highlight can only paint a text shadow in a colour named in its rule, and a blurred name
  // should keep the colour of the text it replaces. So blurred names are grouped by text colour,
  // each group with its own registered highlight and its own rule.
  function highlightFor(node) {
    const mode = settings.mode;
    let key = mode;
    let colour = null;
    if (mode === 'blur') {
      colour = node.parentElement ? getComputedStyle(node.parentElement).color : 'rgb(128, 128, 128)';
      key = `blur:${colour}`;
      if (!highlights.has(key) && highlights.size >= MAX_BLUR_COLOURS) {
        colour = 'rgb(128, 128, 128)';
        key = `blur:${colour}`;
      }
    }

    let highlight = highlights.get(key);
    if (!highlight) {
      highlight = new Highlight();
      const name = colour ? `perde-blur-${highlights.size}` : `perde-${mode}`;
      highlights.set(key, highlight);
      CSS.highlights.set(name, highlight);
      if (colour) {
        // Three stacked shadows: one is soft enough but too faint, three read as a solid smudge.
        blurSheet ??= new CSSStyleSheet();
        blurSheet.insertRule(`::highlight(${name}) { color: transparent; text-shadow: 0 0 0.75em ${colour}, 0 0 0.75em ${colour}, 0 0 0.75em ${colour}; }`);
      }
    }
    if (blurSheet) adoptSheet(document, blurSheet);
    return highlight;
  }

  // Pages replace their adopted style sheets now and then, so this is checked on every use.
  function adoptSheet(scope, sheet) {
    if (!scope.adoptedStyleSheets.includes(sheet)) scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
  }

  function coverNames(node) {
    uncoverNames(node);
    if (revealedText.has(node)) return;
    const highlight = highlightFor(node);
    const ranges = matcher.findAll(node.nodeValue).map(({ start, end }) => {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      highlight.add(range);
      return range;
    });
    if (ranges.length) nameRanges.set(node, ranges);
  }

  function uncoverNames(node) {
    const ranges = nameRanges.get(node);
    if (!ranges) return;
    for (const highlight of highlights.values()) {
      for (const range of ranges) highlight.delete(range);
    }
    nameRanges.delete(node);
  }

  // The text node whose covered name is under the pointer, if any.
  function coveredTextAt(x, y) {
    if (!nameRanges.size) return null;
    const node = document.caretPositionFromPoint?.(x, y)?.offsetNode ?? document.caretRangeFromPoint?.(x, y)?.startContainer;
    const ranges = node && nameRanges.get(node);
    if (!ranges) return null;
    // The caret lookup snaps to the nearest text, so make sure the pointer is really on a covered name.
    const hit = ranges.some((range) => [...range.getClientRects()].some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom));
    return hit ? node : null;
  }

  // An image has no text of its own, so look at what describes it: alt text, file name, link and caption.
  function mediaMatches(el) {
    for (const attribute of ['alt', 'title', 'aria-label']) {
      const value = el.getAttribute(attribute);
      if (value && matcher.test(value)) return true;
    }

    const source = el.currentSrc || el.getAttribute('src') || '';
    if (source && !source.startsWith('data:') && !source.startsWith('blob:') && matcher.testUrl(source)) return true;
    const poster = el.getAttribute('poster');
    if (poster && matcher.testUrl(poster)) return true;

    const link = el.closest('a[href]');
    if (link) {
      if (matcher.testUrl(link.getAttribute('href'))) return true;
      const label = link.getAttribute('title') || link.getAttribute('aria-label');
      if (label && matcher.test(label)) return true;
    }

    const caption = el.closest('figure')?.querySelector('figcaption');
    return Boolean(caption && matcher.test(caption.textContent.slice(0, 400)));
  }

  // ---------------------------------------------------------------- faces in images

  // Text is matched on the spot, but the face model answers later. Until then the image stays
  // blurred (when pre-blur is on), so a blocked face is never shown and then taken away.
  function watchImage(img) {
    const src = img.currentSrc || img.src;
    const known = imageState.get(img);
    if (known && known.src === src) {
      // The block around it was re-scanned: reuse the earlier answer instead of asking again.
      return known.verdict === 'match' ? mark(mediaContainer(img)) : null;
    }

    const state = { src, verdict: 'pending' };
    imageState.set(img, state);
    if (settings.facePreBlur) img.setAttribute(CHECK, '');

    if (img.complete) {
      imageLoaded(img, state);
    } else {
      const loaded = () => imageLoaded(img, state);
      img.addEventListener('load', loaded, { once: true });
      img.addEventListener('error', loaded, { once: true });
    }
    return null;
  }

  function imageLoaded(img, state) {
    if (imageState.get(img) !== state) return; // The image got a new source in the meantime.
    state.src = img.currentSrc || img.src;
    if (!active || !isFaceCandidate(img, state.src)) {
      state.verdict = 'skip';
      img.removeAttribute(CHECK);
      return;
    }
    nearViewport.observe(img); // Ask only once it is close to the screen: the visible part of a page goes first.
  }

  function isFaceCandidate(img, src) {
    if (!src || src.length > 4_000_000) return false;
    if (img.naturalWidth < MIN_FACE_IMAGE || img.naturalHeight < MIN_FACE_IMAGE) return false;
    return !/^data:image\/svg|\.svg(?:[?#]|$)/i.test(src);
  }

  function onImagesNearViewport(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      nearViewport.unobserve(entry.target);
      checkImage(entry.target);
    }
  }

  async function checkImage(img) {
    const state = imageState.get(img);
    if (!state || state.verdict !== 'pending') return;

    let verdict = null;
    try {
      // A blob: address only means something inside this page, so send the pixels instead.
      const src = state.src.startsWith('blob:') ? await blobToDataUrl(state.src) : state.src;
      verdict = await askFace(src, false);
    } catch {
      verdict = null; // Unreadable image or unreachable extension: show it rather than hide it forever.
    }

    if (imageState.get(img) !== state) return;
    state.verdict = verdict?.match ? 'match' : 'clean';
    img.removeAttribute(CHECK);
    if (verdict?.match && active) {
      mark(mediaContainer(img));
      scheduleCount();
    }
  }

  async function askFace(src, volatile) {
    const reply = await chrome.runtime.sendMessage({ type: 'perde:face-check', src, volatile });
    return reply && !reply.error ? reply : null;
  }

  async function blobToDataUrl(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------- faces in video

  // A video cannot be checked ahead of time, so a playing video is sampled a few times a second
  // and covered while a blocked face is on screen. The first frames of a scene can slip through.
  function watchVideo(video) {
    if (!videoState.has(video)) {
      videoState.set(video, { busy: false, clean: 0, unreadable: false });
      video.addEventListener('playing', () => startSampling(video));
      for (const type of ['pause', 'ended', 'emptied']) video.addEventListener(type, () => stopSampling(video));
    }
    if (!video.paused && !video.ended) startSampling(video);
  }

  function startSampling(video) {
    const state = videoState.get(video);
    if (!active || !faceOn || !settings.faceVideo || state.unreadable || videoTimers.has(video)) return;
    videoTimers.set(video, setInterval(() => sampleVideo(video, state), VIDEO_SAMPLE_MS));
    sampleVideo(video, state);
  }

  function stopSampling(video) {
    clearInterval(videoTimers.get(video));
    videoTimers.delete(video);
  }

  async function sampleVideo(video, state) {
    if (!video.isConnected) {
      stopSampling(video);
      return;
    }
    if (state.busy || document.hidden || video.readyState < 2 || !video.videoWidth) return;

    state.busy = true;
    try {
      const scale = Math.min(1, VIDEO_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

      let frame;
      try {
        frame = canvas.toDataURL('image/jpeg', 0.7);
      } catch {
        // Cross-origin video without CORS: the browser will not let a script read its pixels.
        state.unreadable = true;
        stopSampling(video);
        return;
      }

      const verdict = await askFace(frame, true);
      if (!active || !faceOn) return;
      if (verdict?.match) {
        state.clean = 0;
        if (!video.hasAttribute(ATTR)) {
          faceCoveredVideos.add(video);
          mark(video);
          scheduleCount();
        }
      } else if (faceCoveredVideos.has(video) && video.hasAttribute(ATTR) && ++state.clean >= VIDEO_CLEAN_FRAMES) {
        faceCoveredVideos.delete(video);
        unmark(video);
        scheduleCount();
      }
    } catch {
      // The extension was reloaded mid-request; the next mutation tears this script down.
    } finally {
      state.busy = false;
    }
  }

  // ---------------------------------------------------------------- choosing what to cover

  function containerForText(node) {
    const parent = node.parentElement;
    if (!parent) return coverTextOnly(node); // Text sitting directly in a shadow root.
    if (parent.hasAttribute(WRAP)) return parent;

    const picked = settings.scope === 'card' ? pickContainer(parent) : blockOf(parent);
    if (picked === document.body || picked === root || picked.textContent.length > MAX_BLOCK_TEXT) {
      return coverTextOnly(node);
    }
    return picked;
  }

  // The block around the match is too large to cover: cover the name itself instead.
  function coverTextOnly(node) {
    if (!canHighlight) return wrapText(node);
    coverNames(node);
    return null;
  }

  // Prefer the whole card (thumbnail + title + description) over the single line that matched.
  function pickContainer(start) {
    const base = blockOf(start);
    let firstRepeated = null;
    let mediaWrapper = null;
    let el = base;

    const viewportArea = window.innerWidth * window.innerHeight;
    for (let depth = 0; depth < 10 && el && el !== document.body && el !== root; depth++) {
      const length = el.textContent.length;
      if (length > MAX_CARD_TEXT) break;
      // A card is a small thing. A section with little text can still fill the screen
      // (a film page: poster, title, a short summary), and that is not a card.
      const box = el.getBoundingClientRect();
      if (depth > 0 && box.width * box.height > viewportArea * MAX_CARD_AREA) break;

      const hasMedia = el.querySelector(MEDIA_SELECTOR) !== null;
      if (el.matches(CARD_SELECTOR) || isRepeated(el)) {
        firstRepeated ??= el;
        if (hasMedia) return el;
      } else if (hasMedia && depth <= 3 && length <= 600) {
        mediaWrapper ??= el;
      }
      el = el.parentElement;
    }
    return firstRepeated ?? mediaWrapper ?? base;
  }

  // Nearest ancestor that is laid out as a block.
  function blockOf(el) {
    let current = el;
    for (let i = 0; i < 6; i++) {
      const parent = current.parentElement;
      if (!parent || parent === document.body) break;
      const display = getComputedStyle(current).display;
      if (display !== 'inline' && display !== 'contents') break;
      current = parent;
    }
    return current;
  }

  // An element with siblings of the same tag and class is one item of a list: a card, a row, a result.
  function isRepeated(el) {
    const parent = el.parentElement;
    if (!parent) return false;
    const tag = el.localName;
    const className = el.className;
    let sibling = parent.firstElementChild;
    for (let i = 0; sibling && i < 60; i++, sibling = sibling.nextElementSibling) {
      if (sibling !== el && sibling.localName === tag && sibling.className === className) return true;
    }
    return false;
  }

  function wrapText(node) {
    const span = document.createElement('span');
    span.setAttribute(WRAP, '');
    node.replaceWith(span);
    span.append(node);
    return span;
  }

  function mark(el) {
    if (!el || el === root || el === document.body) return null;
    for (const inner of el.querySelectorAll(`[${ATTR}]`)) unmark(inner);
    el.setAttribute(ATTR, settings.mode);
    if (revealed.has(el)) el.setAttribute(REVEALED, '');
    return el;
  }

  function unmark(el) {
    el.removeAttribute(ATTR);
    el.removeAttribute(REVEALED);
  }

  // ---------------------------------------------------------------- shadow DOM

  function adoptShadowRoot(shadow) {
    if (knownShadowRoots.has(shadow)) return;
    knownShadowRoots.add(shadow);
    shadowRoots.push(new WeakRef(shadow));

    try {
      shadowSheet ??= createShadowSheet();
      blurSheet ??= new CSSStyleSheet();
      adoptSheet(shadow, shadowSheet);
      adoptSheet(shadow, blurSheet);
    } catch {
      const style = document.createElement('style');
      style.setAttribute(UI_ATTR, '');
      style.textContent = SHADOW_CSS;
      shadow.append(style);
    }

    observer.observe(shadow, observerOptions());
    pushQueue(shadow);
  }

  function createShadowSheet() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHADOW_CSS);
    return sheet;
  }

  function liveShadowRoots() {
    const live = [];
    for (let i = shadowRoots.length - 1; i >= 0; i--) {
      const shadow = shadowRoots[i].deref();
      if (shadow) live.push(shadow);
      else shadowRoots.splice(i, 1);
    }
    return live;
  }

  // ---------------------------------------------------------------- revealing

  function onClick(event) {
    if (!active) return;
    const text = coveredTextAt(event.clientX, event.clientY);
    if (text) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (settings.revealOnClick && settings.mode !== 'hide' && event.type === 'click') {
        revealedText.add(text);
        uncoverNames(text);
        scheduleCount();
      }
      return;
    }

    const target = event.composedPath().find(
      (node) => node.nodeType === 1 && node.hasAttribute(ATTR) && !node.hasAttribute(REVEALED),
    );
    if (!target) return;

    // The first click never reaches the page: it only uncovers the block (or does nothing when reveal is off).
    event.preventDefault();
    event.stopImmediatePropagation();
    if (settings.revealOnClick && event.type === 'click') {
      revealed.add(target);
      target.setAttribute(REVEALED, '');
      scheduleCount();
    }
  }

  // ---------------------------------------------------------------- whole-page block

  function checkPage() {
    if (!isTop) return;
    const title = document.title;
    if (title !== pageRevealedTitle) pageRevealedTitle = null;
    const hit = active && settings.blockPage && pageRevealedTitle === null && matcher.test(title);
    setPageBlocked(hit);
  }

  function setPageBlocked(blocked) {
    if (blocked === pageBlocked) return;
    pageBlocked = blocked;
    root.toggleAttribute(PAGE_ATTR, blocked);
    if (blocked) showNotice();
    else hideNotice();
  }

  function showNotice() {
    hideNotice();
    const { host, shadow } = createUiHost('inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none;');

    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-labelledby', 'title');
    card.setAttribute('aria-describedby', 'text');

    const title = document.createElement('h2');
    title.id = 'title';
    title.textContent = t('pageBlockedTitle');
    const text = document.createElement('p');
    text.id = 'text';
    text.textContent = t('pageBlockedText');

    const actions = document.createElement('div');
    actions.className = 'actions';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'primary';
    back.textContent = t('pageBack');
    back.addEventListener('click', () => history.back());
    actions.append(back);

    if (settings.revealOnClick) {
      const show = document.createElement('button');
      show.type = 'button';
      show.textContent = t('pageShow');
      show.addEventListener('click', () => {
        pageRevealedTitle = document.title;
        setPageBlocked(false);
        scheduleCount();
      });
      actions.append(show);
    }

    card.append(title, text, actions);
    shadow.append(card);
    root.append(host);
    noticeHost = host;
  }

  function hideNotice() {
    noticeHost?.remove();
    noticeHost = null;
  }

  // ---------------------------------------------------------------- injected UI

  const UI_CSS = `
    .card, .toast {
      color-scheme: light dark;
      font: 14px/1.45 system-ui, sans-serif;
      pointer-events: auto;
    }
    /* Paper and ink, like the popup: a drawn frame, heavy tight type, no colour. */
    .card {
      width: min(342px, calc(100vw - 32px)); padding: 22px 24px 24px; text-align: start;
      background: light-dark(#f5f4f0, #121212); color: light-dark(#111111, #f5f4f0);
      border: 1.5px solid light-dark(#111111, #f5f4f0); border-radius: 8px;
      box-shadow: 0 18px 50px rgb(0 0 0 / 0.28);
    }
    h2 { margin: 0 0 6px; font-size: 24px; font-weight: 700; letter-spacing: -0.035em; line-height: 1.05; }
    p { margin: 0 0 20px; color: light-dark(#6b6a66, #a3a29d); }
    .actions { display: flex; gap: 8px; }
    button {
      font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 6px; cursor: pointer;
      border: 1.5px solid light-dark(#111111, #f5f4f0); background: transparent; color: inherit;
    }
    button.primary { background: light-dark(#111111, #f5f4f0); color: light-dark(#f5f4f0, #121212); }
    button:focus-visible { outline: 2px solid light-dark(#111111, #f5f4f0); outline-offset: 2px; }
    .toast {
      padding: 10px 16px; margin-bottom: 24px; border-radius: 6px; font-weight: 600;
      background: light-dark(#111111, #f5f4f0); color: light-dark(#f5f4f0, #121212);
      box-shadow: 0 10px 30px rgb(0 0 0 / 0.25);
    }
  `;

  function createUiHost(layout) {
    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    host.style.cssText = `all: initial; position: fixed; z-index: 2147483647; ${layout}`;
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.append(style);
    return { host, shadow };
  }

  function showToast(message) {
    toastHost?.remove();
    clearTimeout(toastTimer);
    const { host, shadow } = createUiHost('inset: auto 0 0 0; display: flex; justify-content: center; pointer-events: none;');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    shadow.append(toast);
    root.append(host);
    toastHost = host;
    toastTimer = setTimeout(() => host.remove(), 2600);
  }

  // ---------------------------------------------------------------- talking to the extension

  function countCovered() {
    let count = pageBlocked ? 1 : 0;
    for (const ranges of nameRanges.values()) count += ranges.length;
    for (const scope of [document, ...liveShadowRoots()]) {
      count += scope.querySelectorAll(`[${ATTR}]:not([${REVEALED}])`).length;
    }
    return count;
  }

  function scheduleCount() {
    if (!isTop) return;
    clearTimeout(countTimer);
    countTimer = setTimeout(sendCount, 250);
  }

  async function sendCount() {
    const count = active ? countCovered() : 0;
    if (count === lastSentCount) return;
    lastSentCount = count;
    try {
      await chrome.runtime.sendMessage({ type: 'perde:count', count });
    } catch {
      // The service worker is unreachable (extension reloaded); the badge simply stays as it was.
    }
  }

  function onMessage(message, sender, sendResponse) {
    if (message?.type === 'perde:state') {
      if (!isTop) return false;
      sendResponse({
        host: hostKey(location.hostname),
        count: active ? countCovered() : 0,
        active,
      });
    } else if (message?.type === 'perde:toast') {
      showToast(String(message.text ?? ''));
    }
    return false;
  }
})();
