/*
 * Ad Zapper: page-world interceptor.
 *
 * Runs in the MAIN world at document_start, which is before YouTube's own
 * scripts parse anything. The ad schedule ships inside the player response,
 * so the job here is to make sure the page never sees the ad fields. Four
 * hooks, in the order YouTube can reach them:
 *
 *   1. accessor traps on window.ytInitialPlayerResponse / window.playerResponse
 *      (inline player data embedded in the page HTML)
 *   2. a JSON.parse wrapper (anything the page parses itself)
 *   3. a fetch rewriter (player, get_watch, shorts sequence, legacy watch URLs)
 *   4. an XHR rewriter (legacy player code paths)
 *
 * Every removed ad is reported to the isolated world over window.postMessage,
 * which forwards it to the service worker that keeps the running tally.
 *
 * Field names are the part YouTube rotates. When ads come back, inspect a
 * real player response in devtools and add the new key to AD_KEYS.
 */
(() => {
  'use strict';

  const DEBUG = true;
  const TAG = '[yt-ad-zapper]';
  const CHANNEL = 'yt-ad-zapper';
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const HOOKED_URLS = [
    '/youtubei/v1/player',
    '/youtubei/v1/get_watch',
    '/youtubei/v1/reel/reel_watch_sequence',
    '/watch?',
    'playlist?list=',
  ];
  const ANTI_XSSI = /^\)\]\}',?\s*/;
  const TRAPPED_GLOBALS = ['ytInitialPlayerResponse', 'playerResponse'];

  // Flipped by the panel's master switch through the same config message the
  // popup killer reads. Checked at call time, not at load time: the relay's
  // message lands after this script has installed its hooks, and the hooks stay
  // installed, so turning the switch back on does not need a reload.
  let enabled = true;

  const log = (...args) => {
    if (DEBUG) console.log(TAG, ...args);
  };

  // Read the natives first, so the wrappers below can always call through.
  const nativeParse = JSON.parse;
  const nativeFetch = window.fetch;
  const xhrProto = XMLHttpRequest.prototype;
  const nativeXhrOpen = xhrProto.open;
  const nativeXhrSend = xhrProto.send;
  const textDesc = Object.getOwnPropertyDescriptor(xhrProto, 'responseText');
  const responseDesc = Object.getOwnPropertyDescriptor(xhrProto, 'response');

  // Videos whose ads were already counted in this page session, so repeat
  // fetches of the same player response cannot inflate the tally.
  const countedVideos = new Set();

  const reportBlocked = (value, ads) => {
    if (!ads) return;
    const holder = value && typeof value === 'object' ? (value.videoDetails ? value : value.playerResponse) : null;
    const videoId = (holder && holder.videoDetails && holder.videoDetails.videoId) || '';
    if (videoId) {
      if (countedVideos.has(videoId)) return;
      countedVideos.add(videoId);
    }
    log(`blocked ${ads} ad${ads === 1 ? '' : 's'}${videoId ? ` on ${videoId}` : ''}`);
    try {
      window.postMessage({ source: CHANNEL, type: 'ads-blocked', count: ads, videoId }, '*');
    } catch (_) {}
  };

  // Shorts: /reel/reel_watch_sequence marks inserted ads with adClientParams.isAd.
  const pruneShortsAdMarkers = (value) => {
    const sequence = value.reelWatchSequenceResponse;
    const entries = sequence && sequence.entries;
    if (!Array.isArray(entries)) return 0;
    let ads = 0;
    for (const entry of entries) {
      const endpoint = entry && entry.command && entry.command.reelWatchEndpoint;
      const params = endpoint && endpoint.adClientParams;
      if (params && Object.prototype.hasOwnProperty.call(params, 'isAd')) {
        try {
          delete params.isAd;
          ads += 1;
        } catch (_) {}
      }
    }
    return ads;
  };

  // Removes the ad fields in place. Returns { changed, ads } where `ads` is
  // the number of ad entries that were taken out.
  const prune = (value, depth = 0) => {
    if (!enabled) return { changed: false, ads: 0 };
    if (!value || typeof value !== 'object' || depth > 2) return { changed: false, ads: 0 };
    let changed = false;
    let ads = 0;

    // Each adPlacements / playerAds entry is one ad YouTube planned to play.
    // adSlots and adBreakHeartbeatParams are supporting config, so they only
    // count once when nothing else is present.
    const placements = Array.isArray(value.adPlacements) ? value.adPlacements.length : 0;
    const playerAds = Array.isArray(value.playerAds) ? value.playerAds.length : 0;
    let levelAds = placements + playerAds;
    for (const key of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        if (levelAds === 0) levelAds = 1;
        try {
          delete value[key];
          changed = true;
        } catch (_) {}
      }
    }
    ads += levelAds;

    if (value.playerResponse) {
      const nested = prune(value.playerResponse, depth + 1);
      if (nested.changed) changed = true;
      ads += nested.ads;
    }

    const shortsAds = pruneShortsAdMarkers(value);
    if (shortsAds) {
      changed = true;
      ads += shortsAds;
    }

    return { changed, ads };
  };

  // Parses a response body, prunes it, and re-serialises only on a change.
  const scrubText = (raw) => {
    try {
      const prefix = ANTI_XSSI.exec(raw);
      const data = nativeParse.call(JSON, prefix ? raw.slice(prefix[0].length) : raw);
      const outcome = prune(data);
      if (!outcome.changed) return { body: raw, ads: 0, value: null };
      return { body: (prefix ? prefix[0] : '') + JSON.stringify(data), ads: outcome.ads, value: data };
    } catch (_) {
      return { body: raw, ads: 0, value: null };
    }
  };

  const isHookedUrl = (url) => HOOKED_URLS.some((fragment) => url.includes(fragment));

  const readRequestUrl = (input) => {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  };

  // Hook 1: inline player data assigned to globals during page initialisation.
  for (const name of TRAPPED_GLOBALS) {
    let stored;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          return stored;
        },
        set(value) {
          const outcome = prune(value);
          if (outcome.changed) log(`scrubbed inline ${name}`);
          if (outcome.ads) reportBlocked(value, outcome.ads);
          stored = value;
        },
      });
    } catch (err) {
      log(`inline trap for ${name} failed`, err);
    }
  }

  // Hook 2: anything the page parses itself.
  JSON.parse = function (text, reviver) {
    const result = nativeParse.call(this, text, reviver);
    try {
      const outcome = prune(result);
      if (outcome.ads) reportBlocked(result, outcome.ads);
    } catch (_) {}
    return result;
  };

  // Hook 3: fetch responses.
  if (typeof nativeFetch === 'function') {
    window.fetch = async function () {
      const response = await nativeFetch.apply(this, arguments);
      try {
        const url = readRequestUrl(arguments[0]);
        if (url && isHookedUrl(url)) {
          const raw = await response.clone().text();
          const scrubbed = scrubText(raw);
          if (scrubbed.ads) reportBlocked(scrubbed.value, scrubbed.ads);
          if (scrubbed.body !== raw) {
            log('scrubbed fetch response', url.split('?')[0]);
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            return new Response(scrubbed.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
        }
      } catch (err) {
        log('fetch hook skipped a response', err);
      }
      return response;
    };
  }

  // Hook 4: XHR, for the older player code paths.
  const installXhrScrubber = (xhr) => {
    if (!textDesc || typeof textDesc.get !== 'function') return;
    let cachedRaw = '';
    let cachedBody = '';
    Object.defineProperty(xhr, 'responseText', {
      configurable: true,
      get() {
        const raw = textDesc.get.call(this);
        if (typeof raw !== 'string') return raw;
        if (raw !== cachedRaw) {
          cachedRaw = raw;
          const scrubbed = scrubText(raw);
          cachedBody = scrubbed.body;
          if (scrubbed.ads) reportBlocked(scrubbed.value, scrubbed.ads);
        }
        return cachedBody;
      },
    });
    if (responseDesc && typeof responseDesc.get === 'function') {
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get() {
          const type = this.responseType;
          if (type === 'json') {
            const parsed = responseDesc.get.call(this);
            try {
              const outcome = prune(parsed);
              if (outcome.ads) reportBlocked(parsed, outcome.ads);
            } catch (_) {}
            return parsed;
          }
          if (type === '' || type === 'text') return this.responseText;
          return responseDesc.get.call(this);
        },
      });
    }
  };

  if (typeof nativeXhrOpen === 'function' && typeof nativeXhrSend === 'function') {
    xhrProto.open = function (method, url) {
      this.__ytAdZapperUrl = String(url || '');
      return nativeXhrOpen.apply(this, arguments);
    };
    xhrProto.send = function () {
      if (this.__ytAdZapperUrl && isHookedUrl(this.__ytAdZapperUrl)) {
        installXhrScrubber(this);
      }
      return nativeXhrSend.apply(this, arguments);
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.type !== 'config') return;
    const next = data.enabled !== false;
    if (next === enabled) return;
    enabled = next;
    log(next ? 'interceptor on' : 'interceptor off');
  });

  log('interceptor armed');
})();
