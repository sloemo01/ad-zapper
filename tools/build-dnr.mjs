#!/usr/bin/env node
/*
 * Converts the vendored filter lists into static declarativeNetRequest rulesets.
 *
 * Why: the full EasyList / EasyPrivacy / uBO rule set only ever applied to a tab
 * the deep block had attached through CDP. Every other page got 11 hand-written
 * rules, which is why tracker scripts kept executing on adblock-tester.com. DNR
 * rules are matched by Chrome itself on every request, cost the extension no
 * memory, and need no debugger, so the breadth of the lists reaches every page.
 *
 * The conversion is deliberately conservative: anything whose meaning cannot be
 * expressed exactly as a DNR rule is skipped rather than approximated, because a
 * wrong blocking rule breaks a site silently. Skipped by design:
 *   - cosmetic and HTML filters (handled by the injection and response layers)
 *   - regex filters (regexFilter rules are capped and easy to get wrong)
 *   - $popup (Chrome cannot block popups this way; the MAIN-world killer does it)
 *   - $redirect, $csp, $removeparam, $replace, $webrtc and the uBO-only modifiers
 *   - filters with no hostname anchor and no meaningful pattern (too generic)
 *
 * Run: node tools/build-dnr.mjs
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const listsDir = join(root, 'tools', 'lists');
const outDir = join(root, 'rules');
const CHUNK = 30000;      // Chrome's per-ruleset cap since 121
const MAX_TOTAL = 330000; // Chrome's ceiling across every ruleset
const MAX_FILTER = 800;

// Filter option -> DNR resource type.
const TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  document: 'main_frame',
  doc: 'main_frame',
  font: 'font',
  media: 'media',
  websocket: 'websocket',
  ping: 'ping',
  beacon: 'ping',
  other: 'other',
  csp_report: 'csp_report'
};

// Options this converter understands. Everything else means skip the filter.
const HANDLED = new Set([
  ...Object.keys(TYPE_MAP),
  'third-party', '3p', 'first-party', '1p', 'domain', 'important', 'match-case', 'all'
]);

const PRIORITY = { block: 1, importantBlock: 3, allow: 2, importantAllow: 4 };

const skipped = new Map();
const note = (reason) => skipped.set(reason, (skipped.get(reason) || 0) + 1);

// Splits a filter line into its pattern and options. Returns null for cosmetic
// filters and for regex filters, which are not converted.
const parse = (line) => {
  const isException = line.startsWith('@@');
  const body = isException ? line.slice(2) : line;
  if (body.includes('##') || body.includes('#@#') || body.includes('#?#')) return null;
  if (body.includes('#$#')) return null;
  if (body.length < 3) return null;

  // A regex filter starts with '/' and has its closing '/' before any options.
  if (body[0] === '/') {
    const close = body.indexOf('/', 1);
    if (close > 0 && (body.indexOf('$') < 0 || body.indexOf('$') > close)) {
      note('regex filter');
      return null;
    }
  }

  let pattern = body;
  let options = [];
  const dollar = body.lastIndexOf('$');
  if (dollar > 0) {
    const tail = body.slice(dollar + 1);
    if (tail === '') {
      // A trailing $ with nothing after it is part of the pattern, not options.
      pattern = body;
    } else if (/^[a-z0-9~=.,*|':/_-]+$/i.test(tail)) {
      pattern = body.slice(0, dollar);
      options = tail.split(',').map((part) => part.trim()).filter(Boolean);
    } else {
      // Options this splitter cannot read ($csp values with spaces and
      // semicolons, $replace patterns with spaces). Shipping the whole line as
      // a urlFilter would block on the literal text of the filter itself, which
      // is worse than not shipping the rule.
      note('options cannot be parsed');
      return null;
    }
  }
  return { isException, pattern, options, line };
};

// The DNR condition for one filter's options.
const condition = (parsed) => {
  const out = {};
  const types = [];
  const excludedTypes = [];
  for (const option of parsed.options) {
    const negated = option.startsWith('~');
    const name = option.replace(/^~/, '').split('=')[0].toLowerCase();
    if (name === 'domain') {
      const value = option.split('=').slice(1).join('=');
      const hosts = value.split('|').map((host) => host.trim().toLowerCase()).filter(Boolean);
      // DNR takes plain hostnames: no wildcards, no ports. A value the lists
      // wrote as `wayfair.*` cannot be expressed, so it is dropped, and a filter
      // left with no initiator at all is not shipped.
      const clean = (host) => {
        const bare = host.replace(/^~/, '').replace(/^\*\./, '');
        return /^[a-z0-9][a-z0-9.-]*$/.test(bare) ? { host: bare, negated: host.startsWith('~') } : null;
      };
      const include = [];
      const exclude = [];
      for (const host of hosts) {
        const entry = clean(host);
        if (!entry) continue;
        (entry.negated ? exclude : include).push(entry.host);
      }
      const wanted = hosts.filter((host) => !host.startsWith('~')).length;
      if (wanted > 0 && include.length === 0) return null;
      if (include.length) out.initiatorDomains = include;
      if (exclude.length) out.excludedInitiatorDomains = exclude;
      continue;
    }
    if (name === 'third-party' || name === '3p') {
      out.domainType = negated ? 'firstParty' : 'thirdParty';
      continue;
    }
    if (name === 'first-party' || name === '1p') {
      out.domainType = negated ? 'thirdParty' : 'firstParty';
      continue;
    }
    if (name === 'important' || name === 'match-case' || name === 'all') continue;
    const type = TYPE_MAP[name];
    if (!type) return null;
    if (negated) excludedTypes.push(type);
    else types.push(type);
  }
  const unique = (values) => [...new Set(values)];
  if (types.length) out.resourceTypes = unique(types);
  if (excludedTypes.length) out.excludedResourceTypes = unique(excludedTypes);
  if (out.resourceTypes && out.excludedResourceTypes) {
    const blocked = new Set(out.excludedResourceTypes);
    out.resourceTypes = out.resourceTypes.filter((type) => !blocked.has(type));
    if (!out.resourceTypes.length) return null;
  }
  if (parsed.options.some((option) => option.replace(/^~/, '').split('=')[0] === 'match-case')) {
    out.isUrlFilterCaseSensitive = true;
  }
  return out;
};

/*
 * AdGuard's DNS list writes two shapes Chrome's urlFilter grammar rejects:
 *
 *   ||*.example.com^   the `*` sits where Chrome expects a hostname. The
 *                      domain anchor already covers every subdomain, so the
 *                      wildcard is redundant and can go.
 *   ||example.com^|    Chrome has no end-anchor-after-separator, and `^` has
 *                      to be the last character. The trailing `|` goes.
 *
 * One rejected rule anywhere fails the whole extension with "Rule with id N
 * specifies an incorrect value for the urlFilter key", so these are rewritten
 * rather than dropped: both mean the same thing afterwards.
 */
const normalizePattern = (pattern) => {
  let next = pattern;
  if (next.startsWith('||*.')) next = '||' + next.slice(4);
  if (next.endsWith('^|')) next = next.slice(0, -2) + '^';
  return next;
};

const isAscii = (value) => /^[\x20-\x7e]*$/.test(value);

// `|` is an anchor at either end and a literal nowhere else.
const pipesAreAnchors = (pattern) => {
  const body = pattern.startsWith('||') ? pattern.slice(2) : pattern.startsWith('|') ? pattern.slice(1) : pattern;
  const trimmed = body.endsWith('|') ? body.slice(0, -1) : body;
  return !trimmed.includes('|');
};

// Guards against a single filter taking a whole site down. A rule with no
// hostname anchor needs a real path fragment to be worth shipping.
const tooGeneric = (pattern) => {
  const bare = pattern.replace(/^\|\|?/, '');
  if (!bare) return true;
  if (bare === '*' || bare === '^' || bare === '/' || bare === '/*') return true;
  if (!bare.includes('||') && !/\|[a-z]/i.test(pattern) && bare.replace(/[*^/]/g, '').length < 3) return true;
  return false;
};

const rules = [];
let lines = 0;

for (const file of readdirSync(listsDir).filter((name) => name.endsWith('.txt'))) {
  for (const raw of readFileSync(join(listsDir, file), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[' || line[0] === '#') continue;
    lines += 1;
    // Hosts-format sources (`0.0.0.0 example.com`, `127.0.0.1 example.com`) mean
    // the same thing as `||example.com^`, and `#` is their comment marker, so
    // both are normalised here instead of forcing every source into ABP syntax.
    if (line.startsWith('#')) continue;
    const hostsEntry = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+(\S+)\s*$/.exec(line);
    const parsed = parse(hostsEntry ? `||${hostsEntry[1]}^` : line);
    if (!parsed) {
      note('cosmetic or unparseable');
      continue;
    }
    if (!parsed.pattern || parsed.pattern.length > MAX_FILTER) {
      note('empty or oversized pattern');
      continue;
    }
    const rawPattern = parsed.pattern;
    parsed.pattern = normalizePattern(rawPattern);
    if (parsed.pattern !== rawPattern) note('rewritten for Chrome grammar');
    // Chrome matches urlFilter case-insensitively unless the rule asks
    // otherwise, so a lowercase pattern is the same rule with one less thing
    // for its validator to disagree with. Filters that opt into case matching
    // keep their spelling.
    const wantsCase = parsed.options.some((option) => option.replace(/^~/, '').split('=')[0] === 'match-case');
    if (!wantsCase) parsed.pattern = parsed.pattern.toLowerCase();
    for (const option of parsed.options) {
      const name = option.replace(/^~/, '').split('=')[0].toLowerCase();
      if (!HANDLED.has(name)) {
        note('option: ' + name);
        parsed.dead = true;
        break;
      }
    }
    if (parsed.dead) continue;
    if (tooGeneric(parsed.pattern)) {
      note('too generic');
      continue;
    }
    const dnr = condition(parsed);
    if (!dnr) {
      note('unmappable condition');
      continue;
    }
    const important = parsed.options.some((option) => option.replace(/^~/, '').split('=')[0] === 'important');
    rules.push({
      priority: parsed.isException
        ? (important ? PRIORITY.importantAllow : PRIORITY.allow)
        : (important ? PRIORITY.importantBlock : PRIORITY.block),
      action: { type: parsed.isException ? 'allow' : 'block' },
      condition: Object.assign({ urlFilter: parsed.pattern }, dnr),
      source: file.replace(/\.txt$/, '')
    });
  }
}

// Chrome rejects duplicate rules, and the three lists overlap heavily. This pass
// also drops anything that would not survive Chrome's own validation, so a
// parser mistake cannot ship as a broken ruleset.
const seen = new Set();
const unique = [];
for (const rule of rules) {
  const filter = rule.condition.urlFilter;
  if (!filter || /\s/.test(filter) || filter.length > MAX_FILTER || filter.includes('$') || filter.startsWith('@@')) {
    note('failed the final sanity check');
    continue;
  }
  // The grammar check, learned the hard way: Chrome validates every rule in a
  // ruleset and refuses to load the extension if any single one is malformed,
  // so a filter it cannot express has to be dropped here rather than shipped
  // and discovered in the extensions page.
  // `^` appears at most once and only as the final character: a separator used
  // anywhere else is not something this converter is willing to bet the whole
  // manifest on, since Chrome loads all of a ruleset or none of it.
  if (
    !isAscii(filter) ||
    /^\|\|\*/.test(filter) ||
    (filter.includes('^') && !/^[^^]*\^$/.test(filter)) ||
    !pipesAreAnchors(filter)
  ) {
    note('not expressible in Chrome urlFilter grammar');
    continue;
  }
  const key = JSON.stringify([rule.action.type, rule.priority, rule.condition]);
  if (seen.has(key)) {
    note('duplicate after merge');
    continue;
  }
  seen.add(key);
  unique.push(rule);
}

const capped = unique.slice(0, MAX_TOTAL);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const chunks = [];
for (let index = 0; index < capped.length; index += CHUNK) {
  const slice = capped.slice(index, index + CHUNK);
  const id = `dnr_${Math.floor(index / CHUNK) + 1}`;
  const records = slice.map((rule, offset) => ({
    id: index + offset + 1,
    priority: rule.priority,
    action: rule.action,
    condition: rule.condition
  }));
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(records) + '\n');
  chunks.push({ id, path: `rules/${id}.json`, count: records.length, bytes: JSON.stringify(records).length });
}

const resources = chunks.map((chunk) => ({ id: chunk.id, enabled: true, path: chunk.path }));
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ rule_resources: resources }, null, 2) + '\n'
);

// Keep the extension's own manifest in step with what was just written.
//
// Chrome only loads the rulesets the manifest names, so a new source list that
// pushes the rules past one ruleset is a silent no-op until someone remembers
// to edit manifest.json by hand. The build owns these files, so it owns the
// list of them: every dnr_*.json on disk gets declared, after the hand-written
// ruleset, and nothing else in the manifest is touched.
try {
  const manifestPath = join(import.meta.dirname, '..', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const wanted = [{ id: 'youtube_ads', enabled: true, path: 'rules.json' }, ...resources];
  const current = ((manifest.declarative_net_request || {}).rule_resources) || [];
  if (JSON.stringify(current) === JSON.stringify(wanted)) {
    console.log(`manifest: already declares ${wanted.length} rulesets`);
  } else {
    manifest.declarative_net_request = Object.assign({}, manifest.declarative_net_request, {
      rule_resources: wanted
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`manifest: updated to declare ${wanted.length} rulesets`);
  }
} catch (error) {
  console.log(`manifest: not updated (${error.message})`);
}

console.log(`filter lines read: ${lines}`);
console.log(`rules written: ${capped.length} in ${chunks.length} rulesets`);
for (const chunk of chunks) console.log(`  ${chunk.id}: ${chunk.count} rules, ${(chunk.bytes / 1024 / 1024).toFixed(1)} MB`);
const top = [...skipped.entries()].sort((a, b) => b[1] - a[1]);
console.log('skipped:');
for (const [reason, count] of top) console.log(`  ${String(count).padStart(7)}  ${reason}`);
