/*
 * Filter-list upkeep.
 *
 * The extension ships with a compiled brain (engine/dist/engine.bin) built at
 * build time. On its own that brain ages: the lists move daily and nothing on a
 * machine would ever pick that up, which is the one job every real blocker does
 * that a hand-built one skips. This module is that channel.
 *
 * A refresh: fetch the three lists, compile them with the vendored engine, then
 * prove the result works before it is allowed to replace anything. A compiled
 * set only gets cached if it blocks a known ad URL and still allows a known
 * clean URL; if it fails, the previous brain is loaded back and the old cache
 * stays. When a set passes, the compiled brain is written to IndexedDB (a few MB,
 * past what storage.local is comfortable holding) along with a small record of
 * when it happened and what came in.
 *
 * On boot the worker prefers the cached brain and falls back to the shipped one,
 * so a bad refresh can never leave the extension without a working engine.
 *
 * Rule of thumb for the sizes below: EasyList alone is over 1 MB of text, so a
 * response under 50 KB is a placeholder or an error page, not a list.
 */
'use strict';

const LIST_URLS = [
  { name: 'easylist', url: 'https://easylist.to/easylist/easylist.txt' },
  { name: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { name: 'ubo-filters', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt' }
];
const META_KEY = 'lists';
const DB_NAME = 'ad-zapper';
const DB_STORE = 'brain';
const BRAIN_KEY = 'engine.bin';
const MIN_LIST_BYTES = 50 * 1024;
const REFRESH_ALARM = 'ad-zapper:lists';
const REFRESH_MINUTES = 24 * 60;

// Both of these are decided by the engine, so they double as a check that the
// engine itself is still wired up after a compile.
const CHECK_BLOCK = { url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', type: 'script' };
const CHECK_ALLOW = { url: 'https://example.com/img/hero.jpg', type: 'image' };

let backend = null; // swapped in tests

const openDb = () =>
  new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const idbBackend = {
  async put(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    });
  },
  async get(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly');
        const request = tx.objectStore(DB_STORE).get(key);
        request.onsuccess = () => {
          const value = request.result || null;
          db.close();
          resolve(value);
        };
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    });
  }
};

const getBackend = () => backend || idbBackend;
const setBackend = (next) => {
  backend = next || null;
  return getBackend();
};

const readMeta = async () => {
  try {
    const stored = await chrome.storage.local.get(META_KEY);
    return (stored && stored[META_KEY]) || null;
  } catch (_) {
    return null;
  }
};

const writeMeta = async (meta) => {
  try {
    await chrome.storage.local.set({ [META_KEY]: meta });
  } catch (_) {}
  return meta;
};

const readBrain = async () => {
  try {
    const bytes = await getBackend().get(BRAIN_KEY);
    if (!bytes) return null;
    const size = Number(bytes.byteLength || (bytes.length || 0));
    return size > 0 ? bytes : null;
  } catch (_) {
    return null;
  }
};

const fetchText = async (url) => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (!text || text.length < MIN_LIST_BYTES) throw new Error(`only ${text ? text.length : 0} bytes`);
  return text;
};

const refresh = async () => {
  const engine = self.AdblockerEngine;
  if (!engine) return { ok: false, error: 'the engine bundle is not loaded' };
  // Compiling against nothing would leave no way back if the new set is bad, so
  // the refresh only runs while a brain is live: that is the one it restores.
  if (typeof engine.isReady === 'function' && !engine.isReady()) {
    return { ok: false, error: 'no engine is loaded to compile against' };
  }

  const texts = [];
  const lists = [];
  for (const list of LIST_URLS) {
    try {
      const text = await fetchText(list.url);
      texts.push(text);
      lists.push({ name: list.name, bytes: text.length });
    } catch (error) {
      lists.push({ name: list.name, bytes: 0, error: String((error && error.message) || error) });
    }
  }
  if (!texts.length) return { ok: false, error: 'no list could be fetched', lists };

  let previous = null;
  try {
    previous = engine.serialize();
  } catch (_) {
    previous = null;
  }

  const started = Date.now();
  let counts = null;
  try {
    counts = engine.parseFromText(texts.join('\n'));
  } catch (error) {
    if (previous) engine.loadFromBuffer(previous);
    return { ok: false, error: `compile failed: ${String((error && error.message) || error)}`, lists };
  }

  const blocksAd = engine.decide(CHECK_BLOCK);
  const allowsClean = engine.decide(CHECK_ALLOW);
  if (!blocksAd.block || allowsClean.block) {
    if (previous) engine.loadFromBuffer(previous);
    return {
      ok: false,
      error: 'the compiled lists failed the spot check',
      lists,
      counts,
      spot: { blocksAd: !!blocksAd.block, allowsClean: !allowsClean.block }
    };
  }

  let bytes = null;
  try {
    bytes = engine.serialize();
    engine.loadFromBuffer(bytes);
    if (!engine.decide(CHECK_BLOCK).block) {
      if (previous) engine.loadFromBuffer(previous);
      return { ok: false, error: 'the compiled brain did not survive serialization', lists };
    }
    await getBackend().put(BRAIN_KEY, bytes);
  } catch (error) {
    if (previous) engine.loadFromBuffer(previous);
    return { ok: false, error: `could not cache the brain: ${String((error && error.message) || error)}`, lists };
  }

  const meta = await writeMeta({
    at: Date.now(),
    ms: Date.now() - started,
    source: 'refreshed',
    counts,
    lists,
    bytes: Number(bytes.byteLength || 0)
  });
  return { ok: true, meta };
};

// Called by the deep-block loader: a cached brain, or null to use the shipped one.
const loadCachedBrain = () => readBrain();

const info = async () => {
  const meta = await readMeta();
  const cached = !!(await readBrain());
  return {
    meta,
    cached,
    urls: LIST_URLS.map((list) => list.url),
    refreshMinutes: REFRESH_MINUTES,
    alarm: REFRESH_ALARM
  };
};

const schedule = () => {
  if (!chrome.alarms) return false;
  try {
    chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES, delayInMinutes: 1 });
    return true;
  } catch (_) {
    return false;
  }
};

const clear = async () => {
  try {
    await getBackend().put(BRAIN_KEY, new Uint8Array(0));
  } catch (_) {}
  await writeMeta({ at: 0, source: 'cleared', lists: [] });
  return true;
};

self.AdblockerLists = {
  urls: LIST_URLS,
  metaKey: META_KEY,
  refreshAlarm: REFRESH_ALARM,
  refreshMinutes: REFRESH_MINUTES,
  refresh,
  loadCachedBrain,
  readMeta,
  info,
  schedule,
  clear,
  setBackend,
  getBackend,
  fetchText
};
