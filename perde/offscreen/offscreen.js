// The face model runs here: one hidden page for the whole browser, so the 13 MB of weights are
// loaded once instead of once per tab. Offscreen documents can only use chrome.runtime messaging,
// so the service worker hands over the reference faces and relays every request.
import * as faceapi from '../vendor/face-api/face-api.esm.js';

// A path, not a full chrome-extension:// address: the library only understands http(s) or paths.
const MODEL_URL = '/vendor/face-api/models';
const MAX_SIDE = 800; // Larger images are scaled down before detection.
const MIN_SIDE = 48; // Anything smaller cannot hold a recognisable face.
const CACHE_LIMIT = 3000;

let gallery = { threshold: 0.55, references: [] }; // references: Float32Array[]
const verdicts = new Map(); // image URL -> { match, faces, distance }
const jobs = [];
let running = false;
let modelsReady = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  (async () => {
    try {
      sendResponse(await handle(message));
    } catch (error) {
      sendResponse({ error: String(error?.message ?? error) });
    }
  })();
  return true;
});

async function handle(message) {
  switch (message.type) {
    case 'face:gallery':
      setGallery(message.gallery);
      return { ok: true };
    case 'face:check':
      return check(message.src, Boolean(message.volatile));
    case 'face:describe':
      return schedule(() => describe(message.src, 0.5), true);
    default:
      throw new Error(`unknown message ${message.type}`);
  }
}

function setGallery(next) {
  gallery = {
    threshold: Number(next?.threshold) || 0.55,
    references: (next?.people ?? []).flatMap((person) => person.descriptors.map((values) => Float32Array.from(values))),
  };
  verdicts.clear();
}

// ---------------------------------------------------------------- model

function loadModels() {
  modelsReady ??= (async () => {
    try {
      try {
        await faceapi.tf.setBackend('webgl');
        await faceapi.tf.ready();
      } catch {
        await faceapi.tf.setBackend('cpu'); // No GPU context available: slower, still correct.
        await faceapi.tf.ready();
      }
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
    } catch (error) {
      modelsReady = null; // Let the next request try again instead of failing forever.
      throw new Error(`face model could not be loaded: ${error?.message ?? error}`);
    }
    // After a browser restart this page starts empty: ask for the reference faces once.
    const current = await chrome.runtime.sendMessage({ type: 'perde:gallery-request' });
    if (current) setGallery(current);
  })();
  return modelsReady;
}

// The model uses one GPU context, so requests run one at a time. Video frames and enrolment
// go to the front: a frame is stale within a second, and a person is waiting on enrolment.
function schedule(job, urgent = false) {
  return new Promise((resolve, reject) => {
    const item = { job, resolve, reject };
    if (urgent) jobs.unshift(item);
    else jobs.push(item);
    pump();
  });
}

async function pump() {
  if (running) return;
  running = true;
  while (jobs.length) {
    const { job, resolve, reject } = jobs.shift();
    try {
      resolve(await job());
    } catch (error) {
      reject(error);
    }
  }
  running = false;
}

// ---------------------------------------------------------------- requests

async function check(src, volatile) {
  const cacheable = !volatile && src.length < 2048;
  if (cacheable && verdicts.has(src)) return verdicts.get(src);

  const verdict = await schedule(async () => {
    await loadModels();
    if (!gallery.references.length) return { match: false, faces: 0, distance: null };
    const { faces } = await describe(src, 0.4);
    let best = Infinity;
    for (const face of faces) {
      for (const reference of gallery.references) best = Math.min(best, distance(face.descriptor, reference));
    }
    return { match: best < gallery.threshold, faces: faces.length, distance: Number.isFinite(best) ? best : null };
  }, volatile);

  if (cacheable) {
    if (verdicts.size >= CACHE_LIMIT) verdicts.delete(verdicts.keys().next().value);
    verdicts.set(src, verdict);
  }
  return verdict;
}

// Every face in the image, largest first, each with its 128-number descriptor.
async function describe(src, minConfidence) {
  await loadModels();
  const canvas = await toCanvas(src);
  if (!canvas) return { faces: [] };

  const results = await faceapi
    .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence, maxResults: 12 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  const faces = results
    .map((result) => ({
      descriptor: Array.from(result.descriptor),
      area: result.detection.box.width * result.detection.box.height,
      score: result.detection.score,
    }))
    .sort((a, b) => b.area - a.area);
  return { faces };
}

async function toCanvas(src) {
  const blob = await fetchBlob(src);
  if (blob.type.includes('svg')) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    if (Math.min(bitmap.width, bitmap.height) < MIN_SIDE) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

async function fetchBlob(src) {
  let response;
  try {
    response = await fetch(src, { credentials: 'omit' });
  } catch (error) {
    throw new Error(`image could not be fetched: ${error?.message ?? error}`);
  }
  // Some images are only served to a signed-in session; the page already loaded them that way.
  if (!response.ok && !src.startsWith('data:')) response = await fetch(src, { credentials: 'include' });
  if (!response.ok) throw new Error(`image request failed (${response.status})`);
  return response.blob();
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}
