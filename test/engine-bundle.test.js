/*
 * Loads the built engine bundle the way the service worker will, then checks it
 * blocks and allows the same cases tools/check-engine.mjs verifies at source
 * level, plus cosmetics and a reload of the serialized brain from disk.
 *
 * Run: node tools/check-engine.mjs && node tools/build-engine.mjs && node test/engine-bundle.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const bundlePath = path.join(root, 'engine', 'dist', 'engine.bundle.js');
const binPath = path.join(root, 'engine', 'dist', 'engine.bin');

assert.ok(fs.existsSync(bundlePath), 'engine bundle missing, run node tools/build-engine.mjs');
assert.ok(fs.existsSync(binPath), 'engine.bin missing, run node tools/check-engine.mjs');

let passed = 0;
const failed = [];
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  pass  ' + name);
  } catch (err) {
    failed.push(name);
    console.log('  FAIL  ' + name + ' :: ' + err.message);
  }
};

// importScripts equivalent: run the bundle in this realm so `self` resolves.
globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: 'engine.bundle.js' });
const engine = globalThis.AdblockerEngine;

test('bundle exposes the engine API', () => {
  assert.ok(engine, 'AdblockerEngine missing from the bundle');
  ['loadFromBuffer', 'parseFromText', 'decide', 'cosmetics', 'htmlFilters', 'isReady'].forEach((fn) => {
    assert.strictEqual(typeof engine[fn], 'function', fn + ' missing');
  });
  assert.strictEqual(engine.isReady(), false);
});

test('decide() is a safe no-op before the brain loads', () => {
  const decision = engine.decide({ url: 'https://doubleclick.net/x.js', type: 'script' });
  assert.strictEqual(decision.block, false);
  assert.strictEqual(decision.ready, false);
});

test('loads the serialized brain', () => {
  const info = engine.loadFromBuffer(new Uint8Array(fs.readFileSync(binPath)));
  assert.ok(info.network > 100000, 'expected >100k network filters, got ' + info.network);
  assert.strictEqual(engine.isReady(), true);
});

test('blocks an ad script through the bundle', () => {
  const decision = engine.decide({
    url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    sourceUrl: 'https://example.com/',
    type: 'script'
  });
  assert.strictEqual(decision.block, true);
  assert.ok(decision.filter, 'no filter string reported');
});

test('blocks the youtube ad beacon through the bundle', () => {
  const decision = engine.decide({
    url: 'https://www.youtube.com/api/stats/ads?ver=2',
    sourceUrl: 'https://www.youtube.com/watch?v=x',
    type: 'xmlhttprequest'
  });
  assert.strictEqual(decision.block, true);
});

test('allows a first-party image', () => {
  const decision = engine.decide({
    url: 'https://example.com/img/hero.jpg',
    sourceUrl: 'https://example.com/',
    type: 'image'
  });
  assert.strictEqual(decision.block, false);
});

test('reports cosmetics for a real site', () => {
  const result = engine.cosmetics({ url: 'https://www.cnn.com/', hostname: 'www.cnn.com', domain: 'cnn.com' });
  assert.ok(result.styles.length > 100, 'expected some CSS, got ' + result.styles.length);
});

test('the brain carries HTML filtering rules', () => {
  const info = engine.counts();
  assert.ok(info.html > 0, 'no HTML rules survived into the serialized brain');
  console.log('      (html rules in the brain: ' + info.html + ')');
});

test('rewrites a YouTube player response so the ad schedule is gone', () => {
  const body =
    '{"response":{"adPlacements":[{"adPlacementRenderer":{"id":"1"}}],"adSlots":[{"x":1}],' +
    '"videoDetails":{"id":"abc"}}}';
  const result = engine.rewriteBody({
    text: body,
    url: 'https://www.youtube.com/youtubei/v1/player?key=x',
    sourceUrl: 'https://www.youtube.com/watch?v=abc',
    type: 'xmlhttprequest'
  });
  assert.strictEqual(result.changed, true, 'nothing was rewritten');
  assert.ok(!/"adPlacements"/.test(result.text), 'adPlacements survived: ' + result.text);
  assert.ok(!/"adSlots"/.test(result.text), 'adSlots survived: ' + result.text);
  assert.ok(/videoDetails/.test(result.text), 'the rewrite ate the video details');
});

test('rewrites a Facebook graphql body so sponsored nodes are gone', () => {
  const body = '{"data":{"node":{"role":"SEARCH_ADS","c":1,"cursor":"xyz"}},"keep":1}';
  const result = engine.rewriteBody({
    text: body,
    url: 'https://facebook.com/api/graphql/',
    sourceUrl: 'https://www.facebook.com/',
    type: 'xmlhttprequest'
  });
  assert.strictEqual(result.changed, true, 'nothing was rewritten');
  assert.ok(!/SEARCH_ADS/.test(result.text), 'the sponsored node survived');
  assert.ok(/"keep":1/.test(result.text), 'the rewrite ate the rest of the payload');
});

test('leaves an unrelated body alone', () => {
  const body = '{"items":[1,2,3]}';
  const result = engine.rewriteBody({
    text: body,
    url: 'https://example.com/api/items',
    sourceUrl: 'https://example.com/',
    type: 'xmlhttprequest'
  });
  assert.strictEqual(result.changed, false, 'an unrelated body was changed');
  assert.strictEqual(result.text, body);
});

test('loads the extracted replace rules and matches them per request', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'engine', 'dist', 'replace-rules.json'), 'utf8'));
  assert.ok(rules.length > 5, 'expected the extracted replace rules, got ' + rules.length);
  const info = engine.loadReplaceRules(rules);
  assert.strictEqual(info.skipped, 0, info.skipped + ' rules failed to load');
  assert.ok(engine.replaceRuleCount() > 5, 'no replace rules are active');

  const applicable = engine.replaceRulesFor({
    url: 'https://www.youtube.com/youtubei/v1/player?key=x',
    sourceUrl: 'https://www.youtube.com/watch?v=abc',
    type: 'xmlhttprequest'
  });
  assert.ok(applicable.length > 0, 'no replace rule applies to a YouTube player request');
  const unrelated = engine.replaceRulesFor({
    url: 'https://example.com/api/items',
    sourceUrl: 'https://example.com/',
    type: 'xmlhttprequest'
  });
  assert.strictEqual(unrelated.length, 0, 'a replace rule matched an unrelated request');
});

console.log('');
console.log(`${passed}/${passed + failed.length} passed`);
if (failed.length) {
  console.log('failed: ' + failed.join(', '));
  process.exit(1);
}
