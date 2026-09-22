#!/usr/bin/env node
/*
 * Extracts response-body replacement rules from the vendored filter lists into
 * engine/dist/replace-rules.json.
 *
 * Why this exists: uBO-family lists carry `$replace=/pattern/replacement/flags`
 * filters that rewrite a response body on the way to the page. The filter
 * engine parses them but does not act on them: there is no replace bucket in its
 * engine, and the payload never reaches the public match API. The CDP layer can
 * rewrite bodies, so the rules are extracted here as data, together with a copy
 * of each rule that has the replace option stripped, which the engine matches
 * normally. At runtime: engine match decides whether a rule applies, the
 * extracted pattern does the work.
 *
 * Rules in the lists cover things no blocking rule can: YouTube's ad JSON
 * (adPlacements, adSlots), Facebook's sponsored feed entries, and ad-config
 * flags on news sites (bild.de, welt.de, golem.de) that gate ad-free reading.
 *
 * Run: node tools/build-replace-rules.mjs
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const listsDir = join(root, 'tools', 'lists');
const outFile = join(root, 'engine', 'dist', 'replace-rules.json');

// `replace` may be the first option or any later one, hence the leading class.
const REPLACE_OPTION = /(?:^|[,$])replace=\/((?:\\.|[^/\\])*)\/((?:\\.|[^/\\])*)\/([a-z]*)/;
const VALID_FLAGS = /^[gimsuy]*$/;

// Removes the replace option and tidies up whatever separator it left behind.
const stripOption = (text) =>
  text
    .replace(REPLACE_OPTION, (match) => (match.startsWith(',') ? '' : '$'))
    .replace(/,\s*$/, '')
    .replace(/\$\s*$/, '');

const rules = [];
const seen = new Set();

let files = [];
try {
  files = readdirSync(listsDir).filter((name) => name.endsWith('.txt'));
} catch (_) {
  console.log('no tools/lists directory, nothing to extract');
  process.exit(1);
}

for (const file of files) {
  const lines = readFileSync(join(listsDir, file), 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[') continue;
    if (!line.includes('replace=')) continue;
    const match = REPLACE_OPTION.exec(line);
    if (!match) {
      console.log(`  skipped (unparseable): ${line.slice(0, 90)}`);
      continue;
    }
    const [, pattern, replacement, flags] = match;
    if (!VALID_FLAGS.test(flags || '')) {
      console.log(`  skipped (flags "${flags}"): ${line.slice(0, 90)}`);
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    try {
      new RegExp(pattern, flags || '');
    } catch (err) {
      console.log(`  skipped (bad regex ${err.message}): ${line.slice(0, 90)}`);
      continue;
    }
    rules.push({
      filter: line,
      matcher: stripOption(line),
      pattern,
      replacement: replacement.replace(/\\\//g, '/'),
      flags: flags || '',
      lists: [file.replace(/\.txt$/, '')]
    });
  }
}

mkdirSync(join(root, 'engine', 'dist'), { recursive: true });

// Gates the lists cannot reach. bild.de hands the wall trigger to an inline
// handler on the html-load.com loader: when the loader's handshake fails, that
// handler empties document.body and navigates to /adblockwall.html, and the
// loader has fallback hosts, so blocking it only moves the problem. uBO fixes
// this on Firefox alone; its rule sits behind `cap_html_filtering`, because it
// needs response-body filtering, which is what this layer is for. Stripping the
// handler leaves the page with no trigger: the loader still loads and reports
// whatever it likes, and nothing acts on it.
const CUSTOM_RULES = [
  '||bild.de^$doc,replace=/on(load|error)="[^"]*?html-load\\.com[^"]*?"//g'
];

for (const line of CUSTOM_RULES) {
  const match = REPLACE_OPTION.exec(line);
  if (!match) {
    console.log(`  skipped (unparseable custom rule): ${line.slice(0, 90)}`);
    continue;
  }
  const [, pattern, replacement, flags] = match;
  try {
    new RegExp(pattern, flags || '');
  } catch (err) {
    console.log(`  skipped (bad custom regex ${err.message}): ${line.slice(0, 90)}`);
    continue;
  }
  if (seen.has(line)) continue;
  seen.add(line);
  rules.push({
    filter: line,
    matcher: stripOption(line),
    pattern,
    replacement: replacement.replace(/\\\//g, '/'),
    flags: flags || '',
    lists: ['custom']
  });
}

writeFileSync(outFile, JSON.stringify(rules, null, 2) + '\n');

// The hosts those rules cover, as a generated script. src/wall-guard.js runs in
// every frame and has to know whether this frame is one of them without asking
// the worker, so the list ships like the popup host list does: packed, one
// string, O(1) to reject a host that is not in it.
// Sites that blank the page when they detect blocking, and whose trigger needs no
// rewrite of our own: the carve-out is what fixes them. Standing the lists down
// means nothing gets blocked for their detector to see, and the deep layer takes
// the page instead. dailymail does it with its own paywall script: the DOM keeps
// all 250k characters of text, every image renders, and the body collapses to a
// pixel, which is a blank page with the site's blessing.
const WALL_ONLY_HOSTS = ['dailymail.com', 'dailymail.co.uk'];

const hosts = new Set(WALL_ONLY_HOSTS);
for (const rule of rules) {
  // The anchor is `||host` followed by `^`, `/`, `$` or the end: not every rule
  // is a bare hostname, and requiring only `^` hid most of these sites.
  const match = /\|\|([a-z0-9][a-z0-9.-]*?)(?=[\^/$]|$)/i.exec(String(rule.filter || rule.matcher || ''));
  if (match) hosts.add(match[1].toLowerCase());
}
for (const host of WALL_ONLY_HOSTS) {
  if (!hosts.has(host)) throw new Error(`wall-only host missing from the generated list: ${host}`);
}
const hostList = [...hosts].sort();
const guardFile = join(root, 'src', 'wall-hosts.js');
writeFileSync(
  guardFile,
  [
    '/*',
    ' * Generated by tools/build-replace-rules.mjs. Do not edit.',
    ' *',
    ' * Hosts whose responses this extension rewrites, which is the set of sites',
    ' * that try to wall readers out. src/wall-guard.js loads this in every frame',
    ' * and returns immediately unless the frame is on one of them.',
    ' */',
    'self.__yazWallHosts = ' + JSON.stringify('\n' + hostList.join('\n') + '\n') + ';',
    'self.__yazWallHostCount = ' + hostList.length + ';',
    ''
  ].join('\n')
);
console.log(`wrote ${hostList.length} wall hosts to src/wall-hosts.js: ${hostList.slice(0, 8).join(', ')}${hostList.length > 8 ? ', ...' : ''}`);
console.log(`wrote ${rules.length} replace rules to engine/dist/replace-rules.json`);
for (const rule of rules) console.log(`  ${rule.pattern.slice(0, 44).padEnd(46)} -> ${rule.replacement.slice(0, 40)}`);
