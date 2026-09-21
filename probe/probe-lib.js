/*
 * Pure helpers for the CDP probe. No chrome.* calls in here, so
 * test/probe.test.js can run them in node without a browser.
 */
'use strict';

// Deliberately short: this is a smoke subset, not a filter list.
const BLOCK_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'scorecardresearch.com',
  'adnxs.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'casalemedia.com',
  'teads.tv'
];

const REWRITE_TITLE = '<title>CDP-REWRITE-OK</title>';
const REWRITE_STYLE =
  '<style>html::after{content:"CDP rewrite OK";position:fixed;top:0;left:6px;' +
  'z-index:2147483647;background:#b00020;color:#fff;font:600 12px system-ui;padding:2px 6px}</style>';

// Subdomain-suffix match: "ads.doubleclick.net" matches "doubleclick.net",
// "notdoubleclick.net" does not.
const hostMatches = (host, list) => {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return list.some((domain) => h === domain || h.endsWith('.' + domain));
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return '';
  }
};

// Rewrites only the ASCII markers, so it is safe on binary-decoded bodies.
// Returns null when the body is not a patchable document.
const patchHtml = (html) => {
  if (typeof html !== 'string' || html.length === 0 || html.length > 3_000_000) return null;
  const title = /<title[^>]*>[\s\S]*?<\/title>/i;
  if (title.test(html)) return html.replace(title, REWRITE_TITLE);
  if (!/<\/head>/i.test(html)) return null;
  return html.replace(/<\/head>/i, REWRITE_TITLE + REWRITE_STYLE + '</head>');
};

const isHtmlDocument = (headers) => {
  if (!Array.isArray(headers)) return false;
  const type = headers.find((h) => /^content-type$/i.test(h.name));
  return !!type && /text\/html/i.test(type.value || '');
};

// getResponseBody hands back a decoded body, so re-serving it must drop the
// original transfer headers or the browser will try to decode it twice.
const stripEncodingHeaders = (headers) =>
  (headers || []).filter((h) => !/^(content-encoding|content-length)$/i.test(h.name));

const percentiles = (samples) => {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const r = (n) => Math.round(n * 100) / 100;
  return { count: samples.length, mean: r(mean), p50: r(at(0.5)), p95: r(at(0.95)), max: r(sorted[sorted.length - 1]) };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BLOCK_HOSTS,
    hostMatches,
    hostOf,
    patchHtml,
    isHtmlDocument,
    stripEncodingHeaders,
    percentiles
  };
}
