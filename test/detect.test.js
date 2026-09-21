/*
 * Tests for src/detect.js (the generic ad detector).
 *
 * This layer guesses, so what gets checked is that every guess is bounded and
 * conservative: a standard ad size on its own is not enough, one site's element
 * never hides anything on another site, a host has to look like plumbing by name
 * or turn up on three different sites before it is promoted, and both memories
 * stay inside their caps.
 *
 * Run: node test/detect.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const sandbox = {
  chrome: {
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
    }
  },
  console,
  Date,
  Math,
  Number,
  Object,
  Array,
  String,
  RegExp,
  Set,
  Map,
  URL,
  JSON,
  Promise,
  setTimeout
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'detect.js'), 'utf8'), sandbox, {
  filename: 'detect.js'
});
const detect = sandbox.AdblockerDetect;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};

const fakePage = (nodes, resources) => {
  const makeNode = (spec) => ({
    id: spec.id || '',
    className: spec.cls || '',
    tagName: (spec.tag || 'div').toUpperCase(),
    getAttribute: (name) => (spec.attrs && spec.attrs[name]) || null,
    getBoundingClientRect: () => ({ width: spec.w || 0, height: spec.h || 0 })
  });
  return {
    location: { hostname: 'shop.example' },
    performance: { getEntriesByType: () => resources.map((name) => ({ name })) },
    document: { querySelectorAll: () => nodes.map(makeNode) }
  };
};

(async () => {
  await check('the ad-host pattern knows plumbing and leaves ordinary hosts alone', async () => {
    for (const host of ['ads.example', 'doubleclick.net', 'taboola.com', 'adservice.google.com', 'amazon-adsystem.com', 'criteo.com']) {
      assert(detect.AD_HOST.test(host), `${host} should read as ad plumbing`);
    }
    for (const host of ['example.com', 'google.com', 'cdn.example.org', 'static.bbc.co.uk', 'shop.example']) {
      assert(!detect.AD_HOST.test(host), `${host} should not read as ad plumbing`);
    }
  });

  await check('the collector finds named slots and ignores a bare standard size', async () => {
    const page = fakePage(
      [
        { tag: 'div', id: 'div-gpt-ad-1234-0', w: 300, h: 250 },
        { tag: 'img', w: 728, h: 90, attrs: { src: 'https://ads.example/banner.png' } },
        { tag: 'div', id: 'content', w: 600, h: 400 },
        { tag: 'iframe', w: 300, h: 250 }
      ],
      [
        'https://shop.example/app.js',
        'https://cdn.example.org/style.css',
        'https://ads.example/banner.png',
        'https://tracker.example.net/pixel.gif'
      ]
    );
    const payload = detect.detectCollect(
      detect.adHostSource,
      detect.adPathSource,
      detect.nameShapeSource,
      detect.sizes
    );
    const collected = vm.runInContext(
      `(${detect.detectCollect.toString()})(${JSON.stringify(detect.adHostSource)},${JSON.stringify(
        detect.adPathSource
      )},${JSON.stringify(detect.nameShapeSource)},${JSON.stringify(detect.sizes)})`,
      vm.createContext(Object.assign(page, { URL, performance: page.performance, document: page.document, location: page.location }))
    );
    assert(collected.candidates.length === 2, `expected 2 candidates, got ${collected.candidates.length}`);
    const why = collected.candidates.map((c) => c.why).sort().join(' ');
    assert(/name/.test(why), 'a named slot was not reported as named');
    assert(/host/.test(why), 'an ad-host source was not noticed');
    assert(collected.thirdParty === 3, `expected 3 third-party hosts, got ${collected.thirdParty}`);
    assert(collected.hosts.includes('ads.example'), 'the ad host was not listed');
    assert(!collected.hosts.includes('shop.example'), 'the page host listed itself');
    assert(payload && payload.candidates.length === 0, 'the worker-side collect must stay inert');
  });

  await check('a selector keeps the shape and drops the numbers', async () => {
    assert(
      detect.selectorFor({ tag: 'div', id: 'div-gpt-ad-1234-0' }) === 'div[id^="div-gpt-ad"]',
      `got ${detect.selectorFor({ tag: 'div', id: 'div-gpt-ad-1234-0' })}`
    );
    assert(
      detect.selectorFor({ tag: 'div', cls: 'ad-slot banner' }) === 'div[class*="ad-slot"]',
      `got ${detect.selectorFor({ tag: 'div', cls: 'ad-slot banner' })}`
    );
    assert(detect.selectorFor({ tag: 'div', id: 'main-content' }) === null, 'a plain element produced a selector');
    assert(detect.selectorFor({ tag: 'iframe', w: 300, h: 250 }) === null, 'a bare size produced a selector');
  });

  await check('a host is promoted by name, or by turning up on three sites', async () => {
    await detect.forget();
    let out = await detect.recordSightings('one.example', ['tracker.example.net']);
    assert(out.promoted.length === 0, 'a host seen once was promoted anyway');
    await detect.recordSightings('two.example', ['tracker.example.net']);
    out = await detect.recordSightings('three.example', ['tracker.example.net']);
    assert(out.promoted.length === 1, `three sites did not promote: ${JSON.stringify(out)}`);
    out = await detect.recordSightings('four.example', ['ads.example']);
    assert(out.promoted.length === 1 && out.promoted[0].why === 'name', 'a named host was not promoted on sight');
  });

  await check('the page host never promotes itself, and neither does its apex', async () => {
    await detect.forget();
    const out = await detect.recordSightings('shop.example', ['shop.example', 'cdn.shop.example', 'static.example']);
    const promoted = out.promoted.map((item) => item.host);
    assert(!promoted.includes('shop.example'), 'the page host promoted itself');
    assert(!promoted.includes('cdn.shop.example'), 'a first-party host was promoted');
    assert(!promoted.includes('static.example'), 'an ordinary host was promoted on one sighting');
  });

  await check('a selector only publishes once two sites have produced it', async () => {
    await detect.forget();
    let out = await detect.rememberSelectors('one.example', [{ tag: 'div', cls: 'ad-slot' }]);
    assert(out.ready.length === 0, 'one site was enough to publish a selector');
    out = await detect.rememberSelectors('two.example', [{ tag: 'div', cls: 'ad-slot' }]);
    assert(out.ready.length === 1, 'two sites did not publish the selector');
    const css = await detect.publishCss(out.state);
    assert(css.includes('div[class*="ad-slot"]'), `the sheet does not carry the selector: ${css}`);
    assert((await detect.learnedCss()).includes('display:none'), 'the sheet was not stored');
  });

  await check('both memories stay inside their caps', async () => {
    await detect.forget();
    const batch = [];
    for (let index = 0; index < 60; index++) batch.push(`host${index}.example.org`);
    for (let page = 0; page < 30; page++) {
      await detect.recordSightings(`page${page}.example`, batch.map((host) => `${page}.${host}`));
    }
    const stats = await detect.stats();
    assert(stats.hosts <= detect.hostLimit, `${stats.hosts} hosts kept, cap is ${detect.hostLimit}`);
    assert(stats.hosts >= detect.hostLimit - 60, `the cap threw away too much: ${stats.hosts}`);
  });

  await check('forget empties both memories', async () => {
    await detect.rememberSelectors('one.example', [{ tag: 'div', cls: 'ad-slot' }]);
    await detect.forget();
    const stats = await detect.stats();
    assert(stats.hosts === 0 && stats.selectors === 0, `forget left ${JSON.stringify(stats)}`);
    assert((await detect.learnedCss()) === '', 'the sheet survived forget');
  });

  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
