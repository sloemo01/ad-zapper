/*
 * Worker-side entry for the filter engine brain.
 *
 * tools/build-engine.mjs bundles this file into engine/dist/engine.bundle.js,
 * which the deep-block layer loads with importScripts(). No chrome.* calls in
 * here, so it also runs in node for tests.
 *
 * The brain ships as engine/dist/engine.bin, a serialized FiltersEngine built by
 * tools/check-engine.mjs (parsed with compression, extended selectors and HTML
 * filtering on, so the serialized form carries all three). The worker loads it
 * once per boot and asks it four questions:
 *
 *   decide()       should this request be blocked
 *   cosmetics()    what should this page hide or inject
 *   rewriteHtml()  what should come out of this HTML document instead
 *   serialize()    hand the brain back in binary, so a freshly compiled filter
 *                  set can be cached and reloaded in a fraction of parse time
 *
 * rewriteHtml is the pre-render edit: uBO-family lists carry `##^script` rules
 * that name ad scripts embedded in a page's own HTML. Those scripts are gone
 * before the parser ever sees them, which is not something a blocking rule can
 * do. HTML rules are a small slice of the lists, so this is a scalpel.
 *
 * StreamingHtmlFilter is the library's string-based implementation of those
 * rules (no DOM anywhere), which is what makes it usable from a service worker.
 * It is a streaming filter, so `write()` handles the body and `flush(true)`
 * finishes the buffered tail; modifier-style HTML rules apply to that tail, same
 * as in the library's own streaming use.
 */
import { FiltersEngine, Request, StreamingHtmlFilter } from '@ghostery/adblocker';

let engine = null;

const htmlFilterCount = () => {
  if (engine === null) return 0;
  try {
    return engine.htmlFilters.getFilters().length;
  } catch (_) {
    return 0;
  }
};

const counts = () => {
  const filters = engine.getFilters();
  return {
    network: filters.networkFilters.length,
    cosmetic: filters.cosmeticFilters.length,
    html: htmlFilterCount()
  };
};

const loadFromBuffer = (buffer) => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  engine = FiltersEngine.deserialize(bytes);
  return counts();
};

const parseFromText = (text) => {
  engine = FiltersEngine.parse(text, {
    enableCompression: true,
    enableHtmlFiltering: true,
    loadExtendedSelectors: true
  });
  return counts();
};

// The binary form, for the refresh path: compile once, cache the result, load it
// back quickly on the next boot.
const serialize = () => (engine === null ? null : engine.serialize());

const toRequest = (details) => Request.fromRawDetails({
  url: details.url,
  sourceUrl: details.sourceUrl || '',
  type: details.type || 'other'
});

// One answer for the interception layer: block, allow, or redirect.
const decide = (details) => {
  if (engine === null) return { ready: false, block: false };
  const result = engine.match(toRequest(details));
  return {
    ready: true,
    block: !!result.match,
    redirect: result.redirect ? result.redirect.dataUrl : null,
    rewrite: result.rewrite ? result.rewrite.url || null : null,
    filter: result.filter ? String(result.filter) : null,
    exception: result.exception ? String(result.exception) : null
  };
};

const cosmetics = (details) => {
  if (engine === null) return { styles: '', scripts: [], extended: [] };
  const result = engine.getCosmeticsFilters({
    url: details.url,
    hostname: details.hostname,
    domain: details.domain,
    getBaseRules: details.getBaseRules !== false,
    getInjectionRules: true,
    getExtendedRules: true,
    getRulesFromHostname: true,
    getRulesFromDOM: false
  });
  return { styles: result.styles || '', scripts: result.scripts || [], extended: result.extended || [] };
};

// HTML-level filters, for the response-rewriting stage.
const htmlFilters = (details) => {
  if (engine === null) return [];
  return engine.getHtmlFilters(toRequest(details));
};

const htmlFiltersFor = (details) => htmlFilters(details).length;

// Take an HTML document and return what the page should get instead. Fails open:
// any trouble returns the original body untouched.
const rewriteHtml = (details) => {
  const html = String((details && details.html) || '');
  if (engine === null || !html) return { changed: false, html, filters: 0 };

  let selectors = [];
  try {
    selectors = engine.getHtmlFilters(toRequest(details));
  } catch (_) {
    return { changed: false, html, filters: 0 };
  }
  if (selectors.length === 0) return { changed: false, html, filters: 0 };

  try {
    const filter = new StreamingHtmlFilter(selectors);
    const out = filter.write(html) + filter.flush(true);
    return { changed: out !== html, html: out, filters: selectors.length };
  } catch (error) {
    return { changed: false, html, filters: selectors.length, error: String(error) };
  }
};

const isReady = () => engine !== null;

// Dropping the parsed engine hands ~4.5 MB of tables back to the collector. The
// deep-block layer does this when nothing is attached and nothing has asked for
// cosmetics for a while, then reloads from the cached binary on the next need.
const unload = () => {
  engine = null;
  return true;
};

/*
 * Response-body replacement rules, loaded from engine/dist/replace-rules.json.
 *
 * The engine parses `$replace=` filters but does nothing with them, so each rule
 * arrives here as data: the extracted pattern/replacement, plus a copy of the
 * rule with that option stripped. The stripped copy is compiled into its own
 * small engine, and a match there means the rule applies to this request;
 * then the pattern does the rewrite. One rule per engine keeps the mapping
 * unambiguous without relying on raw filter text surviving compression.
 */
let replaceRules = [];

const loadReplaceRules = (rules) => {
  const list = Array.isArray(rules) ? rules : [];
  const built = [];
  let skipped = 0;
  for (const rule of list) {
    if (!rule || !rule.pattern || !rule.matcher) {
      skipped += 1;
      continue;
    }
    let regexp = null;
    let matcher = null;
    try {
      regexp = new RegExp(rule.pattern, rule.flags || '');
      matcher = FiltersEngine.parse(String(rule.matcher), { enableCompression: true });
    } catch (_) {
      regexp = null;
    }
    if (!regexp || !matcher) {
      skipped += 1;
      continue;
    }
    built.push({
      regexp,
      replacement: String(rule.replacement || ''),
      matcher,
      filter: String(rule.filter || rule.matcher)
    });
  }
  replaceRules = built;
  return { loaded: built.length, skipped };
};

const replaceRuleCount = () => replaceRules.length;

// The hosts that have response rules, so the deep-block layer can attach on
// sight to a page whose body has to be rewritten: an ad-block wall falls only
// if the response stage runs, and waiting for the user to pin the site means
// they see the wall first.
const replaceHosts = () => {
  const hosts = new Set();
  for (const rule of replaceRules) {
    const match = /\|\|([a-z0-9][a-z0-9.-]*?)(?=[\^/$]|$)/i.exec(String(rule.filter || rule.matcher || ''));
    if (match) hosts.add(match[1].toLowerCase());
  }
  return [...hosts];
};

// Which replace rules apply to this request, judged by the engine's own URL,
// domain, party and type matching against the option-stripped copies.
const replaceRulesFor = (details) => {
  if (engine === null || replaceRules.length === 0) return [];
  const request = toRequest(details);
  const applicable = [];
  for (const rule of replaceRules) {
    let hit = false;
    try {
      hit = !!rule.matcher.match(request).match;
    } catch (_) {
      hit = false;
    }
    if (hit) applicable.push(rule);
  }
  return applicable;
};

const applyReplaceRules = (text, rules) => {
  let out = text;
  let applied = 0;
  for (const rule of rules) {
    const before = out;
    try {
      out = out.replace(rule.regexp, rule.replacement);
    } catch (_) {}
    if (out !== before) applied += 1;
  }
  return { text: out, applied };
};

/*
 * The whole pre-render edit in one call: HTML script removal (##^ rules) and
 * response-body replacement ($replace rules), in that order. Fails open.
 */
const rewriteBody = (details) => {
  const text = String((details && details.text) || '');
  const result = { changed: false, text, htmlSelectors: 0, replace: 0 };
  if (engine === null || !text) return result;

  let selectors = [];
  try {
    selectors = engine.getHtmlFilters(toRequest(details));
  } catch (_) {
    selectors = [];
  }
  if (selectors.length) {
    try {
      const filter = new StreamingHtmlFilter(selectors);
      const out = filter.write(text) + filter.flush(true);
      if (out !== text) {
        result.text = out;
        result.changed = true;
      }
      result.htmlSelectors = selectors.length;
    } catch (_) {}
  }

  const applicable = replaceRulesFor(details);
  if (applicable.length) {
    const applied = applyReplaceRules(result.text, applicable);
    if (applied.applied > 0) {
      result.text = applied.text;
      result.changed = true;
      result.replace = applied.applied;
    }
  }

  return result;
};

self.AdblockerEngine = {
  loadFromBuffer,
  parseFromText,
  serialize,
  decide,
  cosmetics,
  htmlFilters,
  htmlFiltersFor,
  rewriteHtml,
  loadReplaceRules,
  replaceRulesFor,
  replaceRuleCount,
  replaceHosts,
  rewriteBody,
  isReady,
  unload,
  counts
};
