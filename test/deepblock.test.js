/*
 * Tests for src/deepblock.js (automatic CDP interception).
 *
 * Deep block talks to chrome.debugger and to the vendored engine, so the test
 * fakes both: a debugger that records attach/detach/sendCommand (and hands back
 * response bodies for Fetch.getResponseBody), an engine that blocks by hostname
 * and rewrites ad markers, and a storage stub. What gets checked is the
 * behaviour that decides whether a tab is worth attaching to, how requests and
 * responses are answered, and that no tab is ever left attached by accident.
 *
 * The last check runs the real engine bundle and the real serialized brain, with
 * only the debugger faked.
 *
 * Run: node test/deepblock.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'deepblock.js'), 'utf8');

// --- fake environment ------------------------------------------------------

const calls = [];
const store = {};
const bodies = new Map();
let eventListener = null;
let detachListener = null;
let removedListener = null;
let navListener = null;
let committedListener = null;
let attachFails = false;

const BLOCKED = ['ads.example', 'tracker.example'];
const REWRITABLE = ['rewrite.example'];
const WITH_REPLACE_RULES = ['json-ads.example'];
// Milliseconds each decide() burns while set: stands in for a page that makes
// filtering pathological, which is what the cost meter is there to notice.
let slowDecide = 0;

const chrome = {
  debugger: {
    attach: async (target, version) => {
      calls.push({ op: 'attach', target, version });
      if (attachFails) throw new Error('Another debugger is already attached');
    },
    detach: async (target) => {
      calls.push({ op: 'detach', target });
    },
    sendCommand: async (target, method, params) => {
      calls.push({ op: 'sendCommand', target, method, params });
      if (method === 'Fetch.getResponseBody') {
        return { body: bodies.get(params.requestId) || '', base64Encoded: false };
      }
      return {};
    },
    onEvent: { addListener: (fn) => (eventListener = fn) },
    onDetach: { addListener: (fn) => (detachListener = fn) }
  },
  tabs: {
    onRemoved: { addListener: (fn) => (removedListener = fn) }
  },
  webNavigation: {
    onBeforeNavigate: { addListener: (fn) => (navListener = fn) },
    onCommitted: { addListener: (fn) => (committedListener = fn) }
  },
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => {
        Object.assign(store, obj);
      }
    }
  },
  runtime: { getURL: (asset) => 'chrome-extension://test/' + asset }
};

const sandbox = {
  chrome,
  console: { log() {}, warn() {}, error() {} },
  setTimeout,
  clearTimeout,
  fetch: async () => ({
    arrayBuffer: async () => new ArrayBuffer(8),
    json: async () => []
  }),
  importScripts: () => {
    // The real bundle registers self.AdblockerEngine; the fake below stands in.
  },
  // How the generated walled-host list arrives in the worker: a script that
  // registers itself on self during initial evaluation.
  __yazWallHosts: '\nwall.example\n',
  URL,
  atob,
  btoa,
  TextEncoder,
  TextDecoder,
  Array,
  Object,
  Number,
  String,
  Math,
  Date,
  Promise,
  Set,
  Map,
  JSON
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.AdblockerEngine = {
  loadFromBuffer: () => ({ network: 3, cosmetic: 1, html: 2 }),
  loadReplaceRules: (rules) => ({ loaded: Array.isArray(rules) ? rules.length : 0, skipped: 0 }),
  decide: ({ url }) => {
    if (slowDecide) {
      const until = Date.now() + slowDecide;
      while (Date.now() < until) {
        /* hold the clock */
      }
    }
    if (url.includes('params.example')) {
      return { ready: true, block: false, rewrite: 'https://params.example/page?clean=1' };
    }
    return { ready: true, block: BLOCKED.some((host) => url.includes(host)) };
  },
  htmlFiltersFor: ({ url }) => (REWRITABLE.some((host) => url.includes(host)) ? 2 : 0),
  replaceRulesFor: ({ url }) => (WITH_REPLACE_RULES.some((host) => url.includes(host)) ? [{ pattern: 'x' }] : []),
  rewriteBody: ({ text }) => {
    const next = String(text).replace(/"adPlacements"/g, '"no_ads"');
    return { changed: next !== text, text: next, htmlSelectors: 2, replace: 1 };
  }
};
vm.createContext(sandbox);
// The worker importScripts these in this order: the adaptive layer registers
// itself, then the deep-block layer reads it (the cost meter comes from there).
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'smart.js'), 'utf8'), sandbox, {
  filename: 'smart.js'
});
// The generated wall-host list, loaded exactly the way the real worker imports
// it. Without it the set stays empty until an engine loads, and the checks that
// depend on a walled host being recognised have nothing to match.
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'wall-hosts.js'), 'utf8'),
  sandbox,
  { filename: 'wall-hosts.js' }
);
// The harness also needs its own stand-in host, which the checks below use to
// stand in for a walled site without depending on a real one.
sandbox.self.__yazWallHosts = String(sandbox.self.__yazWallHosts || '') + '\nwall.example\n';
vm.runInContext(source, sandbox, { filename: 'deepblock.js' });

const deep = sandbox.AdblockerDeep;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const opsOf = (op) => calls.filter((call) => call.op === op);
const attachAttempts = (tabId) => opsOf('attach').filter((call) => call.target.tabId === tabId).length;
const lastCommand = () => opsOf('sendCommand').slice(-1)[0];
const commandFor = (requestId, method) =>
  opsOf('sendCommand')
    .filter((call) => call.params && call.params.requestId === requestId)
    .filter((call) => !method || call.method === method)
    .slice(-1)[0];
const paused = (url, resourceType, tabId) => ({
  source: { tabId: tabId === undefined ? 7 : tabId },
  method: 'Fetch.requestPaused',
  params: { requestId: 'r' + resourceType + url.length, request: { url }, resourceType }
});
const responsePaused = (requestId, url, resourceType, body, headers, tabId) => {
  bodies.set(requestId, body);
  return {
    source: { tabId: tabId === undefined ? 7 : tabId },
    method: 'Fetch.requestPaused',
    params: {
      requestId,
      request: { url },
      resourceType,
      responseStatusCode: 200,
      responseHeaders: headers || [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }]
    }
  };
};

// --- checks ----------------------------------------------------------------

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};

(async () => {
  await check('a navigation to a walled site attaches before the page loads', async () => {
    assert(typeof navListener === 'function', 'no onBeforeNavigate listener was registered');

    // No page report, no evidence, no pin: the navigation alone has to be enough,
    // because a walled site renders its wall before a report could land.
    navListener({ tabId: 90, frameId: 0, url: 'https://wall.example/article' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const attached = calls.filter((call) => call.op === 'attach' && call.target && call.target.tabId === 90);
    assert(attached.length === 1, `expected one attach for the navigation, got ${attached.length}`);

    const before = calls.filter((call) => call.op === 'attach').length;
    navListener({ tabId: 91, frameId: 3, url: 'https://wall.example/frame' });
    navListener({ tabId: 92, frameId: 0, url: 'chrome://settings' });
    navListener({ tabId: 93, frameId: 0, url: 'https://ordinary.example/page' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(
      calls.filter((call) => call.op === 'attach').length === before,
      'it attached for a subframe, a browser page or an ordinary site'
    );

    if (typeof detachListener === 'function') detachListener({ tabId: 90 }, 'user');
  });

  await check('translates CDP resource types to engine types', async () => {
    assert(deep.mapType('Document') === 'main_frame', deep.mapType('Document'));
    assert(deep.mapType('XHR') === 'xmlhttprequest', deep.mapType('XHR'));
    assert(deep.mapType('Fetch') === 'xmlhttprequest', deep.mapType('Fetch'));
    assert(deep.mapType('Script') === 'script', deep.mapType('Script'));
    assert(deep.mapType('Image') === 'image', deep.mapType('Image'));
    assert(deep.mapType('SignedExchange') === 'other', deep.mapType('SignedExchange'));
    assert(deep.mapType('Invented') === 'other', deep.mapType('Invented'));
  });

  await check('does not attach to ordinary sites in smart mode', async () => {
    deep.setSettings({ deepBlock: 'smart' });
    const attached = await deep.maybeAttach(7, 'https://news.example/article');
    assert(attached === false, 'attached to an ordinary site');
    assert(attachAttempts(7) === 0, 'sent an attach command anyway');
  });

  await check('attaches automatically to a host we have caught before', async () => {
    deep.setKnownHosts(['vfxmed.com']);
    const attached = await deep.maybeAttach(7, 'https://www.vfxmed.com/post/');
    assert(attached === true, 'did not attach to a known ad host');
    const attachCall = opsOf('attach').slice(-1)[0];
    assert(attachCall.target.tabId === 7, 'attached the wrong tab');
    assert(attachCall.version === '1.3', `protocol version is ${attachCall.version}`);
    const enable = opsOf('sendCommand').find((call) => call.method === 'Fetch.enable');
    assert(enable, 'Fetch.enable was never sent');
    const stages = enable.params.patterns.map((pattern) => pattern.requestStage).sort();
    assert(stages.join(',') === 'Request,Response', `enabled stages: ${stages.join(',')}`);
    assert(enable.params.patterns.every((pattern) => pattern.urlPattern === '*'), 'patterns are wrong');
  });

  await check('answers what the engine blocks instead of failing it', async () => {
    const before = deep.state().stubbed;
    const event = paused('https://ads.example/banner.js', 'Script', 7);
    const blocked = await deep.handleEvent(event.source, event.method, event.params);
    assert(blocked.blocked === true, 'the ad was not blocked');
    assert(blocked.stubbed === true, 'the block was not answered with a stub');
    assert(blocked.type === 'script', `type is ${blocked.type}`);
    assert(blocked.host === 'ads.example', `host is ${blocked.host}`);
    // An empty script, not a red line in the network panel: a failed request is
    // one of the signals the detector on the other end counts.
    const served = commandFor(event.params.requestId, 'Fetch.fulfillRequest');
    assert(served, 'the blocked script was not answered');
    assert(served.params.responseCode === 200, `response code is ${served.params.responseCode}`);
    const mime = (served.params.responseHeaders || []).find((header) => header.name === 'Content-Type');
    assert(mime && /javascript/.test(mime.value), `content type is ${mime && mime.value}`);
    assert(served.params.body === '', `expected an empty body, got ${served.params.body.length} chars`);
    assert(deep.state().stubbed === before + 1, 'the stub counter did not move');

    const clean = paused('https://news.example/hero.jpg', 'Image', 7);
    const allowed = await deep.handleEvent(clean.source, clean.method, clean.params);
    assert(allowed.blocked === false, 'a clean request was blocked');
    assert(lastCommand().method === 'Fetch.continueRequest', `expected continue, got ${lastCommand().method}`);
  });

  await check('counts blocks per tab and in total', async () => {
    const state = deep.state();
    assert(state.blocked === 1, `total is ${state.blocked}`);
    const session = state.attached.find((entry) => entry.tabId === 7);
    assert(session && session.blocked === 1, 'per-tab count is wrong');
    assert(session.host === 'www.vfxmed.com', `session host is ${session.host}`);
  });

  await check('ignores events for tabs it is not attached to', async () => {
    const before = opsOf('sendCommand').length;
    const event = paused('https://ads.example/a.js', 'Script', 99);
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result === null, 'answered for an unattached tab');
    assert(opsOf('sendCommand').length === before, 'sent a command for an unattached tab');
  });

  await check('attaches on a page signal even when the host is unknown', async () => {
    const attached = await deep.signalAttach(8, 'https://fresh-pirate-site.example/watch');
    assert(attached === true, 'did not attach on a signal');
    assert(deep.isAttached(8), 'tab 8 is not attached');
  });

  await check('honours the off switch', async () => {
    deep.setSettings({ deepBlock: 'off' });
    const attached = await deep.maybeAttach(9, 'https://www.vfxmed.com/post/');
    const signalled = await deep.signalAttach(9, 'https://www.vfxmed.com/post/');
    assert(attached === false && signalled === false, 'attached while switched off');
    deep.setSettings({ deepBlock: 'smart' });
  });

  await check('always mode attaches everywhere', async () => {
    deep.setSettings({ deepBlock: 'always' });
    const attached = await deep.maybeAttach(10, 'https://news.example/article');
    assert(attached === true, 'always mode skipped a page');
    await deep.detach(10, 'test');
    deep.setSettings({ deepBlock: 'smart' });
  });

  await check('pinned sites attach and can be unpinned', async () => {
    deep.setPinned(['news.example']);
    assert((await deep.maybeAttach(11, 'https://news.example/story')) === true, 'a pinned site did not attach');
    await deep.detach(11, 'test');
    deep.setPinned([]);
    assert((await deep.maybeAttach(11, 'https://news.example/story')) === false, 'a pinned site stayed pinned');
  });

  await check('drops the least recently used tab when a fifth one wants in', async () => {
    const wait = () => new Promise((resolve) => setTimeout(resolve, 3));
    for (const tabId of [20, 21, 22, 23]) {
      await deep.maybeAttach(tabId, 'https://www.vfxmed.com/x');
      await wait();
    }
    assert(deep.state().attached.length === 4, `expected four sessions, got ${deep.state().attached.length}`);

    const extra = await deep.maybeAttach(24, 'https://www.vfxmed.com/x');
    assert(extra === true, 'the new tab was refused instead of taking the least recently used slot');
    const attached = deep.state().attached.map((entry) => entry.tabId);
    assert(attached.length === 4, `attached count is ${attached.length}`);
    assert(attached.includes(24), 'the new tab should hold a session');
    assert(!attached.includes(20), `the oldest session should have gone, attached: ${attached.join(',')}`);
    assert(
      opsOf('detach').some((op) => op.target && op.target.tabId === 20),
      'the oldest tab should have been detached to make room'
    );
  });

  await check('skips browser and file pages', async () => {
    const before = opsOf('attach').length;
    for (const url of ['chrome://extensions', 'about:blank', 'file:///Users/apple/notes.html', '']) {
      await deep.maybeAttach(30, url);
    }
    assert(opsOf('attach').length === before, 'attached to a non-http page');
  });

  await check('a refused attach is not retried immediately', async () => {
    await deep.detachAll();
    attachFails = true;
    const first = await deep.attach(31, 'https://www.vfxmed.com/x', 'test');
    const second = await deep.attach(31, 'https://www.vfxmed.com/x', 'test');
    attachFails = false;
    assert(first === false && second === false, 'attach should have been refused');
    assert(attachAttempts(31) === 1, `attach was retried (${attachAttempts(31)} attempts)`);
  });

  // --- memory and cost -----------------------------------------------------

  await check('parks the engine when nothing is attached, and wakes it on demand', async () => {
    assert(deep.isEngineReady(), 'the engine should be loaded by now');
    assert(deep.memory().engineLoaded === true, 'memory() should report a loaded engine');

    await deep.detachAll();
    assert(deep.idleCheck() === false, 'an engine that was just used must not be parked');
    assert(deep.isEngineReady(), 'the engine was parked while it was still warm');

    deep.touch(1); // pretend the last use was long ago
    assert(deep.idleCheck() === true, 'an idle engine with no sessions should be parked');
    assert(deep.isEngineReady() === false, 'the engine was not parked');
    assert(deep.memory().engineLoaded === false, 'memory() should report the parked engine');

    const back = await deep.ensureEngine();
    assert(back === true && deep.isEngineReady(), 'the engine did not come back');
    await settle();
    assert(store.deep && store.deep.memory && store.deep.memory.engineLoaded === true, 'the panel was not told');
  });

  await check('keeps the engine while a tab is still attached to it', async () => {
    await deep.attach(52, 'https://busy.example/page', 'test');
    deep.touch(1);
    assert(deep.idleCheck() === false, 'the engine was parked while a tab was attached');
    assert(deep.isEngineReady(), 'the engine went away under an attached tab');
    await deep.detach(52, 'test');
  });

  await check('spends a rewrite budget instead of rewriting a page forever', async () => {
    await deep.attach(50, 'https://rewrite.example/', 'test');
    let served = 0;
    for (let index = 0; index < 60; index += 1) {
      const event = responsePaused(
        `budget${index}`,
        'https://rewrite.example/page',
        'Document',
        '<p>"adPlacements"</p>',
        undefined,
        50
      );
      const result = await deep.handleEvent(event.source, event.method, event.params);
      if (result && result.rewritten) served += 1;
    }
    assert(served === 60, `expected 60 rewrites inside the budget, got ${served}`);

    const over = responsePaused(
      'budget-over',
      'https://rewrite.example/page',
      'Document',
      '<p>"adPlacements"</p>',
      undefined,
      50
    );
    const refused = await deep.handleEvent(over.source, over.method, over.params);
    assert(refused === null, 'a rewrite past the budget should be released untouched');
    assert(commandFor('budget-over', 'Fetch.getResponseBody'), 'the body should be read before the budget is consulted');
    assert(
      !opsOf('sendCommand').some(
        (call) => call.method === 'Fetch.fulfillRequest' && call.params.requestId === 'budget-over'
      ),
      'a body past the budget was served rewritten'
    );
    await deep.detach(50, 'test');
  });

  await check('drops a tab that makes filtering expensive, and cools its host off', async () => {
    await deep.attach(51, 'https://slow.example/page', 'test');
    slowDecide = 6;
    for (let index = 0; index < 45; index += 1) {
      const event = paused('https://slow.example/ad.js', 'Script', 51);
      event.params.requestId = `slow${index}`;
      await deep.handleEvent(event.source, event.method, event.params);
    }
    slowDecide = 0;
    await settle();

    assert(!deep.isAttached(51), 'a tab whose filtering went pathological should have lost its session');
    assert(
      deep.heavyHosts().includes('slow.example'),
      `slow.example should be cooling off, got ${deep.heavyHosts().join(',') || '(nothing)'}`
    );
    assert(
      (await deep.attach(51, 'https://slow.example/page', 'test')) === false,
      'a host that was too expensive was attached again straight away'
    );
    const cost = deep.cost(51);
    assert(cost === null || cost.count === 0, 'the cost meter should have been reset with the session');
  });

  await check('user closing the banner ends the session', async () => {
    await deep.attach(40, 'https://www.vfxmed.com/x', 'test');
    assert(deep.isAttached(40), 'tab 40 did not attach');
    detachListener({ tabId: 40 });
    assert(!deep.isAttached(40), 'tab 40 stayed attached after an external detach');
  });

  await check('closing the tab cleans up', async () => {
    await deep.attach(41, 'https://www.vfxmed.com/x', 'test');
    removedListener(41);
    assert(!deep.isAttached(41), 'tab 41 stayed attached after closing');
  });

  await check('publishes its state for the popup panel', async () => {
    const state = deep.publish();
    assert(Array.isArray(state.attached), 'attached sessions are missing from the state');
    assert(state.mode === 'smart', `mode is ${state.mode}`);
    assert(typeof state.rewritten === 'number', 'the rewritten counter is missing');
    await settle();
    assert(store.deep, 'no state reached storage');
    assert(Array.isArray(store.deep.attached), 'stored state has no sessions');
    assert(typeof store.deep.engineReady === 'boolean', 'engineReady is missing');
  });

  await check('sweep leaves fresh sessions alone', async () => {
    await deep.attach(60, 'https://www.vfxmed.com/x', 'test');
    const swept = deep.sweep();
    assert(swept === 0, `swept ${swept} fresh sessions`);
    assert(deep.isAttached(60), 'a fresh session was detached');
  });

  // --- response stage ------------------------------------------------------

  await check('rewrites a document body before the page sees it', async () => {
    // The attach checks above ended with detachAll, so put a session back.
    await deep.attach(7, 'https://rewrite.example/', 'test');
    assert(deep.isAttached(7), 'the response-stage checks need an attached tab');
    const before = deep.state().rewritten;
    const event = responsePaused(
      'doc1',
      'https://rewrite.example/page',
      'Document',
      '<html><script>var cfg = {"adPlacements":[1]};</script><p>story</p></html>'
    );
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.rewritten === true, 'the body was not rewritten');
    assert(result.type === 'main_frame', `type is ${result.type}`);

    const fetched = commandFor('doc1', 'Fetch.getResponseBody');
    assert(fetched, 'the body was never fetched');
    const served = opsOf('sendCommand').filter((call) => call.method === 'Fetch.fulfillRequest').pop();
    assert(served, 'no fulfillRequest was sent');
    assert(served.params.responseCode === 200, `response code is ${served.params.responseCode}`);

    const text = Buffer.from(served.params.body, 'base64').toString('utf8');
    assert(!/"adPlacements"/.test(text), `the ad marker survived: ${text}`);
    assert(/story/.test(text), 'the rewrite ate the page content');

    const headerNames = served.params.responseHeaders.map((header) => header.name.toLowerCase());
    assert(!headerNames.includes('content-length'), 'content-length was passed through with a new body');
    assert(headerNames.includes('content-type'), 'content-type was dropped');
    assert(deep.state().rewritten === before + 1, 'the rewritten counter did not move');
  });

  await check('releases a body with nothing to rewrite, without fetching it', async () => {
    const event = responsePaused('doc2', 'https://plain.example/page', 'Document', '<html>hello</html>');
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result === null, 'the handler claimed a rewrite');
    assert(
      !opsOf('sendCommand').some(
        (call) => call.method === 'Fetch.getResponseBody' && call.params.requestId === 'doc2'
      ),
      'the body was fetched for a page with no rules'
    );
    assert(lastCommand().method === 'Fetch.continueRequest', `expected continue, got ${lastCommand().method}`);
  });

  await check('ignores response stages for request types that never carry ads', async () => {
    const event = responsePaused('img1', 'https://rewrite.example/hero.png', 'Image', 'binary');
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result === null, 'an image response was inspected');
    assert(
      !opsOf('sendCommand').some(
        (call) => call.method === 'Fetch.getResponseBody' && call.params.requestId === 'img1'
      ),
      'the image body was fetched'
    );
    assert(lastCommand().method === 'Fetch.continueRequest', 'the image was not released');
  });

  await check('matches replace rules on their own, not just html rules', async () => {
    const event = responsePaused(
      'json1',
      'https://json-ads.example/api/feed',
      'XHR',
      '{"adPlacements":[1],"videoDetails":{}}',
      [{ name: 'Content-Type', value: 'application/json' }]
    );
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.rewritten === true, 'a replace-only body was not rewritten');
    assert(result.replace === 1, `replace count is ${result.replace}`);
  });

  await check('leaves a body alone when it cannot decode it safely', async () => {
    const event = responsePaused('doc3', 'https://rewrite.example/page', 'Document', '<html>caf\u00e9</html>', [
      { name: 'Content-Type', value: 'text/html; charset=iso-8859-1' }
    ]);
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result === null, 'a latin-1 document was rewritten as utf-8');
    assert(
      !opsOf('sendCommand').some(
        (call) => call.method === 'Fetch.getResponseBody' && call.params.requestId === 'doc3'
      ),
      'the body was fetched anyway'
    );
    assert(lastCommand().method === 'Fetch.continueRequest', 'the document was not released');
  });

  await check('leaves a body alone when it is too large to rewrite', async () => {
    const event = responsePaused('doc4', 'https://rewrite.example/huge', 'Document', 'x'.repeat(9 * 1024 * 1024));
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result === null, 'a 9 MB document was rewritten');
    assert(
      !opsOf('sendCommand').some(
        (call) => call.method === 'Fetch.fulfillRequest' && call.params.requestId === 'doc4'
      ),
      'it was served anyway'
    );
    assert(lastCommand().method === 'Fetch.continueRequest', 'the document was not released');
  });

  await check('strips tracking parameters instead of killing the request', async () => {
    const before = deep.state().rewritten;
    const event = paused('https://params.example/page?utm_source=x', 'Document', 7);
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.rewritten === true, 'the URL was not rewritten');
    assert(result.to === 'https://params.example/page?clean=1', `rewritten to ${result.to}`);
    const cont = lastCommand();
    assert(cont.method === 'Fetch.continueRequest', `expected continue, got ${cont.method}`);
    assert(cont.params.url === 'https://params.example/page?clean=1', 'the URL override was not sent');
    assert(deep.state().rewritten === before + 1, 'the rewritten counter did not move');
  });

  // The real thing: src/deepblock.js driving the actual engine bundle and the
  // actual serialized brain, with only chrome.debugger faked. This catches what
  // a fake engine cannot: a wrong asset path, a wrong API shape, a brain that no
  // longer deserializes, a rule set that no longer applies.
  await check('blocks and rewrites through the real engine brain', async () => {
    const root = path.join(__dirname, '..');
    const realCalls = [];
    const realChrome = {
      debugger: {
        attach: async () => {},
        detach: async () => {},
        sendCommand: async (target, method, params) => {
          realCalls.push({ method, params, target });
          if (method === 'Fetch.getResponseBody') {
            // The cases register their own bodies through responsePaused(); the
            // fixed JSON is the default for the rewrite case.
            return {
              body:
                bodies.get(params.requestId) ||
                '{"adPlacements":[{"id":"1"}],"adSlots":[{"x":1}],"videoDetails":{"id":"abc"}}',
              base64Encoded: false
            };
          }
          return {};
        },
        onEvent: { addListener: () => {} },
        onDetach: { addListener: () => {} }
      },
      tabs: { onRemoved: { addListener: () => {} } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: { getURL: (asset) => path.join(root, asset) }
    };
    const realSandbox = {
      chrome: realChrome,
      console: { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
      URL,
      atob,
      btoa,
      TextEncoder,
      TextDecoder,
      fetch: async (target) => ({
        arrayBuffer: async () => {
          const buffer = fs.readFileSync(target);
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        },
        json: async () => JSON.parse(fs.readFileSync(target, 'utf8'))
      })
    };
    realSandbox.self = realSandbox;
    realSandbox.globalThis = realSandbox;
    realSandbox.importScripts = (asset) =>
      vm.runInContext(fs.readFileSync(path.join(root, asset.replace(/^\//, '')), 'utf8'), realSandbox, {
        filename: asset
      });

    vm.createContext(realSandbox);
    vm.runInContext(source, realSandbox, { filename: 'deepblock.js' });
    const real = realSandbox.AdblockerDeep;

    const started = Date.now();
    const attached = await real.attach(1, 'https://www.cnn.com/', 'test');
    assert(attached === true, 'did not attach with the real engine');
    assert(real.isEngineReady(), 'the serialized brain did not load');
    assert(real.hasReplaceRules(), 'the extracted replace rules never loaded');
    const counts = realSandbox.AdblockerEngine.counts();
    assert(counts.network > 100000, `the brain holds ${counts.network} network filters`);
    assert(counts.cosmetic > 10000, `the brain holds ${counts.cosmetic} cosmetic filters`);
    console.log(
      `      (real brain: ${counts.network} network + ${counts.cosmetic} cosmetic + ${counts.html} html filters, ` +
        `${realSandbox.AdblockerEngine.replaceRuleCount()} replace rules, loaded in ${Date.now() - started} ms)`
    );

    // A second tab, on YouTube: those ad rules are scoped to the page's domain.
    await real.attach(2, 'https://www.youtube.com/watch?v=abc', 'test');

    const ad = await real.handleEvent(
      { tabId: 1 },
      'Fetch.requestPaused',
      {
        requestId: 'r1',
        request: { url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js' },
        resourceType: 'Script'
      }
    );
    assert(ad && ad.blocked === true, 'the real engine did not block GPT');
    assert(
      realCalls.some(
        (call) =>
          call.method === 'Fetch.fulfillRequest' &&
          call.params.requestId === 'r1' &&
          call.params.responseCode === 200 &&
          call.params.body === ''
      ),
      'the blocked script was not answered with an empty one'
    );

    const clean = await real.handleEvent(
      { tabId: 1 },
      'Fetch.requestPaused',
      { requestId: 'r2', request: { url: 'https://www.cnn.com/img/hero.jpg' }, resourceType: 'Image' }
    );
    assert(clean && clean.blocked === false, 'the real engine blocked a clean first-party image');
    assert(
      realCalls.some((call) => call.method === 'Fetch.continueRequest' && call.params.requestId === 'r2'),
      'the clean request was never released'
    );

    // The headline: a YouTube player response, scrubbed in the worker, with the
    // page's own scripts never seeing the ad schedule.
    const player = await real.handleEvent(
      { tabId: 2 },
      'Fetch.requestPaused',
      {
        requestId: 'r3',
        request: { url: 'https://www.youtube.com/youtubei/v1/player?key=x' },
        resourceType: 'XHR',
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }]
      }
    );
    assert(player && player.rewritten === true, 'the player response was not rewritten');
    const fulfilled = realCalls.filter((call) => call.method === 'Fetch.fulfillRequest').pop();
    assert(fulfilled, 'no rewritten body was served');
    const servedText = Buffer.from(fulfilled.params.body, 'base64').toString('utf8');
    assert(!/"adPlacements"/.test(servedText), `the ad schedule survived: ${servedText}`);
    assert(!/"adSlots"/.test(servedText), `the ad slots survived: ${servedText}`);
    assert(/videoDetails/.test(servedText), `the rewrite ate the video details: ${servedText}`);

  // --- the reader's copy, against the real engine's wall-host list ----------

  await check("the wall is answered with the reader's own copy of the page", async () => {
    // bild.de is in the real engine's wall-host list, which is what gates this.
    const realTab = 11;
    await real.attach(realTab, 'https://www.bild.de/', 'test');

    const good = responsePaused(
      'good1',
      'https://www.bild.de/',
      'Document',
      '<html><head><title>BILD</title></head><body><h1>Startseite</h1><p>' + 'n'.repeat(3000) + '</p>' +
        '<script src="https://www.bild.de/app.js"></script></body></html>',
      undefined,
      realTab
    );
    const remembered = await real.handleEvent(good.source, good.method, good.params);
    assert(!remembered || remembered.wallServed === undefined, 'a good page was treated as a wall');

    // Now the site serves its wall for the same session.
    const wall = responsePaused(
      'wall1',
      'https://www.bild.de/adblockwall.html',
      'Document',
      '<html><head><title>BILD</title></head><body><main class="main-content--adblockwall">' +
        'Aufgrund Ihres Blockers zeigen wir BILD.de nicht an.</main></body></html>',
      undefined,
      realTab
    );
    const result = await real.handleEvent(wall.source, wall.method, wall.params);
    assert(result && result.wallServed === true, 'the wall was not answered with the copy');

    const served = realCalls.filter((call) => call.method === 'Fetch.fulfillRequest' && call.params.body).pop();
    const text = Buffer.from(served.params.body, 'base64').toString('utf8');
    assert(/Startseite/.test(text), 'the copy did not carry the page content');
    assert(!/<script/i.test(text), 'the served copy still had scripts in it');
    assert(text.includes('<base href="https://www.bild.de/">'), 'the copy had no base tag');
    assert(/yaz-served/.test(text), 'the copy was not marked as ours');
    assert(!/adblockwall/.test(text.slice(0, 400)), 'the wall content leaked into the copy');
  });

  await check('the copy can come from the page itself, not only from a won race', async () => {
    const realTab = 13;
    await real.attach(realTab, 'https://www.welt.de/', 'test');
    const html = '<html><head><title>WELT</title></head><body><h1>Artikel</h1><p>' + 'w'.repeat(3000) + '</p></body></html>';
    assert(real.rememberDoc('https://www.welt.de/politik/x', html) === true, 'the handover was refused');

    const wall = responsePaused(
      'wall3',
      'https://www.welt.de/adblockwall.html',
      'Document',
      '<html><body>Werbeblocker erkannt.</body></html>',
      undefined,
      realTab
    );
    const result = await real.handleEvent(wall.source, wall.method, wall.params);
    assert(result && result.wallServed === true, 'the handover did not feed the wall answer');

    const served = realCalls.filter((call) => call.method === 'Fetch.fulfillRequest' && call.params.body).pop();
    const text = Buffer.from(served.params.body, 'base64').toString('utf8');
    assert(/Artikel/.test(text), 'the served copy did not carry the captured page');
    assert(!/<script/i.test(text), 'the served copy kept scripts from the capture');
  });

  await check('the probe records what this layer decided', async () => {
    const snapshot = real.diag();
    assert(Array.isArray(snapshot.events) && snapshot.events.length > 0, 'the ring is empty');
    assert(
      snapshot.events.some((entry) => entry.k === 'capture'),
      'a capture left no trace in the ring'
    );
    assert(
      snapshot.events.some((entry) => entry.k === 'wall-document'),
      'a wall document left no trace in the ring'
    );
    assert(
      snapshot.counts.some((line) => /stub-answer/.test(line)),
      'the stub answers are not counted'
    );
    assert(
      snapshot.events.some((entry) => entry.k === 'attach'),
      'an attach left no trace in the ring, so a refused attach cannot be told from one never tried'
    );
  });

  await check('with no copy yet, the wall is left to the refusal path', async () => {
    const realTab = 12;
    // A host no other case has handed a copy for, so "no copy yet" is true here.
    await real.attach(realTab, 'https://www.cinema.de/', 'test');
    const wall = responsePaused(
      'wall2',
      'https://www.cinema.de/adblockwall.html',
      'Document',
      '<html><body>Werbeblocker erkannt. Aufgrund Ihres Blockers zeigen wir cinema.de nicht an.</body></html>',
      undefined,
      realTab
    );
    const result = await real.handleEvent(wall.source, wall.method, wall.params);
    assert(!result || result.wallServed === undefined, 'a page with no copy was answered anyway');
  });

  });

  await check('a blocked image is answered with a transparent pixel', async () => {
    const event = paused('https://ads.example/pixel.gif', 'Image', 7);
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.stubbed === true, 'the image was not answered');
    const served = commandFor(event.params.requestId, 'Fetch.fulfillRequest');
    assert(served, 'no answer was sent');
    const mime = (served.params.responseHeaders || []).find((header) => header.name === 'Content-Type');
    assert(mime && mime.value === 'image/png', `content type is ${mime && mime.value}`);
    const bytes = Buffer.from(served.params.body, 'base64');
    assert(bytes.length === 68, `expected a 68 byte png, got ${bytes.length}`);
    assert(bytes.slice(1, 4).toString() === 'PNG', 'the body is not a png');
  });

  await check('a blocked websocket still fails, since it has no body to answer with', async () => {
    const event = paused('https://ads.example/socket', 'WebSocket', 7);
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.blocked === true, 'the socket was not blocked');
    assert(!result.stubbed, 'a websocket was answered with a body');
    const fail = commandFor(event.params.requestId, 'Fetch.failRequest');
    assert(fail && fail.params.errorReason === 'BlockedByClient', 'the socket was not failed');
  });

  await check('a blocked subframe is answered with an empty document', async () => {
    const event = paused('https://ads.example/frame', 'Document', 7);
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.stubbed === true, 'the frame was not answered');
    const served = commandFor(event.params.requestId, 'Fetch.fulfillRequest');
    const text = Buffer.from(served.params.body, 'base64').toString('utf8');
    assert(/<html>/.test(text), `expected an empty document, got ${text.slice(0, 60)}`);
  });

  // --- wall navigations and the detector's beacon ---------------------------

  await check('a wall navigation is refused with a redirect to the site root', async () => {
    await deep.attach(7, 'https://www.bild.de/', 'test');
    const before = deep.state().wallRefused;
    const event = paused('https://www.bild.de/adblockwall.html', 'Document');
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.wallRefused === true, 'the wall navigation was not refused');
    const served = commandFor(event.params.requestId, 'Fetch.fulfillRequest');
    assert(served, 'no fulfillRequest was sent');
    assert(served.params.responseCode === 302, `response code is ${served.params.responseCode}`);
    const header = (served.params.responseHeaders || []).find(
      (entry) => String(entry.name).toLowerCase() === 'location'
    );
    assert(header && header.value === 'https://www.bild.de/', `location is ${header && header.value}`);
    assert(deep.state().wallRefused === before + 1, 'the refusal counter did not move');
  });

  await check('the wall is contested once, then allowed through, so no tab can spin', async () => {
    await deep.attach(8, 'https://www.welt.de/', 'test');
    let refused = 0;
    for (let index = 0; index < 9; index += 1) {
      const event = paused(`https://www.welt.de/adblockwall.html?n=${index}`, 'Document', 8);
      const result = await deep.handleEvent(event.source, event.method, event.params);
      if (result && result.wallRefused) refused += 1;
    }
    // Two refusals inside the window, then the site is allowed its wall: a layer
    // that never yields is a reload loop, which is worse than the wall.
    assert(refused === 2, `expected 2 refusals and then a pass, got ${refused}`);
  });

  await check('an ordinary document navigation is left alone', async () => {
    await deep.attach(9, 'https://www.bild.de/', 'test');
    const event = paused('https://www.bild.de/politik/', 'Document', 9);
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(!result || result.wallRefused === undefined, 'an ordinary navigation was refused');
  });

  await check('the detector beacon is answered, not blocked', async () => {
    const before = deep.state().answered;
    const event = paused('https://report.error-report.com/collect?v=1', 'XHR');
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(result && result.answered === true, 'the beacon was not answered');
    const served = commandFor(event.params.requestId, 'Fetch.fulfillRequest');
    assert(served && served.params.responseCode === 204, 'the beacon was not answered with 204');
    assert(deep.state().answered === before + 1, 'the answered counter did not move');
  });

  await check('a beacon to an unrelated host is not answered', async () => {
    const event = paused('https://collect.example.com/beacon', 'XHR');
    const result = await deep.handleEvent(event.source, event.method, event.params);
    assert(!result || result.answered === undefined, 'an unrelated host was answered');
  });

  await check('a committed document attaches a walled host the navigation missed', async () => {
    assert(typeof committedListener === 'function', 'no onCommitted listener was registered');
    // The generated wall-host list is what seeds the set before the engine loads,
    // so the retry has something to match: the same file the worker imports.
    calls.length = 0;
    await committedListener({ tabId: 21, frameId: 0, url: 'https://www.welt.de/' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(
      calls.some((call) => call.op === 'attach' && call.target && call.target.tabId === 21),
      'a walled host that reached the document stage was left unattached'
    );

    calls.length = 0;
    await committedListener({ tabId: 22, frameId: 0, url: 'https://example.com/' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const attached = calls.some((call) => call.op === 'attach' && call.target && call.target.tabId === 22);
    assert(!attached, 'an ordinary host was attached by the retry');
  });

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL'));
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
})();
