/*
 * Tests for the stand-down list (src/skip-hosts.js).
 *
 * The matcher itself is exercised for real, in a vm. The rest is structure, and
 * it is asserted on purpose: this feature is only as good as it is complete, and
 * a layer that quietly keeps working on these hosts is exactly the bug this is
 * meant to prevent. So the checks below also pin the manifest exclusions and the
 * guard line in each page script.
 *
 * Run: node test/skip.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sandbox = { self: null, URL };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('src/skip-hosts.js'), sandbox, { filename: 'skip-hosts.js' });

const skipped = sandbox.adZapperIsSkippedHost;
const skippedUrl = sandbox.adZapperIsSkippedUrl;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};

(async () => {
  await check('github, its subdomains and its asset hosts stand down', () => {
    for (const host of ['github.com', 'www.github.com', 'gist.github.com', 'githubusercontent.com', 'objects.githubusercontent.com', 'githubassets.com']) {
      assert.strictEqual(skipped(host), true, host);
    }
  });

  await check('the other code hosts stand down too', () => {
    for (const host of ['gitlab.com', 'stackoverflow.com', 'npmjs.com', 'localhost', '127.0.0.1']) {
      assert.strictEqual(skipped(host), true, host);
    }
  });

  await check('somebody else\'s site on github.io is still filtered', () => {
    assert.strictEqual(skipped('foo.github.io'), false);
    assert.strictEqual(skipped('example.com'), false);
    assert.strictEqual(skipped('mygithub.com'), false);
    assert.strictEqual(skipped(''), false);
  });

  await check('a URL is read the same way as a host', () => {
    assert.strictEqual(skippedUrl('https://github.com/sloemo01/ad-zapper'), true);
    assert.strictEqual(skippedUrl('https://example.com/github.com'), false);
    assert.strictEqual(skippedUrl('not a url'), false);
  });

  await check('every all-sites content script is excluded from these hosts', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const allSites = manifest.content_scripts.filter((block) => block.matches.includes('http://*/*'));
    assert.ok(allSites.length >= 4, `expected the all-sites scripts, saw ${allSites.length}`);
    for (const block of allSites) {
      const list = block.exclude_matches || [];
      assert.ok(list.includes('*://github.com/*'), `missing github exclusion in ${block.js.join('+')}`);
      assert.ok(list.includes('*://*.github.com/*'), `missing subdomain exclusion in ${block.js.join('+')}`);
    }
  });

  await check('each page script checks the list before doing anything', () => {
    for (const file of ['src/relay.js', 'src/wall-main.js', 'src/popups.js', 'src/wall-guard.js']) {
      const body = read(file);
      assert.ok(body.includes('adZapperIsSkippedHost'), `${file} has no guard`);
      const guardAt = body.indexOf('adZapperIsSkippedHost');
      const strictAt = body.indexOf("'use strict';");
      assert.ok(guardAt > strictAt && guardAt < strictAt + 500, `${file} checks too late`);
    }
  });

  await check('the worker hides nothing and detects nothing there', () => {
    const worker = read('src/background.js');
    assert.ok(worker.includes("importScripts('/src/skip-hosts.js')"), 'the list is not imported');
    const hide = worker.indexOf('const hideFor = async (url) => {');
    const hideGuard = worker.indexOf('adZapperIsSkippedHost', hide);
    assert.ok(hideGuard > hide && hideGuard < hide + 900, 'hideFor does not stand down');
    const detect = worker.indexOf('const runDetect = async (tabId, url) => {');
    const detectGuard = worker.indexOf('adZapperIsSkippedUrl', detect);
    assert.ok(detectGuard > detect && detectGuard < detect + 400, 'the detector does not stand down');
  });

  await check('the rule sets stand down through allow rules nobody can outrank', () => {
    const worker = read('src/background.js');
    assert.ok(worker.includes('SKIP_ALLOW_BASE'), 'no skip rule id range');
    const body = worker.slice(worker.indexOf('const syncSkipAllowRules'));
    assert.ok(body.includes("priority: 2200"), 'wrong priority');
    assert.ok(body.includes("action: { type: 'allow' }"), 'the skip rules must only allow');
    assert.ok(!body.slice(0, 2000).includes("type: 'block'"), 'a skip rule blocks something');
    const staticRules = fs.readdirSync(path.join(root, 'rules')).filter((f) => f.endsWith('.json'));
    assert.ok(staticRules.length >= 10, 'expected the static rule sets');
    assert.ok(2200 > 1000, 'the skip rules must outrank the static lists');
  });

  await check('the deep block still refuses these hosts outright', () => {
    const deep = read('src/deepblock.js');
    assert.ok(deep.includes('const NEVER_ATTACH = ['), 'no never-attach list');
    assert.ok(deep.includes('if (neverAttach(host))'), 'the gate is not consulted');
    assert.ok(deep.indexOf('neverAttach(host)') < deep.indexOf('chrome.debugger.attach'), 'the gate must come before the attach');
  });

  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
