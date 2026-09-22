/*
 * Wall guard: the in-page half of the wall defence.
 *
 * The response stage is what actually defeats a wall (it strips the trigger
 * from the document before the page runs), but it only applies to a deep-blocked
 * tab and only when interception caught the document. This script needs neither,
 * so it is the layer that still works when the rewrite misses. Three jobs, all
 * of them on the hosts whose responses this extension rewrites:
 *
 *   1. clear marker records the detector already left behind (storage and
 *      cookies). src/wall-main.js stops new ones from being written at all.
 *   2. remove a wall that got rendered over the page anyway, and unfreeze the
 *      scrolling its overlay locks.
 *   3. send the reader back to the site root once per tab if the browser lands
 *      on a wall page, instead of waiting for a click on a slider.
 *
 * Runs in every frame. The host check is first and costs a substring test
 * against one packed string, so a frame on a site with no response rules pays
 * nothing. The master switch is a stored setting rather than something pushed
 * at this script, because this runs in the isolated world and can read it
 * directly: when the switch is off the guard stands down entirely.
 */
(() => {
  'use strict';

  // Sites Ad Zapper does not touch: stand down before anything else here runs.
  // The manifest excludes these hosts, but a frame can still load us through
  // match_about_blank, so the check lives here as well.
  if (self.adZapperIsSkippedHost && self.adZapperIsSkippedHost(location.hostname)) return;


  const LIST = typeof self.__yazWallHosts === 'string' ? self.__yazWallHosts : '\n';
  const WALL_PATH = /adblockwall|adblock-wall|werbeblocker/i;
  // The same family src/wall-main.js refuses to write: RodoGuard's `_fa_`,
  // `last_bfa_at`, `adshield*`, `cache_is_blocking_ads`, `raptive_cached_detection_*`,
  // `is_admiral_active`, plus the host sites' own flags such as
  // `OB-AD-BLOCKER-STAT` and `tcheckResult`.
  const MARKER = /_fa_|_bfa_|ad[-_]?block|blocking|raptive|adshield|admiral|givt|detect|tcheck/i;
  const BOUNCE_KEY = 'yaz_wall_bounce';
  // A wall landing is only fought once per window. Bouncing every landing turns
  // a site that re-walls into a reload loop, which is worse than the wall: the
  // reader gets one bounce, and if it comes straight back the guard yields.
  const BOUNCE_WINDOW_MS = 20000;
  const TAG = '[yt-ad-zapper]';
  const SCAN_CAP = 60;

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
  let path = '';
  try {
    host = location.hostname;
    path = location.pathname;
  } catch (_) {
    return;
  }
  if (!listed(host)) return;

  const WALL_TEXT = /werbeblocker|ad ?blocker|not displaying|schalte deinen|deaktiviere/i;
  const WALL_SELECTOR = [
    '[class*=adblockwall i]',
    '[id*=adblockwall i]',
    '[class*=adblock-wall i]',
    '[id*=adblock-wall i]',
    '[class*=blockwall i]',
    '[id*=blockwall i]',
    '[class*=wall-overlay i]',
    '[id*=wall-overlay i]',
    '[class*=adblocker i]',
    '[id*=adblocker i]',
    '[class*=wall-modal i]',
    '[id*=wall-modal i]'
  ].join(',');

  // A wall is an element laid over the page that says so. Pure on purpose: the
  // test suite calls it directly with fabricated nodes, and a page cannot see
  // it (an isolated world's globals are its own).
  const overlayish = (node, view) => {
    if (!node || node.nodeType !== 1) return false;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'ARTICLE' || tag === 'HEADER' || tag === 'FOOTER') return false;
    let text = '';
    try {
      text = String(node.innerText || node.textContent || '').slice(0, 4000);
    } catch (_) {
      return false;
    }
    if (!WALL_TEXT.test(text)) return false;
    let style = null;
    try {
      style = (view || (node.ownerDocument && node.ownerDocument.defaultView) || {}).getComputedStyle(node);
    } catch (_) {}
    const positioned = !!style && /fixed|absolute/.test(String(style.position || ''));
    const dialog = !!node.getAttribute && (node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true');
    const tall = !!view && view.innerHeight > 0 && node.offsetHeight >= view.innerHeight * 0.5;
    return positioned || dialog || tall;
  };
  self.__yazWallOverlayish = overlayish;
  self.__yazWallMarker = (text) => MARKER.test(String(text));

  // Two late passes, and the page going away. Enough to catch a verdict written
  // during the visit, cheap enough to leave running on a news page.
  const LATE_SWEEPS = [2500, 6000];

  const whenArmed = async (run) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return run(true);
      const stored = await chrome.storage.local.get('settings');
      const settings = (stored && stored.settings) || {};
      return run(settings.enabled !== false);
    } catch (_) {
      return run(true);
    }
  };

  whenArmed((armed) => {
    console.log(`${TAG} wall guard on ${host}${path}${armed ? '' : ' (blocking is off)'}`);
    if (!armed) return;

    // 1. Records the detector already wrote, and the ones it writes later.
    //
    // The verdict that walls the *next* visit is stored a second or two into
    // this one, long after document_start, so a single sweep at the top of the
    // page always misses it: the reader gets walled, the verdict is written,
    // and the next visit is walled from memory before the page is even read.
    // Three bounded passes instead, plus the page going away, and no interval
    // left running afterwards.
    let cleared = 0;
    const sweepRecords = () => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (MARKER.test(key)) {
            localStorage.removeItem(key);
            cleared += 1;
          }
        }
      } catch (_) {}
      try {
        const names = String(document.cookie || '')
          .split(';')
          .map((part) => part.split('=')[0].trim())
          .filter(Boolean);
        for (const name of names) {
          if (!MARKER.test(name)) continue;
          document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
          cleared += 1;
        }
      } catch (_) {}
      return cleared;
    };
    self.__yazWallSweep = sweepRecords;
    sweepRecords();
    for (const delay of LATE_SWEEPS) {
      try {
        setTimeout(sweepRecords, delay);
      } catch (_) {}
    }
    try {
      window.addEventListener('pagehide', sweepRecords);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') sweepRecords();
      });
    } catch (_) {}
    if (cleared) console.log(`${TAG} wall guard cleared ${cleared} stored marker(s)`);

    // 3. A wall page is a page of its own, and the site re-serves it as often as
    // it likes. Three consecutive landings get three bounces, then the guard
    // stops, because a reader stuck in a loop is worse off than one looking at a
    // wall with a back button. Reaching a normal page resets the count, so the
    // next wall landing gets its bounces back.
    if (WALL_PATH.test(path)) {
      let last = 0;
      try {
        last = Number(sessionStorage.getItem(BOUNCE_KEY) || 0) || 0;
      } catch (_) {}
      if (Date.now() - last >= BOUNCE_WINDOW_MS) {
        try {
          sessionStorage.setItem(BOUNCE_KEY, String(Date.now()));
          sessionStorage.setItem('yaz_wall_fight', String(Date.now()));
        } catch (_) {}
        // Back to the article the reader was on, not the front page: the wall
        // page puts the page they came from in the referrer.
        let back = '/';
        try {
          const source = document.referrer || '';
          if (source && !WALL_PATH.test(source)) {
            const target = new URL(source);
            if (target.hostname === host || target.hostname.endsWith('.' + host)) back = target.href;
          }
        } catch (_) {}
        console.log(`${TAG} wall page, returning to ${back.slice(0, 60)}`);
        location.replace(back);
      } else {
        console.log(`${TAG} walled again inside the window, standing down`);
      }
      return;
    }

    // 2. A wall that got rendered anyway. Bounded on purpose: a busy news page
    // mutates constantly, so scans are throttled, capped, and then torn down
    // with the observer and the timer rather than left watching forever.
    let stopped = false;
    let scans = 0;
    let observer = null;
    let timer = null;
    let last = 0;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        if (observer) observer.disconnect();
      } catch (_) {}
      try {
        if (timer) clearInterval(timer);
      } catch (_) {}
    };

    const unfreeze = () => {
      try {
        document.documentElement.style.overflow = '';
        if (document.body) document.body.style.overflow = '';
      } catch (_) {}
    };

    const scan = () => {
      if (stopped || scans >= SCAN_CAP) {
        stop();
        return;
      }
      scans += 1;
      let candidates = [];
      try {
        candidates = Array.from(document.querySelectorAll(WALL_SELECTOR));
      } catch (_) {}
      try {
        // Class names change between builds; the copy in the wall does not.
        if (document.body) {
          for (const node of document.body.children) {
            if (candidates.indexOf(node) < 0) candidates.push(node);
          }
        }
      } catch (_) {}
      let removed = 0;
      for (const node of candidates) {
        if (!overlayish(node, window)) continue;
        try {
          node.remove();
          removed += 1;
        } catch (_) {}
      }
      if (removed) {
        unfreeze();
        console.log(`${TAG} wall guard removed ${removed} wall element(s)`);
      }
    };
    self.__yazWallScan = scan;

    const onMutation = () => {
      const now = Date.now();
      if (now - last < 1200) return;
      last = now;
      scan();
    };

    try {
      observer = new MutationObserver(onMutation);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    try {
      timer = setInterval(scan, 4000);
    } catch (_) {}
    scan();
  });
})();
