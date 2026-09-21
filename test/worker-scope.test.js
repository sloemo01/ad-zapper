/*
 * The worker loads its scripts with importScripts, which shares one global
 * lexical scope. A const declared by two of them is a SyntaxError at load time,
 * and the extension comes up dead: no badge, no hiding, no deep block, nothing.
 * Nothing else in the suite would catch that, because every other test loads one
 * script at a time.
 *
 * This loads them all into one context, in the worker's own order, with a fake
 * chrome, and fails on any collision or on a missing registration.
 *
 * Run: node test/worker-scope.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const scripts = [
  'src/popup-hosts.js',
  'src/smart.js',
  'src/lists.js',
  'src/deepblock.js',
  'src/background.js'
];

const store = {};
const listeners = { message: [], installed: [], startup: [], alarms: [], removed: [], debugger: [] };

const chrome = {
  runtime: {
    getURL: (asset) => 'chrome-extension://test/' + asset,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) }
  },
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
        const out = {};
        for (const name of Array.isArray(key) ? key : []) if (name in store) out[name] = store[name];
        return out;
      },
      set: async (obj) => {
        Object.assign(store, obj);
      }
    }
  },
  action: {
    setBadgeBackgroundColor: () => {},
    setBadgeText: () => {}
  },
  tabs: { onRemoved: { addListener: (fn) => listeners.removed.push(fn) } },
  alarms: {
    create: () => {},
    onAlarm: { addListener: (fn) => listeners.alarms.push(fn) }
  },
  declarativeNetRequest: {
    MAX_NUMBER_OF_DYNAMIC_RULES: 5000,
    updateDynamicRules: async () => {}
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({ body: '', base64Encoded: false }),
    onEvent: { addListener: (fn) => listeners.debugger.push(fn) },
    onDetach: { addListener: (fn) => listeners.debugger.push(fn) }
  }
};

// Chrome refuses importScripts() once the worker's initial evaluation is over:
// "importScripts() of new scripts after service worker installation is not
// allowed". The fake enforces the same rule, so a lazy importScripts anywhere in
// the worker throws here instead of failing only in the browser.
let initialEvaluation = true;

const sandbox = {
  chrome,
  console: { log() {}, warn() {}, error() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async (url) => {
    const asset = String(url).replace('chrome-extension://test/', '');
    const file = path.join(root, asset);
    if (asset.endsWith('engine.bin')) {
      const buffer = fs.readFileSync(file);
      return {
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        json: async () => []
      };
    }
    if (asset.endsWith('replace-rules.json')) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(8), json: async () => [] };
  },
  importScripts: (asset) => {
    if (!initialEvaluation) {
      throw new TypeError('importScripts() of new scripts after service worker installation is not allowed');
    }
    // The real thing: load the file the worker asked for into this same context.
    const file = path.join(root, String(asset).replace(/^\//, ''));
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: String(asset) });
  },
  URL,
  atob,
  btoa,
  TextEncoder,
  TextDecoder,
  performance,
  indexedDB: undefined,
  Promise,
  Date,
  Math,
  Number,
  String,
  Array,
  Object,
  Set,
  Map,
  JSON,
  Boolean,
  RegExp
};
sandbox.self = sandbox;
vm.createContext(sandbox);

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
  const loaded = [];
  await check('every worker script loads into one shared scope', async () => {
    for (const name of scripts) {
      const source = fs.readFileSync(path.join(root, name), 'utf8');
      try {
        vm.runInContext(source, sandbox, { filename: name });
      } catch (error) {
        throw new Error(`${name} failed to load: ${(error && error.message) || error}`);
      }
      loaded.push(name);
    }
    assert(loaded.length === scripts.length, 'not every script was loaded');
    // Initial evaluation is over. From here on, importScripts must not be
    // called again, exactly like the browser.
    initialEvaluation = false;
  });

  await check('the load order the worker uses actually registers everything', async () => {
    assert(sandbox.AdblockerSmart, 'the adaptive layer never registered');
    assert(sandbox.AdblockerLists, 'the list upkeep module never registered');
    assert(sandbox.AdblockerDeep, 'the deep-block layer never registered');
    assert(typeof sandbox.AdblockerDeep.memory === 'function', 'the deep-block layer is missing its memory report');
    assert(typeof sandbox.AdblockerLists.loadCachedBrain === 'function', 'the deep-block loader needs the cached brain');
  });

  await check('the worker listens for its messages, alarms and events', async () => {
    assert(listeners.message.length === 1, `expected one message listener, got ${listeners.message.length}`);
    assert(listeners.alarms.length === 1, `expected one alarm listener, got ${listeners.alarms.length}`);
    assert(listeners.installed.length === 1 && listeners.startup.length === 1, 'boot listeners are missing');
    assert(listeners.debugger.length >= 2, 'the debugger listeners are missing');
    assert(listeners.removed.length >= 1, 'the tab-removal listener is missing');
  });

  await check('a page asking for hiding gets an answer it can inject', async () => {
    let reply = null;
    const answered = new Promise((resolve) => {
      reply = resolve;
    });
    for (const listener of listeners.message) {
      const kept = listener({ type: 'yt-ad-zapper:page', url: 'https://news.example/article', top: true }, {}, (payload) => {
        reply(payload);
      });
      assert(kept === true, 'the page message must keep the channel open for its async reply');
    }
    const hide = await Promise.race([answered, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    assert(hide, 'no reply arrived for a page asking what to hide');
    assert(typeof hide.css === 'string', 'the reply should carry CSS as a string');
    assert(hide.host === 'news.example', `expected the frame host back, got ${hide.host}`);
    assert(hide.bytes === hide.css.length, 'the byte count should be the CSS it sent');
  });

  await check('the engine only loads once, and comes from a real brain', async () => {
    const deep = sandbox.AdblockerDeep;
    assert(deep.isEngineReady(), 'the hiding path should have loaded the engine');
    const memory = deep.memory();
    assert(memory.engineLoaded === true, 'the memory report should show the engine');
    assert(memory.knownHosts === 0 && memory.sessions === 0, 'a fresh worker should hold no hosts or sessions');
    assert(store.deep && store.deep.memory, 'the published state should carry the memory report');
  });

  await check('a frame that cannot have rules still gets an answer', async () => {
    let reply = null;
    const answered = new Promise((resolve) => {
      reply = resolve;
    });
    for (const listener of listeners.message) {
      listener({ type: 'yt-ad-zapper:page', url: 'chrome://extensions', top: false }, {}, (payload) => reply(payload));
    }
    const hide = await Promise.race([answered, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
    assert(hide, 'no reply arrived for a browser page');
    assert(hide.css === '' && hide.bytes === 0, 'a browser page should get an empty answer');
  });

  // --- what the worker learns and does about it -----------------------------

  const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = async (message, sender, wait) => {
    let reply = null;
    for (const listener of listeners.message) {
      listener(message, sender || {}, (payload) => {
        reply = payload;
      });
    }
    await settle(wait);
    return reply;
  };

  await check('a site with form gets a session on sight, without being told twice', async () => {
    store.sites = { 'hot.example': { visits: 2, ads: 0, popups: 1, rewrites: 0, firstSeen: Date.now(), lastSeen: Date.now() } };
    await send({ type: 'yt-ad-zapper:page', url: 'https://hot.example/article', top: true }, { tab: { id: 5 } }, 120);

    const deep = sandbox.AdblockerDeep;
    assert(deep.isAttached(5), 'a site with a caught popup on record should have been attached');
    const session = deep.state().attached.find((entry) => entry.tabId === 5);
    assert(session && session.host === 'hot.example', `the session is for ${session && session.host}`);
  });

  await check('a walled site attaches on sight, so the wall never shows', async () => {
    const deep = sandbox.AdblockerDeep;
    const memory = deep.memory();
    assert(memory.walledHosts >= 1, `expected response-rule hosts from the brain, got ${memory.walledHosts}`);

    await send({ type: 'yt-ad-zapper:page', url: 'https://www.bild.de/', top: true }, { tab: { id: 41 } }, 140);
    assert(deep.isAttached(41), 'a host with response rules should attach without a pin');
    const session = deep.state().attached.find((entry) => entry.tabId === 41);
    assert(session && session.host.endsWith('bild.de'), `expected a bild.de session, got ${JSON.stringify(session)}`);
    await deep.detach(41, 'test');
  });

  await check('a caught popup is recorded against the site that served it', async () => {
    await send(
      { type: 'yt-ad-zapper:popup-blocked', kind: 'popup', host: 'oqhbgxvk.com' },
      { tab: { id: 5 }, url: 'https://hot.example/article' },
      60
    );
    const records = await sandbox.AdblockerSmart.readSites();
    const entry = records['hot.example'];
    assert(entry, 'the page host should be on record');
    assert(entry.popups === 2, `expected two caught popups on record, got ${entry && entry.popups}`);
    assert(!records['oqhbgxvk.com'] || records['oqhbgxvk.com'].popups === 0, 'the popup host is a network block, not a site');
  });

  await check('the panel can ask about list state, and trigger a refresh', async () => {
    const before = await send({ type: 'yt-ad-zapper:lists' }, {}, 40);
    assert(before && before.ok === true && before.info, 'the list state should be readable');
    assert(before.info.urls.length === 3, 'the three sources should be reported');
    assert(before.info.cached === false, 'nothing should be cached in a fresh worker');

    const started = await send({ type: 'yt-ad-zapper:update-lists' }, {}, 10);
    assert(started && started.started === true, 'a refresh should be acknowledged immediately');
    await settle(120);
    assert(store.lists && store.lists.busy === true, 'the refresh should be marked as running in storage');
    const after = await send({ type: 'yt-ad-zapper:lists' }, {}, 40);
    assert(after.info.busy === true, 'the panel should see the refresh in progress');
  });

  await check('reset clears what was learned, not what was downloaded', async () => {
    const reply = await send({ type: 'yt-ad-zapper:reset' }, {}, 60);
    assert(reply && reply.ok === true, 'reset should acknowledge');
    const records = await sandbox.AdblockerSmart.readSites();
    assert(Object.keys(records).length === 0, `expected an empty registry, got ${Object.keys(records).join(',')}`);
    assert(store.stats && store.stats.ads === 0, 'the tally should be back to zero');
    assert(store.lists, 'the list record should survive a reset');
  });

  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
