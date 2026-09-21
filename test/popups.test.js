/*
 * Tests for the web-wide popup killer. Loads the generated host list and the
 * MAIN-world module in node:vm against a fake window, prototype, DOM and
 * MutationObserver, the way the browser injects them into a page.
 *
 * The interesting cases are the ones the deployed payload actually uses: a
 * window opened from a hidden iframe, a blank window written into, the
 * transparent click-catcher over the page, and the blocker blackmail screen.
 *
 * Run: node tools/build-popup-list.mjs && node test/popups.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const hostsSrc = fs.readFileSync(path.join(root, 'src', 'popup-hosts.js'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(root, 'src', 'popups.js'), 'utf8');

const PAGE_URL = 'https://www.vfxmed.com/post/';
const VIEWPORT = { width: 1200, height: 800 };

let FakeElement = null;

const makeElement = (tagName, options = {}) => {
  const element = new FakeElement(tagName);
  element.id = options.id || '';
  element.className = options.className || '';
  element.attrs = options.attrs || {};
  element.textContent = options.text !== undefined ? options.text : '';
  if (options.rect) element.rect = options.rect;
  return element;
};

const makeSandbox = (options = {}) => {
  const activation = options.activation || 'active';
  const topFrame = options.hiddenFrame !== true;
  const listeners = [];
  const opened = [];
  const reports = [];
  const appended = [];
  const observers = [];

  class Node {
    constructor(tagName) {
      this.nodeType = 1;
      this.tagName = tagName;
      this.id = '';
      this.className = '';
      this.attrs = {};
      this.textContent = '';
      this.children = [];
      this.isConnected = true;
      this.parentElement = null;
      this.rect = { width: 0, height: 0 };
      this.style = {
        setProperty(name, value) {
          this[name] = value;
        }
      };
      this.removed = false;
    }
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    }
    hasAttribute(name) {
      return name in this.attrs;
    }
    getBoundingClientRect() {
      return this.rect;
    }
    remove() {
      this.removed = true;
      this.isConnected = false;
    }
    appendChild(node) {
      appended.push(node);
      this.children.push(node);
      node.parentElement = this;
      return node;
    }
    insertBefore(node) {
      appended.push(node);
      this.children.push(node);
      node.parentElement = this;
      return node;
    }
    addEventListener() {}
  }
  FakeElement = Node;

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  }

  // The browser keeps open() on Window.prototype, so an iframe inherits it.
  // That inheritance is the leak this module has to close, so the fake models
  // it exactly: one shared prototype, many windows.
  const winProto = {
    open(...args) {
      opened.push(args);
      return { fake: 'popup' };
    }
  };

  const win = Object.create(winProto);
  Object.assign(win, {
    location: { href: PAGE_URL, origin: 'https://www.vfxmed.com' },
    postMessage(message) {
      reports.push(message);
    },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    innerWidth: topFrame ? VIEWPORT.width : 0,
    innerHeight: topFrame ? VIEWPORT.height : 0,
    frameElement: null,
    navigator: {
      userActivation: { isActive: activation === 'active', hasBeenActive: activation !== 'never' }
    }
  });
  win.self = win;
  win.top = topFrame ? win : { fake: 'top' };
  if (!topFrame) {
    win.frameElement = makeElement('IFRAME', { rect: { width: 0, height: 0 } });
  }

  const document = {
    documentElement: makeElement('HTML'),
    getElementById: () => null,
    createElement: (tagName) => makeElement(tagName)
  };

  const sandbox = {
    window: win,
    self: win,
    document,
    location: win.location,
    navigator: win.navigator,
    Node,
    MutationObserver,
    URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(hostsSrc, sandbox);
  vm.runInContext(moduleSrc, sandbox);

  // A hidden iframe belonging to the same page, as the payload builds them.
  const frameWindow = (frameOptions = {}) => {
    const frame = Object.create(winProto);
    Object.assign(frame, {
      location: { href: 'about:blank', origin: 'https://www.vfxmed.com' },
      postMessage(message) {
        reports.push(message);
      },
      addEventListener() {},
      innerWidth: frameOptions.visible ? VIEWPORT.width : 0,
      innerHeight: frameOptions.visible ? VIEWPORT.height : 0,
      frameElement: null,
      top: win
    });
    frame.self = frame;
    return frame;
  };

  return {
    sandbox,
    win,
    winProto,
    frameWindow,
    document,
    observers,
    opened,
    reports,
    appended,
    makeElement,
    mutate(mutations) {
      for (const observer of observers) observer.callback(mutations);
    },
    dispatchConfig(data) {
      for (const fn of listeners) fn({ source: win, data });
    }
  };
};

const scriptNode = (env, src, text) => {
  const node = env.makeElement('SCRIPT');
  if (src !== undefined) node.src = src;
  if (text !== undefined) node.textContent = text;
  return node;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- the blocklist ---------------------------------------------------------

test('generated list carries the decoded rotating hosts', () => {
  const env = makeSandbox();
  const packed = env.win.__yazPopupHosts;
  assert.equal(typeof packed, 'string', 'the list should be one packed string, got ' + typeof packed);
  assert.ok(packed.length > 1000, 'expected a real list, got ' + (packed && packed.length) + ' chars');
  assert.ok(packed.startsWith('\n') && packed.endsWith('\n'), 'the packed list needs newline padding');
  for (const host of ['oqhbgxvk.com', 'hkryzvagqpjuj.com', 'pemsrv.com', 'displayvertising.com']) {
    assert.ok(packed.includes('\n' + host + '\n'), host + ' missing from the list');
  }
  assert.ok(Number(env.win.__yazPopupHostCount) > 100, 'expected a packed host count');
});

// --- window.open traps -----------------------------------------------------

test('patches the prototype, not just the instance', () => {
  const env = makeSandbox();
  const descriptor = Object.getOwnPropertyDescriptor(env.winProto, 'open');
  assert.ok(descriptor && typeof descriptor.value === 'function', 'Window.prototype.open was not replaced');
  assert.strictEqual(
    Object.getOwnPropertyDescriptor(env.win, 'open'),
    undefined,
    'the window should not shadow open() with its own property'
  );
});

test('blocks a listed popup host on a fresh click', () => {
  const env = makeSandbox();
  const result = env.win.open('https://www.oqhbgxvk.com/XRd/rsha256.min.js');
  assert.strictEqual(result, null);
  assert.strictEqual(env.opened.length, 0);
  assert.strictEqual(env.reports[0].type, 'popup-blocked');
  assert.strictEqual(env.reports[0].host, 'www.oqhbgxvk.com');
});

test('blocks a popup opened from a hidden iframe', () => {
  const env = makeSandbox();
  const frame = env.frameWindow();
  const result = frame.open('https://fresh-ad-host.example/landing');
  assert.strictEqual(result, null, 'a hidden frame must not be able to open windows');
  assert.strictEqual(env.opened.length, 0);
  assert.match(env.reports[0].why, /hidden frame/);
});

test('blocks the blank popup the payload writes its ad into', () => {
  const env = makeSandbox();
  const frame = env.frameWindow();
  assert.strictEqual(frame.open('about:blank'), null);
  assert.strictEqual(frame.open(), null, 'open() with no argument is about:blank too');
  assert.match(env.reports[0].why, /hidden frame/);
});

test('blocks every popup from a frame that is itself hidden', () => {
  const env = makeSandbox({ hiddenFrame: true });
  assert.strictEqual(env.win.open('https://fresh-ad-host.example/landing'), null);
  assert.match(env.reports[0].why, /hidden frame/);
});

test('lets an unknown host through when the click is fresh', () => {
  const env = makeSandbox();
  const result = env.win.open('https://example.com/share');
  assert.ok(result, 'expected the native open result');
  assert.strictEqual(env.opened.length, 1);
  assert.strictEqual(env.reports.length, 0);
});

test('blocks a popup that fires with expired activation', () => {
  const env = makeSandbox({ activation: 'expired' });
  assert.strictEqual(env.win.open('https://unknown-ads.example/landing'), null);
  assert.strictEqual(env.reports.length, 1);
});

test('leaves never-activated popups to Chrome', () => {
  const env = makeSandbox({ activation: 'never' });
  assert.ok(env.win.open('https://unknown-ads.example/landing'));
  assert.strictEqual(env.reports.length, 0);
});

test('ignores same-origin and non-http targets', () => {
  const env = makeSandbox();
  assert.ok(env.win.open('/local/page'));
  assert.ok(env.win.open('about:blank'));
  assert.strictEqual(env.reports.length, 0);
});

test('honours the per-site allowlist from the worker', () => {
  const env = makeSandbox();
  env.dispatchConfig({ source: 'yt-ad-zapper', type: 'config', arm: true, allowlist: ['oqhbgxvk.com'] });
  assert.ok(env.win.open('https://www.oqhbgxvk.com/XRd/rsha256.min.js'));
  assert.strictEqual(env.reports.length, 0);
});

test('disarms everything when the worker says so', () => {
  const env = makeSandbox();
  env.dispatchConfig({ source: 'yt-ad-zapper', type: 'config', arm: false, allowlist: [] });
  assert.ok(env.win.open('https://www.oqhbgxvk.com/XRd/rsha256.min.js'));
  assert.strictEqual(env.reports.length, 0);
});

// --- script insertions -----------------------------------------------------

test('vetoes a script from a blocklisted host', () => {
  const env = makeSandbox();
  const parent = env.makeElement('DIV');
  const node = scriptNode(env, 'https://d3mzokty951c5w.cloudfront.net/ztDigs/bsha256.min.js');
  assert.strictEqual(parent.appendChild(node), node);
  assert.strictEqual(env.appended.length, 0);
  assert.strictEqual(env.reports[0].kind, 'script');
});

test('vetoes a script wearing a .css path and escalates its host', () => {
  const env = makeSandbox();
  const parent = env.makeElement('DIV');
  const node = scriptNode(env, 'https://fresh-host-9x.com/zgettext.cjs.min.css');
  parent.appendChild(node);
  assert.strictEqual(env.appended.length, 0, 'the disguised loader should not load');
  assert.strictEqual(env.reports[0].kind, 'loader');
  assert.ok(
    env.reports.some((report) => report.type === 'escalate' && report.host === 'fresh-host-9x.com'),
    'the host should be handed to the network layer'
  );
});

test('flags an inline loader payload', () => {
  const env = makeSandbox();
  const parent = env.makeElement('DIV');
  parent.appendChild(scriptNode(env, undefined, 'var x = {popundersPerIP: 1, topmostLayer: 2};'));
  assert.strictEqual(env.appended.length, 0);
  assert.strictEqual(env.reports[0].kind, 'loader');
});

test('lets benign script insertions through', () => {
  const env = makeSandbox();
  const parent = env.makeElement('DIV');
  parent.appendChild(scriptNode(env, 'https://cdn.example.com/app.js'));
  assert.strictEqual(env.appended.length, 1);
  assert.strictEqual(env.reports.length, 0);
});

// --- overlays --------------------------------------------------------------

test('removes the transparent click catcher and flags the page', async () => {
  const env = makeSandbox();
  const catcher = env.makeElement('DIV', {
    attrs: {
      style:
        'text-align:center;padding-top:48vh;font-size:4vw;position:fixed;display:block;width:100%;height:100%;' +
        'top:0;left:0;background-color:rgba(0,0,0,0);z-index:300000;'
    },
    rect: { width: VIEWPORT.width, height: VIEWPORT.height }
  });
  env.mutate([{ type: 'childList', addedNodes: [catcher] }]);
  await tick();
  assert.ok(catcher.removed, 'the click catcher should be gone');
  assert.strictEqual(env.reports[0].kind, 'overlay');

  const result = env.win.open('https://fresh-ad-host.example/landing');
  assert.strictEqual(result, null, 'a flagged ad page must not open popups');
  assert.match(env.reports[env.reports.length - 1].why, /ad page/);
});

test('removes the popup blocker blackmail screen', async () => {
  const env = makeSandbox();
  const screen = env.makeElement('DIV', {
    attrs: { style: 'position:fixed;width:100%;height:100%;z-index:300000;background-color:black;' },
    text: 'Access blocked due to popup blocker. Disable popup blocker and click anywhere to access the content.',
    rect: { width: VIEWPORT.width, height: VIEWPORT.height }
  });
  env.mutate([
    {
      type: 'childList',
      addedNodes: [{ nodeType: 3, nodeValue: 'Access blocked due to popup blocker.', parentElement: screen }]
    }
  ]);
  await tick();
  assert.ok(screen.removed, 'the blackmail screen should be gone');
});

test('removes the ad window layer by its marker ids', async () => {
  const env = makeSandbox();
  const layer = env.makeElement('DIV', { id: 'c_window_xEucqIjg', rect: { width: 300, height: 250 } });
  env.mutate([{ type: 'childList', addedNodes: [layer] }]);
  await tick();
  assert.ok(layer.removed);
  assert.strictEqual(env.reports[0].kind, 'overlay');
});

test('leaves ordinary elements alone', async () => {
  const env = makeSandbox();
  const banner = env.makeElement('DIV', {
    id: 'hero',
    attrs: { style: 'position:relative;width:100%;background-color:#fff;' },
    rect: { width: VIEWPORT.width, height: 300 }
  });
  env.mutate([{ type: 'childList', addedNodes: [banner] }]);
  await tick();
  assert.strictEqual(banner.removed, false);
  assert.strictEqual(env.reports.length, 0);
});

// --- runner ----------------------------------------------------------------

(async () => {
  let passed = 0;
  const failed = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('  pass  ' + name);
    } catch (err) {
      failed.push(name);
      console.log('  FAIL  ' + name + ' :: ' + err.message);
    }
  }
  console.log('');
  console.log(`${passed}/${tests.length} passed`);
  if (failed.length) {
    console.log('failed: ' + failed.join(', '));
    process.exit(1);
  }
})();
