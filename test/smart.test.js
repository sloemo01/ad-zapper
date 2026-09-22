/*
 * Tests for src/smart.js: the caches with budgets, the rolling cost meter, and
 * the site registry with its eviction rule.
 *
 * smart.js is plain JS over chrome.storage.local, so a fake chrome in node:vm is
 * enough to exercise the real logic.
 *
 * Run: node test/smart.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'smart.js'), 'utf8');

const store = {};
const chrome = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => {
        Object.assign(store, obj);
      }
    }
  }
};

const sandbox = { chrome, console, Date, Math, Number, Object, JSON, Array, String, performance, self: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'smart.js' });
const smart = vm.runInContext('self.AdblockerSmart', sandbox);

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

(async () => {
  await check('exports the adaptive layer', async () => {
    assert(smart && typeof smart.makeLru === 'function', 'makeLru missing');
    assert(typeof smart.makeMeter === 'function', 'makeMeter missing');
    assert(typeof smart.scoreSite === 'function', 'scoreSite missing');
    assert(smart.siteLimit > 100, 'expected a real site limit');
  });

  await check('the cache evicts by entry count, least recently used first', async () => {
    const lru = smart.makeLru({ entries: 3, bytes: 1024 * 1024 });
    lru.set('a', { bytes: 1 });
    lru.set('b', { bytes: 1 });
    lru.set('c', { bytes: 1 });
    lru.get('a'); // touch: 'b' is now the oldest
    lru.set('d', { bytes: 1 });
    assert(lru.size() === 3, `expected 3 entries, got ${lru.size()}`);
    assert(lru.has('a'), 'the recently used entry was evicted');
    assert(lru.has('d'), 'the new entry was evicted');
    assert(!lru.has('b'), 'the least recently used entry survived');
  });

  await check('the cache also evicts by total bytes', async () => {
    const lru = smart.makeLru({ entries: 100, bytes: 1000 });
    lru.set('big1', { bytes: 400 });
    lru.set('big2', { bytes: 400 });
    assert(lru.bytes() === 800, `expected 800 bytes, got ${lru.bytes()}`);
    lru.set('big3', { bytes: 400 });
    assert(lru.bytes() === 800, `expected the total to stay under the cap, got ${lru.bytes()}`);
    assert(lru.size() === 2, `expected 2 entries after eviction, got ${lru.size()}`);
    assert(!lru.has('big1'), 'the oldest entry should have gone');
    assert(lru.has('big3'), 'the newest entry should be there');
  });

  await check('replacing a key does not double count its bytes', async () => {
    const lru = smart.makeLru({ entries: 10, bytes: 1000 });
    lru.set('page', { bytes: 500 });
    lru.set('page', { bytes: 300 });
    assert(lru.bytes() === 300, `expected 300 bytes after replacement, got ${lru.bytes()}`);
    assert(lru.size() === 1, `expected 1 entry, got ${lru.size()}`);
  });

  await check('the meter keeps a rolling window and reports p95', async () => {
    const meter = smart.makeMeter(100);
    for (let value = 1; value <= 100; value += 1) meter.add(value);
    assert(meter.count() === 100, `expected 100 samples, got ${meter.count()}`);
    const p95 = meter.p95();
    assert(p95 >= 94 && p95 <= 96, `expected p95 near 95, got ${p95}`);
    const avg = meter.avg();
    assert(avg > 49 && avg < 51, `expected an average near 50, got ${avg}`);
  });

  await check('the meter window is bounded and rejects noise', async () => {
    const meter = smart.makeMeter(5);
    for (let value = 0; value < 20; value += 1) meter.add(value);
    assert(meter.count() === 5, `expected the window to hold 5 samples, got ${meter.count()}`);
    meter.add('nonsense');
    meter.add(-5);
    assert(meter.count() === 5, 'junk samples should be ignored');
    assert(meter.p95() === 19, `expected 19 as the sample p95, got ${meter.p95()}`);
    meter.reset();
    assert(meter.count() === 0 && meter.p95() === 0, 'reset should empty the meter');
  });

  await check('describes byte counts the way the panel shows them', async () => {
    assert(smart.describeBytes(512) === '512 B', smart.describeBytes(512));
    assert(smart.describeBytes(2048) === '2 KB', smart.describeBytes(2048));
    assert(smart.describeBytes(4.5 * 1024 * 1024) === '4.5 MB', smart.describeBytes(4.5 * 1024 * 1024));
    assert(smart.describeBytes(0) === '0 B', smart.describeBytes(0));
  });

  await check('normalises hosts before they are remembered', async () => {
    assert(smart.normalizeHost('WWW.CNN.com') === 'cnn.com', smart.normalizeHost('WWW.CNN.com'));
    assert(smart.normalizeHost('  VfxMed.com ') === 'vfxmed.com', smart.normalizeHost('  VfxMed.com '));
    assert(smart.normalizeHost('') === '', 'an empty host should stay empty');
  });

  await check('remembers a site and calls it hot once it has a record', async () => {
    await smart.forgetSites();
    const fresh = await smart.scoreSite('vfxmed.com');
    assert(fresh.hot === false, 'a brand new site should not be hot');

    // rememberSite patches a record, it does not add to it: the worker reads the
    // record, adds the event, and writes the whole thing back.
    await smart.rememberSite('www.vfxmed.com', { visits: 1 });
    await smart.rememberSite('www.vfxmed.com', { visits: 2 });
    await smart.rememberSite('www.vfxmed.com', { popups: 1 });
    const scored = await smart.scoreSite('www.vfxmed.com');
    assert(scored.entry.visits === 2, `expected the patched visit count, got ${scored.entry.visits}`);
    assert(scored.entry.popups === 1, 'the popup should be recorded');
    assert(scored.hot === true, 'one caught popup should make a site hot');

    const byAds = await smart.rememberSite('adsy.example', { ads: 3 });
    assert(byAds.ads === 3, 'ads should be recorded');
    const adsy = await smart.scoreSite('adsy.example');
    assert(adsy.hot === true, 'three ads should make a site hot');
  });

  await check('marks a quiet, often visited site warm instead of hot', async () => {
    await smart.rememberSite('quiet.example', { visits: 5 });
    const scored = await smart.scoreSite('quiet.example');
    assert(scored.hot === false, 'a quiet site is not hot');
    assert(scored.warm === true, 'four or more clean visits should read as warm');
  });

  await check('trims the registry oldest-first at the limit', async () => {
    const records = {};
    for (let index = 0; index < smart.siteLimit; index += 1) {
      records[`site${index}.example`] = { visits: 1, ads: 0, popups: 0, rewrites: 0, lastSeen: 1000 + index };
    }
    await chrome.storage.local.set({ [smart.siteKey]: records });

    await smart.rememberSite('newcomer.example', { visits: 1 });
    const after = (await chrome.storage.local.get(smart.siteKey))[smart.siteKey];
    const hosts = Object.keys(after);
    assert(hosts.length === smart.siteLimit, `expected ${smart.siteLimit} records, got ${hosts.length}`);
    assert(!after['site0.example'], 'the oldest site should have been dropped');
    assert(after['newcomer.example'], 'the new site must be kept');
    await smart.forgetSites();
  });

  await check('site stats report what is being held', async () => {
    await smart.forgetSites();
    await smart.rememberSite('one.example', { visits: 1 });
    await smart.rememberSite('two.example', { visits: 1 });
    const stats = await smart.siteStats();
    assert(stats.hosts === 2, `expected 2 hosts, got ${stats.hosts}`);
    assert(stats.limit === smart.siteLimit, 'the limit should be reported');
    const heap = smart.heapBytes();
    assert(heap === null || heap > 0, 'heapBytes should be null or a real number');
  });

  // --- the deep ledger ------------------------------------------------------

  await check('a page-world host is never offered a CDP session', async () => {
    for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'i.ytimg.com']) {
      const verdict = await smart.deepVerdict(host);
      assert(verdict.attach === false, `${host} would attach`);
      assert(verdict.why === 'page-world', `${host} gave "${verdict.why}"`);
    }
    const other = await smart.deepVerdict('example.com');
    assert(other.attach === true, 'example.com should still be attachable');
  });

  await check('a host whose ads are handled without it loses its place', async () => {
    await smart.rememberSite('busy.example', { ads: 6, visits: 6 });
    const verdict = await smart.deepVerdict('busy.example');
    assert(verdict.attach === false, 'busy.example would attach');
    assert(verdict.why === 'handled without it', `got "${verdict.why}"`);
  });

  await check('sessions without benefit stop the attaching', async () => {
    await smart.deepEvent('costly.example', { deepSessions: 3 });
    const verdict = await smart.deepVerdict('costly.example');
    assert(verdict.attach === false, 'costly.example would attach');
    assert(/no benefit/.test(verdict.why), `got "${verdict.why}"`);
  });

  await check('a walled host keeps its session even after useless ones', async () => {
    await smart.deepEvent('wall.example', { deepSessions: 3 });
    const withoutWall = await smart.deepVerdict('wall.example');
    assert(withoutWall.attach === false, 'the ledger should refuse a host with no benefit');
    // Same record, now a host the wall defence owns: the rules stand down there, so
    // a refusal is not "less blocking", it is none at all.
    // the suite's sandbox has its own `self`, which is what the module reads
    sandbox.self.AdblockerDeep = { isWalledHost: (host) => String(host).endsWith('wall.example') };
    const verdict = await smart.deepVerdict('wall.example');
    assert(verdict.attach === true, 'the wall defence was refused a session');
    assert(verdict.why === 'wall defence', `got "${verdict.why}"`);
    delete sandbox.self.AdblockerDeep;
    const again = await smart.deepVerdict('wall.example');
    assert(again.attach === false, 'the exemption outlived the wall');
  });

  await check('one answered request buys the session back', async () => {
    await smart.deepEvent('costly.example', { deepBenefit: 1 });
    const verdict = await smart.deepVerdict('costly.example');
    assert(verdict.attach === true, 'a host with benefit must keep attaching');
    assert(verdict.why === 'has benefit', `got "${verdict.why}"`);
  });

  await check('the ledger counts both directions', async () => {
    await smart.deepEvent('counted.example', { deepSessions: 2, deepBenefit: 5 });
    await smart.deepEvent('counted.example', { deepSessions: 1 });
    const after = (await smart.readSites())['counted.example'];
    assert(after.deepSessions === 3, `sessions did not accumulate: ${after.deepSessions}`);
    assert(after.deepBenefit === 5, `benefit was clobbered: ${after.deepBenefit}`);
  });

  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
