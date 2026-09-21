/*
 * The wall guard, checked against a fake page.
 *
 * It runs in every frame, so the things that matter are that it does nothing on
 * a host with no response rules, that on a walled host it clears the loader's
 * markers and bounces consecutive wall landings up to a cap instead of looping, and that the
 * panel's master switch stops all of it.
 *
 * Run: node test/wall-guard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const guard = fs.readFileSync(path.join(root, 'src/wall-guard.js'), 'utf8');
const hosts = fs.readFileSync(path.join(root, 'src/wall-hosts.js'), 'utf8');
let consoleLines = [];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// enabled === undefined means no chrome.storage at all, which is a frame the
// guard cannot read a setting from and therefore must not stand down on.
const run = (url, storage = {}, session = {}, enabled, extra = {}) => {
  const navigations = [];
  const logger = { log: (...args) => consoleLines.push(args.join(' ')), warn() {}, error() {} };
  const make = (state) => ({
    getItem: (key) => (key in state ? state[key] : null),
    setItem(key, value) {
      state[key] = String(value);
      this[key] = String(value);
    },
    removeItem(key) {
      delete state[key];
      delete this[key];
    },
    key: (index) => Object.keys(state)[index] || null,
    get length() {
      return Object.keys(state).length;
    }
  });
  const localStorage = make(storage);
  for (const key of Object.keys(storage)) localStorage[key] = storage[key];

  const sandbox = {
    self: {},
    console: logger,
    location: {
      href: url,
      hostname: new URL(url).hostname,
      pathname: new URL(url).pathname,
      replace: (target) => navigations.push(target)
    },
    sessionStorage: make(session),
    localStorage,
    // The guard reads the referrer to bounce a wall landing back to the article
    // the reader was on rather than the front page.
    document: { referrer: extra.referrer || '', cookie: '' },
    Object,
    RegExp,
    String,
    URL
  };
  if (enabled !== undefined) {
    sandbox.chrome = {
      storage: { local: { get: async () => ({ settings: { enabled } }) } }
    };
  }
  // The guard schedules its late sweeps and throttles its scans with timers, so
  // a sandbox without them silently drops that behaviour and the checks below
  // would pass on code that never ran.
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.Date = Date;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(hosts, sandbox, { filename: 'src/wall-hosts.js' });
  vm.runInContext(guard, sandbox, { filename: 'src/wall-guard.js' });
  return { navigations, storage, session, sandbox };
};

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

const hostListRaw = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'wall-hosts.js'), 'utf8').split('self.__yazWallHosts = ')[1].split(';')[0]
);
const walled = hostListRaw.trim().split('\n');
const walledHost = walled[0];

(async () => {
  await check('the host list covers the sites with response rules', async () => {
    assert(walled.length >= 4, `only ${walled.length} walled hosts: ${walled.join(', ')}`);
    assert(walled.includes('bild.de'), 'bild.de has a response rule and must be in the list');
    assert(walled.includes('youtube.com'), 'youtube.com has response rules and must be in the list');
  });

  await check('a host with no response rules is left completely alone', async () => {
    consoleLines = [];
    const page = run('https://example.com/some/page', { example_fa_x: '1' }, {}, true);
    await tick();
    assert(page.navigations.length === 0, 'it navigated on a normal site');
    assert(page.storage.example_fa_x === '1', 'it touched storage on a normal site');
    assert(consoleLines.length === 0, `it logged on a normal site: ${consoleLines.join(' | ')}`);
  });

  await check('a subdomain of a walled host is recognised', async () => {
    consoleLines = [];
    run(`https://news.${walledHost}/article`, {}, {}, true);
    await tick();
    assert(consoleLines.some((line) => line.includes('wall guard on')), 'a subdomain was not recognised');
  });

  await check('the loader markers are cleared and nothing else is', async () => {
    const page = run(
      `https://www.${walledHost}/`,
      { [`www.${walledHost}_fa_bGFzdF9iZmFfYXQ=`]: '1790000000000', consent_state: 'granted' },
      {},
      true
    );
    await tick();
    const keys = Object.keys(page.storage);
    assert(!keys.some((key) => key.includes('_fa_')), `a loader marker survived: ${keys.join(',')}`);
    assert(page.storage.consent_state === 'granted', 'it removed a key that was not a loader marker');
  });

  await check('a wall landing is bounced once, then the guard yields', async () => {
    const session = {};
    const first = run(`https://www.${walledHost}/adblockwall.html`, {}, session, true);
    await tick();
    assert(
      first.navigations.length === 1 && first.navigations[0] === '/',
      `expected one bounce to /, got ${JSON.stringify(first.navigations)}`
    );
    assert(Number(session.yaz_wall_bounce) > 0, 'the bounce was not recorded for the tab');

    // The site re-serves the wall immediately. Bouncing again would be a reload
    // loop, which is worse than the wall, so the second landing is left alone.
    const second = run(`https://www.${walledHost}/adblockwall.html`, {}, session, true);
    await tick();
    assert(second.navigations.length === 0, 'it bounced again inside the window, which would loop');
  });

  await check('an old bounce does not stop a later one', async () => {
    const session = { yaz_wall_bounce: String(Date.now() - 60000) };
    const page = run(`https://www.${walledHost}/adblockwall.html`, {}, session, true);
    await tick();
    assert(page.navigations.length === 1, 'a stale window blocked a legitimate bounce');
  });

  await check('a wall landing goes back to the article, not the front page', async () => {
    const session = {};
    const page = run(`https://www.${walledHost}/adblockwall.html`, {}, session, true, {
      referrer: `https://www.${walledHost}/politik/some-article.bild.html`
    });
    await tick();
    assert(
      page.navigations.length === 1 && page.navigations[0].endsWith('/politik/some-article.bild.html'),
      `expected a bounce to the referrer, got ${JSON.stringify(page.navigations)}`
    );
  });

  await check('a referrer from another host is ignored', async () => {
    const session = {};
    const page = run(`https://www.${walledHost}/adblockwall.html`, {}, session, true, {
      referrer: 'https://tracker.example.com/click'
    });
    await tick();
    assert(
      page.navigations.length === 1 && page.navigations[0] === '/',
      `expected a bounce to the root, got ${JSON.stringify(page.navigations)}`
    );
  });

  await check('a wall-page referrer does not send us in a circle', async () => {
    const session = {};
    const page = run(`https://www.${walledHost}/adblockwall.html`, {}, session, true, {
      referrer: `https://www.${walledHost}/adblockwall.html`
    });
    await tick();
    assert(
      page.navigations.length === 1 && page.navigations[0] === '/',
      `expected a bounce to the root, got ${JSON.stringify(page.navigations)}`
    );
  });

  await check('the fight window is recorded where the page-world switch can see it', async () => {
    const session = {};
    run(`https://www.${walledHost}/adblockwall.html`, {}, session, true);
    await tick();
    assert(Number(session.yaz_wall_fight) > 0, 'the guard did not record its fight for the switch');
  });

  await check('a normal page on a walled host does not navigate', async () => {
    const page = run(`https://www.${walledHost}/news/some-article`, {}, {}, true);
    await tick();
    assert(page.navigations.length === 0, 'it navigated away from a normal article');
  });

  await check('the master switch stops the guard', async () => {
    consoleLines = [];
    const page = run(
      `https://www.${walledHost}/adblockwall.html`,
      { [`www.${walledHost}_fa_x`]: '1790000000000' },
      {},
      false
    );
    await tick();
    assert(page.navigations.length === 0, 'it bounced with blocking switched off');
    assert(
      Object.keys(page.storage).some((key) => key.includes('_fa_')),
      'it cleared markers with blocking switched off'
    );
    assert(
      consoleLines.some((line) => line.includes('blocking is off')),
      `it did not say why it stood down: ${consoleLines.join(' | ')}`
    );
  });

  await check('a frame that cannot read the setting still works', async () => {
    const page = run(`https://www.${walledHost}/adblockwall.html`, {}, {}, undefined);
    await tick();
    assert(page.navigations.length === 1, 'the guard did nothing without chrome.storage');
  });

  const failed = results.filter((line) => line.startsWith('FAIL'));
  await check('a verdict written during the visit is swept too', async () => {
    const page = run(`https://news.${walledHost}/article`, {}, {}, true);
    await tick();
    // This is the shape a detector's cached verdict takes, written a second or
    // two into the visit, long after the guard's first pass.
    page.sandbox.localStorage.setItem('tcheckResult', '1');
    page.sandbox.localStorage.setItem('OB-AD-BLOCKER-WL-STAT', '1');
    assert(page.sandbox.localStorage.getItem('tcheckResult') === '1', 'the verdict never landed');
    await new Promise((resolve) => setTimeout(resolve, 2800));
    assert(page.sandbox.localStorage.getItem('tcheckResult') === null, 'a verdict written mid-visit survived');
    assert(
      page.sandbox.localStorage.getItem('OB-AD-BLOCKER-WL-STAT') === null,
      'the wall-status key written mid-visit survived'
    );
  });

  console.log(results.join('\n'));
  console.log(`\nwall hosts: ${walled.join(', ')}`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
