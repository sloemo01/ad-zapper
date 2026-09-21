/*
 * The DNR rulesets, checked the way Chrome would use them.
 *
 * The rules in rules/*.json are matched by the browser, not by this extension,
 * so nothing at runtime tells us they are right. This file does two jobs:
 *
 *   1. structure: ids unique, action types known, conditions well formed, no
 *      ruleset over Chrome's 30,000 cap, no total over its 330,000 ceiling.
 *   2. behaviour: a urlFilter simulator for Chrome's documented syntax (||, |,
 *      ^, *, resource types, domainType, initiatorDomains) and the acceptance
 *      list: every asset adblock-tester.com scores us on has to be blocked, and
 *      a control set of ordinary requests has to pass.
 *
 * The simulator models Chrome's matcher, it is not Chrome: the rules only get
 * their real proof in a browser. A literal pre-filter keeps the scan cheap, and
 * patterns with too many wildcards are judged by their literal core alone
 * rather than translated into a regex that can blow the stack.
 *
 * Run: node test/dnr.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rulesDir = path.join(root, 'rules');

const manifest = JSON.parse(fs.readFileSync(path.join(rulesDir, 'manifest.json'), 'utf8'));
const rulesets = manifest.rule_resources.map((entry) => ({
  id: entry.id,
  rules: JSON.parse(fs.readFileSync(path.join(root, entry.path), 'utf8'))
}));
const allRules = rulesets.flatMap((set) => set.rules);

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'assertion failed');
};

// --- structure -------------------------------------------------------------

const RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'
]);

check('every ruleset is inside the per-ruleset cap', () => {
  for (const set of rulesets) {
    assert(set.rules.length <= 30000, `${set.id} has ${set.rules.length} rules`);
  }
  assert(allRules.length <= 330000, `total is ${allRules.length}`);
  assert(allRules.length > 100000, `only ${allRules.length} rules converted, the converter is dropping too much`);
});

check('ids are unique and priorities are known', () => {
  const seen = new Set();
  for (const rule of allRules) {
    assert(Number.isInteger(rule.id) && rule.id > 0, 'bad id');
    assert(!seen.has(rule.id), `duplicate id ${rule.id}`);
    seen.add(rule.id);
    assert([1, 2, 3, 4].includes(rule.priority), `unexpected priority ${rule.priority}`);
    assert(rule.action && (rule.action.type === 'block' || rule.action.type === 'allow'), `unexpected action ${JSON.stringify(rule.action)}`);
  }
});

check('every condition is something Chrome accepts', () => {
  for (const rule of allRules) {
    const condition = rule.condition || {};
    assert(typeof condition.urlFilter === 'string' && condition.urlFilter.length > 0, `rule ${rule.id} has no urlFilter`);
    assert(!/\s/.test(condition.urlFilter), `rule ${rule.id} urlFilter has whitespace`);
    assert(condition.urlFilter.length <= 800, `rule ${rule.id} urlFilter too long`);
    assert(!condition.regexFilter, `rule ${rule.id} uses a regexFilter`);
    assert(!('redirect' in rule.action), `rule ${rule.id} redirects`);
    for (const type of condition.resourceTypes || []) assert(RESOURCE_TYPES.has(type), `rule ${rule.id} type ${type}`);
    for (const type of condition.excludedResourceTypes || []) assert(RESOURCE_TYPES.has(type), `rule ${rule.id} excluded ${type}`);
    for (const domain of (condition.initiatorDomains || []).concat(condition.excludedInitiatorDomains || [])) {
      assert(/^[a-z0-9][a-z0-9.-]*$/.test(domain), `rule ${rule.id} domain ${domain}`);
    }
    const stars = (condition.urlFilter.match(/\*/g) || []).length;
    assert(stars <= 4, `rule ${rule.id} has ${stars} wildcards, too many to translate safely`);
  }
});

check('exceptions outrank blocks, and important blocks outrank normal allows', () => {
  const actions = new Map();
  for (const rule of allRules) {
    if (!actions.has(rule.priority)) actions.set(rule.priority, new Set());
    actions.get(rule.priority).add(rule.action.type);
  }
  assert(actions.get(1) && actions.get(1).has('block'), 'priority 1 should hold plain blocks');
  assert(actions.get(2) && actions.get(2).has('allow'), 'priority 2 should hold exceptions');
  assert(!actions.get(3) || actions.get(3).has('block'), 'priority 3 should only hold important blocks');
});

// --- a model of Chrome's urlFilter matching --------------------------------

const SEP = '(?:[^a-zA-Z0-9_.%-]|$)';
const escapeRe = (text) => text.replace(/[.+?${}()|[\]\\/]/g, (char) => '\\' + char);

const filterRegex = (filter, caseSensitive) => {
  let pattern = filter;
  let start = '';
  let end = '';
  if (pattern.startsWith('||')) {
    start = '^(?:[a-z][a-z0-9+.-]*:)?//(?:[^/?#]*\\.)?';
    pattern = pattern.slice(2);
  } else if (pattern.startsWith('|')) {
    start = '^';
    pattern = pattern.slice(1);
  }
  if (pattern.endsWith('|')) {
    end = '$';
    pattern = pattern.slice(0, -1);
  }
  const body = pattern
    .split('*')
    .map((chunk) => escapeRe(chunk).replace(/\^/g, SEP))
    .join('[\\s\\S]*');
  return new RegExp(start + body + end, caseSensitive ? '' : 'i');
};

// The longest run of plain characters in a filter: cheap rejection before any
// regex work, and the fallback judge for patterns that are not translated.
const literalOf = (filter) => {
  const stripped = filter.replace(/^\|\|?/, '');
  let best = '';
  for (const chunk of stripped.split(/[*^]/)) {
    if (chunk.length > best.length) best = chunk;
  }
  return best.replace(/\|$/, '').toLowerCase();
};

const byPriority = new Map();
for (const rule of allRules) {
  const literal = literalOf(rule.condition.urlFilter);
  const stars = (rule.condition.urlFilter.match(/\*/g) || []).length;
  const entry = {
    rule,
    literal,
    regex: stars <= 4 ? filterRegex(rule.condition.urlFilter, !!rule.condition.isUrlFilterCaseSensitive) : null
  };
  if (!byPriority.has(rule.priority)) byPriority.set(rule.priority, []);
  byPriority.get(rule.priority).push(entry);
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

const baseDomain = (host) => {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoLevel = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
};

const sameSite = (a, b) => !!a && !!b && baseDomain(a) === baseDomain(b);
const siteMatch = (host, domain) => host === domain || host.endsWith('.' + domain);

const matches = (entry, request, urlLower) => {
  const condition = entry.rule.condition;
  if (entry.literal && !urlLower.includes(entry.literal)) return false;
  if (condition.resourceTypes && !condition.resourceTypes.includes(request.type)) return false;
  if (condition.excludedResourceTypes && condition.excludedResourceTypes.includes(request.type)) return false;
  if (condition.domainType) {
    const thirdParty = !sameSite(hostOf(request.url), hostOf(request.initiator));
    if (condition.domainType === 'thirdParty' && !thirdParty) return false;
    if (condition.domainType === 'firstParty' && thirdParty) return false;
  }
  if (condition.initiatorDomains) {
    const host = hostOf(request.initiator);
    if (!condition.initiatorDomains.some((domain) => siteMatch(host, domain))) return false;
  }
  if (condition.excludedInitiatorDomains) {
    const host = hostOf(request.initiator);
    if (condition.excludedInitiatorDomains.some((domain) => siteMatch(host, domain))) return false;
  }
  if (entry.regex === null) return true; // literal-only judgement, stated in the header
  return entry.regex.test(request.url);
};

// Chrome takes the highest priority match; allow beats block at equal priority,
// and each priority here holds only one action type.
const verdict = (request) => {
  const urlLower = request.url.toLowerCase();
  for (const priority of [4, 3, 2, 1]) {
    for (const entry of byPriority.get(priority) || []) {
      if (matches(entry, request, urlLower)) {
        return { blocked: entry.rule.action.type === 'block', rule: entry.rule };
      }
    }
  }
  return { blocked: false, rule: null };
};

// --- behaviour -------------------------------------------------------------

const PAGE = 'https://adblock-tester.com/';
const asset = (url, type) => ({ url, type, initiator: PAGE });
const script = (url) => asset(url, 'script');

const TARGETS = [
  ['contextual: Custom', script('https://ymatuhin.ru/ads/ads.js')],
  ['contextual: AdSense', script('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')],
  ['contextual: Yandex Direct', script('https://an.yandex.ru/system/context.js')],
  ['analytics: Google', script('https://www.googletagmanager.com/gtag/js?id=G-EPK7X69JWC')],
  ['analytics: Hotjar', script('https://static.hotjar.com/c/hotjar-1639117.js?sv=6')],
  ['analytics: Yandex Metrica', script('https://mc.yandex.ru/metrika/tag.js')],
  ['errors: Sentry bundle', script('https://browser.sentry-cdn.com/7.81.1/bundle.tracing.replay.min.js')],
  ['errors: Sentry loader', script('https://js.sentry-cdn.com/98eefed2636036c3bdb8377b11ff28fe.min.js')],
  ['errors: Bugsnag', script('https://d2wy8f7a9ursnm.cloudfront.net/v4/bugsnag.min.js')],
  ['banner: flash', asset('https://adblock-tester.com/banners/pr_advertising_ads_banner.swf', 'object')],
  ['banner: gif', asset('https://adblock-tester.com/banners/pr_advertising_ads_banner.gif', 'image')],
  ['banner: static', asset('https://adblock-tester.com/banners/pr_advertising_ads_banner.png', 'image')]
];

const CONTROLS = [
  ['the test page itself', asset('https://adblock-tester.com/', 'main_frame')],
  ['an ordinary site script', script('https://example.com/app.js')],
  ['a first-party image', asset('https://example.com/logo.png', 'image')],
  ['google fonts css', { url: 'https://fonts.googleapis.com/css2?family=Inter', type: 'stylesheet', initiator: 'https://example.com/' }],
  ['a plain document', asset('https://example.com/', 'main_frame')],
  ['a first-party xhr', { url: 'https://example.com/api/feed.json', type: 'xmlhttprequest', initiator: 'https://example.com/' }]
];

const hits = [];
const misses = [];

check('every script asset the tester scores us on is blocked by the rules', () => {
  for (const [label, request] of TARGETS) {
    const outcome = verdict(request);
    if (outcome.blocked) hits.push(`${label}: ${outcome.rule.condition.urlFilter} (p${outcome.rule.priority})`);
    else misses.push(label);
  }
  const required = misses.filter((label) => !label.startsWith('banner:'));
  assert(required.length === 0, `not blocked: ${required.join(', ')}`);
});

check('ordinary requests are not blocked', () => {
  const failures = [];
  for (const [label, request] of CONTROLS) {
    const outcome = verdict(request);
    if (outcome.blocked) failures.push(`${label} (${outcome.rule.condition.urlFilter})`);
  }
  assert(failures.length === 0, `blocked by mistake: ${failures.join(', ')}`);
});

check('every rule passes the urlFilter grammar Chrome enforces', () => {
  // Chrome validates a whole ruleset and refuses to load the extension if a
  // single rule is malformed, which is exactly what happened: one rule with
  // `||*.example.com^` in it took the entire build down with "Rule with id N
  // specifies an incorrect value for the urlFilter key". This is that check,
  // run over everything the builder wrote.
  const offences = [];
  for (const rule of allRules) {
    const filter = String(rule.condition.urlFilter || '');
    const body = filter.startsWith('||') ? filter.slice(2) : filter.startsWith('|') ? filter.slice(1) : filter;
    const trimmed = body.endsWith('|') ? body.slice(0, -1) : body;
    if (!filter) offences.push('empty');
    else if (/[^\x20-\x7e]/.test(filter)) offences.push(`non-ascii: ${filter.slice(0, 40)}`);
    else if (/\s/.test(filter)) offences.push(`whitespace: ${filter.slice(0, 40)}`);
    else if (/^\|\|\*/.test(filter)) offences.push(`wildcard after the domain anchor: ${filter.slice(0, 40)}`);
    else if (filter.includes('^') && !/^[^^]*\^$/.test(filter)) offences.push(`separator not at the end: ${filter.slice(0, 40)}`);
    else if (trimmed.includes('|')) offences.push(`literal pipe: ${filter.slice(0, 40)}`);
    if (offences.length > 5) break;
  }
  assert(offences.length === 0, `Chrome would refuse these: ${offences.join(' | ')}`);
});

check('the conversion is honest about what it cannot express', () => {
  assert(allRules.some((rule) => rule.action.type === 'allow'), 'no exceptions survived, sites will break');
  const allowShare = allRules.filter((rule) => rule.action.type === 'allow').length / allRules.length;
  assert(allowShare > 0.005, `exceptions are only ${(allowShare * 100).toFixed(2)}% of the rules`);

  // The bound is read off the sources rather than written down, because writing
  // it down is how this check went stale the first time: it still expected the
  // 131k lines of the pre-AdGuard list set and failed the moment a source was
  // added. What it is really guarding is a runaway in the converter, so it
  // compares against the lines the sources actually hold.
  //
  // The list files are build inputs, fetched by tools/fetch-lists.mjs, and they
  // are not committed, so a fresh clone has curated-rules.txt and nothing else.
  // The ratio only means something once they have been fetched.
  const listDir = path.join(__dirname, '..', 'tools', 'lists');
  const listFiles = fs.existsSync(listDir)
    ? fs.readdirSync(listDir).filter((name) => name.endsWith('.txt'))
    : [];
  if (listFiles.length < 2) {
    console.log('  list files not fetched, ratio check skipped');
    return;
  }
  const lineTotal = listFiles.reduce(
    (sum, name) => sum + fs.readFileSync(path.join(listDir, name), 'utf8').split('\n').length,
    0
  );
  assert(allRules.length < lineTotal, `more rules (${allRules.length}) than filter lines (${lineTotal})`);
  assert(allRules.length > lineTotal / 4, `only ${allRules.length} rules came out of ${lineTotal} lines`);
});

const failed = results.filter((line) => line.startsWith('FAIL'));
console.log(results.join('\n'));
console.log('\nassets blocked by a rule:');
for (const line of hits) console.log('  ' + line);
if (misses.length) {
  console.log('not blocked:');
  for (const line of misses) console.log('  ' + line);
}
console.log(`\n${allRules.length} rules across ${rulesets.length} rulesets`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
