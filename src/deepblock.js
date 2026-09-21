/*
 * Deep block: automatic request-level interception, on the tabs that need it.
 *
 * The page-side killer (src/popups.js) and the DNR rules cover the ads that
 * matter, but neither can make a per-request judgement the way full uBO does.
 * That takes the DevTools network stack, which chrome.debugger hands to an
 * extension. Two stages, both enabled on an attached tab:
 *
 *   request stage    every request stops in this worker first, and the vendored
 *                    filter engine (engine/dist/engine.bin: 113k network filters
 *                    from EasyList, EasyPrivacy and uBO's own list) answers
 *                    block, allow, or continue after removing tracking params.
 *   response stage   for the request types that can carry an ad payload, the body
 *                    is fetched, rewritten in the worker, and served to the page
 *                    instead: ad scripts stripped out of HTML (##^ rules), ad JSON
 *                    neutralized and ad-config flags flipped ($replace rules from
 *                    engine/dist/replace-rules.json). The page's own scripts
 *                    never see the original, which no blocking rule can do and no
 *                    other Chrome extension attempts.
 *
 * Attaching is loud: Chrome shows a "started debugging this browser" banner,
 * and every request in the tab pays a round trip through this worker. So it is
 * automatic but not unconditional. Modes:
 *
 *   smart (default)  attach when the tab's host is one we have already caught,
 *                    or when the page itself reports ad machinery from
 *                    src/popups.js. Detach after five idle minutes.
 *   always           attach to every http(s) tab.
 *   off              never attach. Everything else keeps working.
 *
 * Sites pinned from the popup always attach while their tab is open, which is
 * the manual override in both directions.
 *
 * Redirect filters are enforced as blocks: same effect for the page, one code
 * path here instead of building synthetic responses. The response stage always
 * fails open: any doubt about a body, and the original goes through untouched.
 */
'use strict';

const DEEP_MODES = ['off', 'smart', 'always'];
const MAX_ATTACHED = 4;
const IDLE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const BODY_LIMIT = 8 * 1024 * 1024;
const UNSAFE_SCHEME = /^(chrome|chrome-extension|about|devtools|edge|file|view-source|data|blob):/i;

// Bodies worth inspecting: documents can carry ad scripts, and the ads that ship
// as JSON or config flags arrive over these request types.
const REWRITE_TYPES = new Set(['main_frame', 'sub_frame', 'script', 'xmlhttprequest']);

// Headers that describe the original body and would now be wrong.
const BODY_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'content-md5']);

// CDP resource types to the webRequest-style names the filter engine expects.
const TYPE_MAP = {
  Document: 'main_frame',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Media: 'media',
  Font: 'font',
  Script: 'script',
  TextTrack: 'other',
  XHR: 'xmlhttprequest',
  Fetch: 'xmlhttprequest',
  Prefetch: 'other',
  EventSource: 'other',
  WebSocket: 'websocket',
  Manifest: 'other',
  SignedExchange: 'other',
  Ping: 'ping',
  CSPViolationReport: 'csp_report',
  Preflight: 'other',
  Other: 'other'
};

let mode = 'smart';
let pinned = new Set();
let knownHosts = new Set();
// Hosts with response rules (an ad-block wall, an ad-config flag). A wall only
// falls when the response stage runs, so these attach on sight: waiting for a
// pin means the user meets the wall first. Filled from the engine, so a list
// update that adds a rule for a new host updates this for free.
let walledHosts = new Set();
let engineReady = false;

// What this layer decided, kept in a bounded ring so a live tab can be *asked*
// what happened instead of it being inferred from the page's after-effects. The
// page world asks for it through src/relay.js, which mirrors the answer into the
// page's localStorage under `__yaz_diag`.
let diag = [];
let diagFlush = 0;
const diagAdd = (entry) => {
  try {
    diag.push(entry);
    if (diag.length > 160) diag.splice(0, diag.length - 160);
    // Persist a tail, throttled: a service worker restart used to wipe the
    // evidence, which is how a whole evening of readings came back empty.
    const now = Date.now();
    if (now - diagFlush > 500) {
      diagFlush = now;
      const tail = diag.slice(-60);
      chrome.storage.session
        .set({ yazDiagTail: { at: now, events: tail } })
        .catch(() => {});
    }
  } catch (_) {}
};
const diagCounts = new Map();
const diagBump = (host, kind) => {
  try {
    const key = `${host} ${kind}`;
    diagCounts.set(key, (diagCounts.get(key) || 0) + 1);
    if (diagCounts.size > 400) diagCounts.clear();
  } catch (_) {}
};
let replaceRulesReady = false;
let blockedTotal = 0;
let rewrittenTotal = 0;
let wallRefusedTotal = 0;
let answeredTotal = 0;
let stubbedTotal = 0;
let loading = null;
let announceTimer = 0;

// A wall is a navigation, and this stage sees it as a request the browser is
// about to make, whoever asked for it. `window.location = url` is unforgeable
// and cannot be wrapped from the page world, a server 302 cannot be argued with,
// and the detector's own code is free to use either, so the refusal happens
// where all of them meet.
const WALL_NAV = /(adblockwall|adblock-wall|werbeblocker|error-report\.com\/modal)/i;
// A site that redirects straight back would loop faster than a reader can see,
// so a tab gets a couple of refusals inside one window and then the wall is
// allowed through. Every layer that fights a wall uses the same shape: contest
// the burst, yield when it keeps coming.
const WALL_NAV_CAP = 2;
const WALL_NAV_WINDOW_MS = 20000;
// The detector's reporting endpoint. Blocking a beacon tells the page it failed;
// this answers with an empty success instead, which is indistinguishable from a
// report that was accepted and discarded, which is what it is.
const REPORT_ENDPOINT = /(^|\.)error-report\.com$/i;

/*
 * Answers for blocked requests.
 *
 * The lists block by not delivering the ad, and there are two ways to not
 * deliver it: fail the request, or hand back nothing. A failure is a visible
 * event (an error handler runs, `script_onerror` fires, a network panel shows a
 * red line), and RodoGuard counts exactly those signals. An empty answer is not
 * a signal: the page's own bookkeeping sees a script that loaded, a pixel that
 * came back, a document that was empty. This is the same idea as the redirect
 * resources in uBO-family blockers, applied where it can be done per request
 * without spending a rule.
 *
 * Sizes are deliberate: everything here is 0 bytes except the PNG, which is 68.
 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const EMPTY_DOCUMENT = '<!DOCTYPE html><html><head></head><body></body></html>';

// `base64` marks a body that is already encoded (the PNG); the rest are ASCII
// and go through btoa, which exists in a service worker, unlike Buffer.
const stubFor = (type) => {
  switch (type) {
    case 'script':
      return { body: '', mime: 'text/javascript' };
    case 'stylesheet':
      return { body: '', mime: 'text/css' };
    case 'image':
      return { body: TINY_PNG, mime: 'image/png', base64: true };
    case 'media':
      return { body: '', mime: 'video/mp4' };
    case 'font':
      return { body: '', mime: 'font/woff2' };
    case 'main_frame':
      return { body: EMPTY_DOCUMENT, mime: 'text/html' };
    case 'xmlhttprequest':
    case 'ping':
      return { body: '', mime: 'application/json' };
    default:
      return { body: '', mime: 'text/plain' };
  }
};

const sessions = new Map(); // tabId -> { host, pageUrl, since, lastSeen, blocked, rewritten, rewrites, reason }
const attempts = new Map(); // tabId -> timestamp of the last refused attach

// Memory and cost policy. The brain is ~4.5 MB of tables, kept only while it is
// earning its place, and a tab whose filtering has gone pathological loses its
// session instead of quietly making the browser slower.
const ENGINE_IDLE_MS = 10 * 60 * 1000;
const HEAVY_COOLDOWN_MS = 30 * 60 * 1000;
const COST_P95_MS = 4;
const COST_MIN_SAMPLES = 40;
const REWRITE_WINDOW_MS = 60 * 1000;
const REWRITE_MAX_PER_WINDOW = 60;
const REWRITE_MAX_BYTES_PER_WINDOW = 32 * 1024 * 1024;

let lastEngineUse = 0;
const meters = new Map(); // tabId -> rolling engine cost
const heavy = new Map(); // host -> timestamp until which it gets no session
const rewriteLog = new Map(); // tabId -> { since, count, bytes, warned }

// Loaded at the top level on purpose. Chrome only allows importScripts() during
// the worker's initial evaluation ("importScripts() of new scripts after service
// worker installation is not allowed"), so calling it lazily from loadEngine()
// throws in the browser even though a node sandbox papers over it. The bundle
// only defines the API and its filter-class tables; the 4.3 MB brain stays lazy
// and parkable, which is where the memory actually is.
try {
  importScripts('/engine/dist/engine.bundle.js');
} catch (_) {}

// The walled-host list, also during initial evaluation. It is small, it is
// static, and having it before the engine loads is what lets a navigation to a
// walled site attach before the document request goes out.
try {
  importScripts('/src/wall-hosts.js');
  // The scriptlet implementations, in the same file the page frames load. This
  // side needs the function itself, because only the worker can hand it to
  // chrome.scripting for a tab.
  importScripts('/src/scriptlets.js');
} catch (_) {}

// Seed the set from that generated list so it is never empty while the engine
// is still loading. loadReplaceRules() merges the engine's own list in later,
// and both come from the same build step.
if (typeof self.__yazWallHosts === 'string') {
  for (const name of self.__yazWallHosts.split('\n')) {
    const clean = name.trim();
    if (clean) walledHosts.add(clean);
  }
}

// The meter lives in src/smart.js, which the worker loads first. Resolved at
// call time, and named distinctly: importScripts shares one global scope, so a
// duplicate const across worker scripts is a load-time SyntaxError.
const newMeter = () => {
  const factory = self.AdblockerSmart && self.AdblockerSmart.makeMeter;
  return factory
    ? factory(48)
    : { add: () => 0, count: () => 0, avg: () => 0, p95: () => 0, reset: () => {} };
};

// Date.now() is too coarse for this: an engine decision is a few hundredths of a
// millisecond, so a millisecond clock would record zeros and the cost meter
// would never see anything.
const nowMs = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// The engine clock. Tests age it by passing a timestamp; nothing else does.
const touchEngine = (when) => {
  lastEngineUse = Number.isFinite(when) ? when : Date.now();
  return lastEngineUse;
};

const log = (...args) => {
  console.log('[ad-zapper:deep]', ...args);
};

const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
};

const suffixHit = (host, set) => {
  let candidate = String(host || '').toLowerCase();
  if (!candidate) return false;
  for (;;) {
    if (set.has(candidate)) return true;
    const dot = candidate.indexOf('.');
    if (dot < 0) return false;
    candidate = candidate.slice(dot + 1);
  }
};

const isAttachable = (url) => {
  const value = String(url || '');
  if (!value) return false;
  if (UNSAFE_SCHEME.test(value)) return false;
  return value.startsWith('http://') || value.startsWith('https://');
};

const stateOf = () => ({
  mode,
  engineReady,
  replaceRulesReady,
  blocked: blockedTotal,
  rewritten: rewrittenTotal,
  wallRefused: wallRefusedTotal,
  answered: answeredTotal,
  stubbed: stubbedTotal,
  wallServed: wallServedTotal,
  heavy: heavy.size,
  memory: memoryOf(),
  pinned: Array.from(pinned),
  attached: Array.from(sessions.entries()).map(([tabId, session]) => ({
    tabId,
    host: session.host,
    blocked: session.blocked,
    rewritten: session.rewritten,
    rewrites: session.rewrites,
    since: session.since
  }))
});

const writeState = (state) => {
  try {
    chrome.storage.local.set({ deep: state });
  } catch (_) {}
  return state;
};

// Publishes state for the popup panel. Throttled, because a busy page can
// produce hundreds of blocks a second.
const announce = () => {
  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    announceTimer = 0;
    writeState(stateOf());
  }, 1500);
};

// Same payload, written immediately. Used when something the user can see
// changes (attach, detach, pin, mode), so the panel is never stale.
const publish = () => {
  if (announceTimer) {
    clearTimeout(announceTimer);
    announceTimer = 0;
  }
  return writeState(stateOf());
};

const loadEngine = async () => {
  touchEngine();
  if (engineReady) return true;
  if (loading) return loading;
  loading = (async () => {
    try {
      if (typeof self.AdblockerEngine === 'undefined') {
        log('engine bundle missing: the top-level importScripts did not run');
        return false;
      }

      // The shipped brain is the floor, a refreshed one the preference: if a
      // list update ever produced something unusable, this falls back cleanly.
      let buffer = null;
      let source = 'shipped';
      if (self.AdblockerLists && typeof self.AdblockerLists.loadCachedBrain === 'function') {
        try {
          buffer = await self.AdblockerLists.loadCachedBrain();
          if (buffer) source = 'refreshed';
        } catch (_) {
          buffer = null;
        }
      }
      if (!buffer) {
        const response = await fetch(chrome.runtime.getURL('engine/dist/engine.bin'));
        buffer = await response.arrayBuffer();
      }
      const counts = self.AdblockerEngine.loadFromBuffer(buffer);
      engineReady = true;
      log('engine ready', counts, 'from', source);

      // The response-body rules are data, not engine state: the engine parses
      // those filters but never acts on them, so they ship as JSON and get
      // matched rule by rule.
      try {
        const rulesResponse = await fetch(chrome.runtime.getURL('engine/dist/replace-rules.json'));
        const rules = await rulesResponse.json();
        const info = self.AdblockerEngine.loadReplaceRules(rules);
        replaceRulesReady = info.loaded > 0;
        log('replace rules', info);
        // Sites whose bodies get rewritten. They attach on sight, and the panel
        // shows the count, so the layer is visible rather than implied.
        if (typeof self.AdblockerEngine.replaceHosts === 'function') {
          walledHosts = new Set(self.AdblockerEngine.replaceHosts());
          log('sites with response rules', walledHosts.size, Array.from(walledHosts).slice(0, 8));
        }
      } catch (error) {
        log('replace rules unavailable', String(error));
      }

      publish();
      return true;
    } catch (error) {
      log('engine load failed', String(error));
      loading = null;
      return false;
    }
  })();
  return loading;
};

const attach = async (tabId, url, reason) => {
  if (mode === 'off') return false;
  if (!chrome.debugger) return false;
  if (tabId === undefined || tabId === null) return false;
  if (sessions.has(tabId)) {
    sessions.get(tabId).lastSeen = Date.now();
    return true;
  }
  if (!isAttachable(url)) return false;

  const host = hostOf(url);
  if ((heavy.get(host) || 0) > Date.now()) {
    log('skipping', host, ': its last session was too expensive to filter');
    return false;
  }

  if (sessions.size >= MAX_ATTACHED) {
    // At the cap, the least recently used tab gives up its slot instead of the
    // new one being refused: a session that has answered nothing for minutes is
    // worth less than the page being opened now.
    let victim = 0;
    let oldest = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastSeen < oldest) {
        oldest = session.lastSeen;
        victim = id;
      }
    }
    if (victim) {
      log('at the cap, dropping the least recently used tab', victim);
      await detach(victim, 'lru');
    }
  }
  if (sessions.size >= MAX_ATTACHED) return false;

  const lastAttempt = attempts.get(tabId) || 0;
  if (Date.now() - lastAttempt < RETRY_MS) return false;

  const ready = await loadEngine();
  if (!ready) {
    // The wall defence needs no ad decisions. Refusing the wall document and
    // answering it with the reader's own copy are decisions about a *document*,
    // and the rule sets still block ads on this host. So a tab that walls
    // readers is attached whether or not the engine loaded: a broken engine must
    // not mean a defenceless tab, which is exactly what it had quietly meant.
    const wallHost = suffixHit(host, walledHosts) || suffixHit(host, pinned);
    if (!wallHost) {
      diagAdd({ k: 'attach-skipped', host, why: 'engine not loaded' });
      return false;
    }
    diagAdd({ k: 'attach-without-engine', host, reason });
  } else {
    diagAdd({ k: 'attach', host, reason });
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    attempts.set(tabId, Date.now());
    // The refusal has to reach the probe, not just the console: Chrome allows a
    // single debugger per tab, so "refused because something else is attached"
    // is the difference between a broken extension and a busy one.
    diagAdd({
      k: 'attach-refused',
      host,
      error: String((error && error.message) || error).slice(0, 140)
    });
    log('attach refused', tabId, String(error));
    return false;
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' }
      ]
    });
  } catch (error) {
    diagAdd({
      k: 'fetch-enable-failed',
      host,
      error: String((error && error.message) || error).slice(0, 140)
    });
    log('Fetch.enable failed', String(error));
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {}
    attempts.set(tabId, Date.now());
    return false;
  }

  attempts.delete(tabId);
  diagAdd({ k: 'attached', host, reason });
  sessions.set(tabId, {
    host: hostOf(url),
    pageUrl: String(url),
    since: Date.now(),
    lastSeen: Date.now(),
    blocked: 0,
    rewritten: 0,
    rewrites: 0,
    reason: reason || 'auto'
  });
  log('attached', tabId, hostOf(url), reason || 'auto');
  publish();
  return true;
};

const detach = async (tabId, reason) => {
  const session = sessions.get(tabId);
  if (!session) return false;
  sessions.delete(tabId);
  if (chrome.debugger) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {}
  }
  log('detached', tabId, reason || '');
  publish();
  return true;
};

const detachAll = async () => {
  const ids = Array.from(sessions.keys());
  for (const tabId of ids) await detach(tabId, 'all');
  return ids.length;
};

// Called when a tab lands on a page. Decides on the host, not on the content.
const maybeAttach = async (tabId, url) => {
  if (mode === 'off') return false;
  if (!isAttachable(url)) return false;
  const host = hostOf(url);
  if (suffixHit(host, pinned)) return attach(tabId, url, 'pinned');
  if (suffixHit(host, walledHosts)) return attach(tabId, url, 'response rules');
  if (mode === 'always') return attach(tabId, url, 'always');
  if (suffixHit(host, knownHosts)) return attach(tabId, url, 'known ad host');
  return false;
};

/*
 * Attach on the navigation, not on the page's report.
 *
 * src/relay.js reports at document_start, which is early, but that report still
 * travels to the worker, gets decided, and only then does chrome.debugger attach
 * and Fetch.enable. On a fast site the document request is already in flight by
 * then, so the first load of a walled site can render its wall and the reader
 * has to reload before the rewrite lands. chrome.webNavigation.onBeforeNavigate
 * fires before the request exists, which is early enough to win that race.
 */
const watchNavigations = () => {
  const nav = chrome.webNavigation;
  if (!nav || !nav.onBeforeNavigate || !nav.onBeforeNavigate.addListener) return false;
  try {
    nav.onBeforeNavigate.addListener((details) => {
      if (!details || typeof details.url !== 'string') return;
      if (details.frameId !== 0) return; // the top frame is the document that walls
      const tabId = details.tabId;
      if (typeof tabId !== 'number' || tabId < 0) return;
      maybeAttach(tabId, details.url).catch(() => {});
    });
    return true;
  } catch (_) {
    return false;
  }
};

watchNavigations();

/*
 * A second chance at the attach.
 *
 * onBeforeNavigate is the right moment (it fires before the document request
 * exists), but it is one attempt: a worker waking up, a transient refusal of the
 * debugger, and the tab stays unattached for the whole visit with nobody told.
 * This runs once the document exists, still early enough to catch a site that
 * fetches its ads after parse, and it says so out loud when the attach fails
 * instead of swallowing it.
 */
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (!details || details.frameId !== 0) return;
    if (typeof details.tabId !== 'number' || details.tabId < 0) return;
    if (typeof details.url !== 'string' || !isAttachable(details.url)) return;
    if (sessions.has(details.tabId)) return;
    maybeAttach(details.tabId, details.url).catch((error) =>
      log('attach retry failed', details.tabId, String((error && error.message) || error))
    );
  });
}

// Called when the page itself reports ad machinery. Evidence beats heuristics.
const signalAttach = async (tabId, url) => {
  if (mode === 'off') return false;
  return attach(tabId, url, 'page signal');
};

const continueRequest = async (tabId, requestId, url) => {
  const params = { requestId };
  if (url) params.url = url;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', params);
    return true;
  } catch (_) {
    return false;
  }
};

const failRequest = async (tabId, requestId, errorReason) => {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId, errorReason });
    return true;
  } catch (_) {
    return false;
  }
};

const fulfillRequest = async (tabId, requestId, responseCode, responseHeaders, body) => {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
      requestId,
      responseCode,
      responseHeaders,
      body
    });
    return true;
  } catch (_) {
    return false;
  }
};

// --- response stage -------------------------------------------------------

const meterFor = (tabId) => {
  let meter = meters.get(tabId);
  if (!meter) {
    meter = newMeter();
    meters.set(tabId, meter);
  }
  return meter;
};

// A tab whose engine work has turned pathological loses its session, and its
// host gets a cooldown so it does not come straight back. Detaching mid-request
// is safe: the reply for this request still goes out.
const demoteIfExpensive = (tabId, session) => {
  const meter = meters.get(tabId);
  if (!meter || meter.count() < COST_MIN_SAMPLES) return false;
  const p95 = meter.p95();
  if (p95 <= COST_P95_MS) return false;
  if (session && session.host) heavy.set(session.host, Date.now() + HEAVY_COOLDOWN_MS);
  log('detaching', tabId, 'filtering cost p95', p95.toFixed(2), 'ms');
  meter.reset();
  detach(tabId, 'expensive').catch(() => {});
  return true;
};

// Body rewriting is the most expensive thing this extension does, and a page
// looping on its own requests could ask for it forever. Each tab gets a minute's
// budget; when it is spent the page is released untouched, and the tab is told
// about it once instead of once per response.
const allowRewrite = (tabId, size) => {
  const now = Date.now();
  let record = rewriteLog.get(tabId);
  if (!record || now - record.since > REWRITE_WINDOW_MS) {
    record = { since: now, count: 0, bytes: 0, warned: false };
    rewriteLog.set(tabId, record);
  }
  if (record.count >= REWRITE_MAX_PER_WINDOW || record.bytes + size > REWRITE_MAX_BYTES_PER_WINDOW) {
    if (!record.warned) {
      record.warned = true;
      log('rewrite budget spent for tab', tabId, `(${record.count} bodies, ${record.bytes} bytes)`);
    }
    return false;
  }
  record.count += 1;
  record.bytes += size;
  return true;
};

const isResponseStage = (params) =>
  !!params && ('responseStatusCode' in params || 'responseErrorReason' in params);

const headerValue = (headers, name) => {
  if (!Array.isArray(headers)) return '';
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header && String(header.name || '').toLowerCase() === wanted) return String(header.value || '');
  }
  return '';
};

// Headers describing the original body are dropped; everything else (cookies,
// CSP, caching, type) is passed through as Chrome gave it to us.
const stripBodyHeaders = (headers) =>
  (Array.isArray(headers) ? headers : []).filter(
    (header) => header && !BODY_HEADERS.has(String(header.name || '').toLowerCase())
  );

const charsetIsSafe = (headers) => {
  const contentType = headerValue(headers, 'content-type');
  const match = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  if (!match) return true;
  return /^(utf-?8|us-ascii|ascii)/i.test(match[1].trim());
};

const textFromBase64 = (value) => {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8').decode(bytes);
};

const base64FromText = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

// Cheap gate before paying for a body: does the engine have any rule at all for
// this request. Two engine lookups, microseconds, and it means ordinary responses
// are released without ever being fetched into the worker.
const hasRewriteTarget = (details) => {
  const engine = self.AdblockerEngine;
  if (!engine) return false;
  try {
    if (engine.htmlFiltersFor(details) > 0) return true;
    return engine.replaceRulesFor(details).length > 0;
  } catch (_) {
    return false;
  }
};

// --- the reader's own copy of a walled page -------------------------------

/*
 * A wall is a page the site serves instead of the one that was asked for, and
 * on these hosts the reader has usually already had the real thing: the article
 * renders, the detector decides, and only then does the tab walk to the wall.
 * Contested navigations can only buy a bounce or two before the site wins, and
 * chasing the jump through every form it can take is a losing game.
 *
 * So the response stage answers the wall with the reader's copy of the page:
 * the last good document seen for that URL (or for the host root), served with
 * its scripts removed, so the served copy cannot navigate anywhere either. The
 * fight becomes a substitution. Bounded to a dozen documents and a few MB, and
 * dropped entirely when blocking is off.
 */
const goodDocs = new Map(); // url -> { body, at, host }
// The newest capture per host. The wall arrives on a URL of the site's choosing,
// so the copy that answers it is usually the article the reader was on rather
// than anything matching the wall URL: remembering the last good page per host
// is what makes the answer possible at all.
const goodDocLatest = new Map(); // host -> url
let goodDocBytes = 0;
let wallServedTotal = 0;
const GOOD_DOC_MAX = 12;
const GOOD_DOC_BYTES = 8 * 1024 * 1024;
const WALL_BODY = /adblockwall|Aufgrund Ihres Blockers|werbeblocker|not displaying|deaktiviere/i;

const rememberDoc = (url, host, body) => {
  try {
    const previous = goodDocs.get(url);
    if (previous) goodDocBytes -= previous.body.length;
    goodDocs.set(url, { body, at: Date.now(), host });
    goodDocLatest.set(host, url);
    goodDocBytes += body.length;
    while (goodDocs.size > GOOD_DOC_MAX || goodDocBytes > GOOD_DOC_BYTES) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of goodDocs) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const gone = goodDocs.get(oldestKey);
      goodDocBytes -= gone.body.length;
      goodDocs.delete(oldestKey);
    }
  } catch (_) {}
};

// Scripts come out so the copy cannot jump, and a base tag goes in so relative
// URLs resolve against the site rather than the wall URL in the address bar. The
// meta tag is there to be visible from the page: it is how a live check can tell
// an answered wall from a served one.
const staticCopy = (html, origin) => {
  let out = String(html);
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script\b[^>]*\/>/gi, '');
  const tag = `<base href="${origin}/"><meta name="yaz-served" content="cached">`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (match) => match + tag);
  else out = tag + out;
  return out;
};

// A walled host in the list can be stored as the registrable name while the
// request arrives on a subdomain (or the other way round), so the check walks
// the suffix chain rather than requiring an exact match.
const listedHost = (host) => {
  let name = String(host || '').toLowerCase();
  if (!name) return false;
  for (;;) {
    if (walledHosts.has(name)) return true;
    const dot = name.indexOf('.');
    if (dot < 0) return false;
    name = name.slice(dot + 1);
  }
};

const handleWalledDocument = async (tabId, params, requestId, url, host) => {
  diagAdd({ k: 'wall-document', host, url: String(url).slice(0, 90) });
  if (!charsetIsSafe(params.responseHeaders)) return null;
  let fetched = null;
  try {
    fetched = await chrome.debugger.sendCommand({ tabId }, 'Fetch.getResponseBody', { requestId });
  } catch (_) {
    fetched = null;
  }
  if (!fetched || typeof fetched.body !== 'string') return null;
  let text = '';
  try {
    text = fetched.base64Encoded ? textFromBase64(fetched.body) : String(fetched.body);
  } catch (_) {
    return null;
  }
  const head = text.slice(0, 60000);
  if (WALL_NAV.test(url) || WALL_BODY.test(head)) {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch (_) {
      origin = '';
    }
    const newest = goodDocLatest.get(host) || '';
    const chosen =
      goodDocs.get(url) || (newest ? goodDocs.get(newest) : null) || (origin ? goodDocs.get(origin + '/') : null);
    if (chosen && origin) {
      const body = base64FromText(staticCopy(chosen.body, origin));
      const served = await fulfillRequest(
        tabId,
        requestId,
        200,
        [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' }
        ],
        body
      );
      if (served) {
        wallServedTotal += 1;
        announce();
        log('wall answered with the reader\'s copy', url.slice(0, 80));
        return { wallServed: true, type: 'main_frame', url, host, tabId };
      }
    }
    return null;
  }
  if (text.length > 2000) rememberDoc(url, host, text);
  return null;
};

const handleResponseStage = async (tabId, session, params, requestId, url, type) => {
  if (!REWRITE_TYPES.has(type)) {
    await continueRequest(tabId, requestId);
    return null;
  }

  // Walled hosts: remember the real page, answer the wall with it.
  const responseHost = hostOf(url);
  if (type === 'main_frame' && listedHost(responseHost)) {
    const handled = await handleWalledDocument(tabId, params, requestId, url, responseHost);
    if (handled) return handled;
  }

  const details = { url, sourceUrl: session.pageUrl, type };
  if (!hasRewriteTarget(details)) {
    await continueRequest(tabId, requestId);
    return null;
  }

  const headers = stripBodyHeaders(params.responseHeaders);
  if (!charsetIsSafe(params.responseHeaders)) {
    await continueRequest(tabId, requestId);
    return null;
  }

  let body = '';
  try {
    const fetched = await chrome.debugger.sendCommand({ tabId }, 'Fetch.getResponseBody', { requestId });
    if (!fetched) {
      await continueRequest(tabId, requestId);
      return null;
    }
    body = fetched.base64Encoded ? textFromBase64(fetched.body) : String(fetched.body || '');
  } catch (_) {
    await continueRequest(tabId, requestId);
    return null;
  }

  if (!body || body.length > BODY_LIMIT) {
    await continueRequest(tabId, requestId);
    return null;
  }

  if (!allowRewrite(tabId, body.length)) {
    await continueRequest(tabId, requestId);
    return null;
  }

  let result = { changed: false, text: body, htmlSelectors: 0, replace: 0 };
  try {
    const raw = self.AdblockerEngine.rewriteBody({ text: body, ...details });
    result = {
      changed: !!raw.changed,
      text: typeof raw.text === 'string' ? raw.text : body,
      htmlSelectors: raw.htmlSelectors || raw.html || 0,
      replace: raw.replace || 0
    };
  } catch (_) {
    result = { changed: false, text: body, htmlSelectors: 0, replace: 0 };
  }

  if (!result.changed) {
    await continueRequest(tabId, requestId);
    return null;
  }

  const served = await fulfillRequest(
    tabId,
    requestId,
    params.responseStatusCode || 200,
    headers,
    base64FromText(result.text)
  );
  if (!served) {
    await continueRequest(tabId, requestId);
    return null;
  }

  session.rewritten += 1;
  rewrittenTotal += 1;
  announce();
  return {
    rewritten: true,
    type,
    url,
    host: hostOf(url),
    before: body.length,
    after: result.text.length,
    htmlSelectors: result.htmlSelectors,
    replace: result.replace,
    tabId
  };
};

// --- request stage --------------------------------------------------------

// The interception loop. Returns a small record so tests and logs can see what
// the engine decided without reading CDP traffic.
const handleEvent = async (source, method, params) => {
  const tabId = source && source.tabId;
  const session = tabId === undefined ? null : sessions.get(tabId);
  if (!session) return null;
  session.lastSeen = Date.now();
  if (method !== 'Fetch.requestPaused') return null;

  const requestId = params && params.requestId;
  if (!requestId) return null;
  const request = (params && params.request) || {};
  const url = request.url || '';
  const type = TYPE_MAP[(params && params.resourceType) || 'Other'] || 'other';
  if (!url) {
    await continueRequest(tabId, requestId);
    return null;
  }

  // A wall document is never loaded: the browser is sent back to the site root
  // and the reader keeps their page. Bounded per tab (the counter lives on the
  // session, so it goes away with it).
  if (type === 'main_frame' && WALL_NAV.test(url) && !isResponseStage(params)) {
    // A burst is contested; a site that keeps coming back is not. Three layers
    // can each refuse the same navigation, and if any of them never yields the
    // tab spins between the wall and the page faster than a reader can use
    // either, so the refusals stop after a couple inside one window.
    const lastRefusal = session.wallRefusedAt || 0;
    if (Date.now() - lastRefusal < WALL_NAV_WINDOW_MS) {
      session.wallRefusals = (session.wallRefusals || 0) + 1;
    } else {
      session.wallRefusals = 1;
      session.wallRefusedAt = Date.now();
    }
    if (session.wallRefusals <= WALL_NAV_CAP) {
      let root = '';
      try {
        root = new URL(url).origin + '/';
      } catch (_) {
        root = '';
      }
      if (root) {
        const done = await fulfillRequest(
          tabId,
          requestId,
          302,
          [{ name: 'Location', value: root }, { name: 'Cache-Control', value: 'no-store' }],
          ''
        );
        if (done) {
          wallRefusedTotal += 1;
          announce();
          log('wall navigation refused', url.slice(0, 90), '->', root);
          return { wallRefused: true, type, url, to: root, host: hostOf(url), tabId };
        }
      }
    }
  }

  // The detector's beacon, answered instead of blocked.
  if (type !== 'main_frame' && REPORT_ENDPOINT.test(hostOf(url)) && !isResponseStage(params)) {
    const done = await fulfillRequest(tabId, requestId, 204, [{ name: 'Cache-Control', value: 'no-store' }], '');
    if (done) {
      answeredTotal += 1;
      announce();
      return { answered: true, type, url, host: hostOf(url), tabId };
    }
  }

  if (isResponseStage(params)) {
    return handleResponseStage(tabId, session, params, requestId, url, type);
  }

  touchEngine();
  let decision = { ready: false, block: false };
  const startedAt = nowMs();
  try {
    decision = self.AdblockerEngine.decide({
      url,
      sourceUrl: session.pageUrl,
      type
    });
  } catch (_) {
    decision = { ready: false, block: false };
  }
  // Rolling cost per tab, so a page that makes filtering expensive can be let go
  // of instead of being allowed to slow the browser down. The detach is fired
  // and not awaited: this request still gets its reply.
  meterFor(tabId).add(nowMs() - startedAt);
  demoteIfExpensive(tabId, session);

  if (decision.block) {
    session.blocked += 1;
    blockedTotal += 1;
    announce();
    // A websocket upgrade cannot be answered with a body, so it keeps the old
    // treatment; everything else gets an empty answer shaped like its own kind.
    if (type !== 'websocket') {
      diagBump(hostOf(params.request.url), `stub-answer ${type}`);
      const stub = stubFor(type);
      const body = stub.base64 ? stub.body : btoa(stub.body);
      const headers = [{ name: 'Content-Type', value: stub.mime }, { name: 'Cache-Control', value: 'no-store' }];
      const served = await fulfillRequest(tabId, requestId, 200, headers, body);
      if (served) {
        session.stubbed = (session.stubbed || 0) + 1;
        stubbedTotal += 1;
        announce();
        return {
          blocked: true,
          stubbed: true,
          type,
          url,
          host: hostOf(url),
          filter: decision.filter || null,
          tabId
        };
      }
    }
    await failRequest(tabId, requestId, 'BlockedByClient');
    return { blocked: true, type, url, host: hostOf(url), filter: decision.filter || null, tabId };
  }

  // Tracking parameters come off the URL instead of killing the request, which
  // is what the lists ask for with their removeparam rules.
  if (decision.rewrite && decision.rewrite !== url) {
    const done = await continueRequest(tabId, requestId, decision.rewrite);
    if (done) {
      session.rewrites += 1;
      rewrittenTotal += 1;
      announce();
      return { rewritten: true, type, url, to: decision.rewrite, host: hostOf(url), tabId };
    }
  }

  await continueRequest(tabId, requestId);
  return { blocked: false, type, url, host: hostOf(url), tabId };
};

// Idle sessions give the banner back. Called on every worker message, because a
// service worker cannot rely on its own timers surviving.
const sweep = () => {
  const now = Date.now();
  const stale = [];
  for (const [tabId, session] of sessions) {
    if (now - session.lastSeen > IDLE_MS) stale.push(tabId);
  }
  for (const tabId of stale) detach(tabId, 'idle');
  idleCheck();
  return stale.length;
};

// With nothing attached and nothing asking the engine anything, the brain's
// ~4.5 MB of tables are handed back to the collector. loadEngine() brings them
// back from the cached binary (~120 ms) the next time a tab needs them.
const idleCheck = () => {
  if (!engineReady || sessions.size > 0) return false;
  if (Date.now() - lastEngineUse < ENGINE_IDLE_MS) return false;
  try {
    if (self.AdblockerEngine && self.AdblockerEngine.unload) self.AdblockerEngine.unload();
  } catch (_) {}
  engineReady = false;
  replaceRulesReady = false;
  // Drop the resolved loader too: leaving it in place would hand the next caller
  // a stale "loaded" and skip the actual reload.
  loading = null;
  writeState(stateOf());
  log('engine unloaded while idle');
  return true;
};

const memoryOf = () => {
  const smart = self.AdblockerSmart;
  return {
    heap: smart && smart.heapBytes ? smart.heapBytes() : null,
    engineLoaded: engineReady,
    sessions: sessions.size,
    knownHosts: knownHosts.size,
    walledHosts: walledHosts.size,
    pinned: pinned.size,
    heavy: heavy.size,
    meters: meters.size,
    rewrites: rewriteLog.size
  };
};

const setSettings = (settings) => {
  const next = settings && settings.deepBlock;
  mode = DEEP_MODES.includes(next) ? next : 'smart';
  return mode;
};

const setPinned = (hosts) => {
  pinned = new Set((Array.isArray(hosts) ? hosts : []).map((host) => String(host).toLowerCase()).filter(Boolean));
  publish();
  return Array.from(pinned);
};

const setKnownHosts = (hosts) => {
  knownHosts = new Set(
    (Array.isArray(hosts) ? hosts : []).map((host) => String(host).toLowerCase()).filter(Boolean)
  );
  return knownHosts.size;
};

// Chrome takes the tab away, the user closes the banner, the tab navigates:
// every one of those ends the session, and no tab is left attached by accident.
if (chrome.debugger) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    handleEvent(source, method, params).catch(() => {});
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId !== undefined && sessions.has(source.tabId)) {
      sessions.delete(source.tabId);
      publish();
    }
  });
}
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (sessions.has(tabId)) {
      sessions.delete(tabId);
      attempts.delete(tabId);
      publish();
    }
    // Per-tab bookkeeping goes with the tab, or the maps become the leak.
    meters.delete(tabId);
    rewriteLog.delete(tabId);
  });
}

self.AdblockerDeep = {
  mapType: (resourceType) => TYPE_MAP[resourceType] || 'other',
  isResponseStage,
  setSettings,
  setPinned,
  setKnownHosts,
  maybeAttach,
  signalAttach,
  attach,
  detach,
  detachAll,
  handleEvent,
  sweep,
  publish,
  idleCheck,
  touch: touchEngine,
  memory: memoryOf,
  heavyHosts: () => Array.from(heavy.keys()),
  cost: (tabId) => {
    const meter = meters.get(tabId);
    return meter ? { count: meter.count(), avg: Number(meter.avg().toFixed(4)), p95: Number(meter.p95().toFixed(4)) } : null;
  },
  state: stateOf,
  isAttached: (tabId) => sessions.has(tabId),
  isWalledHost: (host) => suffixHit(host, walledHosts),
  // Turning the switch back on has to be able to attach immediately. The
  // cooldown a refused or failed attach leaves behind belongs to the state that
  // failed, not to the state that was just switched on.
  resetAttempts: () => {
    try {
      attempts.clear();
      return true;
    } catch (_) {
      return false;
    }
  },
  // What the tabs are attached to right now, for the probe and for the toggle.
  attachedTabs: () => {
    try {
      return Array.from(sessions.keys());
    } catch (_) {
      return [];
    }
  },
  // The probe: what this layer decided, newest last, plus per-host counts.
  diag: () => {
    try {
      return {
        events: diag.slice(-160),
        counts: Array.from(diagCounts)
          .map(([key, count]) => `${key} x${count}`)
          .sort()
      };
    } catch (_) {
      return { events: [], counts: [] };
    }
  },
  // The content script on a walled host hands over the document it rendered, so
  // the copy the wall is answered with does not depend on this layer having won
  // a race for the response body.
  rememberDoc: (url, html) => {
    try {
      const text = String(html || '');
      diagAdd({ k: 'capture', host: hostOf(url), url: String(url).slice(0, 90), bytes: text.length });
      if (!text || text.length < 2000) return false;
      rememberDoc(String(url), hostOf(url), text);
      return true;
    } catch (_) {
      return false;
    }
  },
  walledHostList: () => Array.from(walledHosts),
  isEngineReady: () => engineReady,
  hasReplaceRules: () => replaceRulesReady,
  ensureEngine: loadEngine
};
