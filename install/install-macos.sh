#!/usr/bin/env bash
#
# Walks you from a cloned folder to a loaded extension in Chrome: checks the
# checkout, opens chrome://extensions with the folder path on your clipboard,
# waits while you click Load unpacked, then opens a page and says what to look
# for, including the debugger bar.
#
# Usage:  ./install/install-macos.sh [--dry-run]
#
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '%s\n' "$*"; }

say "Ad Zapper installer"
say ""

# 1. Chrome
CHROME="/Applications/Google Chrome.app"
if [[ ! -d "$CHROME" ]]; then
  if [[ $DRY -eq 1 ]]; then
    say "1/3  Chrome is not in /Applications (fine for a dry run)."
  else
    say "1/3  Chrome is not in /Applications."
    say "Install Google Chrome first, or load the folder by hand: chrome://extensions,"
    say "Developer mode, Load unpacked, then pick:"
    say "  $ROOT"
    exit 1
  fi
else
  say "1/3  Chrome found."
fi

# 2. The folder has to be a working extension
missing=0
for f in manifest.json rules/dnr_1.json src/background.js; do
  [[ -f "$ROOT/$f" ]] || { say "missing $f"; missing=1; }
done
if [[ $missing -eq 1 ]]; then
  say "This is not a full checkout of the repository. Clone or download it again, then rerun."
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  python3 - "$ROOT" <<'PY' || { say "a file failed to parse, the checkout is damaged"; exit 1; }
import glob, json, sys
root = sys.argv[1]
json.load(open(root + "/manifest.json"))
files = glob.glob(root + "/rules/*.json")
for path in files:
    json.load(open(path))
print("2/3  manifest and %d rule sets parse." % len(files))
PY
else
  say "2/3  python3 is not installed, so the file check is skipped."
fi

# 3. Clipboard, then the extension page
if [[ $DRY -eq 1 ]]; then
  say "3/3  dry run: clipboard and browser left alone."
  say ""
  say "Would have opened chrome://extensions with this path on the clipboard:"
  say "  $ROOT"
  exit 0
fi

printf '%s' "$ROOT" | pbcopy
open -a "Google Chrome" "chrome://extensions" 2>/dev/null || open -a "Google Chrome" || true
say "3/3  chrome://extensions is open, and the folder path is on your clipboard."
say ""
say "In Chrome, four steps:"
say "  1. Developer mode, the toggle at the top right."
say "  2. Load unpacked, top left. The file dialog opens: press Cmd+Shift+G, paste"
say "     (Cmd+V), and press Open."
say "  3. Chrome shows a dialog listing what the extension can do, Debugger among the"
say "     entries. That permission is what lets one layer inspect requests on the sites"
say "     that need it. Click Add extension."
say "  4. The card appears. Pin the toolbar icon if you want the counter in view."
say ""
if [[ -t 0 ]]; then
  say "Press Enter once the card is showing, and this opens a page to test it on."
  read -r _ || true
  open -a "Google Chrome" "https://www.youtube.com/" || true
  say ""
  say "Chrome is on YouTube. What to look for:"
  say "  - the toolbar icon counts up once ads are stopped."
  say "  - a bar under the address bar reading \"Ad Zapper started debugging this browser\"."
  say "    That is the deep block attaching. It only shows on sites that need it, and it"
  say "    goes away on its own."
  say "  - DevTools (Cmd+Option+J) shows [yt-ad-zapper] lines on YouTube and [ad-zapper:deep]"
  say "    lines anywhere the deep block attached."
else
  say "Run it again in a terminal to get the test page and the debugger bar explained."
fi
