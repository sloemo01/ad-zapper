/*
 * Generic ad detection.
 *
 * Everything above this file works from lists or from what you have already
 * visited: the rule sets are downloaded, the site registry remembers the sites
 * that have produced ads before. This file is the part that can look at a page
 * it has never seen and say something useful about it, and then generalise what
 * it found so the next site benefits.
 *
 * Three jobs:
 *
 *   1. Look at the page. src/detect.js::collect runs inside the page (through
 *      chrome.scripting) and reports two things: the third-party hosts the page
 *      actually loaded, and the elements that look like ad slots, each with the
 *      reason it looked like one. Nothing is hidden on the strength of a single
 *      guess.
 *   2. Generalise the hosts. A host seen on one site is a host seen on one site.
 *      A host that matches known ad-network naming, or that turns up on three
 *      different sites, is plumbing, and it goes through the same escalation
 *      gate the popup catcher uses (src/background.js::escalateHost), which
 *      refuses anything that is not ad infrastructure.
 *   3. Generalise the elements. An element named like an ad slot is turned into
 *      a selector with the numbers and hashes stripped out, and a selector only
 *      joins the hiding sheet once two different sites have produced it.
 *
 * Both memories are capped and both are visible in the popup and the probe:
 * this layer guesses, so it has to be able to show its work.
 */
'use strict';

const DETECT_SIGHTING_KEY = 'sightings';
const DETECT_LEARNED_KEY = 'learned.css';
const DETECT_SIGHTING_LIMIT = 800;
const DETECT_SELECTOR_LIMIT = 200;
const DETECT_SITES_FOR_PROMOTION = 3;
const DETECT_SITES_FOR_SELECTOR = 2;

// Host names that are ad plumbing by name. Deliberately narrow: this is a
// promotion shortcut, not a blocklist, and every hit still goes through the
// escalation gate downstream.
const AD_HOST = new RegExp(
  [
    '(^|\\.)(adservice|adsystem|adserver|adnxs|adsrvr|adform|adition|adcolony|adroll|',
    'amazon-adsystem|doubleclick|googlesyndication|googleadservices|moatads|taboola|outbrain|',
    'criteo|pubmatic|rubiconproject|smartadserver|teads|sharethrough|spotxchange|yieldmo|',
    'casalemedia|openx|indexww|loopme|zedo|carbonads|adthrive|mediavine|ezoic|sovrn|triplelift|',
    'inmobi|mopub|applovin|startapp|chartboost|vungle|ironsrc|smaato|tremor|unrulymedia|',
    'freewheel|innovid|extremereach|springserve|beeswax|districtm|emxdgt|gumgum|pixalate|',
    'quantcast|scorecardresearch|demdex|everesttech|agkn|mathtag|simpli\\.fi|crwdcntrl)($|\\.)',
    '|(^|\\.)(ads?|adserv|adserver|adsystem|adtech|advertising|sponsors?)\\.'
  ].join(''),
  'i'
);

// Path and file shapes that mean ad plumbing regardless of the host name.
const AD_PATH = /\/(ads?|adserver|advert|advertise|advertising|banners?|sponsors?|prebid|gpt|gampad|pagead|tag|openrtb|vast|vpaid|beacon)\//i;

// The sizes the industry actually uses. An element of exactly one of these is a
// guess on its own; it only counts when the name or the source agrees.
const AD_SIZES = [
  [300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [160, 600], [300, 600],
  [320, 50], [320, 100], [468, 60], [234, 60], [120, 600], [300, 100], [250, 250]
];

const NAME_SHAPE = /(^|[-_ ])(ads?|advert|advertisement|sponsor|sponsored|promo|promoted|banner|gpt|dfp|taboola|outbrain|taboola|prebid)([-_ ]|$)/i;

const normaliseHost = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');

const detectApex = (host) => {
  const parts = String(host || '').split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
};

const detectSameSite = (a, b) => {
  const left = detectApex(normaliseHost(a));
  const right = detectApex(normaliseHost(b));
  return !!left && left === right;
};

// --- the page side ----------------------------------------------------------

// Runs inside the page. Everything it needs arrives as arguments, because a
// function handed to chrome.scripting.executeScript cannot close over anything.
const detectCollect = (adHostSource, adPathSource, nameShapeSource, sizes) => {
  const out = { hosts: [], candidates: [], thirdParty: 0, resources: 0 };
  try {
    const adHost = new RegExp(adHostSource, 'i');
    const adPath = new RegExp(adPathSource, 'i');
    const nameShape = new RegExp(nameShapeSource, 'i');
    const here = String(location.hostname || '').replace(/^www\./, '');
    const apex = (host) => {
      const parts = String(host || '').split('.').filter(Boolean);
      return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
    };
    const mine = apex(here);

    const entries = performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
    const seen = new Set();
    out.resources = entries.length;
    for (const entry of entries) {
      let host = '';
      try {
        host = new URL(entry.name).hostname.replace(/^www\./, '');
      } catch (_) {
        continue;
      }
      if (!host || apex(host) === mine) continue;
      out.thirdParty += 1;
      if (seen.has(host) || seen.size >= 40) continue;
      seen.add(host);
      out.hosts.push(host);
    }

    const pixels = (rect) => {
      for (const pair of sizes) {
        if (Math.abs(rect.width - pair[0]) <= 2 && Math.abs(rect.height - pair[1]) <= 2) {
          return pair[0] + 'x' + pair[1];
        }
      }
      return '';
    };

    const nodes = document.querySelectorAll('iframe, ins, img, div, aside, section');
    let looked = 0;
    for (const node of nodes) {
      if (out.candidates.length >= 25 || looked >= 900) break;
      const id = String(node.id || '');
      const cls = String(node.className || '').slice(0, 120);
      const src = String(node.getAttribute && (node.getAttribute('src') || node.getAttribute('data-src')) || '');
      const text = id + ' ' + cls;
      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
      const size = pixels(rect);
      const named = nameShape.test(text);
      const sourced = !!src && adHost.test(String(src).split('/')[2] || '') ;
      const pathed = !!src && adPath.test(src);
      if (!named && !size && !sourced && !pathed) continue;
      looked += 1;
      if (!named && !sourced && !pathed) continue; // a standard size on its own is not enough
      out.candidates.push({
        tag: node.tagName ? node.tagName.toLowerCase() : 'div',
        id,
        cls,
        size,
        why: [named && 'name', sourced && 'host', pathed && 'path'].filter(Boolean).join('+'),
        src: src.slice(0, 120)
      });
    }
  } catch (_) {}
  return out;
};

// --- the worker side --------------------------------------------------------

const detectStripNoise = (value) =>
  String(value || '')
    .replace(/[0-9a-f]{8,}/gi, '')
    .replace(/\d+/g, '')
    .replace(/[-_]{2,}/g, '-')
    .replace(/[-_ ]+$/, '')
    .replace(/^[-_ ]+/, '');

// An element named like an ad slot, turned into something that fits other
// pages: the numbers and hashes are what makes two slots different installs of
// the same widget.
const selectorFor = (candidate) => {
  if (!candidate || typeof candidate !== 'object') return null;
  const tag = String(candidate.tag || 'div').toLowerCase();
  if (!/^(div|iframe|ins|img|aside|section|span)$/.test(tag)) return null;

  const id = detectStripNoise(candidate.id);
  if (id && NAME_SHAPE.test(candidate.id) && id.length >= 4 && id.length <= 40) {
    return `${tag}[id^="${id.replace(/"/g, '')}"]`;
  }
  const classes = String(candidate.cls || '')
    .split(/\s+/)
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of classes) {
    if (!NAME_SHAPE.test(name)) continue;
    const clean = detectStripNoise(name);
    if (clean.length < 4 || clean.length > 40) continue;
    if (!/^[a-z0-9-_ ]+$/i.test(clean)) continue;
    return `${tag}[class*="${clean.replace(/"/g, '')}"]`;
  }
  return null;
};

const emptySightings = () => ({ hosts: {}, selectors: {} });

const readSightings = async () => {
  try {
    const stored = await chrome.storage.local.get(DETECT_SIGHTING_KEY);
    const value = stored && stored[DETECT_SIGHTING_KEY];
    if (!value || typeof value !== 'object') return emptySightings();
    return {
      hosts: value.hosts && typeof value.hosts === 'object' ? value.hosts : {},
      selectors: value.selectors && typeof value.selectors === 'object' ? value.selectors : {}
    };
  } catch (_) {
    return emptySightings();
  }
};

const trimMap = (map, limit) => {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  keys.sort((a, b) => (map[a].last || 0) - (map[b].last || 0));
  for (let index = 0; index < keys.length - limit; index++) delete map[keys[index]];
  return map;
};

const writeSightings = async (state) => {
  trimMap(state.hosts, DETECT_SIGHTING_LIMIT);
  trimMap(state.selectors, DETECT_SELECTOR_LIMIT);
  try {
    await chrome.storage.local.set({ [DETECT_SIGHTING_KEY]: state });
  } catch (_) {}
  return state;
};

const detectMark = (entry, site) => {
  entry = entry || { sites: [], count: 0, last: 0 };
  entry.count = (entry.count || 0) + 1;
  entry.last = Date.now();
  const list = Array.isArray(entry.sites) ? entry.sites : [];
  if (site && !list.includes(site)) {
    list.push(site);
    while (list.length > 4) list.shift();
  }
  entry.sites = list;
  return entry;
};

const recordSightings = async (pageHost, hosts) => {
  const site = normaliseHost(pageHost);
  const list = Array.isArray(hosts) ? hosts.slice(0, 60) : [];
  if (!site || !list.length) return { promoted: [], counted: 0 };
  const state = await readSightings();
  const promoted = [];
  let counted = 0;
  for (const raw of list) {
    const host = normaliseHost(raw);
    if (!host || !host.includes('.')) continue;
    if (detectSameSite(host, site)) continue;
    if (host.length > 120) continue;
    const entry = detectMark(state.hosts[host], site);
    state.hosts[host] = entry;
    counted += 1;
    const distinct = entry.sites.length;
    const looksAd = AD_HOST.test(host) || AD_PATH.test('/' + host + '/');
    if (!looksAd && distinct < DETECT_SITES_FOR_PROMOTION) continue;
    if (entry.promoted) continue;
    entry.promoted = true;
    promoted.push({ host, why: looksAd ? 'name' : `${distinct} sites` });
  }
  await writeSightings(state);
  return { promoted, counted };
};

const rememberSelectors = async (pageHost, candidates) => {
  const site = normaliseHost(pageHost);
  const list = Array.isArray(candidates) ? candidates.slice(0, 25) : [];
  if (!site || !list.length) return { ready: [], state: null };
  const state = await readSightings();
  const ready = [];
  for (const candidate of list) {
    const selector = selectorFor(candidate);
    if (!selector) continue;
    const entry = detectMark(state.selectors[selector], site);
    state.selectors[selector] = entry;
    entry.why = candidate.why || entry.why || '';
  }
  Object.keys(state.selectors).forEach((selector) => {
    const entry = state.selectors[selector];
    if (!entry.published && entry.sites.length >= DETECT_SITES_FOR_SELECTOR) {
      entry.published = true;
      ready.push(selector);
    }
  });
  await writeSightings(state);
  return { ready, state };
};

const buildCss = (state) => {
  const selectors = Object.keys(state.selectors || {}).filter((selector) => state.selectors[selector].published);
  if (!selectors.length) return '';
  return selectors
    .slice(0, DETECT_SELECTOR_LIMIT)
    .map((selector) => `${selector}{display:none !important;}`)
    .join('\n');
};

const publishCss = async (state) => {
  const css = buildCss(state);
  try {
    await chrome.storage.local.set({ [DETECT_LEARNED_KEY]: css });
  } catch (_) {}
  return css;
};

const learnedCss = async () => {
  try {
    const stored = await chrome.storage.local.get(DETECT_LEARNED_KEY);
    return String((stored && stored[DETECT_LEARNED_KEY]) || '');
  } catch (_) {
    return '';
  }
};

const forget = async () => {
  try {
    await chrome.storage.local.set({ [DETECT_SIGHTING_KEY]: emptySightings(), [DETECT_LEARNED_KEY]: '' });
  } catch (_) {}
  return true;
};

const stats = async (diag) => {
  const state = await readSightings();
  const hosts = Object.keys(state.hosts);
  const selectors = Object.keys(state.selectors);
  const promoted = hosts.filter((host) => state.hosts[host].promoted);
  return {
    hosts: hosts.length,
    hostLimit: DETECT_SIGHTING_LIMIT,
    promoted: promoted.length,
    selectors: selectors.length,
    published: selectors.filter((selector) => state.selectors[selector].published).length,
    selectorLimit: DETECT_SELECTOR_LIMIT,
    recent: promoted
      .sort((a, b) => (state.hosts[b].last || 0) - (state.hosts[a].last || 0))
      .slice(0, 8)
      .map((host) => `${host} (${state.hosts[host].sites.length} site(s))`)
  };
};

self.AdblockerDetect = {
  sightingKey: DETECT_SIGHTING_KEY,
  learnedKey: DETECT_LEARNED_KEY,
  hostLimit: DETECT_SIGHTING_LIMIT,
  selectorLimit: DETECT_SELECTOR_LIMIT,
  sitesForPromotion: DETECT_SITES_FOR_PROMOTION,
  sitesForSelector: DETECT_SITES_FOR_SELECTOR,
  adHostSource: AD_HOST.source,
  adPathSource: AD_PATH.source,
  nameShapeSource: NAME_SHAPE.source,
  sizes: AD_SIZES,
  AD_HOST,
  AD_PATH,
  NAME_SHAPE,
  detectCollect,
  selectorFor,
  detectStripNoise,
  recordSightings,
  rememberSelectors,
  buildCss,
  publishCss,
  learnedCss,
  readSightings,
  forget,
  stats
};
