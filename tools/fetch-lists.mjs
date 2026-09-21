/*
 * Downloads the filter lists the engine compiles from, into tools/lists/.
 * Run: node tools/fetch-lists.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LISTS = {
  'easylist.txt': 'https://easylist.to/easylist/easylist.txt',
  'easyprivacy.txt': 'https://easylist.to/easylist/easyprivacy.txt',
  'ubo-filters.txt': 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
  // Host-level list. EasyList and EasyPrivacy block most things by path and
  // resource type, which leaves whole ad and telemetry hosts (vendor analytics,
  // device makers' log servers) reachable. This one is the list AdGuard DNS
  // serves, so its entries block the entire host.
  'adguard-dns.txt': 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
  // d3Host is published by the author of the Toolz adblock test, which is the
  // page this extension is measured on, and is shipped as-is by Blokada and
  // OISD. Only its host entries are used (131 of them, real ad, analytics,
  // telemetry and social-tracking endpoints). The adblock variant of the same
  // file also carries rules scoped to the test's own page, such as
  // `*$3p,domain=d3ward.github.io` and `d3ward.github.io##.textads`, which
  // exist to satisfy the test rather than to block anything, and are not used.
  'd3host.txt': 'https://raw.githubusercontent.com/d3ward/toolz/master/src/d3host.txt',
  // uBO's per-site fixes. Most of it is network rules for one domain each, and
  // it is also where the scriptlet filters (`##+js(...)`) live: the other lists
  // in this set carry none at all.
  'quick-fixes.txt': 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt'
};

const dir = join(import.meta.dirname, 'lists');
mkdirSync(dir, { recursive: true });

for (const [name, url] of Object.entries(LISTS)) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`FAIL  ${name}: HTTP ${res.status}`);
      continue;
    }
    const text = await res.text();
    writeFileSync(join(dir, name), text);
    console.log(`ok    ${name}: ${text.length.toLocaleString()} bytes`);
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}
