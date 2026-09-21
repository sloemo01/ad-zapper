/*
 * The wall switch and the standing guard, run against fakes.
 *
 * Both scripts are self-contained IIFEs that take their world from the browser
 * globals; here they take hand-built fakes, which is the only way to check the
 * behaviour that matters without a browser: that a marker-shaped key cannot be
 * written, that a wall node gets removed, that the guard stands down when the
 * master switch is off, and that the work stops instead of watching forever.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
let passed = 0;
const failures = [];
const pending = [];

const check = (name, fn) => {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(out.then(() => { passed += 1; }, (error) => failures.push(`${name}: ${error.message}`)));
      return;
    }
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'assertion failed');
};

// A fresh class per world: the switch patches Storage.prototype, so sharing one
// class between cases would let the first patched world change the next one.
const makeStorageClass = () => class FakeStorage {
  setItem(key, value) { this[String(key)] = String(value); }
  getItem(key) { return Object.prototype.hasOwnProperty.call(this, String(key)) ? this[String(key)] : null; }
  removeItem(key) { delete this[String(key)]; }
  get length() { return Object.keys(this).length; }
  key(index) { return Object.keys(this)[index]; }
};

// Per-world as well: the switch patches Location.prototype, so a shared class
// would let one case's patch decide another case's navigation.
const makeLocationClass = () => class FakeLocation {
  constructor(props = {}) {
    this._href = props.href || 'https://www.bild.de/';
    this.hostname = props.hostname || 'www.bild.de';
    this.pathname = props.pathname || '/';
    this.replacements = [];
    this.assignments = [];
  }
  get href() { return this._href; }
  set href(value) { this._href = String(value); this.replacements.push('href:' + value); }
  replace(target) { this.replacements.push(String(target)); }
  assign(target) { this.assignments.push(String(target)); }
};

class FakeDocument {
  constructor() { this._cookie = ''; }
  get cookie() { return this._cookie; }
  set cookie(value) { this._cookie += String(value) + '; '; }
}

const makeWorld = (options = {}) => {
  const calls = { selectors: [], observers: [], states: [] };
  const intervals = [];
  const document_ = new FakeDocument();
  document_.documentElement = { style: { overflow: 'hidden' } };
  document_.body = { style: { overflow: 'hidden' }, children: options.bodyChildren || [] };
  document_.querySelectorAll = (selector) => {
    calls.selectors.push(selector);
    return options.nodes || [];
  };
  const Storage = options.Storage || makeStorageClass();
  const Location = options.Location || makeLocationClass();
  return {
    calls,
    intervals,
    Storage,
    window: {
      innerHeight: options.innerHeight || 800,
      getComputedStyle: (node) => node.__style || { position: 'static' },
      // The switch learns the master setting over postMessage from src/relay.js;
      // this stands in for that message so a case can flip it without a reload.
      __listeners: [],
      addEventListener: function (type, fn) {
        if (type === 'message') this.__listeners.push(fn);
      },
      dispatch: function (data) {
        for (const fn of this.__listeners.slice()) fn({ source: this, data });
      }
    },
    document: document_,
    location: new Location(options.location),
    history: {
      replaceState: (state, title, url) => { calls.states.push(url); },
      pushState: (state, title, url) => { calls.states.push(url); }
    },
    localStorage: options.localStorage || new Storage(),
    sessionStorage: options.sessionStorage || new Storage(),
    chrome: options.chrome || { storage: { local: { get: async () => ({ settings: { enabled: true } }) } } },
    Document: FakeDocument,
    HTMLDocument: FakeDocument,
    MutationObserver: class FakeObserver {
      constructor(callback) { this.callback = callback; calls.observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (handle) => { calls.clearedInterval = handle; },
    console: { log: () => {} }
  };
};

const runScript = (file, world) => {
  const source = readFileSync(join(root, file), 'utf8');
  const self = {};
  // Both scripts gate on the packed host list before they do anything, so the
  // harness has to look like a build that shipped one.
  self.__yazWallHosts = world.wallHosts || '\nwww.bild.de\n';
  const names = Object.keys(world).filter((name) => name !== 'wallHosts');
  const values = names.map((name) => world[name]);
  new Function('self', ...names, source)(self, ...values);
  return self;
};

const wallText = 'Due to your ad blocker, we are not displaying BILD.de';

const makeNode = (props = {}) => Object.assign({
  nodeType: 1,
  tagName: 'DIV',
  textContent: '',
  innerText: '',
  offsetHeight: 100,
  __style: { position: 'static' },
  getAttribute: () => null,
  remove() { this.removed = true; }
}, props);

// ---------------------------------------------------------------- the switch

check('wall-main patches storage on a listed host', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.localStorage.setItem('_fa_1689', '1');
  assert(world.localStorage.getItem('_fa_1689') === null, 'marker key was stored');
  world.localStorage.setItem('consent', 'yes');
  assert(world.localStorage.getItem('consent') === 'yes', 'ordinary key was dropped');
});

check('wall-main drops marker cookies and keeps ordinary ones', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.document.cookie = '_fa_probe=1';
  assert(!String(world.document._cookie).includes('_fa_probe'), 'marker cookie was written');
  world.document.cookie = 'theme=dark';
  assert(String(world.document._cookie).includes('theme=dark'), 'ordinary cookie was dropped');
});

check('wall-main patches sessionStorage too', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.sessionStorage.setItem('__bfa_state', 'x');
  assert(world.sessionStorage.getItem('__bfa_state') === null, 'marker key survived on sessionStorage');
});

check('wall-main leaves the page untouched on an unlisted host', () => {
  const world = makeWorld({ location: { hostname: 'example.com' } });
  runScript('src/wall-main.js', world);
  world.localStorage.setItem('_fa_1234', '1');
  assert(world.localStorage.getItem('_fa_1234') === '1', 'unlisted host was patched anyway');
});

check('patched functions carry a native-looking toString', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  assert(/native code/.test(world.localStorage.setItem.toString()), 'setItem does not look native');
});

// ----------------------------------------------------------------- the guard

check('a static article block that mentions ad blockers is not a wall', () => {
  const world = makeWorld();
  const self = runScript('src/wall-guard.js', world);
  const node = makeNode({ textContent: wallText });
  assert(self.__yazWallOverlayish(node, world.window) === false, 'static block taken for a wall');
});

check('a fixed element with the wall copy is a wall', () => {
  const world = makeWorld();
  const self = runScript('src/wall-guard.js', world);
  const node = makeNode({ textContent: wallText, __style: { position: 'fixed' } });
  assert(self.__yazWallOverlayish(node, world.window) === true, 'fixed wall not recognised');
});

check('a dialog with the wall copy is a wall even when static', () => {
  const world = makeWorld();
  const self = runScript('src/wall-guard.js', world);
  const node = makeNode({ textContent: wallText, getAttribute: (name) => (name === 'role' ? 'dialog' : null) });
  assert(self.__yazWallOverlayish(node, world.window) === true, 'dialog wall not recognised');
});

check('the body and the article element are never removed', () => {
  const world = makeWorld();
  const self = runScript('src/wall-guard.js', world);
  const body = makeNode({ tagName: 'BODY', textContent: wallText, __style: { position: 'fixed' } });
  const article = makeNode({ tagName: 'ARTICLE', textContent: wallText, __style: { position: 'fixed' } });
  assert(self.__yazWallOverlayish(body, world.window) === false, 'body was considered a wall');
  assert(self.__yazWallOverlayish(article, world.window) === false, 'article was considered a wall');
});

check('a wall node is removed and the scrolling lock is released', async () => {
  const wallNode = makeNode({ textContent: wallText, __style: { position: 'fixed' }, offsetHeight: 900 });
  const world = makeWorld({ nodes: [wallNode] });
  const self = runScript('src/wall-guard.js', world);
  await new Promise((resolve) => setTimeout(resolve, 0));
  self.__yazWallScan();
  assert(wallNode.removed === true, 'wall node was not removed');
  assert(world.document.body.style.overflow === '', 'body scroll lock left in place');
  assert(world.document.documentElement.style.overflow === '', 'root scroll lock left in place');
});

check('the guard tears itself down at the scan cap', async () => {
  const world = makeWorld();
  const self = runScript('src/wall-guard.js', world);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 70; index += 1) self.__yazWallScan();
  const observer = world.calls.observers[0];
  assert(observer && observer.disconnected === true, 'observer kept running past the cap');
  assert(world.calls.clearedInterval !== undefined, 'interval kept running past the cap');
});

check('with the switch off the guard does nothing at all', async () => {
  const world = makeWorld({ chrome: { storage: { local: { get: async () => ({ settings: { enabled: false } }) } } } });
  const self = runScript('src/wall-guard.js', world);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(world.calls.selectors.length === 0, 'guard scanned with blocking off');
  assert(world.calls.observers.length === 0, 'guard watched with blocking off');
  assert(self.__yazWallScan === undefined, 'guard armed its scan with blocking off');
});

check('a switch turned off leaves the page alone', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.window.dispatch({ source: 'yt-ad-zapper', enabled: false });

  world.localStorage.setItem('raptive_cached_detection_hidden', '1');
  assert(
    world.localStorage.getItem('raptive_cached_detection_hidden') === '1',
    'a storage write was still dropped with the switch off'
  );
  world.document.cookie = 'OB-AD-BLOCKER-STAT=1; path=/';
  assert(world.document.cookie.includes('OB-AD-BLOCKER-STAT=1'), 'a cookie was still dropped with the switch off');

  world.location.replace('/adblockwall.html');
  assert(world.location.replacements.length === 1, 'a wall jump was still refused with the switch off');

  // Nothing may be refused twice: a switch thrown off while a page is open has
  // to look, from the page's side, exactly like an extension that never ran.
  world.history.pushState(null, '', '/adblockwall.html');
  assert(world.calls.states.length === 1, 'a wall state was still refused with the switch off');
});

check('turning it off clears the verdict the detector already wrote', () => {
  const world = makeWorld();
  // Seeded before the switch is installed, which is how the detector's records
  // look on a page whose blocker has just been turned off.
  world.localStorage.setItem('ordinary', 'keep');
  world.localStorage.setItem('raptive_abd_redetection', '1');
  world.sessionStorage.setItem('_fa_probe', '1');
  world.document.cookie = 'OB-AD-BLOCKER-WL-STAT=1; path=/';

  runScript('src/wall-main.js', world);
  world.window.dispatch({ source: 'yt-ad-zapper', enabled: false });

  assert(world.localStorage.getItem('raptive_abd_redetection') === null, 'the storage verdict survived the switch');
  assert(world.sessionStorage.getItem('_fa_probe') === null, 'the session verdict survived the switch');
  assert(world.localStorage.getItem('ordinary') === 'keep', 'a key that is not the detector\'s was deleted');
  assert(
    world.document.cookie.includes('OB-AD-BLOCKER-WL-STAT=; expires='),
    'the detector cookie was not expired'
  );
});

check('switching it back on arms the page again', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.window.dispatch({ source: 'yt-ad-zapper', enabled: false });
  world.window.dispatch({ source: 'yt-ad-zapper', enabled: true });
  world.localStorage.setItem('is_admiral_active', '1');
  assert(world.localStorage.getItem('is_admiral_active') === null, 'the switch did not come back on');
});

check('a wall landing is bounced once, then the guard yields', async () => {
  const session = new (makeStorageClass())();
  const first = makeWorld({ location: { pathname: '/adblockwall.html' }, sessionStorage: session });
  runScript('src/wall-guard.js', first);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(
    first.location.replacements.length === 1 && first.location.replacements[0] === '/',
    `expected one bounce, got ${first.location.replacements.length}`
  );
  assert(Number(session.getItem('yaz_wall_fight')) > 0, 'the fight was not recorded for the switch');

  const second = makeWorld({ location: { pathname: '/adblockwall.html' }, sessionStorage: session });
  runScript('src/wall-guard.js', second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(second.location.replacements.length === 0, 'it bounced again inside the window, which would loop');
});

check('an unlisted host is left alone', async () => {
  const world = makeWorld({ location: { hostname: 'example.com' } });
  const self = runScript('src/wall-guard.js', world);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(world.calls.selectors.length === 0, 'guard ran on an unlisted host');
  assert(self.__yazWallScan === undefined, 'guard armed on an unlisted host');
});

check('the marker test matches the loader keys and not ordinary ones', () => {
  const world = makeWorld();
  const self = runScript('src/wall-guard.js', world);
  assert(self.__yazWallMarker('_fa_1689') === true, 'marker key not recognised');
  assert(self.__yazWallMarker('adblock_seen') === true, 'adblock key not recognised');
  assert(self.__yazWallMarker('consent_mode') === false, 'ordinary key taken for a marker');
});

check('every record name the detector uses is caught', () => {
  const world = makeWorld();
  const self = runScript('src/wall-guard.js', world);
  // Taken from the detector's own string table, not invented for the test.
  const markers = [
    '_fa_',
    'last_bfa_at',
    'adshield_apply',
    'adshieldAvgRTT',
    'cache_is_blocking_ads',
    'cache_is_blocking_acceptable_ads',
    'is_blocking_ads',
    'raptive_cached_detection_detected_at_ms',
    'raptive_cached_detection_hidden',
    'raptive_abd_redetection',
    'is_admiral_active',
    'is_admiral_adwall_rendered',
    'givt_detected',
    'OB-AD-BLOCKER-WL-STAT',
    'OB-AD-BLOCKER-STAT',
    'tcheckResult'
  ];
  for (const name of markers) {
    assert(self.__yazWallMarker(name) === true, `record name not caught: ${name}`);
  }
  for (const name of ['consent_state', 'theme', 'sp_rollout_seg', 'mp_mixpanel_id']) {
    assert(self.__yazWallMarker(name) === false, `ordinary key caught as a marker: ${name}`);
  }
});

check('the switch refuses writes under every record name', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  for (const name of ['_fa_', 'last_bfa_at', 'cache_is_blocking_ads', 'raptive_cached_detection_hidden', 'is_admiral_active', 'OB-AD-BLOCKER-STAT', 'tcheckResult']) {
    world.localStorage.setItem(name, 'true');
    assert(world.localStorage.getItem(name) === null, `stored anyway: ${name}`);
  }
  world.localStorage.setItem('consent_state', 'granted');
  assert(world.localStorage.getItem('consent_state') === 'granted', 'ordinary key dropped');
});

check('a detection cookie is refused', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.document.cookie = 'raptive_cached_detection=' + encodeURIComponent('{"hidden":true}');
  assert(!String(world.document._cookie).includes('raptive'), 'detection cookie was written');
  world.document.cookie = 'ob_consent=1';
  assert(String(world.document._cookie).includes('ob_consent'), 'ordinary cookie dropped');
});

check('stored markers are cleared on a listed host', async () => {
  const store = new (makeStorageClass())();
  store.setItem('_fa_1689', '1');
  store.setItem('consent', 'yes');
  const world = makeWorld({ localStorage: store });
  runScript('src/wall-guard.js', world);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(store.getItem('_fa_1689') === null, 'stored marker survived');
  assert(store.getItem('consent') === 'yes', 'ordinary key was cleared');
});

check('the first wall jump is refused, and the page is then allowed to go', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.location.replace('/adblockwall.html');
  assert(world.location.replacements.length === 0, 'the first wall jump got through');

  // A layer that refuses every jump turns a wall into a reload loop, so the
  // second attempt inside the window is allowed. The window is in
  // sessionStorage, shared with the guard.
  world.location.replace('/adblockwall.html');
  assert(world.location.replacements.length === 1, 'the page was never allowed its wall');
  assert(Number(world.sessionStorage.getItem('yaz_wall_fight')) > 0, 'the fight was not recorded');

  const clean = makeWorld();
  runScript('src/wall-main.js', clean);
  clean.location.replace('/politik/');
  clean.location.href = '/news/';
  assert(clean.location.replacements.length === 2, `normal jumps were dropped: ${clean.location.replacements.join(', ')}`);
});

check('a state swap onto the wall path is refused, and ordinary states still pass', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  world.history.replaceState(null, '', '/adblockwall.html');
  assert(world.calls.states.length === 0, 'a wall state was pushed');
  world.history.pushState(null, '', '/sport/');
  assert(world.calls.states.length === 1, 'a normal state was refused');
});

check('the navigation guard does not arm on an unlisted host', () => {
  const world = makeWorld({ location: { hostname: 'example.com' } });
  runScript('src/wall-main.js', world);
  world.location.replace('/adblockwall.html');
  assert(world.location.replacements.length === 1, 'an unlisted host had its navigation patched');
});

check('the patched navigation functions look native', () => {
  const world = makeWorld();
  runScript('src/wall-main.js', world);
  assert(/native code/.test(world.location.replace.toString()), 'replace does not look native');
});

Promise.all(pending).then(() => {
  if (failures.length) {
    console.log(`FAIL ${failures.length}`);
    for (const failure of failures) console.log('  ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log(`${passed}/${passed} passed`);
});
