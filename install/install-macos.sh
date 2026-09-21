#!/usr/bin/env bash
#
# Puts Ad Zapper in front of you in Chrome, with the folder path on the
# clipboard so "Load unpacked" is one paste away. Everything it can check, it
# checks first; the two clicks Chrome requires are the only manual part.
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
  say "This is not a full checkout of the repository. Download or clone it again, then rerun."
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

# 3. Clipboard and browser
if [[ $DRY -eq 1 ]]; then
  say "3/3  dry run: clipboard and browser left alone."
else
  printf '%s' "$ROOT" | pbcopy
  open -a "Google Chrome" "chrome://extensions" 2>/dev/null || open -a "Google Chrome" || true
  say "3/3  the folder path is on your clipboard and chrome://extensions is open."
fi

say ""
say "Three clicks left, in Chrome:"
say "  1. Turn on Developer mode, top right."
say "  2. Click Load unpacked, then paste the path (Cmd+V) and press Open."
say "  3. Open any site and check the counter on the toolbar icon."
say ""
say "Chrome asks about the debugger permission. One layer of the extension uses it on"
say "the sites that need it; declining costs only that layer."
