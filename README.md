# Ad Zapper

An ad blocker for Chrome. It blocks ads and trackers on every page, takes the ads out of YouTube
videos, kills popup windows, hides empty ad slots, and removes the "turn off your ad blocker"
screens that some sites put in front of the article.

Nothing to sign up for. No account, no telemetry, nothing sent anywhere. MIT licensed.

![tests](https://github.com/sloemo01/ad-zapper/actions/workflows/ci.yml/badge.svg)

## Video

![Ad Zapper taking ads off a page](docs/ad-zapper.gif)

The whole walkthrough, four minutes: [watch it](https://github.com/sloemo01/ad-zapper/blob/main/docs/ad-zapper-walkthrough.mp4). The rest of this file covers the same ground in writing.

## Install

You need Chrome, on a Mac or a PC. Nothing else: no Git, no developer tools, no build step.

Open Terminal on macOS or PowerShell on Windows, paste the line for your computer, press Enter.
The script prepares everything around the one step Chrome will not let any program do for you.

**macOS**

```
curl -fsSL https://cdn.jsdelivr.net/gh/sloemo01/ad-zapper@main/install/install-macos.sh -o /tmp/ad-zapper.sh
bash /tmp/ad-zapper.sh
```

**Windows**

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/sloemo01/ad-zapper/main/install/install-windows.ps1 -OutFile $env:TEMP\ad-zapper.ps1; & $env:TEMP\ad-zapper.ps1"
```

On Windows there is also `install\install-windows.cmd` for double-clicking if you already have the
folder.

### What the script does

It downloads the extension into a folder that stays put (`~/Downloads/Ad Zapper` on macOS,
`%USERPROFILE%\Downloads\Ad Zapper` on Windows), checks that every file is there and that the filter files
parse, copies the folder path to your clipboard, and opens Chrome's extension page. Chrome then
needs four clicks from you:

1. Turn on **Developer mode**, the switch at the top right.
2. Click **Load unpacked**, top left. In the file dialog press Cmd+Shift+G on macOS or Ctrl+V on
   Windows, paste, and press Open.
3. Chrome lists the permissions it wants, **Debugger** among them. That one is what lets a layer
   inspect requests on the sites that need it. Click **Add extension**.
4. The card appears in the list. Pin the toolbar icon if you want the counter in view.

Press Enter in the terminal after that and it opens YouTube so you can watch the counter move.

### Updating

Chrome only auto-updates extensions that came from the Web Store, and this one is not listed there,
so updates are asked for rather than pushed. The button at the bottom of the popup does the asking:
it checks GitHub on the spot (a few hundred bytes) and, when there is something newer, installs it in
that same click. The extension then reloads itself into the new version in the background: no
extension page to visit, no arrow to click, and open tabs keep working. The new build's page scripts
take over on the next page load.

Chrome does not let an extension write files, so it cannot replace its own folder by itself. The
installer therefore registers a small helper on the machine (a native messaging host) that can, and
the button talks to it. If the helper is not registered, the button copies the one command instead,
and the update is a paste and an Enter. To register or remove the helper by hand:

    bash install/native-host/register-macos.sh              # register
    bash install/native-host/register-macos.sh --remove     # unregister

On Windows it is `install\native-host\register-windows.ps1`, with `-Remove` to take it back out.

The button is the only thing that checks. Nothing in this extension runs on a timer, and no request
leaves it unless you clicked, which also means no update message will ever appear on its own. What
does happen without being asked is local: when the background worker next starts, it reads the
version marker in its own folder, and if the installer has put a newer version there it reloads into
it. That is why there is no reload arrow to click after the paste.

That command runs the installer's `--update-only` path, which asks for the version first and only
downloads the archive when it is genuinely newer. Running the installer normally does the same thing
as part of its four steps.

### Two things that look alarming and are not

A bar under the address bar on some sites, reading "Ad Zapper started debugging this browser". That
is the Debugger permission doing its job on the sites that need per-request handling. It belongs to
that one tab, it clears itself, and nothing about your traffic is recorded or sent anywhere.

Chrome's warning that the extension can read and change your data on all websites. An ad blocker
has to see the requests a page makes, and it works on every site by definition. If you would rather
check than trust, all of the code is in this repository.

### What you should see

The toolbar icon counts up as ads are stopped. Open the popup for the page you are on: ads blocked,
videos cleaned, popup ads killed, hosts blocked site-wide, what this extension remembers about the
site, and the state of the deep block for that tab. On YouTube, DevTools (Cmd+Option+J, or
Ctrl+Shift+J) prints `[yt-ad-zapper]` lines as ad fields get stripped.

### Turning it off, and taking it out

The switch at the top right of the popup, and off means off: Chrome's matching stops, all ten
rulesets are disabled, the deep block detaches from every tab, and no CSS is injected anywhere.
Flip it back and all of it returns.

To remove the extension: **Remove** on its card in `chrome://extensions`, then delete the folder the
script created.

### If something goes wrong

The installer prints its revision on the second line, so you can always tell which copy ran. If it
stops saying "missing manifest.json", the download did not finish; run the same command again.
Piping straight into `bash` works too, but stdin is the script then, so the pause before the test
page does nothing.

GitHub sometimes serves a cached copy of the script for a few minutes after a change, which is why
the macOS line above points at jsDelivr. Whichever copy you get, the extension itself is always
fetched fresh from the repository, so you get the newest version.

### Why it is not in the Chrome Web Store

Because nobody has submitted it. It is built to be loaded unpacked from a folder you own, which is
what those four clicks are for.

The Debugger permission is not the obstacle, and this README said it was until it was pointed out
that Google's own documentation says otherwise. `chrome.debugger` is one of the documented
exceptions to the no-remote-code rule (developer.chrome.com, "Deal with remote hosted code
violations", section "Is there any workaround?"), allowed precisely because it cannot hide:

> While it is being used, the user will see a warning bar at the top of the window. If the banner is
> closed or dismissed, the debugging session will be terminated.

Extensions that use it are on the store today. What the permission does cost is that banner, on the
tab, whenever a session is open, and that is a real cost on a site you visit often. Only two things
here use it (response rewriting on walled hosts, and per-request handling), and both are skipped on
everything else.

## How it works

Everything below this line is the technical detail: the seven layers, the filter lists, the memory
cost, and the places where this cannot help. Skip it if you only want the ads gone.

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

- Chrome's matching stops. All ten rulesets are disabled through `updateEnabledRulesets`,
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

### Detecting ads instead of remembering them

The registry above only knows the sites you have visited. `src/detect.js` looks at the page in front
of it, on the first visit, through `chrome.scripting`: the third-party hosts the page actually
loaded, and the elements shaped like ad slots (named like one, or sized like one *and* named or
served from ad plumbing; a standard 300x250 the size of an ad on its own is not enough).

A host that is named like ad plumbing, or that turns up on three different sites, goes through the
same escalation gate the popup catcher uses, so it is blocked everywhere rather than on the site
that revealed it. An element selector is generalised first, with the numbers and hashes stripped
out (`div-gpt-ad-1234-0` becomes `div[id^="div-gpt-ad"]`), and it only joins the hiding sheet once
two different sites have produced it. One site's guess never hides anything on another site.

Both memories are capped (800 hosts, 200 selectors) and both are visible: the popup reports what it
found, the probe carries the list, and Reset empties them.

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
- The `debugger` permission is allowed by policy (a documented exception, see above), and the
  attach is still detectable by page scripts that look for CDP, with the banner as the visible
  part of it.
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
| `src/update.js` | the updater: checks GitHub for a newer version, gives the popup's update button its command, reads the version marker the installer writes into the folder, and reloads the extension into that version once, recording a version it could not load as stuck instead of retrying forever |
| `src/detect.js` | the generic ad detector: third-party hosts and ad-shaped elements on pages the registry has never seen, generalised into blocked hosts and hiding selectors |

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