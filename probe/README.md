# CDP probe

Stage 0 of the "break the limits" plan. Before we build anything on `chrome.debugger`,
we measure whether intercepting every request through it is livable.

## What it does

- Attaches the debugger to one tab and turns on the CDP `Fetch` domain, so every
  request pauses and gets released by the extension service worker.
- Measures the worker-side handling time per request (mean, p50, p95, max) and
  counts requests by resource type.
- Optional: enforce a small blocklist (`Fetch.failRequest`) to prove blocking works.
- Optional: intercept `Document` responses and rewrite the HTML body before the
  page sees it, replacing the page title with `CDP-REWRITE-OK`. That body
  rewriting is the exact power MV3 deleted, and it is beyond what MV2
  `webRequest` offered on Chrome.
- Tracks page load time for the target tab, so the attached load can be compared
  against an unattached baseline.
- Counts service-worker boots, so a restart mid-run is visible instead of silent.

## How to run it

1. `chrome://extensions` -> Developer mode -> Load unpacked -> this `probe/` folder.
2. Click the toolbar icon (puzzle piece menu) to open the probe page.
3. Reload the target tab once so there is a baseline load number.
4. Pick the tab, tick what you want, `Attach & start`, then reload the target tab
   and scroll for twenty or thirty seconds.
5. `Stop & detach` and read the numbers.

## How to read the numbers

- **handling p95** is the worker's own per-request cost. Under about 5 ms is fine.
  Anything above roughly 20 ms makes every page feel heavy.
- **worker boots** should stay at 1 through a run. If it climbs, the service
  worker is being killed mid-interception, which is itself a finding.
- **attached load** vs **baseline**: within about 20% is livable. Multiple times
  slower means this door is a science project, not a daily driver.
- Any `attach failed` message about another debugger means DevTools or another
  tool already owns that tab.

## Cautions

- The target tab shows a "started debugging this browser" banner while attached.
- DevTools cannot attach to the target tab at the same time.
- The probe only ever attaches to one tab, always detaches on Stop, and
  auto-detaches if interception errors pile up.
