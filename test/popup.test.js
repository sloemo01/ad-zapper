/*
 * Test for popup.js (the tally popup).
 *
 * popup.js is an extension page script: `chrome.*` only exists inside the
 * extension, so it cannot run under plain node or as a normal web page. This
 * test supplies a fake chrome and a tiny fake DOM in node:vm and exercises
 * the real code: initial render, empty store, singular copy, and the reset.
 *
 * Run: node test/popup.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

const makeElement = (id) => ({
  id,
  textContent: '',
  listeners: {},
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  },
  async click() {
    if (this.listeners.click) await this.listeners.click();
  },
});

// Boots popup.js in a fresh context with its own DOM and storage.
const boot = async (initialStats) => {
  const elements = {
    total: makeElement('total'),
    detail: makeElement('detail'),
    reset: makeElement('reset'),
  };
  const store = initialStats ? { stats: initialStats } : {};
  const messages = [];

  const document = {
    getElementById: (id) => elements[id] || null,
  };

  const chrome = {
    storage: {
      local: {
        // Chrome takes a key, an array of keys or null. Handled the same way
        // here so a panel that reads two things at once is not a test failure.
        get: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          const found = {};
          for (const name of keys) {
            if (name in store) found[name] = store[name];
          }
          return found;
        },
      },
    },
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        // Mimics the worker's reset response.
        if (message && message.type === 'yt-ad-zapper:reset') {
          store.stats = { ads: 0, videos: 0, since: Date.now(), lastAt: 0 };
          return { ok: true };
        }
        return undefined;
      },
    },
  };

  const sandbox = { chrome, document, console, Date, Object, Number, String, Promise };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'popup.js' });
  await settle();
  return { elements, store, messages };
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

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'assertion failed');
};

const digits = (text) => String(text).replace(/[^0-9]/g, '');

(async () => {
  await check('renders the stored tally on load', async () => {
    const { elements } = await boot({ ads: 1234, videos: 56, since: 1, lastAt: Date.now() });
    assert(digits(elements.total.textContent) === '1234', `total shows "${elements.total.textContent}"`);
    assert(/56 videos cleaned/.test(elements.detail.textContent), `detail shows "${elements.detail.textContent}"`);
  });

  await check('empty store renders the zero state', async () => {
    const { elements } = await boot(null);
    assert(digits(elements.total.textContent) === '0', `total shows "${elements.total.textContent}"`);
    assert(/Nothing counted yet/.test(elements.detail.textContent), `detail shows "${elements.detail.textContent}"`);
  });

  await check('singular copy for one video', async () => {
    const { elements } = await boot({ ads: 2, videos: 1, since: 1, lastAt: Date.now() });
    assert(/1 video cleaned/.test(elements.detail.textContent), `detail shows "${elements.detail.textContent}"`);
  });

  await check('reset goes through the worker and re-renders', async () => {
    const { elements, messages, store } = await boot({ ads: 99, videos: 9, since: 1, lastAt: Date.now() });
    await elements.reset.click();
    await settle();
    assert(messages.length === 1, `expected one message, got ${messages.length}`);
    assert(messages[0].type === 'yt-ad-zapper:reset', `message type is ${messages[0].type}`);
    assert(store.stats && store.stats.ads === 0, 'the reset did not reach storage');
    assert(digits(elements.total.textContent) === '0', `total shows "${elements.total.textContent}"`);
    assert(/Nothing counted yet/.test(elements.detail.textContent), `detail shows "${elements.detail.textContent}"`);
  });

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL'));
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
})();
