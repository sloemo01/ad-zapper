/*
 * Relay: isolated world, every http(s) page and its about:blank frames,
 * document_start.
 *
 * The bridge between the page-world popup killer and the extension:
 *   1. hands the killer its config (armed flag plus the per-site allowlist,
 *      read from chrome.storage.local);
 *   2. forwards its block reports to the service worker, which keeps the tally
 *      and turns caught hosts into network-level blocks.
 * The page world cannot touch chrome.*, so this is the only path up.
 */
(() => {
  'use strict';

  // Sites Ad Zapper does not touch: stand down before anything else here runs.
  // The manifest excludes these hosts, but a frame can still load us through
  // match_about_blank, so the check lives here as well.
  if (self.adZapperIsSkippedHost && self.adZapperIsSkippedHost(location.hostname)) return;


  const CHANNEL = 'yt-ad-zapper';
  const TO_DOC = 'yt-ad-zapper:doc';
  const TO_POPUP = 'yt-ad-zapper:popup-blocked';
  const TO_ESCALATE = 'yt-ad-zapper:escalate';

  const post = (message) => {
    try {
      window.postMessage({ source: CHANNEL, ...message }, '*');
    } catch (_) {}
  };

  const send = (payload) => {
    try {
      const sent = chrome.runtime.sendMessage(payload);
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (_) {}
  };

  const sync = async () => {
    try {
      const stored = await chrome.storage.local.get(['settings', 'allowlist']);
      const settings = (stored && stored.settings) || {};
      const allowlist = (stored && stored.allowlist) || [];
      // The master switch reaches three page-world scripts through this one
      // message: the popup killer reads `arm`, the YouTube interceptor and the
      // wall guard read `enabled`.
      const enabled = settings.enabled !== false;
      post({
        type: 'config',
        arm: enabled && settings.popupKiller !== false,
        enabled,
        allowlist: Array.isArray(allowlist) ? allowlist : []
      });
    } catch (_) {}
  };

  // The wall is answered with the reader's own copy of the page, and this is
  // where that copy is taken: the article renders first, the wall arrives a
  // second or two later, and a capture at load time beats the jump. Walled hosts
  // only, capped, and silent about it.
  const captureDoc = () => {
    try {
      const list = typeof self.__yazWallHosts === 'string' ? self.__yazWallHosts : '';
      if (!list) return;
      let name = String(location.hostname || '').toLowerCase();
      let listed = false;
      for (;;) {
        if (('\n' + list + '\n').indexOf('\n' + name + '\n') >= 0) {
          listed = true;
          break;
        }
        const dot = name.indexOf('.');
        if (dot < 0) break;
        name = name.slice(dot + 1);
      }
      if (!listed) return;
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      if (!html || html.length < 2000 || html.length > 1500000) return;
      send({ type: TO_DOC, url: location.href, html });
    } catch (_) {}
  };
  // The copy has to exist before the wall does. BILD's front page pulls ~250
  // resources, so `load` lands at three or four seconds and the jump at two:
  // capturing on load meant capturing after the walk had already happened, and
  // the wall was never answered with anything. Take it at DOMContentLoaded, and
  // again on a short timer in case that fires late or not at all, and once more
  // at load for pages that really are slow.
  let captured = false;
  const captureOnce = () => {
    if (captured) return;
    captured = true;
    captureDoc();
  };
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(captureOnce, 300));
    } else {
      captureOnce();
    }
    setTimeout(captureOnce, 1200);
    window.addEventListener('load', () => setTimeout(captureOnce, 200));
  } catch (_) {}

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL) return;
    // The page asking what the extension just did. The answer is mirrored into
    // localStorage so a live tab can be read without opening any UI.
    if (data.type === 'diag') {
      try {
        chrome.runtime.sendMessage({ type: 'yt-ad-zapper:diag' }, (info) => {
          try {
            const payload = Object.assign(
              { at: Date.now(), page: location.href },
              info || { error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no reply' }
            );
            localStorage.setItem('__yaz_diag', JSON.stringify(payload));
          } catch (_) {}
        });
      } catch (_) {}
      return;
    }

    if (data.type === 'escalate') {
      if (typeof data.host !== 'string') return;
      send({ type: TO_ESCALATE, host: data.host });
      return;
    }

    if (data.type !== 'popup-blocked') return;
    send({
      type: TO_POPUP,
      kind: typeof data.kind === 'string' ? data.kind : 'popup',
      host: typeof data.host === 'string' ? data.host : '',
      url: typeof data.url === 'string' ? data.url : ''
    });
  });

  // Element hiding, computed by the worker from the same filter engine the deep
  // block uses. The panel of rules is fetched once per host and cached there.
  const injectCosmetics = (css, host) => {
    if (!css) return;
    try {
      const style = document.createElement('style');
      style.setAttribute('data-ad-zapper', host || 'page');
      style.textContent = css;
      const root = document.head || document.documentElement;
      if (root) root.appendChild(style);
    } catch (_) {}
  };

  // Every frame reports its URL: the worker decides whether this tab earns the
  // deep-block treatment from the top frame's URL, and hands back the hiding CSS
  // for whatever frame asked. Only the top frame reports once per page load.
  const report = () => {
    try {
      chrome.runtime.sendMessage(
        { type: 'yt-ad-zapper:page', url: location.href, top: window === window.top },
        (reply) => {
          if (chrome.runtime.lastError) return;
          if (reply && typeof reply.css === 'string') injectCosmetics(reply.css, reply.host);
        }
      );
    } catch (_) {}
  };

  report();

  sync();

  // Scriptlets: the generated map says what this host asks for, and the worker
  // runs it in the page's world because no content script can. Once per frame
  // load, and only while the switch is on and the site is not allowlisted.
  const runScriptlets = async () => {
    try {
      if (typeof AD_ZAPPER_SCRIPTLETS_FOR !== 'function') return;
      if (!/^https?:$/.test(location.protocol)) return;
      const host = location.hostname;
      if (!host) return;
      const stored = await chrome.storage.local.get(['settings', 'allowlist']);
      const settings = (stored && stored.settings) || {};
      if (settings.enabled === false) return;
      const allowlist = (stored && stored.allowlist) || [];
      if (Array.isArray(allowlist) && allowlist.includes(host)) return;
      const calls = AD_ZAPPER_SCRIPTLETS_FOR(host);
      if (!calls || !calls.length) return;
      send({ type: 'yt-ad-zapper:scriptlets', host, calls });
    } catch (_) {}
  };

  runScriptlets();

  // The panel's switch writes to chrome.storage, which fires here in every open
  // frame, so a page that is already loaded follows the switch without a reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes && changes.settings) sync();
    });
  } catch (_) {}
})();
