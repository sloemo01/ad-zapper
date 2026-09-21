/*
 * Adaptive layer: what the extension remembers about sites, and what it does
 * with the memory it holds.
 *
 * Three jobs, all small enough to live inside a service worker:
 *
 *   1. Site memory. A page that has produced ads before is worth attaching the
 *      DevTools stack to the moment it loads; a page that has produced nothing
 *      over several visits is not. That judgement needs a record per site, and
 *      records need a cap plus an eviction rule or they become the leak.
 *   2. Caches with real budgets. Element-hiding CSS is kept per host, bounded by
 *      both a host count and a total byte budget, least-recently-used first out.
 *   3. Rolling cost. A meter keeps the last N samples of engine work, so a tab
 *      whose filtering has turned pathological can be detached instead of
 *      quietly slowing the browser down.
 *
 * Nothing here is clever for its own sake: every number is a cap, and every cap
 * has an eviction path.
 */
'use strict';

const SITE_KEY = 'sites';
const SITE_LIMIT = 1500;
const HOT_ADS = 3;
const HOT_POPUPS = 1;
const WARM_VISITS = 4;

const makeLru = ({ entries = 400, bytes = 2 * 1024 * 1024 } = {}) => {
  const map = new Map();
  let total = 0;
  const trim = () => {
    while (map.size > entries || total > bytes) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      const value = map.get(oldest.value);
      total -= (value && Number(value.bytes)) || 0;
      map.delete(oldest.value);
    }
  };
  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      const size = (value && Number(value.bytes)) || 0;
      if (map.has(key)) {
        total -= (map.get(key) && Number(map.get(key).bytes)) || 0;
        map.delete(key);
      }
      map.set(key, value);
      total += size;
      trim();
      return value;
    },
    has: (key) => map.has(key),
    size: () => map.size,
    bytes: () => total,
    clear: () => {
      map.clear();
      total = 0;
    }
  };
};

const makeMeter = (size = 64) => {
  const samples = [];
  return {
    add(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value < 0) return 0;
      samples.push(value);
      if (samples.length > size) samples.shift();
      return value;
    },
    count: () => samples.length,
    avg() {
      if (!samples.length) return 0;
      return samples.reduce((total, value) => total + value, 0) / samples.length;
    },
    p95() {
      if (!samples.length) return 0;
      const sorted = samples.slice().sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    },
    reset() {
      samples.length = 0;
    }
  };
};

const describeBytes = (value) => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Chrome only. When it is missing the panel hides the line instead of guessing.
const heapBytes = () => {
  try {
    const memory = performance && performance.memory;
    const used = memory && Number(memory.usedJSHeapSize);
    return Number.isFinite(used) && used > 0 ? used : null;
  } catch (_) {
    return null;
  }
};

const normalizeHost = (host) => String(host || '').trim().toLowerCase().replace(/^www\./, '');

const readSites = async () => {
  try {
    const stored = await chrome.storage.local.get(SITE_KEY);
    const records = stored && stored[SITE_KEY];
    return records && typeof records === 'object' ? records : {};
  } catch (_) {
    return {};
  }
};

const writeSites = async (records) => {
  try {
    await chrome.storage.local.set({ [SITE_KEY]: records });
  } catch (_) {}
  return records;
};

const entryOf = (records, host) =>
  records[host] || { visits: 0, ads: 0, popups: 0, rewrites: 0, firstSeen: 0, lastSeen: 0, heavyUntil: 0 };

// Keeps the registry under SITE_LIMIT by dropping whichever sites were seen
// longest ago.
const trimSites = (records) => {
  const hosts = Object.keys(records);
  if (hosts.length <= SITE_LIMIT) return records;
  hosts.sort((a, b) => (records[a].lastSeen || 0) - (records[b].lastSeen || 0));
  const drop = hosts.length - SITE_LIMIT;
  for (let index = 0; index < drop; index++) delete records[hosts[index]];
  return records;
};

const rememberSite = async (host, patch = {}) => {
  const clean = normalizeHost(host);
  if (!clean || !clean.includes('.')) return null;
  const records = await readSites();
  const entry = Object.assign(entryOf(records, clean), patch);
  const now = Date.now();
  if (!entry.firstSeen) entry.firstSeen = now;
  entry.lastSeen = now;
  records[clean] = entry;
  await writeSites(trimSites(records));
  return entry;
};

const scoreSite = async (host) => {
  const clean = normalizeHost(host);
  if (!clean) return { host: '', hot: false, warm: false, entry: null };
  const records = await readSites();
  const entry = records[clean] || null;
  if (!entry) return { host: clean, hot: false, warm: false, entry: null };
  const hot = entry.ads >= HOT_ADS || entry.popups >= HOT_POPUPS || entry.rewrites >= HOT_ADS;
  const warm = !hot && entry.visits >= WARM_VISITS && entry.ads === 0 && entry.popups === 0;
  return { host: clean, hot, warm, entry };
};

const forgetSites = async () => {
  await writeSites({});
  return true;
};

const siteStats = async () => {
  const records = await readSites();
  return { hosts: Object.keys(records).length, limit: SITE_LIMIT };
};

self.AdblockerSmart = {
  siteKey: SITE_KEY,
  siteLimit: SITE_LIMIT,
  hotAds: HOT_ADS,
  hotPopups: HOT_POPUPS,
  makeLru,
  makeMeter,
  describeBytes,
  heapBytes,
  normalizeHost,
  rememberSite,
  scoreSite,
  siteStats,
  forgetSites,
  readSites
};
