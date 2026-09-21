# Ad Zapper

![tests](https://github.com/sloemo01/ad-zapper/actions/workflows/ci.yml/badge.svg)

A Chrome extension (Manifest V3) that blocks ads and trackers on every page from the real filter
lists, removes YouTube ads, kills popunder windows and ad loaders, hides ad slots, and rewrites
ad-block walls before they render. Loads as-is, no build step for the extension itself.

## Install

### macOS

```
curl -fsSL https://cdn.jsdelivr.net/gh/sloemo01/ad-zapper@main/install/install-macos.sh -o /tmp/ad-zapper.sh
bash /tmp/ad-zapper.sh
```

Piping straight into bash works too, but stdin is the script then, so the pause before the test
page does not work: `curl -fsSL .../install-macos.sh | bash`.

The script prints its own revision on the second line. That line matters if you fetch it
immediately after a commit: `raw.githubusercontent.com` can serve a cached copy for a few minutes,
which is why the jsDelivr URL above is listed first. The banner tells you which revision you got.

### Windows

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/sloemo01/ad-zapper/main/install/install-windows.ps1 -OutFile $env:TEMP\ad-zapper.ps1; & $env:TEMP\ad-zapper.ps1"
```

There is also `install\install-windows.cmd` for double-clicking after a clone.

### What the script does with the folder

It works the same whether you cloned the repository or not. Inside a checkout it installs that
folder. Anywhere else it downloads the newest `main` from GitHub, unpacks it into a folder that
stays put (`~/Applications/Ad Zapper` on macOS, `%LOCALAPPDATA%\Ad Zapper` on Windows) and
installs from there. Running it again replaces that folder with the newest version, which is how
you update. Both scripts take `--dry-run` / `-DryRun` to report without downloading or touching
Chrome, `--download` / `-Download` to force a fresh copy, and `--download-only` / `-DownloadOnly`
to fetch and check the files and stop before Chrome.

### What the scripts can and cannot do

Neither script finishes the job, because Chrome does not allow it: an unpacked extension is loaded
by a person, and no supported API or installer can put one into a profile you are already signed
into. What the scripts do is everything around that. They check that Chrome is where it should be,
check that the checkout is complete and that the manifest and all ten rule sets parse, put the
folder path on your clipboard, and open `chrome://extensions`. Then it is four steps:

1. Developer mode, the toggle at the top right.
2. Load unpacked, top left. In the file dialog press Cmd+Shift+G (macOS) or Ctrl+V (Windows),
   paste, and press Open.
3. Chrome shows a dialog listing what the extension can do, Debugger among the entries. That
   permission is what lets one layer inspect requests on the sites that need it. Click Add
   extension.
4. The card appears. Pin the toolbar icon if you want the counter in view.

The installer then waits, and once the card is showing you press Enter and it opens YouTube for
you. What to look for there: the toolbar icon counts up as ads are stopped, DevTools
(Cmd+Option+J, or Ctrl+Shift+J) shows `[yt-ad-zapper]` lines, and a bar under the address bar
reads "Ad Zapper started debugging this browser" on the sites where the deep block attaches. That
bar is the debugger permission in action, and it clears itself.

After editing any file, hit the reload button on the extension card.

## What it does

Seven layers, each covering what the one below cannot.

1. **Player response scrubbing** (`src/inject.js`). Runs in the page's own JS context at
   `document_start`, before YouTube's scripts. Deletes the ad fields (`adPlacements`, `adSlots`,
   `playerAds`, `adBreakHeartbeatParams`) from every player response: the inline
   `ytInitialPlayerResponse`, anything the page parses with `JSON.parse`, and responses from
   `/youtubei/v1/player`, `/get_watch` and the shorts sequence endpoint. The player never learns
   an ad break exists, so no break is scheduled.
2. **Filter lists, matched by Chrome** (`rules/dnr_*.json`). 213,898 network rules converted from
   EasyList, EasyPrivacy, uBO's list and three host-level lists (AdGuard's DNS filter, d3Host, and
   one small hand-written file) into static declarativeNetRequest rulesets, so the breadth of the
   lists applies to every request on every page with no debugger cost in the extension. The
   hand-written file, `tools/lists/curated-rules.txt`, lists each of its four rules with what it
   is for; nothing in it is scoped to any particular site. See **Breadth** below for what the
   conversion can and cannot express.

   Element hiding is split the same way: the lists' per-site cosmetic rules are injected per host
   by the worker, and `src/generic-cosmetic.css` carries 13,680 generic selectors to every http(s)
   page without needing an attach, so the rules that in the lists are not scoped to a site apply
   everywhere, the way uBO applies them.

   **Scriptlets** (`src/scriptlet-map.js` + `src/scriptlets.js`) are the page-world half. The map
   is generated from the lists' `##+js(...)` filters: 3,471 calls across 2,431 hosts. The relay in
   each frame reads the map for its own host, and the worker runs the calls in the page's world
   through `chrome.scripting`, so page CSP cannot refuse them. A name with no implementation is
   never in the map: the build counts it and prints it (423 calls today, mostly uBO's `trusted-*`
   family, which exists to be trusted with privileges this extension does not hand out).
3. **Learned hosts and the hand-written rules** (`rules.json`). Static rules cover YouTube's ad
   beacons, DoubleClick and the popunder loader network. Every host the popup killer catches in
   the wild is added as a dynamic rule, so it is blocked in Chrome itself on every site from then
   on. The cap comes from the platform (5,000 dynamic rules guaranteed, 30,000 on Chrome 121+);
   when it is full the host with fewest catches is evicted, so hosts that keep returning stay
   blocked and one-hit junk falls off.
4. **Popup killer** (`src/popups.js`, `src/popup-hosts.js`, `src/relay.js`). Popunders do not
   use the top window's `window.open`: they open windows from a hidden iframe and write the ad
   into a blank window, so they are caught by their shape instead of their URL. The module vetoes
   listed hosts, popups opened from hidden frames (visible-box check), popups with no live user
   activation, and everything on a page already flagged as an ad page. It also removes the
   transparent full-page click-catcher these scripts install, the "disable your popup blocker"
   blackmail screen, and refuses `<script>` tags disguised as `.css` loaders. The 2,738-host list
   ships as one packed string plus a Bloom filter, because this script runs in every frame.
5. **Element hiding** (`src/relay.js` asks, `src/background.js` answers). Every frame reports its
   URL and gets back the CSS its page should hide, computed by the vendored engine from the
   cosmetic rules of the lists. Answers are cached per host in the worker, including the negative
   answers, so a page with no rules costs one lookup ever.
6. **Deep block** (`src/deepblock.js` + the vendored engine). The DevTools network stack
   (`chrome.debugger`) on the tabs that need it: every request stops in the worker first and the
   filter engine answers from 113k network filters. This is the only way to get per-request
   judgement beyond what DNR can express, and it is automatic. On attached tabs it also rewrites
   responses before the page sees them: ad `<script>` tags removed from HTML (`##^` rules), ad JSON
   and ad-config flags neutralized (`$replace` rules extracted from the lists into
   `engine/dist/replace-rules.json`, since the engine library parses those filters and never acts
   on them), and tracking parameters stripped from URLs (`removeparam`).
7. **List upkeep** (`src/lists.js`). The engine would otherwise age into uselessness. Once a day
   the worker fetches EasyList, EasyPrivacy and uBO's list, compiles them, and only caches the
   result if it blocks a known ad URL and still allows a known clean one. The compiled brain goes
   to IndexedDB and is preferred over the shipped one at boot. A set that fails the check is
   dropped and the previous brain is loaded back, so a bad refresh can never leave the extension
   without a working engine. The popup has **Update filter lists** for doing it by hand.

## The switch

One switch, top right of the panel, and it means off:

- Chrome's matching stops. All five static rulesets are disabled through `updateEnabledRulesets`,
  and the dynamic rules learned from this browser are removed. They stay in storage and are put
  back on the way in.
- The deep block is forced to `off` and every attached tab is detached.
- Element hiding answers nothing, so no CSS is injected anywhere.
- The in-page layers follow through `chrome.storage.onChanged`: `src/relay.js` re-posts the config,
  the popup killer disarms, the YouTube interceptor stops pruning, and the wall guard stands down.
  A page that is already open follows without a reload.
- The toolbar badge reads `off`, because a blank badge would look like a blocker that is working
  and has simply seen nothing.

Nothing is thrown away while it is off: the learned hosts, the pinned sites and the settings all
stay in storage. The flag lives in `settings.enabled`, so a worker that wakes up while the switch
is off disables the rulesets on boot rather than trusting the manifest default.

## Breadth: the DNR rulesets

The lists only reached a page once the deep block had attached to it, which meant a tracker script
on a page nobody had flagged ran untouched. `tools/build-dnr.mjs` converts the same lists into
rules Chrome matches itself, and the manifest ships them as rulesets.

| | |
| --- | --- |
| Filter lines read | 313,101 across four sources |
| Rules written | 214,226 across 8 rulesets, all under the 30,000 cap |
| Room left | Chrome allows 50 rulesets and 330,000 rules in total: 8 and 214,226 used |
| Skipped: cosmetic and HTML | handled by the injection and response layers |
| Skipped: duplicates | 77,903 (the four sources overlap heavily) |

The fourth source is AdGuard's DNS filter, and it is the one that changed the shape of the
coverage. EasyList and EasyPrivacy mostly block by path and resource type, so a host like
`iadsdk.apple.com` or `data.mistat.xiaomi.com` stays reachable at any path nobody wrote a rule for.
A DNS-class list blocks the whole host, which is what a request to a telemetry endpoint looks like
in practice. It is also the most aggressive thing in this extension: whole-host blocks can break a
site that a path-scoped rule would not, which is what the switch in the panel is for.
| Skipped: `$popup` | 2,946 (Chrome cannot block popups this way; the MAIN-world killer does) |
| Skipped: regex filters | 1,662 (a capped rule type, easy to get wrong) |
| Skipped: `$redirect`, `$csp`, `$ghide`, `$removeparam`, `$replace`, `$denyallow` | 462 |
| Skipped: unparseable options, too generic, empty | 69 |

The conversion is conservative on purpose: a blocking rule that means something other than the
filter it came from breaks a site silently. Anything whose meaning cannot be expressed exactly is
dropped instead of approximated, and `test/dnr.test.js` holds the line: it validates every rule
against Chrome's accepted shape, then runs a model of Chrome's `urlFilter` matcher (the `||`, `|`,
`^` and `*` anchors, resource types, `domainType`, `initiatorDomains`) over a fixed acceptance list.
That list is the adblock-tester.com scoring page's own assets, because those are the eleven checks
where the score comes from: all eight tracker and error-monitoring scripts plus the three banner
images are blocked by a rule, and the model is not allowed to block the test page itself, Google
Fonts, a plain document, an ordinary script or a first-party XHR.

Three honest limits. The model is a model, and the rules only get their real proof in a browser.
Regex and popup filters are simply not represented, so a page that relies on those still needs the
deep block. And 110k rules is a real amount of work for Chrome to match, in the same league as
uBOL's rulesets; if page loads ever feel slower, `chrome://extensions` can disable a ruleset by
hand without touching anything else.

## Deep block, and the banner

Attaching the debugger shows Chrome's "started debugging this browser" banner on that tab and
adds a round trip per request, so it is automatic but not unconditional.

| Mode | Behaviour |
| --- | --- |
| `smart` (default) | Attach when the tab's host has form (this extension caught it before, or it has popups on record), when the site has response rules, or the moment a page reports ad machinery. Detach after five idle minutes. |
| `always` | Attach to every http(s) tab. |
| `off` | Never attach; every other layer keeps working. |

The popup has the controls: **Deep block this site** pins a host so its tabs always attach (and
unpinning detaches), and the **Smart / Always / Off** switch sets the mode for the whole browser.

At most four tabs are attached at once. When a fifth wants in, the least recently used session is
dropped rather than the new page being refused. Non-http pages are skipped and a refused attach is
not retried for a minute.

## Memory, and what it costs

Every cache here has a cap and an eviction path, and the engine is treated as something to hold
only while it is being used. The DNR rulesets cost the extension nothing: Chrome holds them.

| Thing | Cost | Bound |
| --- | --- | --- |
| Popup host list (per frame) | 0.042 MB, was 0.133 MB as an array and a Set | one packed string, 43 KB |
| Host lookup in the killer | 0.84 µs, was 50 µs scanning the string | Bloom filter first (16 bits per host, 0 false negatives over all 2,738) |
| Brain while live (Node measurement) | 12.6 MB: the 4.3 MB binary plus deserialized tables and caches | unloaded after 10 idle minutes with nothing attached; back in ~59 ms |
| Filter decision | ~7 µs per request | 113,199 network filters |
| Hiding CSS cache | 400 hosts or 2 MB, whichever comes first | least recently used first out, negative answers included |
| Site registry | 1,500 hosts | oldest seen dropped first |
| Response rewriting | 60 bodies or 32 MB per tab per minute | past the budget the page is released untouched |
| Per-tab meters and budgets | one entry per tab | deleted when the tab closes |

The popup shows the worker's own heap (`performance.memory`) when Chrome reports it, plus whether
the engine is loaded or parked, so the numbers are visible instead of implied.

One browser rule shapes all of this. Chrome only allows `importScripts()` during the worker's
initial evaluation, so the engine bundle is pulled in at boot and only the 4.3 MB brain stays lazy
and parkable. A late `importScripts()` throws in the browser while a node sandbox allows it, which
is how that bug survived a full green test run: see `test/worker-scope.test.js`, which now makes
the fake throw the moment initial evaluation is over.

Sites with response rules attach on sight. Answering an ad-block wall needs the response stage, and
waiting for a pin means the reader meets the wall first, so the deep block reads the rule set's

hosts out of the engine and attaches as soon as one of them loads. bild.de is the worked example:
its gate hangs off an inline `onload` handler on the `html-load.com` loader, and when that loader's
handshake fails the handler empties the body and redirects to `/adblockwall.html`. uBO fixes it on
Firefox only, behind `cap_html_filtering`, because the fix needs response-body filtering. Here the
rule strips the handler and flips the page's own `adBlockWallEnabled` flag, both before render.

The response stage is not the only layer, because a detector that stops talking to the network does
not stop looking. It leaves a record of what it found (a timestamped marker in storage, sometimes a
cookie) and the page reads that record back a beat later to decide whether to render its wall. Two
scripts answer that, both gated on the same generated host list so a frame on any other site pays
one substring test:

- `src/wall-main.js` runs in the page's own world at `document_start`, before page script, and stops
  the record from existing: marker-shaped keys are dropped on `setItem` and answer `null` on
  `getItem`, marker-named cookies are dropped on write, both on `localStorage`, `sessionStorage` and
  `document.cookie`. The patched functions carry a native-looking `toString`. Everything not
  marker-shaped behaves exactly as written.
- The deep block also refuses the jump, at the layer the page cannot reach around. The page-world
  wrappers cover `location.replace`, `location.assign`, `location.href` and the history methods, but
  `window.location = url` is unforgeable and cannot be wrapped, and a server 302 cannot be argued
  with at all. For an attached tab, a wall or report document is answered with a 302 back to the site
  root before it loads, capped at five refusals per tab so a site that redirects straight back
  cannot spin the reader faster than they can see. The detector's own reporting endpoint
  (`error-report.com`) is answered with an empty 204 instead of being blocked: a blocked beacon is
  itself a reading the page can take, while an accepted-and-discarded report is indistinguishable
  from a report that landed.
- The same file refuses the jump itself. Measured on bild.de: the front page renders clean, the
  loader's handshake fails, and page script injects a handler at runtime that navigates to
  `/adblockwall.html`. That handler is not in the served HTML, so response rewriting cannot catch it
  (`redirectCount` stays 0: it is a client-side jump, not a server redirect). `location.replace`,
  `location.assign`, the `href` setter and `history.replaceState`/`pushState` are wrapped in the page
  world: a target that is a wall path is dropped, every other target passes through untouched. This
  is the layer that ends the wall; the record-keeping patch above only stops the site from
  remembering.
- `src/wall-guard.js` runs in the isolated world and does the rest: it clears records the detector
  already left behind, removes a wall element that got rendered anyway (matched by class name and by
  the wall's own copy, and only if it is positioned over the page, a dialog, or taller than half the
  viewport, so an article that merely mentions ad blockers is untouched), releases the scroll lock
  such an overlay leaves behind, and bounces a landing on a wall page back to the article the reader
  came from (`document.referrer`, same host, never a wall path) and to the site root otherwise. Three
  consecutive landings get three bounces and then the guard stops, because a reader in a redirect
  loop is worse off than one looking at a wall with a back button; reaching any normal page resets
  the count. Its watcher is throttled, capped at 60 scans, and then torn down with its observer and
  timer.

## What it learns

Every site gets a record: visits, popups caught there, ads attributed to it. One caught popup or
three ads makes a site **hot**, and hot sites attach on sight without waiting for a signal. Four
clean visits in a row marks a site quiet, and quiet sites skip the attach check entirely. Reset
clears the registry; it does not throw away the downloaded lists.

A tab whose engine work turns pathological (p95 above 4 ms over 40 samples) loses its session and
its host gets a 30 minute cooldown, so filtering cannot quietly slow the browser down. Detaching
mid-request is safe: that request still gets its reply.

## The counter

The toolbar badge shows the all-time YouTube ad total; click the icon for the full picture.

- **ads blocked** counts ad entries removed from player responses. A two-ad pre-roll counts as 2.
- **videos cleaned** counts how many videos had ads removed.
- **popup ads killed** counts popup machinery stopped: popups, invisible overlays, loader scripts.
- **hosts blocked site-wide** counts learned hosts now blocked at the network layer by Chrome.
- **this site** shows what the extension remembers about the page you are on.
- **Deep block** shows the state for the tab you are looking at, and its blocked count there.
- The bottom line reports the engine (loaded or parked), the list age, and the hiding cache.
- **Reset count** zeroes the tallies, forgets every learned host and clears the site registry.

Numbers live in `chrome.storage.local`, so they are per browser profile and survive restarts.

## Checking it works

Open DevTools on a tab. YouTube pages log `[yt-ad-zapper]` lines (`interceptor armed`, then
`blocked N ads on <videoId>`). Any page logs `[yt-ad-zapper] popup killer armed: <n> hosts,
<bytes> bytes, filter=<bits>`, then `popup blocked:` lines. A deep-blocked tab logs
`[ad-zapper:deep] engine ready <counts> from <shipped|refreshed>`, then `attached <tab> <host>`,
`detached <tab> expensive` if the cost guard fired, or `engine unloaded while idle` when the brain
is parked. Silence means the content script or the worker did not run; `chrome://extensions` shows
load errors on the card.

The DNR rules are the one layer with no console output, because the extension is not involved in
serving them. `chrome://extensions` lists the rulesets on the card, and disabling one there is the
quickest way to tell whether a site break is coming from the lists.

## Tests

```
node test/worker-scope.test.js  # all worker scripts in one scope, real engine, real brain
node test/dnr.test.js           # DNR rulesets: structure, and a model of Chrome's matcher
node test/smoke.js              # YouTube interceptor: hooks, scrubbing, counting
node test/popups.test.js        # popup killer: hidden frames, overlays, loaders, packed list
node test/deepblock.test.js     # deep block: attach rules, LRU cap, cost guard, rewriting
node test/background.test.js    # worker: tallies, badge, escalation, eviction, reset
node test/smart.test.js         # caches with caps, cost meter, site registry
node test/lists.test.js         # list refresh: compile, spot check, cache, restore on failure
node test/popup.test.js         # popup: render, empty state, reset
node test/popup-deep.test.js    # popup: deep-block state, pin, mode switch
node test/probe.test.js         # CDP probe helpers
node test/engine-bundle.test.js # vendored engine: decide, cosmetics, HTML and $replace rules
node test/wall-guard.test.js    # wall guard: host list, marker clearing, one bounce, the switch
node test/wall-switch.test.js   # wall switch and standing guard against fakes: key drop, overlay removal, teardown
node test/scriptlets.test.js    # scriptlets: generated map, each implementation, the two callers
```

All of them run under plain node with fake `chrome`/DOM objects and never touch a browser. The
suite that matters most is `worker-scope.test.js`: it loads every worker script into one context
the way `importScripts` does, with the real 4.3 MB brain, drives real messages through it, and
makes its fake `importScripts` throw the moment initial evaluation ends, because Chrome does. It
exists because two scripts declaring the same top-level `const` is a load-time SyntaxError that
takes the whole extension down, and because a lazy `importScripts` looks fine in node and silently
kills the engine in Chrome. Nothing else would have caught either.

Refresh the filter lists and rebuild everything derived from them:

```
node tools/fetch-lists.mjs && node tools/check-engine.mjs   # parses lists, writes engine/dist/engine.bin
node tools/build-replace-rules.mjs                           # extracts $replace rules for the worker
node tools/build-engine.mjs                                  # rebuilds engine/dist/engine.bundle.js
node tools/build-dnr.mjs                                     # rebuilds rules/dnr_*.json for Chrome
node tools/build-popup-list.mjs                              # regenerates src/popup-hosts.js
node tools/build-cosmetic-css.mjs                            # regenerates src/generic-cosmetic.css
node tools/build-scriptlets.mjs                              # regenerates src/scriptlet-map.js
python3 tools/make-icons.py                                  # redraws icons/
```

## Known gaps

- Server-stitched ads in live streams cannot be cleaned by any extension, and neither can ads
  baked into a video's own bytes.
- Scriptlets cover the names this build implements, not uBO's whole set. Missing: `trusted-*`,
  the `rpnt`/`rmnt` node-text rewrites, the timer boosters and `nowebrtc`, 423 calls in total, all
  named in the build log. A wall that checks for one of those effects is still fought by the
  network rules, the response rewriting and the popup killer only.
- Scriptlet calls are made from the frame once the document exists, which is early but not as
  early as a content script declared in the manifest: a page whose first inline script reads the
  property a scriptlet was meant to defuse can win the race.
- DNR cannot block popups, cannot use regex filters, and cannot modify a response; those three
  classes stay with the deep block and the MAIN-world killer.
- Switching off stops Chrome's matching and the debugger immediately, but hiding CSS that has
  already been injected into an open page stays until that page is reloaded.
- Deep block covers attached tabs only. Smart mode attaches where there is evidence, which means a
  brand-new ad page can get one ad through before the page reports its machinery.
- The attach for a site with response rules happens on `chrome.webNavigation.onBeforeNavigate`,
  which is before the document request exists, but everything else still waits for evidence: a
  brand-new ad host that is not on a list and does not touch the popup killer is attached only
  after its first ad appears.

## What the test pages say, and what the numbers are worth

Read off the live pages in the user's own browser, not simulated:

| Test | Result |
| --- | --- |
| adblock-tester.com | 100 / 100 (11 services, 22 checks), which is the tester's own ceiling |
| Toolz (d3ward) adblock test | 117 / 135 measured before the host-level lists went in; 14 of the 18 open checks were host probes, and the other four are the checks described below |

The last four checks on Toolz are not host probes. Two are ad containers, one static and one
inserted after load, and two are fake ad scripts the page loads itself (`pagead.js` and a widget
named `ads.js`). The author of that test reaches 135/135 with rules scoped to the test's own page,
which is what his published d3Host adblock file carries: `*$3p,domain=d3ward.github.io`,
`/pagead.js$domain=d3ward.github.io` and `d3ward.github.io##.textads`. Rules that only work on the
page doing the measuring measure nothing, so this build does not use them, and none of the 14 host
probes were satisfied that way either: they come from d3Host's host entries, which Blokada and OISD
also ship, and which are ordinary ad, analytics and telemetry endpoints.

The same four checks are answered here with global rules instead, in
`tools/lists/curated-rules.txt` (two ad script path patterns) and `src/generic-cosmetic.css` (two
ad container class names). Those are the broadest rules in the build, they exist because those
checks exercise them, and they are documented as such rather than hidden in a list.
- The `debugger` permission is why this build would not pass Chrome Web Store review, and the
  CDP attach is detectable by page scripts that look for it.
- Only one person has run this in a real browser. Everything in the test suites is Node with
  fakes; the hiding injection, the IndexedDB cache, the alarms, the DNR rules as Chrome matches
  them, and the response rewriting have never been exercised by a real Chrome.
- The extension itself has no update channel. `tools/fetch-lists.mjs` is how the *brain* gets new
  lists, and the worker's own refresh does it daily once installed.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest (Chrome 111+ for MAIN world content scripts) |
| `rules.json` | hand-written static declarativeNetRequest rules |
| `rules/dnr_*.json` | generated declarativeNetRequest rulesets from the filter lists |
| `src/inject.js` | page-world YouTube interceptor |
| `src/content.js` | YouTube watchdog (skips, fast-forward, wall removal) and counter bridge |
| `src/popups.js` | page-world popup killer, every http(s) frame |
| `src/popup-hosts.js` | generated popup host blocklist, packed, with its Bloom filter |
| `src/relay.js` | isolated-world bridge: config down, reports up, hiding CSS in |
| `src/wall-guard.js` | in-page wall defense: clears stored markers, removes a rendered wall, releases the scroll lock, bounces wall pages |
| `src/wall-main.js` | page-world switch: marker-shaped keys and cookies cannot be written |
| `src/wall-hosts.js` | generated list of the hosts with response rules |
| `src/deepblock.js` | automatic CDP attachment, request interception, response rewriting |
| `src/smart.js` | caches with budgets, rolling cost meter, site registry |
| `src/lists.js` | list refresh: fetch, compile, spot check, cache, restore |
| `src/background.js` | service worker: tallies, badge, escalation, hiding, upkeep, routing |
| `src/cosmetic.css` | YouTube element hiding |
| `popup.html` / `popup.js` | popup: master switch, tallies, deep-block control, list update, reset |
| `engine/` | vendored filter engine (`@ghostery/adblocker`), its brain, and the replace rules |
| `tools/` | list fetching, engine build, DNR conversion, replace rules, popup list, icons |
| `install/` | one-command setup for macOS and Windows |
| `probe/` | separate unpacked extension that measures CDP viability |
| `test/` | node test suites for every layer |

## Credits, and the license

This repository is MIT licensed. See `LICENSE`.

Two things in here are other people's work. The filter lists come from EasyList, EasyPrivacy, the
uBlock Origin filters and three host-level lists, fetched and compiled by `tools/`; those projects
keep their own terms, and so do the rule sets built from them. The filter engine is
`@ghostery/adblocker` (MPL-2.0), vendored into `engine/dist` so the extension loads without a build
step. Everything else, including the scriptlets, the wall defense and the probe, is written for
this extension.