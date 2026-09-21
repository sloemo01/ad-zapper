/*
 * Builds src/scriptlet-map.js from the filter lists.
 *
 * Scriptlet filters (`example.com##+js(set, adblock, false)`) ask for a small
 * piece of page-world code to run before the site's own scripts do. The engine
 * this extension vendors carries no scriptlet code, so the implementations are
 * hand-written in src/scriptlets.js and this file decides which site gets which
 * call.
 *
 * Only names with a hand-written implementation are kept. Everything else is
 * counted and printed by name, so the build log answers "what do we not cover"
 * instead of implying full coverage. `trusted-*` scriptlets are deliberately
 * never supported: in uBO they exist to be trusted with privileges this
 * extension does not hand out.
 *
 * Run: node tools/build-scriptlets.mjs
 */
import fs from 'node:fs';

const LIST_DIR = new URL('../tools/lists/', import.meta.url);
const OUT = new URL('../src/scriptlet-map.js', import.meta.url);

// Names with an implementation in src/scriptlets.js. Aliases are listed with
// the canonical name they map to.
const SUPPORTED = new Map([
  ['set', 'set'],
  ['set-constant', 'set'],
  ['json-prune', 'json-prune'],
  ['json-prune-fetch-response', 'json-prune'],
  ['no-fetch-if', 'no-fetch-if'],
  ['fetch-defuser', 'no-fetch-if'],
  ['no-xhr-if', 'no-xhr-if'],
  ['xhr-defuser', 'no-xhr-if'],
  ['abort-on-property-read', 'abort-on-property-read'],
  ['aopr', 'abort-on-property-read'],
  ['abort-on-property-write', 'abort-on-property-write'],
  ['aopw', 'abort-on-property-write'],
  ['abort-current-inline-script', 'abort-current-inline-script'],
  ['acs', 'abort-current-inline-script'],
  ['no-window-open-if', 'no-window-open-if'],
  ['nowoif', 'no-window-open-if'],
  ['addEventListener-defuser', 'addEventListener-defuser'],
  ['aeld', 'addEventListener-defuser'],
  ['no-setTimeout-if', 'no-setTimeout-if'],
  ['nostif', 'no-setTimeout-if'],
  ['setTimeout-defuser', 'no-setTimeout-if'],
  ['no-setInterval-if', 'no-setInterval-if'],
  ['nosif', 'no-setInterval-if'],
  ['nosiif', 'no-setInterval-if'],
  ['cookie-remover', 'cookie-remover'],
  ['set-cookie', 'set-cookie']
]);

// A scriptlet invocation is `##+js(name, arg, arg)`, and every argument may
// escape a comma as `\,`.
const parseInvocation = (body) => {
  const inner = body.slice(4).replace(/\)\s*$/, '');
  const parts = [];
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '\\' && inner[index + 1] === ',') {
      current += ',';
      index += 1;
      continue;
    }
    if (char === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  const name = parts[0];
  const args = parts.slice(1).filter((part) => part.length);
  return { name, args };
};

const generic = [];
const hosts = new Map();
const skipped = new Map();
const sources = fs.readdirSync(LIST_DIR).filter((name) => name.endsWith('.txt')).sort();
let invocations = 0;

for (const file of sources) {
  for (const raw of fs.readFileSync(new URL(file, LIST_DIR), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[') continue;
    const marker = line.indexOf('##+js(');
    if (marker < 0) continue;
    // `#@#+js(...)` is an exception, which means "do not run this here".
    if (line.slice(0, marker).endsWith('#@')) continue;
    invocations += 1;
    const prefix = line.slice(0, marker);
    const { name, args } = parseInvocation(line.slice(marker + 2));
    const canonical = SUPPORTED.get(name);
    if (!canonical) {
      skipped.set(name, (skipped.get(name) || 0) + 1);
      continue;
    }
    const entry = [canonical, args];
    if (prefix && !prefix.endsWith('#')) {
      // Domain-scoped, possibly negated (`~example.com`).
      for (const domain of prefix.split(',').map((part) => part.trim())) {
        if (!domain || domain.startsWith('~') || domain.includes('*') || domain.includes('/')) continue;
        const host = domain.replace(/^\|\|?/, '').replace(/^www\./, '').toLowerCase();
        if (!host.includes('.')) continue;
        const list = hosts.get(host) || [];
        list.push(entry);
        hosts.set(host, list);
      }
    } else {
      generic.push(entry);
    }
  }
}

const dedupe = (list) => {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const key = entry[0] + '\u0000' + entry[1].join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort((a, b) => (a[0] + a[1].join()).localeCompare(b[0] + b[1].join()));
};

const genericOut = dedupe(generic);
const hostsOut = {};
for (const host of [...hosts.keys()].sort()) hostsOut[host] = dedupe(hosts.get(host));

const header = `/*
 * GENERATED FILE, do not edit. Built by tools/build-scriptlets.mjs from
 * ${sources.join(', ')}.
 *
 * host -> scriptlet calls to run in the page world before the site's own
 * scripts. The implementations are in src/scriptlets.js; a name with no
 * implementation there is never listed here.
 */
`;

const body = `self.AD_ZAPPER_SCRIPTLETS = ${JSON.stringify({ generic: genericOut, hosts: hostsOut }, null, 0)};\n`;
fs.writeFileSync(OUT, header + body);

const hostCount = Object.keys(hostsOut).length;
const callCount = genericOut.length + Object.values(hostsOut).reduce((sum, list) => sum + list.length, 0);
console.log(`scriptlet filters found: ${invocations}`);
console.log(`kept: ${callCount} calls across ${hostCount} hosts (${genericOut.length} apply to every site)`);
if (skipped.size) {
  const worst = [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`not implemented (${[...skipped.values()].reduce((a, b) => a + b, 0)} calls, ${skipped.size} names):`);
  for (const [name, count] of worst) console.log(`  ${String(count).padStart(4)}  ${name}`);
}
