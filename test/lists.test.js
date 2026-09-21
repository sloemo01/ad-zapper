/*
 * Tests for src/lists.js: the refresh path (fetch, compile, prove, cache), the
 * failure paths that must not break the running engine, and the cached brain the
 * deep-block loader reads at boot.
 *
 * The engine here is the real bundle and the real shipped brain; only chrome.*,
 * fetch and the storage backend are fakes. That means this exercises the same
 * code the worker runs, with real filter syntax.
 *
 * Run: node test/lists.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'lists.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'engine', 'dist', 'engine.bundle.js'), 'utf8');
const shipped = fs.readFileSync(path.join(root, 'engine', 'dist', 'engine.bin'));

const PROBE = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
const CLEAN = 'https://example.com/img/hero.jpg';

// The module refuses anything under 50 KB as a placeholder, so the fake lists
// carry a real amount of filler plus the rules each check wants.
const filler = '! filler line, only here to clear the size floor\n'.repeat(1500);
const listText = (rules) => `! Ad Zapper test list\n${filler}${rules || ''}\n`;

const LISTS = {
  'https://easylist.to/easylist/easylist.txt': listText('||securepubads.g.doubleclick.net^'),
  'https://easylist.to/easylist/easyprivacy.txt': listText('||tracker.example^'),
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt': listText('||ads.example^')
};

const calls = { fetch: [], put: [], alarms: [] };
const cache = new Map();

const backend = {
  put: async (key, value) => {
    calls.put.push({ key, bytes: value.byteLength });
    cache.set(key, value);
    return true;
  },
  get: async (key) => cache.get(key) || null
};

const store = {};
const chrome = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => {
        Object.assign(store, obj);
      }
    }
  },
  alarms: {
    create: (name, options) => calls.alarms.push({ name, ...options })
  }
};

const fetch = async (url) => {
  calls.fetch.push(url);
  if (!(url in LISTS)) return { ok: false, status: 404 };
  return { ok: true, text: async () => LISTS[url] };
};

const sandbox = {
  chrome,
  console,
  Date,
  Math,
  Number,
  Object,
  JSON,
  Array,
  String,
  Uint8Array,
  TextEncoder,
  TextDecoder,
  fetch,
  performance,
  self: {}
};

vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'engine.bundle.js' });
vm.runInContext(source, sandbox, { filename: 'lists.js' });

const engine = vm.runInContext('self.AdblockerEngine', sandbox);
const lists = vm.runInContext('self.AdblockerLists', sandbox);
lists.setBackend(backend);

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'assertion failed');
};

const decide = (url, type) => engine.decide({ url, sourceUrl: 'https://example.com/', type });

(async () => {
  await check('compiles against the shipped brain and reports its size', async () => {
    const counts = engine.loadFromBuffer(shipped);
    assert(counts.network > 100000, `expected a real brain, got ${counts.network} network filters`);
    assert(engine.isReady(), 'the engine should be ready after loading');
    assert(decide(PROBE, 'script').block === true, 'the shipped brain should block the ad probe');
    assert(decide(CLEAN, 'image').block === false, 'the shipped brain should allow a clean image');
  });

  await check('takes a refresh that passes the spot check, and caches the brain', async () => {
    const before = calls.put.length;
    const result = await lists.refresh();
    assert(result.ok === true, `expected the refresh to succeed, got ${JSON.stringify(result.error || result)}`);
    assert(result.meta.counts.network > 0, 'the refresh should report what it compiled');
    assert(result.meta.ms >= 0 && result.meta.at > 0, 'the record should carry a time and a duration');
    assert(calls.put.length === before + 1, 'the compiled brain should have been cached once');

    const cached = await lists.loadCachedBrain();
    assert(cached && cached.byteLength > 0, `expected a cached brain, got ${cached && cached.byteLength}`);
    assert(cached.byteLength === calls.put[calls.put.length - 1].bytes, 'the cache should hold what was serialized');

    assert(decide(PROBE, 'script').block === true, 'the refreshed brain should block the probe');
    assert(decide(CLEAN, 'image').block === false, 'the refreshed brain should still allow a clean image');
    assert(decide('https://ads.example/banner.png', 'image').block === true, 'the refreshed rules should be live');
  });

  await check('restores the previous brain when a refresh fails the spot check', async () => {
    const puts = calls.put.length;
    LISTS['https://easylist.to/easylist/easylist.txt'] = listText('');
    const result = await lists.refresh();
    assert(result.ok === false, 'a set that does not block the probe must be refused');
    assert(/spot check/.test(result.error || ''), `expected a spot check failure, got ${result.error}`);
    assert(result.spot && result.spot.blocksAd === false, 'the failure should say what the probe saw');
    assert(calls.put.length === puts, 'a rejected set must not be cached');
    assert(decide(PROBE, 'script').block === true, 'the previous brain should be live again');

    LISTS['https://easylist.to/easylist/easylist.txt'] = listText('||securepubads.g.doubleclick.net^');
  });

  await check('keeps the good lists when one of them fails', async () => {
    const good = LISTS['https://easylist.to/easylist/easyprivacy.txt'];
    delete LISTS['https://easylist.to/easylist/easyprivacy.txt'];
    const result = await lists.refresh();
    assert(result.ok === true, `expected a refresh from the remaining lists, got ${result.error}`);
    const privacy = result.meta.lists.find((entry) => entry.name === 'easyprivacy');
    assert(privacy && privacy.error, 'the failed list should be recorded with its error');
    const easy = result.meta.lists.find((entry) => entry.name === 'easylist');
    assert(easy && easy.bytes > 50000, 'the good list should be recorded with its size');
    LISTS['https://easylist.to/easylist/easyprivacy.txt'] = good;
  });

  await check('refuses to refresh when no list can be fetched', async () => {
    const saved = { ...LISTS };
    for (const url of Object.keys(LISTS)) delete LISTS[url];
    const result = await lists.refresh();
    assert(result.ok === false, 'a refresh with no lists must fail');
    assert(/no list/.test(result.error || ''), `expected a "no list" error, got ${result.error}`);
    assert(result.lists.length === 3, 'every attempted list should be reported');
    assert(decide(PROBE, 'script').block === true, 'the engine should be untouched');
    Object.assign(LISTS, saved);
  });

  await check('refuses to compile when no brain is loaded', async () => {
    engine.unload();
    const result = await lists.refresh();
    assert(result.ok === false, 'a refresh without a live engine must fail');
    assert(/no engine is loaded/.test(result.error || ''), `expected a "no engine" error, got ${result.error}`);
    engine.loadFromBuffer(shipped);
  });

  await check('schedules the daily refresh through the platform alarm', async () => {
    const scheduled = lists.schedule();
    assert(scheduled === true, 'the alarm should have been created');
    const alarm = calls.alarms.find((entry) => entry.name === lists.refreshAlarm);
    assert(alarm, 'the refresh alarm should be registered under its own name');
    assert(alarm.periodInMinutes === lists.refreshMinutes, `expected ${lists.refreshMinutes} minutes, got ${alarm.periodInMinutes}`);
    assert(lists.refreshMinutes >= 60 * 12, 'lists should not be hammered more than a couple of times a day');
  });

  await check('reports what it is holding, and can let go of it', async () => {
    const info = await lists.info();
    assert(info.cached === true, 'a cached brain should be reported');
    assert(info.meta && info.meta.source === 'refreshed', `expected a refreshed source, got ${info.meta.source}`);
    assert(info.urls.length === 3, 'the three list sources should be reported');

    await lists.clear();
    assert((await lists.loadCachedBrain()) === null, 'clearing should drop the cached brain');
    const after = await lists.readMeta();
    assert(after.source === 'cleared', 'clearing should be recorded');
  });

  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
