/*
 * Smoke test for src/inject.js.
 *
 * Runs the interceptor in a fake page context (node:vm) and checks that all
 * four hooks install, strip the ad fields, and report blocked-ad counts over
 * window.postMessage. No browser involved.
 *
 * Run: node test/smoke.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'inject.js'), 'utf8');

// --- fake page environment -------------------------------------------------

class FakeHeaders {
  constructor(init) {
    this.map = new Map();
    if (init && typeof init.forEach === 'function') {
      init.forEach((value, name) => this.map.set(name, value));
    }
  }
  forEach(callback) {
    this.map.forEach((value, name) => callback(value, name, this));
  }
  delete(name) {
    this.map.delete(name);
  }
}

class FakeResponse {
  constructor(body, init = {}) {
    this._body = body;
    this.status = init.status || 200;
    this.statusText = init.statusText || 'OK';
    this.headers = init.headers instanceof FakeHeaders ? init.headers : new FakeHeaders(init.headers);
  }
  clone() {
    return new FakeResponse(this._body);
  }
  async text() {
    return this._body;
  }
}

class FakeXHR {}
FakeXHR.prototype.readyState = 0;
FakeXHR.prototype.responseType = '';
FakeXHR.prototype.open = function (method, url) {
  this._url = url;
  this.readyState = 1;
};
FakeXHR.prototype.send = function () {
  this._text = JSON.stringify({
    playabilityStatus: { status: 'OK' },
    adSlots: [{ adSlotRenderer: {} }],
    adBreakHeartbeatParams: 'opaque-blob',
    keepMe: true,
  });
  this.readyState = 4;
};
Object.defineProperty(FakeXHR.prototype, 'responseText', {
  configurable: true,
  get() {
    return this.readyState === 4 ? this._text : '';
  },
});
Object.defineProperty(FakeXHR.prototype, 'response', {
  configurable: true,
  get() {
    return this.responseText;
  },
});

// Two ad entries plus one playerAd: a payload YouTube would call 3 ads.
const playerPayload = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: 'dQw4w9WgXcQ' },
  adPlacements: [{ adPlacementRenderer: {} }, { adPlacementRenderer: {} }],
  playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
  adSlots: [{ adSlotRenderer: {} }],
  adBreakHeartbeatParams: 'opaque-blob',
};

const freshPayload = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: 'freshVideo' },
  adPlacements: [{ adPlacementRenderer: {} }, { adPlacementRenderer: {} }],
};

const cleanPayload = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: 'cleanVideo' },
};

// Captures everything the interceptor posts over window.postMessage.
const posted = [];

// The interceptor listens for the panel's master switch over window message, so
// the fake window holds listeners and can fire them.
const listeners = {};

const page = {
  addEventListener: (type, handler) => {
    (listeners[type] = listeners[type] || []).push(handler);
  },
  emitMessage: (data) => {
    for (const handler of listeners.message || []) handler({ source: page, data });
  },
  fetch: async (url) => {
    const target = String(url);
    if (target.includes('/get_watch')) return new FakeResponse(JSON.stringify(cleanPayload));
    if (target.includes('fresh=1')) return new FakeResponse(JSON.stringify(freshPayload));
    return new FakeResponse(JSON.stringify(playerPayload));
  },
  postMessage: (data) => {
    posted.push(data);
  },
};
page.window = page;

// A JSON object whose `parse` can be replaced without touching the host one.
const pageJSON = Object.create(JSON);

const sandbox = {
  window: page,
  console,
  JSON: pageJSON,
  Object,
  Array,
  Number,
  String,
  Headers: FakeHeaders,
  Response: FakeResponse,
  Request: class {},
  XMLHttpRequest: FakeXHR,
};
vm.createContext(sandbox);

const originalFetch = page.fetch;
const originalXhrOpen = FakeXHR.prototype.open;

vm.runInContext(source, sandbox, { filename: 'inject.js' });

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

const blockMessages = () =>
  posted.filter((m) => m && m.source === 'yt-ad-zapper' && m.type === 'ads-blocked');

(async () => {
  await check('fetch is wrapped', async () => {
    assert(page.fetch !== originalFetch, 'window.fetch was not replaced');
  });

  await check('XHR open is wrapped', async () => {
    assert(FakeXHR.prototype.open !== originalXhrOpen, 'XHR.open was not replaced');
  });

  await check('ytInitialPlayerResponse trap strips ad fields on assignment', async () => {
    page.ytInitialPlayerResponse = {
      videoDetails: { videoId: 'abc' },
      adPlacements: [{}, {}],
      playerAds: [{}],
      adSlots: [{}],
      adBreakHeartbeatParams: 'x',
    };
    const stored = page.ytInitialPlayerResponse;
    assert(!('adPlacements' in stored), 'adPlacements survived');
    assert(!('playerAds' in stored), 'playerAds survived');
    assert(!('adSlots' in stored), 'adSlots survived');
    assert(!('adBreakHeartbeatParams' in stored), 'adBreakHeartbeatParams survived');
    assert(stored.videoDetails && stored.videoDetails.videoId === 'abc', 'payload content was lost');

    const messages = blockMessages();
    const last = messages[messages.length - 1];
    assert(last, 'no blocked-ad message was posted');
    assert(last.count === 3, `expected a count of 3, got ${last.count}`);
    assert(last.videoId === 'abc', `expected videoId abc, got ${last.videoId}`);
  });

  await check('JSON.parse results are scrubbed', async () => {
    const parsed = pageJSON.parse('{"adPlacements":[1],"ok":true}');
    assert(!('adPlacements' in parsed), 'adPlacements survived JSON.parse');
    assert(parsed.ok === true, 'payload content was lost');
  });

  await check('fetch player response is scrubbed', async () => {
    const response = await page.fetch('https://www.youtube.com/youtubei/v1/player?key=x');
    const data = JSON.parse(await response.text());
    assert(!('adPlacements' in data), 'adPlacements survived fetch');
    assert(!('playerAds' in data), 'playerAds survived fetch');
    assert(!('adBreakHeartbeatParams' in data), 'adBreakHeartbeatParams survived fetch');
    assert(data.videoDetails.videoId === 'dQw4w9WgXcQ', 'payload content was lost');
  });

  await check('XHR player response is scrubbed and counted', async () => {
    const before = blockMessages().length;
    const xhr = new FakeXHR();
    xhr.open('POST', '/youtubei/v1/player');
    xhr.send();
    const data = JSON.parse(xhr.responseText);
    assert(!('adSlots' in data), 'adSlots survived XHR');
    assert(!('adBreakHeartbeatParams' in data), 'adBreakHeartbeatParams survived XHR');
    assert(data.keepMe === true, 'payload content was lost');

    const messages = blockMessages();
    assert(messages.length === before + 1, 'the XHR block was not reported');
    assert(messages[messages.length - 1].count === 1, `expected a count of 1, got ${messages[messages.length - 1].count}`);
  });

  await check('unhooked URLs pass through untouched', async () => {
    const response = await page.fetch('https://www.youtube.com/youtubei/v1/log_event');
    const text = await response.text();
    assert(text.includes('"adPlacements"'), 'an unhooked URL must not be rewritten');
  });

  await check('ad-free payloads pass through untouched', async () => {
    const response = await page.fetch('https://www.youtube.com/youtubei/v1/get_watch?v=x');
    const body = await response.text();
    assert(body === JSON.stringify(cleanPayload), 'a clean payload was rewritten');
  });

  await check('blocked ads are reported with a count and videoId', async () => {
    const before = blockMessages().length;
    const response = await page.fetch('https://www.youtube.com/youtubei/v1/player?fresh=1');
    await response.text();
    const messages = blockMessages();
    assert(messages.length === before + 1, `expected one new message, got ${messages.length - before}`);
    const last = messages[messages.length - 1];
    assert(last.count === 2, `expected a count of 2, got ${last.count}`);
    assert(last.videoId === 'freshVideo', `expected videoId freshVideo, got ${last.videoId}`);
  });

  await check('the same video is only counted once per page session', async () => {
    const before = blockMessages().length;
    await (await page.fetch('https://www.youtube.com/youtubei/v1/player?fresh=1')).text();
    assert(blockMessages().length === before, 'a repeat player response was counted twice');
  });

  await check('the master switch turns the interceptor off and back on', async () => {
    page.emitMessage({ source: 'yt-ad-zapper', type: 'config', enabled: false });
    const off = pageJSON.parse('{"adPlacements":[1],"ok":true}');
    assert('adPlacements' in off, 'the interceptor still stripped ads with blocking switched off');

    page.emitMessage({ source: 'yt-ad-zapper', type: 'config', enabled: true });
    const backOn = pageJSON.parse('{"adPlacements":[1],"ok":true}');
    assert(!('adPlacements' in backOn), 'the interceptor did not come back on');
  });

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL'));
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
})();
