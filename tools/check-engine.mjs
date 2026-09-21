/*
 * Verifies the engine brain in plain node: compiles the vendored lists,
 * asserts the block/allow cases we care about, checks cosmetic output, and
 * measures parse, serialize, deserialize and match throughput.
 *
 * Run: node tools/fetch-lists.mjs && node tools/check-engine.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FiltersEngine, Request } from '@ghostery/adblocker';

const root = join(import.meta.dirname, '..');
const listsDir = join(root, 'tools', 'lists');
const FILES = ['easylist.txt', 'easyprivacy.txt', 'ubo-filters.txt'];

const parts = [];
for (const file of FILES) {
  try {
    parts.push(readFileSync(join(listsDir, file), 'utf8'));
  } catch (err) {
    console.log(`note: ${file} missing, skipping (run tools/fetch-lists.mjs)`);
  }
}
if (parts.length === 0) {
  console.log('no lists found, nothing to verify');
  process.exit(1);
}
const raw = parts.join('\n');

const heap = () => process.memoryUsage().heapUsed;
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

console.log(`compiling ${parts.length} lists, ${mb(raw.length)} of filter text`);
console.log('');

// 1. parse
const heapBefore = heap();
const t0 = performance.now();
const engine = FiltersEngine.parse(raw, {
  enableCompression: true,
  enableHtmlFiltering: true,
  loadExtendedSelectors: true
});
const parseMs = performance.now() - t0;
const { networkFilters, cosmeticFilters } = engine.getFilters();
console.log(`parse         ${parseMs.toFixed(0)} ms -> ${networkFilters.length.toLocaleString()} network, ${cosmeticFilters.length.toLocaleString()} cosmetic`);
console.log(`heap delta    ${mb(heap() - heapBefore)}`);

// 2. block and allow cases
const req = (url, type, sourceUrl) =>
  Request.fromRawDetails({ url, type, sourceUrl: sourceUrl || 'https://example.com/' });

const CASES = [
  ['doubleclick gpt.js', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script', true],
  ['google-analytics.js', 'https://www.google-analytics.com/analytics.js', 'script', true],
  ['criteo publisher tag', 'https://static.criteo.net/js/ld/publishertag.js', 'script', true],
  ['youtube ad stats beacon', 'https://www.youtube.com/api/stats/ads?ver=2', 'xmlhttprequest', true],
  ['allowed: own image', 'https://example.com/img/hero.jpg', 'image', false],
  ['allowed: own document', 'https://example.com/', 'main_frame', false],
  ['allowed: jsdelivr asset', 'https://cdn.jsdelivr.net/npm/three/build/three.min.js', 'script', false]
];

let failures = 0;
for (const [name, url, type, wantBlocked] of CASES) {
  const result = engine.match(req(url, type));
  const blocked = !!result.match;
  const ok = blocked === wantBlocked;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(24)} blocked=${String(blocked).padEnd(5)} expected=${wantBlocked}`);
  if (!ok && result.exception) {
    console.log(`        exception filter: ${String(result.exception).slice(0, 100)}`);
  }
}

// 3. cosmetics and html filters for a real site
const cosmetic = engine.getCosmeticsFilters({
  url: 'https://www.cnn.com/',
  hostname: 'www.cnn.com',
  domain: 'cnn.com',
  getBaseRules: true,
  getInjectionRules: true,
  getExtendedRules: true,
  getRulesFromHostname: true,
  getRulesFromDOM: false
});
const styles = cosmetic.styles || '';
console.log(`cosmetics     ${styles.length.toLocaleString()} bytes of CSS, ${(cosmetic.scripts || []).length} scripts for cnn.com`);
const htmlFilters = engine.getHtmlFilters(req('https://www.cnn.com/', 'main_frame'));
console.log(`html filters  ${htmlFilters.length} for cnn.com`);

// 4. serialize and deserialize
const t1 = performance.now();
const buffer = engine.serialize();
const serializeMs = performance.now() - t1;
const t2 = performance.now();
const restored = FiltersEngine.deserialize(buffer);
const deserializeMs = performance.now() - t2;
console.log(`serialize     ${serializeMs.toFixed(0)} ms -> ${mb(buffer.byteLength)} buffer`);
console.log(`deserialize   ${deserializeMs.toFixed(0)} ms`);
const spot = restored.match(req('https://www.google-analytics.com/analytics.js', 'script'));
console.log(`restored      ${spot.match ? 'still blocks google-analytics' : 'LOST ITS MEMORY'}`);
writeFileSync(join(root, 'engine', 'dist', 'engine.bin'), buffer);
console.log(`wrote         engine/dist/engine.bin`);

// 5. throughput (in-memory decision cache is on, same as it will be live)
const N = 20000;
const mix = [
  'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
  'https://example.com/img/hero.jpg',
  'https://www.google-analytics.com/analytics.js',
  'https://cdn.jsdelivr.net/npm/three/build/three.min.js'
];
const t3 = performance.now();
let blockedCount = 0;
for (let i = 0; i < N; i++) {
  if (engine.match(req(mix[i % mix.length], 'script')).match) blockedCount++;
}
const total = performance.now() - t3;
console.log(`throughput    ${N.toLocaleString()} matches in ${total.toFixed(0)} ms (${((total / N) * 1000).toFixed(2)} us/match, ${blockedCount} blocked)`);

console.log('');
console.log(failures === 0 ? 'all cases passed' : `${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
