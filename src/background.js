/*
 * Ad Zapper: service worker.
 *
 * Six jobs:
 *   1. the ad tally reported by the YouTube interceptor, and the toolbar badge;
 *   2. the popup-killer tally reported by every page through src/relay.js;
 *   3. host escalation: hosts the killer catches in the wild become dynamic
 *      declarativeNetRequest rules, so they are blocked at the network layer on
 *      every site from then on. The cap comes from the platform (5,000 dynamic
 *      rules guaranteed, 30,000 on Chrome 121+), and a full registry evicts the
 *      host with fewest catches instead of ignoring the new one;
 *   4. element hiding: every frame asks for the CSS that belongs to its URL and
 *      the worker answers from the vendored engine, cached per host with a host
 *      cap and a byte cap (src/smart.js);
 *   5. list upkeep: src/lists.js recompiles the filter lists daily and caches the
 *      result, so the engine does not age into uselessness;
 *   6. deep block: src/deepblock.js attaches the DevTools network stack to the
 *      tabs that deserve it and filters every request through the engine. This
 *      file decides when a page deserves it, from what src/smart.js remembers
 *      about the site.
 *
 * Memory is a policy here, not an afterthought: the brain is unloaded when it is
 * idle, every cache has a cap and an eviction path, and the site registry is
 * trimmed oldest-first.
 *
 * Escalations are recorded so the reset can undo them, and every host is
 * validated (protected apex list plus an ad-infrastructure shape check) so a
 * hostile page cannot talk us into blocking the web.
 *
 * Storage updates run through a promise queue so two frames reporting at once
 * cannot clobber each other's write.
 */
'use strict';

try {
  importScripts('/src/popup-hosts.js');
} catch (_) {}

try {
  importScripts('/src/skip-hosts.js');
  importScripts('/src/smart.js');
  importScripts('/src/detect.js');
  importScripts('/src/update.js');
} catch (_) {}

try {
  importScripts('/src/lists.js');
} catch (_) {}

try {
  importScripts('/src/deepblock.js');
} catch (_) {}

// The packed host list (see tools/build-popup-list.mjs). One string and a
// newline-padded substring test: the worker asks this only when a page hands it
// a host to learn, so the cost is irrelevant and the memory stays flat.
const POPUP_HOST_LIST = typeof self.__yazPopupHosts === 'string' ? self.__yazPopupHosts : '\n';

const isPopupHost = (host) => {
  let candidate = String(host || '').toLowerCase();
  if (!candidate) return false;
  for (;;) {
    if (POPUP_HOST_LIST.includes('\n' + candidate + '\n')) return true;
    const dot = candidate.indexOf('.');
    if (dot < 0) return false;
    candidate = candidate.slice(dot + 1);
  }
};
const smart = self.AdblockerSmart || null;
const detect = self.AdblockerDetect || null;
const update = self.AdblockerUpdate || null;
const lists = self.AdblockerLists || null;
const deep = self.AdblockerDeep || null;

const STORAGE_KEY = 'stats';
const ESCALATION_KEY = 'escalated';
const PINNED_KEY = 'pinned';
const SETTINGS_KEY = 'settings';
const BLOCKED_MESSAGE = 'yt-ad-zapper:ads-blocked';
const POPUP_MESSAGE = 'yt-ad-zapper:popup-blocked';
const ESCALATE_MESSAGE = 'yt-ad-zapper:escalate';
const RESET_MESSAGE = 'yt-ad-zapper:reset';
const PAGE_MESSAGE = 'yt-ad-zapper:page';
const SCRIPTLET_MESSAGE = 'yt-ad-zapper:scriptlets';
const TAB_INFO_MESSAGE = 'yt-ad-zapper:tab-info';
const PIN_MESSAGE = 'yt-ad-zapper:pin';
const SETTINGS_MESSAGE = 'yt-ad-zapper:settings';
const POWER_MESSAGE = 'yt-ad-zapper:power';
const SELF_UPDATE_MESSAGE = 'yt-ad-zapper:self-update';
const BADGE_OFF_COLOR = '#8e8e93';

// The master switch. Read from the settings blob at boot, flipped from the
// panel. Every gate below that blocks something checks it at call time, so
// there is one place to look when something is still getting through.
let power = true;
const LISTS_MESSAGE = 'yt-ad-zapper:lists';
const UPDATE_LISTS_MESSAGE = 'yt-ad-zapper:update-lists';
const BADGE_COLOR = '#eb3b30';
const IDLE_ALARM = 'ad-zapper:idle';

const RULE_ID_BASE = 9000;

// Hiding is on by default: it is the visible half of what a blocker does.
const HIDING_ENTRIES = 400;
const HIDING_BYTES = 2 * 1024 * 1024;
const VISIT_THROTTLE_MS = 60 * 1000;

const DYNAMIC_LIMIT = (() => {
  const api = chrome.declarativeNetRequest;
  const limit = api && Number(api.MAX_NUMBER_OF_DYNAMIC_RULES);
  return Number.isFinite(limit) && limit > 0 ? limit : 5000;
})();

// Never spend the whole budget: leave 100 rules of headroom for anything the
// extension learns later.
const MAX_ESCALATIONS = Math.max(10, Math.min(DYNAMIC_LIMIT - 100, 20000));

// Infrastructure nobody gets to block, whatever a page claims.
const PROTECTED = new Set([
  'google.com', 'googleapis.com', 'gstatic.com', 'youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com',
  'cloudflare.com', 'cloudfront.net', 'amazonaws.com', 'akamai.net', 'akamaized.net', 'fastly.net',
  'facebook.com', 'fbcdn.net', 'instagram.com', 'whatsapp.com', 'x.com', 'twitter.com', 'linkedin.com',
  'apple.com', 'icloud.com', 'microsoft.com', 'live.com', 'office.com', 'microsoftonline.com', 'windows.net',
  'amazon.com', 'ebay.com', 'paypal.com', 'stripe.com', 'adobe.com', 'mozilla.org',
  'wikipedia.org', 'wikimedia.org', 'github.com', 'githubusercontent.com', 'vercel.com', 'vercel.app',
  'netlify.app', 'notion.so', 'slack.com', 'discord.com', 'openai.com'
]);

// Ad infrastructure is machine-named, so a long consonant run in the domain
// label is the tell (oqhbgxvk, hkryzvagqpjuj, d3mzokty951c5w). Ordinary words
// do not survive it (cloudflare, wordpress, stackoverflow).
const JUNK_LABEL = /[bcdfghjklmnpqrstvwxz0-9]{5,}/;

// Page URLs seen per tab, from src/relay.js. Chrome would want the tabs
// permission for URLs, and this covers it without asking for one, so the popup
// panel and the deep-block decision both read from here.
const pageByTab = new Map();
// Hiding bytes handed to each tab's top frame, for the panel.
const hidingByTab = new Map();

// Host -> { css, host, bytes }. Two caps: the host count, and the total bytes of
// CSS held. Both evict least-recently-used first.
const cosmetics = smart
  ? smart.makeLru({ entries: HIDING_ENTRIES, bytes: HIDING_BYTES })
  : null;

const emptyStats = () => ({
  ads: 0,
  videos: 0,
  since: Date.now(),
  lastAt: 0,
  popups: 0,
  lastPopupAt: 0,
  lastPopupHost: '',
  lastPopupKind: ''
});

const readStats = async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Object.assign(emptyStats(), (stored && stored[STORAGE_KEY]) || {});
};

const formatBadge = (total) => {
  if (total < 1000) return String(total);
  if (total < 10000) return `${(total / 1000).toFixed(1)}k`;
  return `${Math.round(total / 1000)}k`;
};

const paintBadge = (total) => {
  // Off says so in the toolbar. A blank badge would read as a blocker that is
  // working and has simply seen nothing yet.
  if (!power) {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_OFF_COLOR });
    chrome.action.setBadgeText({ text: 'off' });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  chrome.action.setBadgeText({ text: total > 0 ? formatBadge(total) : '' });
};

const hostOfUrl = (url) => {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
};

// Last two labels: cnn.com, bbc.co.uk (for the hosts that matter here, dropping
// one label is the right answer; a public-suffix list would be a lot of bytes to
// get the same result).
const domainOf = (host) => {
  const labels = String(host || '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.') || null;
  return labels.slice(1).join('.');
};

const addBlocked = async (count) => {
  const stats = await readStats();
  stats.ads += count;
  stats.videos += 1;
  stats.lastAt = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: stats });
  paintBadge(stats.ads);
  return stats;
};

const addPopup = async (kind, host) => {
  const stats = await readStats();
  stats.popups += 1;
  stats.lastPopupAt = Date.now();
  if (host) stats.lastPopupHost = host;
  if (kind) stats.lastPopupKind = kind;
  await chrome.storage.local.set({ [STORAGE_KEY]: stats });
  return stats;
};

// --- element hiding -------------------------------------------------------

/*
 * The engine answers "what should this page hide" for a URL, and the answer is
 * cached per host. Ordinary pages have no rules at all, and those negative
 * answers are cached too: that is what makes this cheap enough to do for every
 * frame on every page.
 */
const hideFor = async (url) => {
  const empty = { css: '', host: '', bytes: 0 };
  if (!power) return empty;
  if (!smart || !deep || !url || !/^https?:/i.test(url)) return empty;
  const host = hostOfUrl(url);
  if (!host) return empty;
  // Sites Ad Zapper does not touch: no hiding sheet, nothing blocked, nothing counted.
  if (self.adZapperIsSkippedHost && self.adZapperIsSkippedHost(host)) return empty;

  const cached = cosmetics ? cosmetics.get(host) : null;
  if (cached) return cached;

  try {
    const ready = await deep.ensureEngine();
    if (!ready) return empty;
    const engine = self.AdblockerEngine;
    if (!engine) return empty;
    const result = engine.cosmetics({ url, hostname: host, domain: domainOf(host) });
    const css = typeof result.styles === 'string' ? result.styles : '';
    const answer = { css, host, bytes: css.length };
    if (cosmetics) cosmetics.set(host, answer);
    return answer;
  } catch (_) {
    return empty;
  }
};

const hidingStats = () =>
  cosmetics ? { hosts: cosmetics.size(), bytes: cosmetics.bytes(), limit: HIDING_ENTRIES } : { hosts: 0, bytes: 0, limit: 0 };

// --- site memory ----------------------------------------------------------

// One visit per host per minute: a page with forty iframes is still one visit.
const noteVisit = async (host) => {
  if (!smart || !host) return null;
  try {
    const records = await smart.readSites();
    const entry = records[smart.normalizeHost(host)] || null;
    if (entry && Date.now() - entry.lastSeen < VISIT_THROTTLE_MS) return entry;
    return smart.rememberSite(host, { visits: (entry ? entry.visits : 0) + 1 });
  } catch (_) {
    return null;
  }
};

const noteSiteEvent = async (host, patch) => {
  if (!smart || !host) return null;
  try {
    const records = await smart.readSites();
    const entry = records[smart.normalizeHost(host)] || {};
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      next[key] = (Number(entry[key]) || 0) + Number(value || 0);
    }
    return smart.rememberSite(host, next);
  } catch (_) {
    return null;
  }
};

// What the panel and the attach decision both read.
const siteInfo = async (host) => {
  const info = { host, visits: 0, ads: 0, popups: 0, hot: false, warm: false, known: false };
  if (!smart || !host) return info;
  try {
    const score = await smart.scoreSite(host);
    return {
      host,
      visits: score.entry ? score.entry.visits : 0,
      ads: score.entry ? score.entry.ads : 0,
      popups: score.entry ? score.entry.popups : 0,
      hot: !!score.hot,
      warm: !!score.warm,
      known: (await registeredHosts()).some((entry) => host === entry.host || host.endsWith('.' + entry.host))
    };
  } catch (_) {
    return info;
  }
};

// --- escalations ----------------------------------------------------------

// Registrations are records: { id, host, hits, lastAt }. Builds before this one
// stored bare hostnames, so those are migrated on read.
const registeredHosts = async () => {
  const stored = await chrome.storage.local.get(ESCALATION_KEY);
  const list = stored && stored[ESCALATION_KEY];
  if (!Array.isArray(list)) return [];
  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      return { id: RULE_ID_BASE + index + 1, host: entry, hits: 1, lastAt: 0 };
    }
    return {
      id: Number(entry && entry.id) || 0,
      host: String((entry && entry.host) || '').toLowerCase(),
      hits: Number(entry && entry.hits) || 1,
      lastAt: Number(entry && entry.lastAt) || 0
    };
  });
};

const readPinned = async () => {
  const stored = await chrome.storage.local.get(PINNED_KEY);
  const list = stored && stored[PINNED_KEY];
  return Array.isArray(list) ? list.map((host) => String(host).toLowerCase()) : [];
};

const apexOf = (host) => host.split('.').slice(-2).join('.');

const looksLikeAdInfrastructure = (host) => {
  if (isPopupHost(host)) return true;
  const labels = host.split('.');
  const domain = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  return JUNK_LABEL.test(domain);
};

const blockRule = (host, id) => ({
  id,
  priority: 1,
  action: { type: 'block' },
  condition: {
    urlFilter: `||${host}^`,
    resourceTypes: [
      'main_frame',
      'sub_frame',
      'script',
      'stylesheet',
      'image',
      'font',
      'media',
      'xmlhttprequest',
      'ping',
      'websocket',
      'other'
    ]
  }
});

// Fewest catches wins the eviction; ties go to whoever was seen longest ago.
const evictionVictim = (list) =>
  list.reduce((worst, entry) => {
    if (!worst) return entry;
    if (entry.hits < worst.hits) return entry;
    if (entry.hits === worst.hits && entry.lastAt < worst.lastAt) return entry;
    return worst;
  }, null);

const escalateHost = async (host) => {
  const clean = String(host || '').trim().toLowerCase();
  if (!clean || clean.length > 200) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean)) return null;
  if (PROTECTED.has(clean) || PROTECTED.has(apexOf(clean))) return null;
  if (!looksLikeAdInfrastructure(clean)) return null;
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return null;

  const list = await registeredHosts();
  const existing = list.find((entry) => entry.host === clean);
  if (existing) {
    // Seen again. This counter is what saves a host from eviction later.
    existing.hits += 1;
    existing.lastAt = Date.now();
    await chrome.storage.local.set({ [ESCALATION_KEY]: list });
    return null;
  }

  if (list.length >= MAX_ESCALATIONS) {
    const victim = evictionVictim(list);
    if (victim) {
      if (victim.id) {
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [victim.id] });
        } catch (_) {}
      }
      const index = list.indexOf(victim);
      if (index >= 0) list.splice(index, 1);
    }
  }

  const id = list.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), RULE_ID_BASE) + 1;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [blockRule(clean, id)] });
  } catch (_) {
    return null;
  }
  list.push({ id, host: clean, hits: 1, lastAt: Date.now() });
  await chrome.storage.local.set({ [ESCALATION_KEY]: list });
  if (deep) deep.setKnownHosts(list.map((entry) => entry.host));
  return clean;
};

const clearEscalations = async () => {
  const list = await registeredHosts();
  if (!list.length) return 0;
  const ids = [];
  list.forEach((entry, index) => {
    const id = Number(entry.id) || RULE_ID_BASE + index + 1;
    if (!ids.includes(id)) ids.push(id);
  });
  if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    } catch (_) {}
  }
  await chrome.storage.local.set({ [ESCALATION_KEY]: [] });
  if (deep) deep.setKnownHosts([]);
  return list.length;
};

const resetStats = async () => {
  await chrome.storage.local.set({ [STORAGE_KEY]: emptyStats() });
  await clearEscalations();
  if (smart) await smart.forgetSites();
  hidingByTab.clear();
  if (cosmetics) cosmetics.clear();
  paintBadge(0);
};

// --- list upkeep ----------------------------------------------------------

const listsInfo = async () => {
  if (!lists) return null;
  const info = await lists.info();
  const meta = info.meta || {};
  return {
    cached: info.cached,
    at: Number(meta.at) || 0,
    busy: !!meta.busy,
    source: meta.source || '',
    counts: meta.counts || null,
    bytes: Number(meta.bytes) || 0,
    lists: Array.isArray(meta.lists) ? meta.lists : [],
    urls: info.urls,
    refreshMinutes: info.refreshMinutes
  };
};

const runRefresh = async () => {
  if (!lists) return { ok: false, error: 'the lists module is not loaded' };
  try {
    const previous = await lists.readMeta();
    await chrome.storage.local.set({
      [lists.metaKey]: Object.assign({}, previous || {}, { busy: true, busyAt: Date.now() })
    });
  } catch (_) {}
  try {
    if (deep && typeof deep.ensureEngine === 'function') await deep.ensureEngine();
  } catch (_) {}
  const result = await lists.refresh();
  const info = await listsInfo();
  return Object.assign({}, result, { info });
};

// The catch-up path: a machine that was off when the alarm should have fired
// refreshes on the next boot, but only once there is something to replace.
const refreshIfStale = async () => {
  if (!lists) return false;
  const info = await lists.info();
  const at = Number((info.meta && info.meta.at) || 0);
  if (!info.cached) return false;
  if (Date.now() - at < lists.refreshMinutes * 60 * 1000) return false;
  await runRefresh();
  return true;
};

const scheduleWork = () => {
  if (lists) lists.schedule();
  try {
    if (chrome.alarms) chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 5 });
    // Updating asks rather than pushes: the popup's button runs the check, and
    // nothing here goes to the network. What does happen at boot is the local
    // marker read, so a folder the installer has already swapped reloads into its
    // new version without a reload click. Silent on failure.
    if (update) update.applyIfStaged().catch(() => {});
  } catch (_) {}
};

// --- the tab the popup is open on ----------------------------------------

const tabInfo = async (tabId) => {
  const url = pageByTab.get(tabId) || '';
  const host = hostOfUrl(url);
  const pinned = await readPinned();
  const state = deep ? deep.state() : { mode: 'off', engineReady: false, attached: [], blocked: 0 };
  const session = (state.attached || []).find((entry) => entry.tabId === tabId) || null;
  const site = await siteInfo(host);
  const info = lists ? await listsInfo() : null;
  return {
    host,
    attached: !!session,
    attachedHost: session ? session.host : '',
    blockedHere: session ? session.blocked : 0,
    blockedTotal: state.blocked || 0,
    rewrittenTotal: state.rewritten || 0,
    mode: state.mode,
    engineReady: !!state.engineReady,
    memory: state.memory || (deep && deep.memory ? deep.memory() : null),
    pinned: host ? pinned.some((entry) => host === entry || host.endsWith('.' + entry)) : false,
    skipped: !!(self.adZapperIsSkippedHost && self.adZapperIsSkippedHost(host)),
    verdict: smart && smart.deepVerdict && host ? await smart.deepVerdict(host) : null,
    learned: detect ? await detect.stats() : null,
    update: update ? await update.stats() : null,
    site,
    hiding: Object.assign({ enabled: true }, hidingByTab.get(tabId) || { bytes: 0 }),
    hidingTotal: hidingStats(),
    lists: info
  };
};

const setPin = async (host, pin, tabId) => {
  const clean = String(host || '').trim().toLowerCase();
  if (!clean) return null;
  const pinned = await readPinned();
  const without = pinned.filter((entry) => entry !== clean);
  const next = pin ? without.concat(clean) : without;
  await chrome.storage.local.set({ [PINNED_KEY]: next });
  if (deep) deep.setPinned(next);
  if (deep && tabId !== undefined && tabId !== null) {
    if (pin) {
      await deep.attach(tabId, pageByTab.get(tabId) || `https://${clean}/`, 'pinned');
    } else {
      await deep.detach(tabId, 'unpinned');
    }
  }
  return next;
};

/*
 * The master switch, in one function.
 *
 * Off has to reach four places, because this extension blocks in four places:
 * the static rulesets Chrome matches itself, the dynamic rules learned from
 * this browser, the debugger sessions, and what the in-page scripts do. The
 * in-page side follows through src/relay.js, which posts the flag to the page
 * world and re-posts it whenever the settings change, so it lands in pages that
 * are already open.
 *
 * Nothing here is destructive: the learned hosts stay in storage, the pinned
 * sites stay pinned, and turning the switch back on restores all of it.
 */
const applyPower = async (enabled) => {
  power = enabled !== false;

  // Turning the switch on has to reach the tabs that are already open. The
  // attach used to wait for a navigation, so a tab loaded while the extension
  // was off stayed unattached for the rest of its life, and the cooldown from
  // whatever failed while it was off was still being honoured afterwards. That
  // reads, from the outside, as "it never attaches back".
  if (power && deep) {
    try {
      if (typeof deep.resetAttempts === 'function') deep.resetAttempts();
      if (typeof deep.maybeAttach === 'function') {
        let seen = 0;
        for (const [tabId, url] of pageByTab) {
          seen += 1;
          deep.maybeAttach(tabId, url).catch(() => {});
        }
        console.log('[ad-zapper:deep]', `power on: re-attaching ${seen} open tab(s)`);
      }
    } catch (err) {
      console.warn('[ad-zapper:deep]', 'the re-attach after power on threw:', err && err.message);
    }
  }

  // 1. Chrome's own matching.
  try {
    const dnr = chrome.declarativeNetRequest;
    if (dnr) {
      const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : null;
      const resources = ((manifest && manifest.declarative_net_request) || {}).rule_resources || [];
      const ids = resources.map((entry) => entry && entry.id).filter(Boolean);
      if (ids.length && dnr.updateEnabledRulesets) {
        await dnr.updateEnabledRulesets(
          power ? { enableRulesetIds: ids } : { disableRulesetIds: ids }
        );
      }
      // The learned hosts are dynamic rules and there is no off switch for a
      // set of them, so they are removed on the way out and put back on the
      // way in, from the same stored list of catches.
      const list = await registeredHosts();
      const owned = list.filter((entry) => typeof entry.id === 'number');
      if (owned.length && dnr.updateDynamicRules) {
        await dnr.updateDynamicRules({ removeRuleIds: owned.map((entry) => entry.id) });
        if (power) {
          await dnr.updateDynamicRules({ addRules: owned.map((entry) => blockRule(entry.host, entry.id)) });
        }
      }
    }
  } catch (_) {}

  // 2. The deep block: forced off while the switch is off, and restored from
  //    what was stored when it comes back on.
  try {
    if (deep) {
      if (power) {
        await hydrateDeep();
      } else {
        deep.setSettings({ deepBlock: 'off' });
        await deep.detachAll();
      }
    }
  } catch (_) {}

  // 2b. Element hiding. These stylesheets used to sit in the manifest, where
  //     Chrome injects them on every matching page whatever this setting says:
  //     with the switch off they kept hiding ad containers, which is exactly
  //     what a detector's bait element looks at, so off did not look off. They
  //     are injected from here instead and removed when the switch goes off.
  try {
    if (power) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab && typeof tab.id === 'number') await injectHiding(tab.id, null, tab.url);
      }
    } else {
      await removeHiding();
    }
  } catch (_) {}

  // 3. The badge, so the toolbar carries the state without the panel open.
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const stats = (stored && stored[STORAGE_KEY]) || {};
    paintBadge(Number(stats.ads) || 0);
  } catch (_) {
    paintBadge(0);
  }

  return power;
};

// The worker can wake up at any time, so settings, the pinned list and the
// learned host list are re-applied on every boot.
// What the extension did, gathered in one place so a live tab can be asked for
// it: the build, the switch, the carve-out that is actually installed, and this
// layer's own decision ring.
const diagInfo = async () => {
  const info = {
    version: (() => {
      try {
        const manifest = chrome.runtime.getManifest();
        return (manifest && manifest.version) || 'unknown';
      } catch (_) {
        return 'unknown';
      }
    })(),
    enabled: !!power,
    walledHosts: wallHostList().length,
    deep: deep && typeof deep.diag === 'function' ? deep.diag() : null,
    state: deep && typeof deep.state === 'function' ? deep.state() : null
  };
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    info.allowRules = (rules || []).filter((rule) => rule.id >= WALL_ALLOW_BASE).length;
  } catch (_) {
    info.allowRules = 'unavailable';
  }
  try {
    if (detect) info.learned = await detect.stats();
    if (update) info.update = await update.stats();
  } catch (_) {}
  try {
    const stored = await chrome.storage.session.get('yazDiagTail');
    const tail = stored && stored.yazDiagTail;
    if (tail && Array.isArray(tail.events)) {
      info.tail = { at: tail.at, events: tail.events };
    }
  } catch (_) {
    info.tail = null;
  }
  return info;
};

const WALL_ALLOW_BASE = 9000;

const wallHostList = () => {
  try {
    return String(self.__yazWallHosts || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
};

// On the walled hosts this layer is the only blocking there is, so the rule sets
// have to stand down there or the page sees failures this layer cannot hide.
//
// Dynamic allow rules, not a static ruleset: Chrome does not pick up a changed
// rule_resources list when an unpacked extension is reloaded, so the static
// version of this carve-out never ran once in three builds. Dynamic rules apply
// the moment this worker installs them. They only ever unblock, so leaving them
// in place while the switch is off is exactly what "off" means.
const syncWallAllowRules = async () => {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr || !dnr.updateDynamicRules || !dnr.getDynamicRules) return;
  const hosts = wallHostList();
  if (!hosts.length) return;
  try {
    const existing = (await dnr.getDynamicRules()) || [];
    const removeRuleIds = existing
      .filter((rule) => rule.id >= WALL_ALLOW_BASE && rule.id < WALL_ALLOW_BASE + 200)
      .map((rule) => rule.id);
    // Two shapes, because one is not enough to hide an ad blocker from a page
    // that reads its own failed requests:
    //  - what that page asks for, wherever it goes;
    //  - anything asking for that site's own hosts, which is how the site's own
    //    scripts and its consent layer keep loading instead of erroring. A
    //    failed first-party script is the cleanest signal a detector can get,
    //    and the filter lists do block first-party hosts (BILD's own JS host,
    //    its ad stack, the recovery SDK its wall vendor serves).
    // Documents stay out of both, so navigations still meet the wall refusal
    // and the copy serve.
    // A page-world host keeps the rule sets' blocking: its ads are removed
    // before any request is made, so it is not carved out and not attached.
    // YouTube reached this list only because it carries response rules, which
    // was quietly standing the 214k rules down on the busiest site there is.
    if (deep && deep.isPageWorldHost && Array.isArray(hosts)) {
      for (let index = hosts.length - 1; index >= 0; index--) {
        if (deep.isPageWorldHost(hosts[index])) hosts.splice(index, 1);
      }
    }
    const allowRules = [];
    hosts.forEach((host, index) => {
      allowRules.push({
        id: WALL_ALLOW_BASE + index,
        priority: 2000,
        action: { type: 'allow' },
        condition: {
          urlFilter: '*',
          initiatorDomains: [host],
          excludedResourceTypes: ['main_frame', 'sub_frame']
        }
      });
      allowRules.push({
        id: WALL_ALLOW_BASE + 100 + index,
        priority: 2000,
        action: { type: 'allow' },
        condition: {
          urlFilter: '*',
          requestDomains: [host],
          excludedResourceTypes: ['main_frame', 'sub_frame']
        }
      });
    });
    await dnr.updateDynamicRules({ removeRuleIds, addRules: allowRules });
    console.log('[ad-zapper:deep]', `wall carve-out installed for ${hosts.length} host(s)`);
  } catch (err) {
    console.warn(`${TAG} the wall carve-out did not install:`, err && err.message);
  }
};

// ---- sites Ad Zapper does not touch -----------------------------------------
//
// Standing down is the honest shape for code hosts: there is nothing there to
// block, and every layer here is capable of changing a page it runs on. The
// content scripts are excluded in the manifest; this is what stops the rule sets.
// Same shape as the wall carve-out, at a priority no block rule reaches, and it
// only ever allows, so leaving it installed while the switch is off is harmless.
const SKIP_ALLOW_BASE = 9400001;

const syncSkipAllowRules = async () => {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr || !dnr.updateDynamicRules || !dnr.getDynamicRules) return;
  const hosts = (self.adZapperSkipHosts || []).filter((host) => host !== 'localhost' && host !== '127.0.0.1');
  if (!hosts.length) return;
  try {
    const existing = (await dnr.getDynamicRules()) || [];
    const removeRuleIds = existing
      .filter((rule) => rule.id >= SKIP_ALLOW_BASE && rule.id < SKIP_ALLOW_BASE + 200)
      .map((rule) => rule.id);
    const rules = [];
    hosts.forEach((host, index) => {
      rules.push({
        id: SKIP_ALLOW_BASE + index,
        priority: 2200,
        action: { type: 'allow' },
        condition: { urlFilter: '*', requestDomains: [host] }
      });
      rules.push({
        id: SKIP_ALLOW_BASE + 100 + index,
        priority: 2200,
        action: { type: 'allow' },
        condition: { urlFilter: '*', initiatorDomains: [host] }
      });
    });
    await dnr.updateDynamicRules({ removeRuleIds, addRules: rules });
    console.log('[ad-zapper:deep]', `standing down on ${hosts.length} host(s)`);
  } catch (err) {
    console.warn(`${TAG} the skip rules did not install:`, err && err.message);
  }
};

const hydrateDeep = async () => {
  if (!deep) return false;
  const stored = await chrome.storage.local.get([SETTINGS_KEY, PINNED_KEY, ESCALATION_KEY]);
  const settings = stored && stored[SETTINGS_KEY];
  const pinned = stored && stored[PINNED_KEY];
  // Off is a stored setting too. A worker that wakes up while it is off has to
  // put Chrome's matching back off with it, because static ruleset state is not
  // something this extension gets to assume survives a restart.
  power = !settings || settings.enabled !== false;
  if (!power) await applyPower(false);
  const hosts = stored && stored[ESCALATION_KEY];
  deep.setSettings(power ? settings || {} : Object.assign({}, settings || {}, { deepBlock: 'off' }));
  deep.setPinned(Array.isArray(pinned) ? pinned : []);
  deep.setKnownHosts(
    (Array.isArray(hosts) ? hosts : []).map((entry) =>
      typeof entry === 'string' ? entry : entry && entry.host
    ).filter(Boolean)
  );
  deep.publish();
  // On the carved-out hosts this layer is the only blocking there is, so the
  // brain comes up at boot rather than on the first request that needs it.
  if (power) deep.ensureEngine().catch(() => {});
  return true;
};

// --- messages -------------------------------------------------------------

let work = Promise.resolve();
const enqueue = (task) => {
  work = work.then(task, task);
  return work;
};

/*
 * A page (or frame) asking what it should hide. Every frame asks, which is why
 * the answer is cached per host and why the negative answers are cached too.
 * Only the top frame is treated as "the page the user is on", so that is the one
 * that drives the deep-block decision and the panel.
 */
const handlePage = async (tabId, url, top) => {
  const isTop = top !== false;
  if (tabId !== undefined && typeof url === 'string' && isTop) {
    pageByTab.set(tabId, url);
  }
  if (deep) {
    if (isTop && tabId !== undefined && url) {
      const host = hostOfUrl(url);
      if (host) {
        noteVisit(host).then((entry) => {
          if (entry && entry.visits >= 3 && !entry.popups && !entry.ads) return;
          return siteInfo(host).then((score) => {
            if (score.hot) {
              deep.attach(tabId, url, 'site evidence').catch(() => {});
            } else {
              deep.maybeAttach(tabId, url).catch(() => {});
            }
          });
        }).catch(() => {
          deep.maybeAttach(tabId, url).catch(() => {});
        });
      }
    }
    deep.sweep();
  }
  const hide = await hideFor(url);
  if (isTop && tabId !== undefined && hide.bytes) hidingByTab.set(tabId, { host: hide.host, bytes: hide.bytes });
  return hide;
};

// Scriptlets: page-world code the lists ask for on this host, run before the
// site's own scripts do. The relay in the frame reads the generated map and
// sends the calls up, because a content script cannot run code in the page's
// world itself: chrome.scripting needs a tab id and only the worker has one.
const runScriptlets = async (tabId, frameId, host, calls) => {
  if (tabId === undefined || !chrome.scripting || !Array.isArray(calls) || !calls.length) {
    return { ran: 0, failed: 0, host: host || '', reason: 'nothing to run' };
  }
  let allowed = true;
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = (stored && stored[SETTINGS_KEY]) || {};
    allowed = settings.enabled !== false;
  } catch (_) {}
  if (!allowed) return { ran: 0, failed: 0, host: host || '', reason: 'off' };

  // A frame gets a bounded number of calls: the generated map is written from
  // filter lists, and a list bug should not turn into an unbounded loop of
  // page-world code.
  const list = calls.slice(0, 12);
  let ran = 0;
  let failed = 0;
  for (const call of list) {
    if (!Array.isArray(call) || typeof call[0] !== 'string') continue;
    try {
      await chrome.scripting.executeScript({
        target: frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] },
        world: 'MAIN',
        func: self.AD_ZAPPER_RUN_SCRIPTLET,
        args: [call[0], Array.isArray(call[1]) ? call[1] : []]
      });
      ran += 1;
    } catch (_) {
      failed += 1;
    }
  }
  if (ran || failed) console.log('[ad-zapper:deep]', 'scriptlets', ran, 'ran,', failed, 'failed on', host || 'this frame');
  return { ran, failed, host: host || '' };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const pageUrl = (sender && sender.url) || '';

  if (message.type === BLOCKED_MESSAGE) {
    const count = Number(message.count) || 0;
    if (count > 0) enqueue(() => addBlocked(count));
    return;
  }

  if (message.type === POPUP_MESSAGE) {
    enqueue(() => addPopup(message.kind, message.host));
    // Ad machinery on a page is evidence, and evidence is what earns a tab the
    // deep-block treatment even when its host is new to us.
    const pageHost = hostOfUrl(pageByTab.get(tabId) || pageUrl);
    if (pageHost) noteSiteEvent(pageHost, { popups: 1 }).catch(() => {});
    if (deep && tabId !== undefined) {
      deep.signalAttach(tabId, pageByTab.get(tabId) || pageUrl).catch(() => {});
      deep.sweep();
    }
    return;
  }

  if (message.type === ESCALATE_MESSAGE) {
    if (typeof message.host === 'string') enqueue(() => escalateHost(message.host));
    return;
  }

  if (message.type === PAGE_MESSAGE) {
    handlePage(tabId, message.url, message.top)
      .then((hide) => {
        runDetect(tabId, message.url).catch(() => {});
        sendResponse(hide);
      })
      .catch(() => sendResponse({ css: '', host: '', bytes: 0 }));
    return true; // async response: the caller injects the CSS it gets back
  }

  if (message.type === SCRIPTLET_MESSAGE) {
    runScriptlets(tabId, sender && sender.frameId, message.host, message.calls)
      .then((report) => sendResponse(report))
      .catch(() => sendResponse({ ran: 0, failed: 0 }));
    return true;
  }

  if (message.type === TAB_INFO_MESSAGE) {
    const wanted = message.tabId === undefined ? tabId : message.tabId;
    // The popup opening is the moment right after somebody pasted the update
    // command, so it is also the moment to look for the marker the installer
    // wrote. If the folder holds something newer, this reloads into it now
    // rather than whenever Chrome next restarts the worker.
    if (update) update.applyIfStaged().catch(() => {});
    tabInfo(wanted).then((info) => sendResponse(info));
    return true; // async response
  }

  if (message.type === PIN_MESSAGE) {
    setPin(message.host, !!message.pin, message.tabId)
      .then((pinned) => sendResponse({ ok: true, pinned }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }

  if (message.type === 'yt-ad-zapper:diag') {
    diagInfo().then(sendResponse, () => {
      try {
        sendResponse({ error: 'the probe could not be built' });
      } catch (_) {}
    });
    return true;
  }

  if (message.type === 'yt-ad-zapper:doc') {
    const stored = !!(
      deep &&
      typeof deep.rememberDoc === 'function' &&
      deep.rememberDoc(message.url, message.html)
    );
    sendResponse({ ok: stored });
    return false;
  }

  if (message.type === POWER_MESSAGE) {
    const wanted = message.enabled !== false;
    (async () => {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const settings = Object.assign({}, (stored && stored[SETTINGS_KEY]) || {}, { enabled: wanted });
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      await applyPower(wanted);
      return { ok: true, enabled: wanted };
    })()
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, enabled: power }));
    return true; // async response: the panel repaints from it
  }

  if (message.type === SETTINGS_MESSAGE) {
    const wanted = ['off', 'smart', 'always'].includes(message.deepBlock) ? message.deepBlock : 'smart';
    (async () => {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const settings = Object.assign({}, (stored && stored[SETTINGS_KEY]) || {}, { deepBlock: wanted });
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      if (deep) {
        deep.setSettings(settings);
        deep.publish();
      }
      return wanted;
    })()
      .then((mode) => sendResponse({ ok: true, mode }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }

  if (message.type === LISTS_MESSAGE) {
    listsInfo()
      .then((info) => sendResponse({ ok: !!info, info }))
      .catch(() => sendResponse({ ok: false, info: null }));
    return true; // async response
  }

  if (message.type === UPDATE_LISTS_MESSAGE) {
    // Long job (megabytes of lists, a compile, a spot check): acknowledged now,
    // finished in the background, and the panel reads the state file back.
    enqueue(() => runRefresh());
    sendResponse({ ok: true, started: true });
    return;
  }

  if (message.type === SELF_UPDATE_MESSAGE) {
    if (!update) {
      sendResponse({ ok: false });
      return;
    }
    if (message.action === 'install') {
      // The button wants the update done, not described. Ask the native host to run
      // the installer, then read the marker it wrote: if the folder holds something
      // newer than what is running, this reloads straight into it. The worker often
      // dies here mid-reload, which is the point, so a silent reply is normal.
      update
        .nativeUpdate()
        .then(async (result) => {
          if (result && result.ok) {
            // The host answered with the version it installed, so reload on that,
            // right now. The marker read stays as the fallback path.
            if (!update.reloadFor(result.version)) await update.applyIfStaged();
            sendResponse({
              ok: true,
              installed: true,
              version: result.version || null,
              target: result.target || null
            });
            return;
          }
          sendResponse({
            ok: true,
            installed: false,
            why: (result && result.why) || 'the updater did not run'
          });
        })
        .catch(() => sendResponse({ ok: false, installed: false }));
      return true; // async response
    }
    update
      .check()
      .then(() => update.applyIfStaged())
      .then(() => update.stats())
      .then((stats) => sendResponse({ ok: true, update: stats }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }

  if (message.type === RESET_MESSAGE) {
    enqueue(async () => {
      if (detect) await detect.forget();
      await resetStats();
    }).then(() => sendResponse({ ok: true }));
    return true; // keeps the message channel open for the async response
  }
});

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    pageByTab.delete(tabId);
    hidingByTab.delete(tabId);
  });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (lists && alarm.name === lists.refreshAlarm) {
      enqueue(runRefresh);
      return;
    }
    if (alarm.name === IDLE_ALARM) {
      if (deep) deep.sweep();
    }
  });
}

const restoreBadge = () => {
  readStats()
    .then((stats) => paintBadge(stats.ads))
    .catch(() => {});
};

const boot = () => {
  restoreBadge();
  hydrateDeep().catch(() => {});
// Its own call, and a logged failure: buried at the end of hydrateDeep this was
// one throw away from never running, and a catch-all upstream would have hidden
// it. The carve-out is the difference between a page seeing failures and seeing
// answers, so it is not allowed to fail quietly.
syncSkipAllowRules().catch((err) => {
  console.warn(`${TAG} the skip rules did not install:`, err && err.message);
});
syncWallAllowRules().catch((err) => {
  console.warn('[ad-zapper:deep]', 'the wall carve-out threw:', err && err.message);
});
  scheduleWork();
  refreshIfStale().catch(() => {});
};

// --- element hiding ---------------------------------------------------------

// The two stylesheets that used to be declared in the manifest. Everything they
// do is cosmetic: hiding the container an ad would have been drawn in. That is
// invisible to the network and very visible to a detector that inserts a bait
// element and measures it, so it has to follow the master switch like the rest.
/*
 * Who blocks a walled host.
 *
 * Two layers can stop a request: Chrome's rule sets, and the debugging layer on
 * an attached tab. On the rule-set side a stopped request is a *failure* the page
 * can see, and at least one real detector counts exactly that. On the attached
 * side the same request can be answered with an empty body instead, which the
 * page cannot tell from a real one.
 *
 * Both at once is the worst case: the debugging layer continues a request that
 * the rule sets then kill, and the page sees the failure. So on the hosts this
 * extension already attaches to on sight, the rule sets stand down and the layer
 * that can answer does the blocking. Every other site keeps the full list.
 */
const HIDING_FILES = ['src/cosmetic.css', 'src/generic-cosmetic.css'];
// The YouTube-scoped sheet stays everywhere. The all-sites one hides BILD's own
// ad wrappers, and a host that walls readers over a hidden ad slot reads that as
// a blocker however the requests went: on those hosts the slot is left in the
// layout (empty, because the requests are answered) and only the site-specific
// sheet is applied.
const WALLED_HIDING_FILES = ['src/cosmetic.css'];

// The learned sheet is this extension's own guesswork, so it never lands on the
// hosts everything depends on. A wrong guess there costs more than any ad.
const isProtectedUrl = (url) => {
  try {
    const clean = new URL(String(url || '')).hostname.replace(/^www\./, '');
    return PROTECTED.has(clean) || PROTECTED.has(apexOf(clean));
  } catch (_) {
    return false;
  }
};

const isWalledUrl = (url) => {
  try {
    const host = new URL(String(url || '')).hostname;
    return !!(deep && typeof deep.isWalledHost === 'function' && deep.isWalledHost(host));
  } catch (_) {
    return false;
  }
};

// --- generic detection -----------------------------------------------------
//
// Everything else here works from lists or from what you have already visited.
// This job looks at the page in front of it: the third-party hosts it actually
// loaded, and the elements shaped like ad slots. A host that is named like ad
// plumbing, or that turns up on three different sites, goes through the same
// escalation gate the popup catcher uses, which refuses anything that is not ad
// infrastructure. A selector joins the hiding sheet only once two different
// sites have produced it, so one site's guess never hides anything anywhere.
const detectSeen = new Map();
let detectLearned = 0;

const runDetect = async (tabId, url) => {
  if (!power || !detect || !chrome.scripting || typeof tabId !== 'number') return;
  if (self.adZapperIsSkippedUrl && self.adZapperIsSkippedUrl(url)) return;
  if (!/^https?:/i.test(String(url || ''))) return;
  if (detectSeen.get(tabId) === url) return;
  detectSeen.set(tabId, url);
  if (detectSeen.size > 60) detectSeen.clear();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: detect.detectCollect,
      args: [detect.adHostSource, detect.adPathSource, detect.nameShapeSource, detect.sizes]
    });
    const payload = results && results[0] && results[0].result;
    if (!payload) return;
    const pageHost = hostOfUrl(url);
    const sighted = await detect.recordSightings(pageHost, payload.hosts);
    const remembered = await detect.rememberSelectors(pageHost, payload.candidates);
    if (remembered.ready.length) {
      await detect.publishCss(remembered.state);
      detectLearned += remembered.ready.length;
      await injectHiding(tabId, null, url);
    }
    for (const item of sighted.promoted) enqueue(() => escalateHost(item.host));
    if (sighted.promoted.length || remembered.ready.length) {
      console.log(
        '[ad-zapper:detect]',
        pageHost,
        `${payload.thirdParty} third-party host(s), ${payload.candidates.length} candidate(s), learned ${sighted.promoted.length} host(s), ${remembered.ready.length} selector(s)`
      );
    }
  } catch (_) {}
};

const injectHiding = async (tabId, frameIds, url) => {
  if (!power || typeof tabId !== 'number') return false;
  const files = isWalledUrl(url) ? WALLED_HIDING_FILES : HIDING_FILES;
  const target = frameIds && frameIds.length ? { tabId, frameIds } : { tabId, allFrames: true };
  try {
    await chrome.scripting.insertCSS({ target, files });
    // The selectors this layer has learned from two or more sites. Kept as one
    // string because insertCSS and removeCSS only match on identical text.
    const learned = detect ? await detect.learnedCss() : '';
    if (learned && !isProtectedUrl(url)) {
      await chrome.scripting.insertCSS({ target, css: learned, origin: 'USER' });
    }
    return true;
  } catch (_) {
    return false;
  }
};

const removeHiding = async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== 'number') continue;
      try {
        await chrome.scripting.removeCSS({ target: { tabId: tab.id, allFrames: true }, files: HIDING_FILES });
        const learned = detect ? await detect.learnedCss() : '';
        if (learned) {
          await chrome.scripting.removeCSS({ target: { tabId: tab.id, allFrames: true }, css: learned, origin: 'USER' });
        }
      } catch (_) {}
    }
  } catch (_) {}
};

// Every frame that commits gets the stylesheet, which is the same coverage the
// manifest entry had, minus the frames on pages that no longer exist.
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (!details || typeof details.tabId !== 'number' || details.tabId < 0) return;
    injectHiding(details.tabId, [details.frameId], details.url);
  });
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();

// Test hooks, used by test/background.test.js. Inert in the worker.
globalThis.__yazTestHooks = {
  diagInfo,
  addBlocked,
  addPopup,
  escalateHost,
  clearEscalations,
  escalationCap: () => MAX_ESCALATIONS,
  formatBadge,
  readStats,
  registeredHosts,
  resetStats,
  hydrateDeep,
  tabInfo,
  setPin,
  hideFor,
  handlePage,
  hidingStats,
  siteInfo,
  noteVisit,
  noteSiteEvent,
  listsInfo,
  runRefresh,
  refreshIfStale,
  scheduleWork,
  domainOf,
  pageByTab,
  hidingByTab
};
