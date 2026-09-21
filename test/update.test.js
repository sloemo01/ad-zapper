/*
 * Tests for src/update.js (the self-updater).
 *
 * The dangerous part of an extension that reloads itself is the failure mode:
 * a marker that keeps naming a version it cannot actually load turns into a
 * reload loop. So the checks here are mostly about restraint. One reload per
 * marker version, a stuck version recorded and never retried, silence when the
 * network or the marker is missing, and a version comparison that is numeric
 * rather than alphabetical.
 *
 * Run: node test/update.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const reloads = [];
let platform = 'mac';
let markerResponse = null;
let latestResponse = null;
let fetchCalls = [];

const sandbox = {
  chrome: {
    runtime: {
      getManifest: () => ({ version: '2.7.24' }),
      getURL: (file) => `chrome-extension://test/${file}`,
      reload: () => reloads.push(Date.now()),
      getPlatformInfo: async () => ({ os: platform })
    },
    storage: {
      local: {
        get: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const name of keys) if (name in store) out[name] = store[name];
          return out;
        },
        set: async (patch) => {
          Object.assign(store, patch);
        }
      }
    },
    alarms: { create: () => true }
  },
  fetch: async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('update.json')) {
      if (!markerResponse) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => markerResponse };
    }
    if (!latestResponse) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(latestResponse) };
  },
  setTimeout: (fn) => {
    fn();
    return 0;
  },
  console,
  Date,
  Math,
  JSON,
  Promise,
  String,
  Number,
  Object,
  Array,
  RegExp
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'update.js'), 'utf8'), sandbox, {
  filename: 'update.js'
});
const update = sandbox.AdblockerUpdate;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};

const reset = () => {
  for (const key of Object.keys(store)) delete store[key];
  reloads.length = 0;
  fetchCalls.length = 0;
  markerResponse = null;
  latestResponse = null;
};

(async () => {
  await check('versions compare as numbers, not as strings', async () => {
    assert(update.compareVersions('2.7.10', '2.7.9') === 1, '2.7.10 should beat 2.7.9');
    assert(update.compareVersions('2.7.25', '2.7.24') === 1, '2.7.25 should beat 2.7.24');
    assert(update.compareVersions('2.8', '2.7.24') === 1, 'a new minor should beat the old one');
    assert(update.compareVersions('2.7.24', '2.7.24') === 0, 'equal versions should tie');
    assert(update.compareVersions('2.7.24', '2.7.24.0') === 0, 'a trailing zero should not count');
    assert(update.compareVersions('2.6.99', '2.7.0') === -1, 'older should lose');
  });

  await check('the marker tells the truth or nothing at all', async () => {
    reset();
    assert((await update.readMarker()) === null, 'a missing marker should read as nothing');
    markerResponse = { version: '2.7.25' };
    const marker = await update.readMarker();
    assert(marker && marker.version === '2.7.25', `got ${JSON.stringify(marker)}`);
    assert(
      fetchCalls.some((url) => url.includes('no-store') === false && url.includes('update.json')),
      'the marker was not fetched from the extension folder'
    );
  });

  await check('a check records what GitHub says without installing anything', async () => {
    reset();
    latestResponse = { version: '2.7.26' };
    const state = await update.check();
    assert(state.latest === '2.7.26', `latest is ${state.latest}`);
    assert(state.newer === true, 'a newer remote version was not flagged');
    assert(state.running === '2.7.24', `running is ${state.running}`);
    assert(store.update && store.update.checkedAt, 'the check did not record a time');
  });

  await check('a broken or offline check stays quiet', async () => {
    reset();
    latestResponse = null;
    markerResponse = null;
    const state = await update.check();
    assert(state.newer === false, 'an offline check claimed an update existed');
    assert(state.latest === null, `latest is ${state.latest}`);
    assert(reloads.length === 0, 'an offline check triggered a reload');
  });

  await check('a staged newer version reloads once', async () => {
    reset();
    markerResponse = { version: '2.7.25' };
    const applied = await update.applyIfStaged();
    assert(applied === true, 'a newer marker did not apply');
    assert(reloads.length === 1, `expected one reload, got ${reloads.length}`);
    assert(store.update.lastReloadFor === '2.7.25', 'the reload was not recorded');
  });

  await check('the same marker twice does not reload twice, and is recorded as stuck', async () => {
    reset();
    markerResponse = { version: '2.7.25' };
    await update.applyIfStaged();
    reloads.length = 0;
    const again = await update.applyIfStaged();
    assert(again === false, 'the second attempt reloaded again');
    assert(reloads.length === 0, `the second attempt reloaded ${reloads.length} time(s)`);
    assert(store.update.stuck === '2.7.25', 'a version that would not load was not recorded as stuck');
  });

  await check('a marker that matches the running version is left alone', async () => {
    reset();
    markerResponse = { version: '2.7.24' };
    const applied = await update.applyIfStaged();
    assert(applied === false, 'an equal version triggered a reload');
    assert(reloads.length === 0, 'an equal version triggered a reload');
  });

  await check('the button gets a command that matches the platform', async () => {
    reset();
    platform = 'mac';
    let stats = await update.stats();
    assert(stats.os === 'mac', `os is ${stats.os}`);
    assert(/install-macos\.sh/.test(stats.command), `mac command looks wrong: ${stats.command}`);
    assert(/--update-only/.test(stats.command), 'the mac command does not update in place');
    platform = 'win';
    stats = await update.stats();
    assert(stats.os === 'win', `os is ${stats.os}`);
    assert(/install-windows\.ps1/.test(stats.command), `windows command looks wrong: ${stats.command}`);
    assert(/-UpdateOnly/.test(stats.command), 'the windows command does not update in place');
    platform = 'mac';
  });

  await check('the alarm is scheduled and the stats have the shape the popup reads', async () => {
    reset();
    assert(update.start() === true, 'the alarm was not scheduled');
    latestResponse = { version: '2.7.25' };
    markerResponse = { version: '2.7.25' };
    await update.check();
    const stats = await update.stats();
    assert(stats.every === 360, `the interval is ${stats.every}`);
    assert(stats.running === '2.7.24', `running is ${stats.running}`);
    assert(stats.newer === true && stats.staged === '2.7.25', `stats look wrong: ${JSON.stringify(stats)}`);
  });

  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
