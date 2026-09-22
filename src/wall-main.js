/*
 * Main-world wall switch.
 *
 * The detector that walls readers out does not act on the requests it sees. It
 * records a decision: a timestamped marker in storage, and a cookie. The page
 * reads that record back a beat later and renders the wall when it finds it.
 *
 * Clearing the record from the isolated world loses a race: the write and the
 * read happen inside one page load, and a content script that sweeps after the
 * fact is too late for the read that mattered. This script runs in the page's
 * own world at document_start, before any page script, and stops the record
 * from ever existing: marker keys are dropped on write and answer null on read,
 * so the page's check runs against an empty shelf and finds nothing to act on.
 *
 * Only marker-shaped keys are touched. Everything else the site stores, reads
 * and deletes behaves exactly as written, and the patched functions carry a
 * native-looking toString so the page has no cheap way to tell they are ours.
 *
 * Runs in every frame on every site and returns after one substring test unless
 * the frame is on a host whose responses this extension rewrites. The master
 * switch cannot be read here (the page world has no extension APIs), so this
 * patcher stays in place when blocking is off: with nothing blocked there is no
 * marker to write, and a dropped marker-shaped key changes nothing for a reader
 * who is not being walled.
 */
(() => {
  'use strict';

  // Sites Ad Zapper does not touch: stand down before anything else here runs.
  // The manifest excludes these hosts, but a frame can still load us through
  // match_about_blank, so the check lives here as well.
  if (self.adZapperIsSkippedHost && self.adZapperIsSkippedHost(location.hostname)) return;


  const LIST = typeof self.__yazWallHosts === 'string' ? self.__yazWallHosts : '\n';
  const TAG = '[yt-ad-zapper]';

  const listed = (host) => {
    let name = String(host || '').toLowerCase();
    if (!name) return false;
    for (;;) {
      if (LIST.includes('\n' + name + '\n')) return true;
      const dot = name.indexOf('.');
      if (dot < 0) return false;
      name = name.slice(dot + 1);
    }
  };

  let host = '';
  try {
    host = location.hostname;
  } catch (_) {
    return;
  }
  if (!listed(host)) return;

  // The detector's record names, taken from its own code rather than guessed:
  // RodoGuard writes `_fa_`, `last_bfa_at`, `adshield*`, `cache_is_blocking_ads`,
  // `raptive_cached_detection_*` and `is_admiral_active`, and the sites it runs on
  // add their own (`OB-AD-BLOCKER-STAT`, `tcheckResult`). Keys are matched
  // broadly because the family is wide and renamed between builds; values are
  // matched narrowly, so a site writing the literal string "_fa_" as content is
  // the only thing at risk. A dropped key of another kind leaves the site on its
  // default, which is the safe direction for this kind of switch.
  const KEY = /_fa_|_bfa_|ad[-_]?block|blocking|raptive|adshield|admiral|givt|detect|tcheck/i;
  const VALUE = /_fa_|_bfa_/i;

  const looksNative = (fn, name) => {
    try {
      Object.defineProperty(fn, 'toString', {
        configurable: true,
        value: () => `function ${name}() { [native code] }`
      });
      Object.defineProperty(fn, 'name', { configurable: true, value: name });
    } catch (_) {}
    return fn;
  };

  let dropped = 0;
  const report = (what, key) => {
    dropped += 1;
    if (dropped <= 5) console.log(`${TAG} wall switch: dropped ${what} write "${String(key).slice(0, 40)}"`);
  };

  // The master switch. This script runs in the page's own world, which has no
  // extension APIs, so the setting arrives from src/relay.js over postMessage
  // and stays in step with it: a switch thrown while a page is open lands here
  // without a reload. Until the first message it is assumed on, which costs
  // nothing because the relay posts within a few milliseconds of
  // document_start, well before any detector has reason to write anything.
  const CHANNEL = 'yt-ad-zapper';
  let live = true;
  let nativeCookieSet = null;

  // Wipes the records the detector left behind. Called once, on the transition
  // to off: with blocking stopped, a stale verdict is the only thing left that
  // can wall a reader, and it is this extension's footprint, so it goes.
  const sweep = () => {
    try {
      for (const shelf of [localStorage, sessionStorage]) {
        const names = [];
        for (let index = 0; index < shelf.length; index += 1) {
          const name = shelf.key(index);
          if (name && KEY.test(name)) names.push(name);
        }
        for (const name of names) shelf.removeItem(name);
      }
    } catch (_) {}
    try {
      for (const chunk of String(document.cookie || '').split(';')) {
        const name = chunk.split('=')[0].trim();
        if (!name || !KEY.test(name) || !nativeCookieSet) continue;
        nativeCookieSet.call(document, `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`);
      }
    } catch (_) {}
  };

  try {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== CHANNEL || typeof data.enabled !== 'boolean') return;
      if (data.enabled === live) return;
      const was = live;
      live = data.enabled;
      if (was && !live) {
        sweep();
        console.log(`${TAG} wall switch: off, records cleared on ${host}`);
      } else {
        console.log(`${TAG} wall switch: on again on ${host}`);
      }
    });
  } catch (_) {}

  // Storage covers localStorage and sessionStorage in one patch, which is why
  // the prototype is the target rather than either instance.
  try {
    if (typeof Storage === 'function' && Storage.prototype) {
      const proto = Storage.prototype;
      const nativeSet = proto.setItem;
      const nativeGet = proto.getItem;
      const nativeRemove = proto.removeItem;
      proto.setItem = looksNative(function setItem(key, value) {
        const name = String(key);
        if (live && (KEY.test(name) || VALUE.test(String(value)))) {
          report('storage', name);
          return undefined;
        }
        return nativeSet.call(this, key, value);
      }, 'setItem');
      proto.getItem = looksNative(function getItem(key) {
        const name = String(key);
        if (live && KEY.test(name)) return null;
        return nativeGet.call(this, key);
      }, 'getItem');
      proto.removeItem = looksNative(function removeItem(key) {
        return nativeRemove.call(this, key);
      }, 'removeItem');
    }
  } catch (_) {}

  try {
    const descriptor =
      Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
      Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (descriptor && descriptor.get && descriptor.set) {
      nativeCookieSet = descriptor.set.bind(document);
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => descriptor.get.call(document),
        set: (value) => {
          const name = String(value).split('=')[0].trim();
          if (live && KEY.test(name)) {
            report('cookie', name);
            return;
          }
          descriptor.set.call(document, value);
        }
      });
    }
  } catch (_) {}

  // The jump itself. The detector does not ask permission: when its handshake
  // fails it navigates the tab to the site's wall page, from an inline handler
  // the page builds at runtime (which is why stripping the same handler out of
  // the document never stopped it). A navigation is a plain `location.replace`
  // or `href` call from page script, so it can be refused right where it is
  // made: a target that is a wall path is dropped, everything else passes.
  const WALL_PATH = /adblockwall|adblock-wall|werbeblocker/i;
  const pathOf = (value) => {
    try {
      const text = String(value == null ? '' : value);
      if (!text) return '';
      const url = new URL(text, location.href);
      return url.pathname + url.search;
    } catch (_) {
      return '';
    }
  };
  // One fight per window, and then the page is allowed to go. Fighting every
  // jump is what turns a wall into a reload loop: the site answers a refusal by
  // jumping again, and a layer that never yields keeps the tab spinning. The
  // window is shared with the guard through sessionStorage, so the two page-world
  // layers cannot each decide to fight the same navigation.
  const FIGHT_KEY = 'yaz_wall_fight';
  const FIGHT_WINDOW_MS = 20000;
  let jumps = 0;
  const refused = (value) => {
    if (!live) return false;
    const target = pathOf(value);
    if (!target || !WALL_PATH.test(target)) return false;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(FIGHT_KEY) || 0) || 0;
    } catch (_) {}
    if (Date.now() - last < FIGHT_WINDOW_MS) return false;
    try {
      sessionStorage.setItem(FIGHT_KEY, String(Date.now()));
    } catch (_) {}
    jumps += 1;
    console.log(`${TAG} wall switch: refused a jump to ${target.slice(0, 60)}`);
    return true;
  };

  try {
    const proto = Object.getPrototypeOf(location);
    for (const name of ['replace', 'assign']) {
      const native = proto[name];
      if (typeof native !== 'function') continue;
      proto[name] = looksNative(function (value) {
        if (refused(value)) return undefined;
        return native.call(this, value);
      }, name);
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'href');
    if (descriptor && descriptor.get && descriptor.set) {
      Object.defineProperty(proto, 'href', {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) { if (refused(value)) return; descriptor.set.call(this, value); }
      });
    }
  } catch (_) {}

  try {
    for (const name of ['replaceState', 'pushState']) {
      const native = history[name];
      if (typeof native !== 'function') continue;
      history[name] = looksNative(function (state, title, url) {
        if (refused(url)) return undefined;
        return native.call(this, state, title, url);
      }, name);
    }
  } catch (_) {}

  console.log(`${TAG} wall switch armed on ${host}`);
})();
