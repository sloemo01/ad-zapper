/*
 * Measures what the brain costs at runtime, loaded the way the worker will load
 * it: deserialize only, no parse. Run: node tools/footprint.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FiltersEngine, Request } from '@ghostery/adblocker';

const bin = readFileSync(join(import.meta.dirname, '..', 'engine', 'dist', 'engine.bin'));

const t0 = performance.now();
const engine = FiltersEngine.deserialize(new Uint8Array(bin));
const deserializeMs = performance.now() - t0;
const mem = process.memoryUsage();

console.log(`brain file     ${(bin.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`deserialize    ${deserializeMs.toFixed(1)} ms`);
console.log(`rss            ${(mem.rss / 1024 / 1024).toFixed(0)} MB (includes node's own overhead)`);
console.log(`heapUsed       ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB`);

const decision = engine.match(Request.fromRawDetails({
  url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
  sourceUrl: 'https://example.com/',
  type: 'script'
}));
console.log(`sanity match   ${decision.match ? 'blocks doubleclick' : 'MISSED'}`);
