/*
 * Tests the popup panel's deep-block section (src/popup.js) against a fake DOM
 * that has the real element ids, a fake tab and a worker that answers messages.
 *
 * The other popup suite covers the counters only; this one covers the parts
 * that only exist on a panel with a tab behind it: the state line, the pin
 * button, and the mode switch.
 *
 * Run: node test/popup-deep.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

const results = [];
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 40 : ms));

const makeElement = (id, extra) => ({
  id,
  textContent: '',
  innerHTML: '',
  className: (extra && extra.className) || '',
  disabled: false,
  attrs: (extra && extra.attrs) || {},
  children: (extra && extra.children) || null,
  listeners: {},
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  },
  click() {
    if (this.listeners.click) return this.listeners.click({ target: this });
    return undefined;
  },
  getAttribute(name) {
    return this.attrs[name];
  },
  closest(selector) {
    return selector === '[data-mode]' && this.attrs['data-mode'] ? this : null;
  },
  querySelectorAll(selector) {
    if (!this.children) return [];
    if (selector === '[data-mode]') return this.children.filter((child) => child.attrs['data-mode']);
    return [];
  }
});

const build = (options) => {
  const settings = options || {};
  const segs = ['smart', 'always', 'off'].map((mode) =>
    makeElement('seg-' + mode, { className: 'seg', attrs: { 'data-mode': mode } })
  );
  const elements = {
    total: makeElement('total'),
    detail: makeElement('detail'),
    popups: makeElement('popups'),
    deep: makeElement('deep'),
    deepDot: makeElement('deepDot', { className: 'dot' }),
    deepLabel: makeElement('deepLabel'),
    pin: makeElement('pin'),
    modes: makeElement('modes', { children: segs }),
    reset: makeElement('reset')
  };

  const store = Object.assign(
    {
      stats: {
        ads: 1248,
        videos: 9,
        since: Date.now(),
        lastAt: Date.now(),
        popups: 2,
        lastPopupHost: 'vfxmed.com',
        lastPopupKind: 'popup'
      },
      escalated: [{ host: 'a.example' }, { host: 'b.example' }, { host: 'c.example' }]
    },
    settings.store || {}
  );

  const sent = [];
  let tabReply = Object.assign(
    {
      host: 'vfxmed.com',
      attached: true,
      attachedHost: 'www.vfxmed.com',
      blockedHere: 7,
      mode: settings.mode || 'always',
      engineReady: true,
      blockedTotal: 320,
      pinned: false
    },
    settings.tabReply || {}
  );

  const chrome = {
    storage: {
      local: {
        get: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          const found = {};
          for (const name of keys) {
            if (name in store) found[name] = store[name];
          }
          return found;
        },
        set: async (obj) => Object.assign(store, obj)
      }
    },
    tabs: { query: async () => [{ id: 42, url: 'https://www.vfxmed.com/post/' }] },
    runtime: {
      sendMessage: async (message) => {
        if (settings.offline) throw new Error('Could not establish connection. Receiving end does not exist.');
        sent.push(message);
        if (message.type === 'yt-ad-zapper:tab-info') return tabReply;
        if (message.type === 'yt-ad-zapper:pin') {
          tabReply = Object.assign({}, tabReply, { pinned: !!message.pin });
        }
        return { ok: true };
      }
    }
  };

  const sandbox = {
    chrome,
    document: { getElementById: (id) => elements[id] || null },
    console,
    Date,
    Array,
    Object,
    Number,
    String,
    Promise,
    Math,
    JSON,
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'popup.js' });

  return { elements, segs, sent, store };
};

const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};

(async () => {
  const app = build();
  await settle();

  await check('renders the counters above the deep-block section', async () => {
    assert.strictEqual(app.elements.total.textContent, '1,248', app.elements.total.textContent);
    assert(/9 videos cleaned/.test(app.elements.detail.textContent), app.elements.detail.textContent);
    assert(/2 popup ads killed/.test(app.elements.popups.textContent), app.elements.popups.textContent);
    assert(/last one vfxmed\.com/.test(app.elements.popups.textContent), app.elements.popups.textContent);
    assert(/3 hosts blocked site-wide/.test(app.elements.popups.textContent), app.elements.popups.textContent);
  });

  await check('asks the worker about the tab it was opened on', async () => {
    const asked = app.sent.filter((message) => message.type === 'yt-ad-zapper:tab-info');
    assert(asked.length === 1, `asked ${asked.length} times`);
    assert(asked[0].tabId === 42, `asked about tab ${asked[0].tabId}`);
  });

  await check('describes an attached tab, with the count for that tab', async () => {
    assert(/<b>on<\/b> for this tab/.test(app.elements.deepLabel.innerHTML), app.elements.deepLabel.innerHTML);
    assert(/7 blocked here/.test(app.elements.deepLabel.innerHTML), app.elements.deepLabel.innerHTML);
    assert.strictEqual(app.elements.deepDot.className, 'dot on', app.elements.deepDot.className);
    assert.strictEqual(app.elements.pin.textContent, 'Deep block this site', app.elements.pin.textContent);
    assert.strictEqual(app.elements.pin.disabled, false, 'the pin button is disabled on a real site');
  });

  await check('marks the mode the worker reported', async () => {
    const active = app.segs.filter((seg) => seg.className.includes('active'));
    assert(active.length === 1, `${active.length} modes look active`);
    assert(active[0].attrs['data-mode'] === 'always', `active mode is ${active[0].attrs['data-mode']}`);
  });

  await check('pinning a site tells the worker and flips the button', async () => {
    await app.elements.pin.click();
    await settle();
    const pinned = app.sent.filter((message) => message.type === 'yt-ad-zapper:pin');
    assert(pinned.length === 1, `sent ${pinned.length} pin messages`);
    assert(pinned[0].host === 'vfxmed.com', `pinned ${pinned[0].host}`);
    assert(pinned[0].pin === true, 'the pin message says unpin');
    assert(pinned[0].tabId === 42, `pinned tab ${pinned[0].tabId}`);
    assert.strictEqual(app.elements.pin.textContent, 'Stop deep blocking this site', app.elements.pin.textContent);
  });

  await check('the mode switch sends the mode and re-marks it', async () => {
    const off = app.segs.find((seg) => seg.attrs['data-mode'] === 'off');
    // The listener sits on the container and takes bubbled clicks. The fake DOM
    // has no event system, so the bubbled event is built by hand.
    await app.elements.modes.listeners.click({ target: off });
    await settle();
    const modes = app.sent.filter((message) => message.type === 'yt-ad-zapper:settings');
    assert(modes.length === 1, `sent ${modes.length} mode messages`);
    assert(modes[0].deepBlock === 'off', `sent ${modes[0].deepBlock}`);
    assert(off.className.includes('active'), 'the pressed mode is not marked');
    assert(
      app.segs.filter((seg) => seg.className.includes('active')).length === 1,
      'more than one mode is marked'
    );
  });

  await check('an ordinary page reads as standby, not attached', async () => {
    const plain = build({
      mode: 'smart',
      tabReply: { host: 'news.example', attached: false, blockedHere: 0, pinned: false, mode: 'smart' }
    });
    await settle();
    assert(/standby/.test(plain.elements.deepLabel.innerHTML), plain.elements.deepLabel.innerHTML);
    assert.strictEqual(plain.elements.deepDot.className, 'dot', plain.elements.deepDot.className);
    const active = plain.segs.filter((seg) => seg.className.includes('active'));
    assert(active.length === 1 && active[0].attrs['data-mode'] === 'smart', 'smart is not marked');
  });

  await check('a page with no host (chrome://, new tab) leaves the pin alone', async () => {
    const blank = build({ tabReply: { host: '', attached: false, pinned: false, mode: 'smart' } });
    await settle();
    assert.strictEqual(blank.elements.pin.disabled, true, 'the pin button is enabled without a host');
    assert(/standby/.test(blank.elements.deepLabel.innerHTML), blank.elements.deepLabel.innerHTML);
  });

  await check('a worker that cannot be reached does not break the panel', async () => {
    const offline = build({ offline: true });
    await settle();
    assert.strictEqual(offline.elements.total.textContent, '1,248', offline.elements.total.textContent);
    assert.strictEqual(offline.sent.length, 0, 'messages were recorded while offline');
    assert.strictEqual(offline.elements.pin.textContent, 'Deep block this site', offline.elements.pin.textContent);
    assert(/idle/.test(offline.elements.deepLabel.innerHTML), offline.elements.deepLabel.innerHTML);
  });

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL'));
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
})();
