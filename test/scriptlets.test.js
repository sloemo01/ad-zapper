/*
 * The scriptlet pipeline, checked the way it runs.
 *
 * Three pieces, each testable without a browser: the generated map (built from
 * the lists), the implementations (plain functions against a fake window), and
 * the two sides that decide when a call happens (the relay in the frame and the
 * worker that runs it).
 *
 * The implementations are the risky part: they are page-world code that edits
 * the page's own objects, so each one is checked for the effect it claims and
 * for leaving everything else alone.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let passed = 0;
const failures = [];
const pending = [];
const check = (name, fn) => {
  const ok = () => {
    passed += 1;
    console.log('ok   ' + name);
  };
  const bad = (error) => {
    failures.push(name + ': ' + error.message);
    console.log('FAIL ' + name + ': ' + error.message);
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') pending.push(result.then(ok, bad));
    else ok();
  } catch (error) {
    bad(error);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'assertion failed');
};

// The implementations run in a page, so they are loaded into one: a fake global
// that stands in for both `self` and `window`, with `document` on it. Node's own
// globals stay reachable, the same way the page's do.
const loadImplementations = () => {
  const source = read('src/scriptlets.js');
  const sandbox = { JSON, Math, setTimeout: global.setTimeout, setInterval: global.setInterval };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  sandbox.document = {};
  global.window = sandbox;
  global.document = sandbox.document;
  // eslint-disable-next-line no-new-func
  const run = new Function('self', 'window', source + '; return self.AD_ZAPPER_RUN_SCRIPTLET;')(sandbox, sandbox);
  return { run, sandbox };
};

const loadMap = () => {
  const source = read('src/scriptlet-map.js');
  const sandbox = {};
  new Function('self', source)(sandbox);
  return sandbox.AD_ZAPPER_SCRIPTLETS;
};

check('the generated map only lists names that have an implementation', () => {
  const map = loadMap();
  const source = read('src/scriptlets.js');
  const calls = [...Object.values(map.hosts).flat(), ...map.generic];
  assert(calls.length > 100, `the map looks empty (${calls.length} calls), run the build step`);
  const names = new Set(calls.map((entry) => entry[0]));
  for (const name of names) {
    assert(source.includes(`case '${name}':`), `${name} is in the map with no implementation`);
    assert(!name.startsWith('trusted-'), 'trusted scriptlets are never shipped');
  }
  assert(Object.keys(map.hosts).length > 500, `only ${Object.keys(map.hosts).length} hosts in the map`);
});

check('the map is sorted and deduped, so a rebuild is a no-op diff', () => {
  const map = loadMap();
  const hosts = Object.keys(map.hosts);
  assert(hosts.join() === [...hosts].sort().join(), 'hosts are not sorted');
  for (const entries of Object.values(map.hosts)) {
    const keys = entries.map((entry) => entry[0] + '|' + entry[1].join(','));
    assert(new Set(keys).size === keys.length, 'duplicate call for one host');
  }
});

check('host lookup walks up the domain the way a filter does', () => {
  const { sandbox } = loadImplementations();
  sandbox.AD_ZAPPER_SCRIPTLETS = {
    generic: [['set', ['adblock', 'false']]],
    hosts: { 'example.com': [['no-fetch-if', ['/ads/']]] }
  };
  const calls = sandbox.AD_ZAPPER_SCRIPTLETS_FOR('www.example.com');
  assert(calls.length === 2, `expected both calls, got ${calls.length}`);
  assert(calls.some((entry) => entry[0] === 'set'), 'the generic call is missing');
  assert(sandbox.AD_ZAPPER_SCRIPTLETS_FOR('elsewhere.test').length === 1, 'a foreign host must only get the generic calls');
});

check('set defines a constant and stops writes', () => {
  const { run, sandbox } = loadImplementations();
  run('set', ['adblock', 'false']);
  assert(sandbox.adblock === false, 'the property was not set');
  sandbox.adblock = true;
  assert(sandbox.adblock === false, 'a write got through');
  assert(run('set', ['missing.path.value', '1']) === 'set: no target', 'a missing path must be reported, not thrown');
});

check('json-prune removes the named properties at any depth', () => {
  const { run, sandbox } = loadImplementations();
  const nativeParse = JSON.parse;
  run('json-prune', ['adPlacements playerAds']);
  const parsed = JSON.parse('{"a":{"adPlacements":[1]},"adPlacements":[2],"keep":3}');
  sandbox.JSON.parse = nativeParse;
  assert(!('adPlacements' in parsed), 'the top level property survived');
  assert(!('adPlacements' in parsed.a), 'the nested property survived');
  assert(parsed.keep === 3, 'json-prune touched something else');
});

check('no-fetch-if rejects only matching URLs', () => {
  const { run, sandbox } = loadImplementations();
  let called = 0;
  sandbox.fetch = () => {
    called += 1;
    return Promise.resolve('ok');
  };
  run('no-fetch-if', ['/ads/']);
  const blocked = sandbox.fetch('https://example.com/ads/x').then(() => 'resolved', () => 'rejected');
  const allowed = sandbox.fetch('https://example.com/content');
  return Promise.all([blocked, allowed]).then(([verdict, value]) => {
    assert(verdict === 'rejected', 'a matching request was not rejected');
    assert(value === 'ok', 'a non-matching request was blocked');
    assert(called === 1, `the native fetch ran ${called} times, expected once`);
  });
});

check('no-xhr-if defuses the matching request and leaves the rest', () => {
  const { run, sandbox } = loadImplementations();
  const opened = [];
  const sent = [];
  function FakeXhr() {}
  FakeXhr.prototype.open = function (method, url) {
    opened.push(url);
  };
  FakeXhr.prototype.send = function () {
    sent.push(1);
  };
  sandbox.XMLHttpRequest = FakeXhr;
  run('no-xhr-if', ['/beacon']);
  const defused = new FakeXhr();
  defused.open('GET', 'https://example.com/beacon?id=1');
  defused.send();
  const normal = new FakeXhr();
  normal.open('GET', 'https://example.com/page');
  normal.send();
  assert(opened.length === 1, `expected one real open, got ${opened.length}`);
  assert(sent.length === 1, `expected one real send, got ${sent.length}`);
  assert(opened[0].includes('/page'), 'the wrong request was let through');
});

check('abort-on-property-read throws on read, abort-on-property-write on write', () => {
  const { run, sandbox } = loadImplementations();
  sandbox.bait = { read: 1, write: 1 };
  run('abort-on-property-read', ['bait.read']);
  run('abort-on-property-write', ['bait.write']);
  let readThrew = false;
  let writeThrew = false;
  try {
    void sandbox.bait.read;
  } catch (_) {
    readThrew = true;
  }
  try {
    sandbox.bait.write = 2;
  } catch (_) {
    writeThrew = true;
  }
  assert(readThrew, 'reading the property did not throw');
  assert(writeThrew, 'writing the property did not throw');
});

check('acs throws only for the inline script it was written for', () => {
  const { run, sandbox } = loadImplementations();
  sandbox.Math = Math;
  sandbox.document.currentScript = { textContent: 'var adblock = true; check();' };
  run('abort-current-inline-script', ['Math.random', '/adblock/']);
  let threw = false;
  try {
    void sandbox.Math.random;
  } catch (_) {
    threw = true;
  }
  assert(threw, 'the matching inline script was not aborted');
  sandbox.document.currentScript = { textContent: 'var content = 1;' };
  assert(typeof sandbox.Math.random === 'function', 'an unrelated script lost access to the property');
});

check('nowoif defuses window.open, with and without a pattern', () => {
  const { run, sandbox } = loadImplementations();
  let opened = 0;
  sandbox.open = () => {
    opened += 1;
    return 'window';
  };
  run('no-window-open-if', []);
  assert(sandbox.open('https://ads.example') === null, 'a popup was allowed through');
  assert(opened === 0, 'the native open ran for a defused call');
  sandbox.open = () => {
    opened += 1;
    return 'window';
  };
  run('no-window-open-if', ['/popup/']);
  assert(sandbox.open('https://example.com/page') === 'window', 'a non-matching open was blocked');
  assert(opened === 1, 'the native open did not run for a normal call');
});

check('the timer defusers drop matching callbacks and keep the rest', () => {
  const { run, sandbox } = loadImplementations();
  const ran = [];
  sandbox.setTimeout = (fn) => {
    if (typeof fn === 'function') fn();
    return 1;
  };
  run('no-setTimeout-if', ['/adblock/', '1000']);
  sandbox.setTimeout(function adblockCheck() {
    ran.push('ad');
  }, 1000);
  sandbox.setTimeout(function normal() {
    ran.push('normal');
  }, 500);
  assert(ran.join() === 'normal', `wrong callbacks ran: ${ran.join()}`);
});

check('cookie-remover lets every other cookie through', () => {
  const { run, sandbox } = loadImplementations();
  const written = [];
  function FakeDocument() {}
  Object.defineProperty(FakeDocument.prototype, 'cookie', {
    get: () => written.join('; '),
    set: (value) => written.push(value),
    configurable: true
  });
  sandbox.Document = FakeDocument;
  sandbox.document = Object.create(FakeDocument.prototype);
  run('cookie-remover', ['adblock_detected']);
  sandbox.document.cookie = 'adblock_detected=1; path=/';
  sandbox.document.cookie = 'session=abc; path=/';
  assert(written.length === 1 && written[0].startsWith('session='), `wrong cookies written: ${written.join(' | ')}`);
});

check("the relay asks the worker only when the switch is on and the site is not allowlisted", () => {
  const source = read('src/relay.js');
  assert(/AD_ZAPPER_SCRIPTLETS_FOR/.test(source), 'the relay never consults the map');
  assert(/settings\.enabled === false\) return/.test(source), 'the relay does not check the master switch');
  assert(/allowlist\.includes\(host\)\) return/.test(source), 'the relay does not honour the allowlist');
  assert(/\^https\?:\$/.test(source), 'the relay does not restrict itself to http(s)');
  assert(/scriptlets', host, calls/.test(source), 'the relay does not send the calls');
});

check('the worker runs them in the page world, bounded, and only when enabled', () => {
  const source = read('src/background.js');
  assert(/world: 'MAIN'/.test(source), 'the scriptlet call does not target the page world');
  assert(/func: self\.AD_ZAPPER_RUN_SCRIPTLET/.test(source), 'the worker does not pass the implementation');
  assert(/calls\.slice\(0, 12\)/.test(source), 'the per-frame call budget is missing');
  assert(/SCRIPTLET_MESSAGE/.test(source), 'the message type is not handled');
  assert(/importScripts\('\/src\/scriptlets\.js'\)/.test(read('src/deepblock.js')), 'the worker does not load the implementations');
});

check('the frame loads the map and the implementations before the relay', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const block = manifest.content_scripts.find((entry) => (entry.js || []).includes('src/relay.js'));
  assert(block, 'no content script loads the relay');
  const js = block.js || [];
  // The order that matters is relative: the map and the implementations have to
  // be evaluated before the relay calls into them. Other preludes (the wall-host
  // list, which also rides this entry) may come first.
  const mapAt = js.indexOf('src/scriptlet-map.js');
  const implAt = js.indexOf('src/scriptlets.js');
  const relayAt = js.indexOf('src/relay.js');
  assert(mapAt >= 0 && implAt > mapAt && relayAt > implAt, `the frame loads ${js.join(', ')}`);
  assert((manifest.permissions || []).includes('scripting'), 'the scripting permission is missing');
  // chrome.scripting refuses to touch a frame the extension has no host
  // permission for, and declared content script matches do not count as one.
  const hosts = manifest.host_permissions || [];
  assert(hosts.includes('*://*/*'), 'no host permission for ordinary pages, every scriptlet call would fail');
});

Promise.all(pending).then(() => {
  console.log('\n' + passed + '/' + (passed + failures.length) + ' passed');
  if (failures.length) {
    for (const failure of failures) console.log('  ' + failure);
    process.exitCode = 1;
  }
});
