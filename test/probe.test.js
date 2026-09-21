/*
 * Node tests for the CDP probe helpers. Run: node test/probe.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const lib = require(path.join(__dirname, '..', 'probe', 'probe-lib.js'));

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

test('hostMatches matches an exact host', () => {
  assert.strictEqual(lib.hostMatches('doubleclick.net', ['doubleclick.net']), true);
});

test('hostMatches matches a subdomain', () => {
  assert.strictEqual(lib.hostMatches('ads.g.doubleclick.net', ['doubleclick.net']), true);
});

test('hostMatches rejects a lookalike domain', () => {
  assert.strictEqual(lib.hostMatches('notdoubleclick.net', ['doubleclick.net']), false);
});

test('hostMatches is case-insensitive and empty-safe', () => {
  assert.strictEqual(lib.hostMatches('Ads.DoubleClick.NET', ['doubleclick.net']), true);
  assert.strictEqual(lib.hostMatches('', ['doubleclick.net']), false);
  assert.strictEqual(lib.hostMatches(null, ['doubleclick.net']), false);
});

test('hostOf extracts a hostname and survives garbage', () => {
  assert.strictEqual(lib.hostOf('https://sub.example.com/a?b=c'), 'sub.example.com');
  assert.strictEqual(lib.hostOf('not a url'), '');
});

test('patchHtml replaces an existing title', () => {
  const out = lib.patchHtml('<html><head><title>Original</title></head><body></body></html>');
  assert.ok(out.includes('<title>CDP-REWRITE-OK</title>'));
  assert.ok(!out.includes('Original'));
});

test('patchHtml inserts a marker when there is no title', () => {
  const out = lib.patchHtml('<html><head></head><body>hi</body></html>');
  const marker = '<title>CDP-REWRITE-OK</title>';
  assert.ok(out.includes(marker));
  assert.ok(out.indexOf(marker) < out.indexOf('</head>'));
});

test('patchHtml refuses unpatchable or oversized bodies', () => {
  assert.strictEqual(lib.patchHtml('no head tag here'), null);
  assert.strictEqual(lib.patchHtml('x'.repeat(3_000_001)), null);
  assert.strictEqual(lib.patchHtml(''), null);
  assert.strictEqual(lib.patchHtml(null), null);
});

test('isHtmlDocument reads the content-type header', () => {
  assert.strictEqual(lib.isHtmlDocument([{ name: 'content-type', value: 'text/html; charset=utf-8' }]), true);
  assert.strictEqual(lib.isHtmlDocument([{ name: 'content-type', value: 'image/png' }]), false);
  assert.strictEqual(lib.isHtmlDocument([]), false);
  assert.strictEqual(lib.isHtmlDocument(undefined), false);
});

test('stripEncodingHeaders drops transfer headers, keeps the rest', () => {
  const headers = [
    { name: 'content-type', value: 'text/html' },
    { name: 'content-encoding', value: 'gzip' },
    { name: 'content-length', value: '1234' },
    { name: 'set-cookie', value: 'a=b' }
  ];
  const out = lib.stripEncodingHeaders(headers);
  assert.deepStrictEqual(out.map((h) => h.name), ['content-type', 'set-cookie']);
});

test('percentiles computes mean, p50, p95 and max', () => {
  const p = lib.percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.strictEqual(p.count, 10);
  assert.strictEqual(p.mean, 5.5);
  assert.strictEqual(p.p50, 6);
  assert.strictEqual(p.p95, 10);
  assert.strictEqual(p.max, 10);
});

test('percentiles is empty-safe', () => {
  const p = lib.percentiles([]);
  assert.deepStrictEqual(p, { count: 0, mean: 0, p50: 0, p95: 0, max: 0 });
  assert.strictEqual(lib.percentiles(undefined).count, 0);
});

test('percentiles handles a single sample', () => {
  const p = lib.percentiles([7.126]);
  assert.strictEqual(p.p50, 7.13);
  assert.strictEqual(p.p95, 7.13);
  assert.strictEqual(p.max, 7.13);
});

console.log('');
console.log(`${passed}/${passed + failed.length} passed`);
if (failed.length) {
  console.log('failed: ' + failed.join(', '));
  process.exit(1);
}
