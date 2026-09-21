/*
 * Updating itself.
 *
 * Chrome updates extensions from the Web Store. This one is not in the store, so
 * Chrome will never update it, and no API exists to ask. What is possible is the
 * two halves below, which together amount to the same thing:
 *
 *   1. An updater on the machine (installed by install/autoupdate-macos.sh or
 *      install/autoupdate-windows.ps1) runs the installer's --update-only path
 *      every six hours. That path fetches the newest source, compares it with the
 *      folder on disk, and swaps the folder when there is something newer. It
 *      writes update.json into the folder as the last step, so the folder itself
 *      can say which version it now holds.
 *
 *   2. The extension reads that marker through chrome.runtime.getURL, and when it
 *      names a version newer than the one running, it calls chrome.runtime.reload.
 *      Reloading re-reads the folder from disk, so the new code is live without
 *      anybody clicking the reload arrow.
 *
 * This file also checks GitHub directly, on its own, every six hours. That check
 * cannot install anything (an extension cannot write files), but it can say that
 * something newer exists, which the popup reports. If the updater on the machine
 * is not installed, the popup is the whole story; with it installed, the download
 * happens on its own and the reload follows.
 *
 * Two guards, because a self-reloading extension that gets it wrong is a loop: a
 * reload is attempted once per marker version, and if the running version is still
 * older afterwards the state records it as stuck and stops. Nothing here runs when
 * the request fails: no network, no complaint.
 */
'use strict';

const UPDATE_ALARM = 'yaz-update';
const UPDATE_KEY = 'update';
const UPDATE_MARKER = 'update.json';
const UPDATE_CHECK_MINUTES = 360;
const UPDATE_API = 'https://api.github.com/repos/sloemo01/ad-zapper/contents/manifest.json';
const UPDATE_CDN = 'https://cdn.jsdelivr.net/gh/sloemo01/ad-zapper@main/manifest.json';

const versionParts = (version) =>
  String(version || '')
    .split(/[.+-]/)
    .map((piece) => parseInt(piece, 10) || 0);

// 1 if a is newer than b, -1 if older, 0 if the same. Numeric, so 2.7.10 beats
// 2.7.9, which string comparison gets backwards.
const compareVersions = (a, b) => {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const one = left[index] || 0;
    const other = right[index] || 0;
    if (one > other) return 1;
    if (one < other) return -1;
  }
  return 0;
};

const runningVersion = () => {
  try {
    return (chrome.runtime.getManifest() || {}).version || '0';
  } catch (_) {
    return '0';
  }
};

const readState = async () => {
  try {
    const stored = await chrome.storage.local.get(UPDATE_KEY);
    const value = stored && stored[UPDATE_KEY];
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
};

const writeState = async (state) => {
  try {
    await chrome.storage.local.set({ [UPDATE_KEY]: state });
  } catch (_) {}
  return state;
};

// The folder on disk says what it holds. The query string and no-store are both
// there because a cached copy of this file would be worse than no file.
const readMarker = async () => {
  try {
    const response = await fetch(`${chrome.runtime.getURL(UPDATE_MARKER)}?running=${runningVersion()}`, {
      cache: 'no-store'
    });
    if (!response || !response.ok) return null;
    const data = await response.json();
    return data && data.version ? data : null;
  } catch (_) {
    return null;
  }
};

const fetchLatest = async () => {
  try {
    const response = await fetch(UPDATE_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github.raw' }
    });
    if (response && response.ok) {
      const data = JSON.parse(await response.text());
      if (data && data.version) return { version: String(data.version), source: 'github' };
    }
  } catch (_) {}
  // The CDN can lag behind a fresh commit, which is fine here: a lagging answer
  // says "nothing newer" and the next check catches up. It cannot invent a version.
  try {
    const response = await fetch(`${UPDATE_CDN}?t=${Date.now()}`, { cache: 'no-store' });
    if (response && response.ok) {
      const data = await response.json();
      if (data && data.version) return { version: String(data.version), source: 'cdn' };
    }
  } catch (_) {}
  return null;
};

const check = async () => {
  const running = runningVersion();
  const latest = await fetchLatest();
  const marker = await readMarker();
  const state = await readState();
  const next = {
    ...state,
    running,
    checkedAt: Date.now(),
    latest: latest ? latest.version : state.latest || null,
    source: latest ? latest.source : state.source || null,
    newer: latest ? compareVersions(latest.version, running) > 0 : false,
    staged: marker && marker.version ? marker.version : null
  };
  return writeState(next);
};

const applyIfStaged = async () => {
  const marker = await readMarker();
  if (!marker || !marker.version) return false;
  const running = runningVersion();
  if (compareVersions(marker.version, running) <= 0) return false;
  const state = await readState();
  if (state.lastReloadFor === marker.version) {
    // Asked for this version already and still running something older, so the
    // swap on disk did not take. Say so once and stop trying.
    if (state.stuck !== marker.version) {
      await writeState({ ...state, stuck: marker.version, stuckAt: Date.now() });
    }
    return false;
  }
  await writeState({
    ...state,
    lastReloadFor: marker.version,
    lastReloadAt: Date.now(),
    staged: marker.version,
    stuck: null
  });
  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch (_) {}
  }, 400);
  return true;
};

const start = () => {
  if (!chrome.alarms || !chrome.alarms.create) return false;
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: UPDATE_CHECK_MINUTES });
  return true;
};

const stats = async () => {
  const state = await readState();
  return {
    running: runningVersion(),
    latest: state.latest || null,
    newer: !!state.newer,
    staged: state.staged || null,
    stuck: state.stuck || null,
    checkedAt: state.checkedAt || null,
    every: UPDATE_CHECK_MINUTES
  };
};

self.AdblockerUpdate = {
  alarmName: UPDATE_ALARM,
  every: UPDATE_CHECK_MINUTES,
  markerFile: UPDATE_MARKER,
  compareVersions,
  runningVersion,
  readMarker,
  fetchLatest,
  check,
  applyIfStaged,
  start,
  stats
};
