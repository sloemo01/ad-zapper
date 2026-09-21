/*
 * Builds src/generic-cosmetic.css from the vendored filter lists.
 *
 * Every list carries two kinds of element hiding: rules for one site (written
 * `example.com##.ad`), and generic rules that apply everywhere (`##.ad-slot`).
 * The per-site half is handled by the worker, which injects the engine's
 * cosmetics for the host it is attached to. Without an attach there was nothing
 * generic on the page at all, which is the gap this file closes: 13,680 generic
 * selectors, applied to every http(s) page by a declared content script.
 *
 * Selectors are grouped into rules of CHUNK selectors each, not one giant
 * comma-joined rule and not one rule per selector. One rule for everything
 * means a single selector the parser rejects takes all 13,680 with it; one
 * rule each costs 340 KB of `{display:none !important}` overhead, which every
 * document would pay. At 64 per rule the text is about the size of the
 * selectors themselves, and a bad selector costs 63 neighbours at worst. Each
 * one is checked for balanced brackets and quotes before it goes in, which is
 * as much as can be checked without a CSS parser.
 *
 * Skipped on purpose:
 *   - procedural selectors (`:has-text(...)`, `:xpath(...)`, `:-abp-*`,
 *     `:matches-*`, `:upward(...)`, `:remove()`, `:style(...)`), which are not
 *     CSS and cannot be expressed in a stylesheet
 *   - `##^` HTML filters, which the response layer handles on attached tabs
 *   - scriptlet calls (`##+js(...)`) and exceptions (`#@#`)
 *
 * Run: node tools/build-cosmetic-css.mjs
 */
import fs from 'node:fs';

const LIST_DIR = new URL('../tools/lists/', import.meta.url);
const OUT = new URL('../src/generic-cosmetic.css', import.meta.url);
const CHUNK = 64;

const PROCEDURAL = /:(?:has-text|matches-attr|matches-css|matches-css-after|matches-css-before|min-text-length|watch-attr|others|upward|remove|style|matches-path|xpath|contains|if|if-not|not\(:has-text)\(|:-abp-/;

const sources = fs.readdirSync(LIST_DIR).filter((name) => name.endsWith('.txt')).sort();
const selectors = new Set();
const skipped = { procedural: 0, html: 0, scriptlet: 0, exception: 0, cosmetic: 0 };

for (const file of sources) {
  for (const raw of fs.readFileSync(new URL(file, LIST_DIR), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '[') continue;
    if (line.startsWith('#@#')) {
      skipped.exception += 1;
      continue;
    }
    // A generic hiding rule is exactly `##selector` with nothing in front of it.
    if (!line.startsWith('##')) {
      if (line.includes('##')) skipped.cosmetic += 1;
      continue;
    }
    const selector = line.slice(2);
    if (selector.startsWith('^')) {
      skipped.html += 1;
      continue;
    }
    if (selector.startsWith('+js(')) {
      skipped.scriptlet += 1;
      continue;
    }
    if (PROCEDURAL.test(selector)) {
      skipped.procedural += 1;
      continue;
    }
    selectors.add(selector);
  }
}

// Balanced brackets and quotes, and no stray combinators at the ends. Not a
// CSS parser, but it catches the shapes a filter dialect can produce that CSS
// cannot parse at all, and those are the ones that would silently disable a
// chunk.
const balanced = (selector) => {
  let depth = 0;
  let bracket = 0;
  let quote = '';
  for (const char of selector) {
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === '[') bracket += 1;
    else if (char === ']') bracket -= 1;
    if (depth < 0 || bracket < 0) return false;
  }
  if (depth !== 0 || bracket !== 0 || quote) return false;
  return !/[>+~]$/.test(selector);
};

const sorted = [...selectors].filter(balanced).sort();
const head = `/*
 * GENERATED FILE, do not edit. Built by tools/build-cosmetic-css.mjs from
 * ${sources.join(', ')}.
 *
 * Generic element hiding: the rules in those lists that name no domain, and so
 * apply to every site. ${sorted.length} selectors. The hand-written ones live
 * next to this file in src/curated-cosmetic.css. Both are declared as content
 * script CSS for every http(s) page in manifest.json.
 *
 * ${CHUNK} selectors per rule, each one checked for balanced brackets and quotes
 * before it went in.
 */
`;

const rules = [];
for (let index = 0; index < sorted.length; index += CHUNK) {
  rules.push(sorted.slice(index, index + CHUNK).join(',\n') + ' { display: none !important; }');
}
const body = rules.join('\n');
fs.writeFileSync(OUT, head + body + '\n');

const bytes = Buffer.byteLength(head + body + '\n');
console.log(`generic cosmetic selectors: ${sorted.length} written to src/generic-cosmetic.css (${(bytes / 1024).toFixed(1)} KB)`);
console.log('skipped:', JSON.stringify(skipped));
const shortest = sorted.filter((s) => s.length <= 4).slice(0, 12);
if (shortest.length) console.log('shortest selectors kept:', shortest.join(' '));
const longest = sorted.reduce((a, b) => (b.length > a.length ? b : a), '');
console.log('longest selector:', longest.length, 'chars');
