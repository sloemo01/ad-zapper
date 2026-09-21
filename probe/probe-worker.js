/*
 * CDP probe service worker.
 *
 * Stage 0 of the "break the limits" plan: attach chrome.debugger to one tab,
 * turn on the Fetch domain, and measure what intercepting every request costs.
 * Optionally enforces a small blocklist and rewrites HTML documents on the way
 * through, which is the power MV3 deleted. Throwaway measurement scaffolding,
 * not part of the shipping extension.
 */
'use strict';

importScripts('probe-lib.js');

const STATS_CAP = 5000;
const MAX_ERRORS = 40;

const target = { tabId: null };
const mode = { block: false, rewrite: false };

let boots = 0;
let detachReason = '';

const stats = {
  startedAt: 0,
  paused: 0,
  blocked: 0,
  rewritten: 0,
  byType: {},
  samples: [],
  errors: [],
  loads: [],
  baselines: {}
};

const dbg = (method, params) => chrome.debugger.sendCommand({ tabId: target.tabId }, method, params);

const toBinary = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return bin;
};

const persist = () =>
  chrome.storage.session.set({
    lastStats: {
      startedAt: stats.startedAt,
      paused: stats.paused,
      blocked: stats.blocked,
      rewritten: stats.rewritten,
      byType: stats.byType,
      loads: stats.loads,
      baselines: stats.baselines
    }
  });

const resetStats = () => {
  stats.startedAt = 0;
  stats.paused = 0;
  stats.blocked = 0;
  stats.rewritten = 0;
  stats.byType = {};
  stats.samples = [];
  stats.errors = [];
  stats.loads = [];
};

const record = (ms) => {
  if (stats.samples.length < STATS_CAP) stats.samples.push(ms);
};

const continuePaused = async (requestId, responseStage) => {
  if (responseStage) {
    try {
      await dbg('Fetch.continueResponse', { requestId });
      return;
    } catch (err) {
      // Older CDP builds have no continueResponse; continueRequest also releases it.
    }
  }
  await dbg('Fetch.continueRequest', { requestId });
};

const rewriteDocument = async (params) => {
  const body = await dbg('Fetch.getResponseBody', { requestId: params.requestId });
  const text = body.base64Encoded ? atob(body.body) : body.body;
  const patched = patchHtml(text);
  if (patched === null) return false;
  await dbg('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: params.responseStatusCode || 200,
    responseHeaders: stripEncodingHeaders(params.responseHeaders),
    body: body.base64Encoded ? btoa(patched) : btoa(toBinary(patched))
  });
  stats.rewritten++;
  return true;
};

const onPaused = async (source, params) => {
  if (source.tabId !== target.tabId) return;
  const t0 = performance.now();
  stats.paused++;
  stats.byType[params.resourceType] = (stats.byType[params.resourceType] || 0) + 1;
  const responseStage = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
  try {
    if (responseStage) {
      let handled = false;
      if (mode.rewrite && params.responseStatusCode === 200 && isHtmlDocument(params.responseHeaders)) {
        handled = await rewriteDocument(params);
      }
      if (!handled) await continuePaused(params.requestId, true);
    } else if (mode.block && hostMatches(hostOf(params.request.url), BLOCK_HOSTS)) {
      await dbg('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
      stats.blocked++;
    } else {
      await continuePaused(params.requestId, false);
    }
  } catch (err) {
    stats.errors.push(String((err && err.message) || err));
    if (stats.errors.length > MAX_ERRORS) await detach();
  } finally {
    record(performance.now() - t0);
    if (stats.paused % 25 === 0) persist();
  }
};

const enable = async () => {
  const patterns = [{ urlPattern: '*', requestStage: 'Request' }];
  if (mode.rewrite) {
    patterns.push({ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' });
  }
  await dbg('Fetch.enable', { patterns });
};

const attach = async (tabId, opts) => {
  if (target.tabId !== null) await detach();
  mode.block = !!opts.block;
  mode.rewrite = !!opts.rewrite;
  resetStats();
  target.tabId = tabId;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await enable();
  } catch (err) {
    target.tabId = null;
    throw err;
  }
  detachReason = '';
  stats.startedAt = Date.now();
  return { ok: true, tabId, mode: { ...mode } };
};

const detach = async () => {
  if (target.tabId === null) return { ok: true };
  const tabId = target.tabId;
  target.tabId = null;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
  } catch (err) {
    // Already gone; detaching below is what matters.
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    // Same.
  }
  await persist();
  return { ok: true };
};

const listTabs = async () => {
  const self = chrome.runtime.getURL('');
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.url && /^https?:/i.test(t.url))
    .filter((t) => !t.url.startsWith(self))
    .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
};

const publicStats = () => ({
  attached: target.tabId !== null,
  tabId: target.tabId,
  mode: { ...mode },
  elapsedMs: stats.startedAt ? Date.now() - stats.startedAt : 0,
  paused: stats.paused,
  blocked: stats.blocked,
  rewritten: stats.rewritten,
  byType: stats.byType,
  latency: percentiles(stats.samples),
  errors: stats.errors.slice(-5),
  errorCount: stats.errors.length,
  boots,
  detachReason,
  loads: stats.loads,
  baseline: target.tabId !== null ? stats.baselines[target.tabId] || null : null
});

const dispatch = async (msg) => {
  switch (msg && msg.type) {
    case 'tabs':
      return { tabs: await listTabs() };
    case 'attach':
      return attach(msg.tabId, { block: !!msg.block, rewrite: !!msg.rewrite });
    case 'detach':
      return detach();
    case 'stats':
      return publicStats();
    case 'clear':
      resetStats();
      return publicStats();
    default:
      return { error: 'unknown message: ' + String(msg && msg.type) };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  dispatch(msg)
    .then(respond)
    .catch((err) => respond({ error: String((err && err.message) || err) }));
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Fetch.requestPaused') onPaused(source, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === target.tabId) {
    target.tabId = null;
    detachReason = reason || 'unknown';
    persist();
  }
});

// Load timing, so the UI can show a before/after reload comparison.
const loadStart = new Map();
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    loadStart.set(tabId, performance.now());
    return;
  }
  if (info.status !== 'complete') return;
  const t0 = loadStart.get(tabId);
  loadStart.delete(tabId);
  if (t0 === undefined) return;
  const ms = Math.round(performance.now() - t0);
  if (tabId === target.tabId) {
    stats.loads.unshift({ at: Date.now(), ms, attached: true });
    stats.loads = stats.loads.slice(0, 8);
  } else {
    stats.baselines[tabId] = { at: Date.now(), ms };
  }
});

// Track boots and restore counts across service-worker restarts.
(async () => {
  const stored = await chrome.storage.session.get(['boots', 'lastStats']);
  boots = (stored.boots || 0) + 1;
  await chrome.storage.session.set({ boots });
  if (stored.lastStats) {
    const last = stored.lastStats;
    stats.startedAt = last.startedAt || 0;
    stats.paused = last.paused || 0;
    stats.blocked = last.blocked || 0;
    stats.rewritten = last.rewritten || 0;
    stats.byType = last.byType || {};
    stats.loads = last.loads || [];
    stats.baselines = last.baselines || {};
  }
})();
