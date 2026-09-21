#!/usr/bin/env bash
#
# Gets Chrome to a loaded Ad Zapper, from a clone or from nothing.
#
# Inside a checkout it uses that folder. Anywhere else (a downloaded copy, or a
# fresh machine) it fetches the newest main from GitHub into a permanent folder
# and installs from there. Then it opens chrome://extensions with the folder
# path on your clipboard, waits while you click Load unpacked, and opens a page
# to check it on.
#
# Usage:
#   ./install/install-macos.sh                 # install, from a clone or by download
#   ./install/install-macos.sh --download      # force a fresh download
#   ./install/install-macos.sh --download-only # fetch and check it, stop before Chrome
#   ./install/install-macos.sh --dry-run       # report only, no downloads, no browser
#
# AD_ZAPPER_DIR overrides where the downloaded copy lives.
#
set -euo pipefail

REPO="sloemo01/ad-zapper"
REF="main"
REV="installer rev 3, 2026-09-22"
TARGET="${AD_ZAPPER_DIR:-$HOME/Applications/Ad Zapper}"

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry" ;;
    --download) MODE="download" ;;
    --download-only) MODE="download-only" ;;
    --update-only) MODE="update-only" ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

say "Ad Zapper installer"

# --update-only is what the background job runs: fetch the newest source, compare
# it with what is installed, swap only when it is newer, and leave a marker file
# in the folder saying which version is now there. The extension reads that marker
# and reloads itself into it. Chrome is never touched by this path.
if [[ $MODE == "update-only" ]]; then
  command -v curl >/dev/null 2>&1 || { say "curl is not installed, and this needs it"; exit 1; }
  command -v python3 >/dev/null 2>&1 || { say "python3 is not installed, so versions cannot be compared"; exit 1; }
  version_of() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$1" 2>/dev/null || echo ""; }
  newer_than() { python3 -c 'import sys;a=[int(x) for x in sys.argv[1].split(".")];b=[int(x) for x in sys.argv[2].split(".")];sys.exit(0 if a>b else 1)' "$1" "$2"; }
  OLD=""
  [[ -f "$TARGET/manifest.json" ]] && OLD="$(version_of "$TARGET/manifest.json")"
  # Ask for the version first: a few hundred bytes from the API instead of the
  # whole archive when there is nothing new.
  REMOTE="$(curl -fsSL -H 'Accept: application/vnd.github.raw' \
    "https://api.github.com/repos/$REPO/contents/manifest.json?ref=$REF" 2>/dev/null \
    | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  if [[ -z "$REMOTE" ]]; then
    REMOTE="$(curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/manifest.json" 2>/dev/null \
      | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  fi
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -n "$REMOTE" && -n "$OLD" ]] && ! newer_than "$REMOTE" "$OLD"; then
    printf '{"version": "%s", "at": "%s"}\n' "$OLD" "$stamp" > "$TARGET/update.json"
    say "up to date ($OLD), nothing downloaded"
    exit 0
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" -o "$TMP/src.tar.gz" \
    || { say "the download failed"; exit 1; }
  tar -xzf "$TMP/src.tar.gz" -C "$TMP"
  INNER="$(find "$TMP" -maxdepth 1 -type d -name 'ad-zapper-*' | head -1)"
  [[ -n "$INNER" ]] || { say "the archive did not contain the expected folder"; exit 1; }
  NEW="$(version_of "$INNER/manifest.json")"
  [[ -n "$NEW" ]] || { say "the download has no readable manifest.json"; exit 1; }
  python3 - "$INNER" <<'PY' || { say "the downloaded copy is damaged"; exit 1; }
import glob, json, sys
root = sys.argv[1]
json.load(open(root + "/manifest.json"))
files = glob.glob(root + "/rules/*.json")
for path in files:
    json.load(open(path))
print("checked %d rule sets" % len(files))
PY
  if [[ -n "$OLD" ]] && ! newer_than "$NEW" "$OLD"; then
    printf '{"version": "%s", "at": "%s"}\n' "$OLD" "$stamp" > "$TARGET/update.json"
    say "up to date ($OLD)"
    exit 0
  fi
  mkdir -p "$(dirname "$TARGET")"
  rm -rf "$TARGET"
  mv "$INNER" "$TARGET"
  printf '{"version": "%s", "at": "%s"}\n' "$NEW" "$stamp" > "$TARGET/update.json"
  say "updated ${OLD:-nothing} -> $NEW"
  exit 0
fi
say "  ($REV)"
say ""

# 1. Where does the extension come from?
SRC=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  CAND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [[ -f "$CAND/manifest.json" ]] && SRC="$CAND"
fi

need_download=0
case "$MODE" in
  download|download-only) need_download=1 ;;
  *) [[ -z "$SRC" ]] && need_download=1 ;;
esac

if [[ $MODE == "dry" ]]; then
  if [[ $need_download -eq 1 ]]; then
    say "1/3  dry run: would download github.com/$REPO ($REF) into:"
    say "       $TARGET"
  else
    say "1/3  dry run: would use the checkout at $SRC"
  fi
elif [[ $need_download -eq 1 ]]; then
  say "1/3  fetching the newest $REF from github.com/$REPO ..."
  command -v curl >/dev/null 2>&1 || { say "curl is not installed, and this needs it to download"; exit 1; }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if ! curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" -o "$TMP/src.tar.gz"; then
    say "the download failed. Check the network, then rerun, or install from a clone:"
    say "  git clone https://github.com/$REPO.git && cd ad-zapper && ./install/install-macos.sh"
    exit 1
  fi
  tar -xzf "$TMP/src.tar.gz" -C "$TMP"
  INNER="$(find "$TMP" -maxdepth 1 -type d -name 'ad-zapper-*' | head -1)"
  [[ -n "$INNER" ]] || { say "the archive did not contain the expected folder"; exit 1; }
  mkdir -p "$(dirname "$TARGET")"
  rm -rf "$TARGET"
  mv "$INNER" "$TARGET"
  SRC="$TARGET"
  say "      downloaded $(du -sh "$SRC" | cut -f1) into $SRC"
else
  say "1/3  using the checkout at $SRC"
fi

if [[ $MODE == "dry" ]]; then
  say "2/3  dry run: manifest and rule sets left unchecked."
else
  missing=0
  for f in manifest.json rules/dnr_1.json src/background.js; do
    [[ -f "$SRC/$f" ]] || { say "missing $f"; missing=1; }
  done
  if [[ $missing -eq 1 ]]; then
    say "That folder is not a complete copy of the extension."
    exit 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$SRC" <<'PY' || { say "a file failed to parse, something is damaged"; exit 1; }
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
fi

if [[ $MODE == "download-only" ]]; then
  say ""
  say "Done. The extension is ready to load from:"
  say "  $SRC"
  exit 0
fi

# 3. Chrome
CHROME="/Applications/Google Chrome.app"
if [[ ! -d "$CHROME" ]]; then
  if [[ $MODE == "dry" ]]; then
    say "3/4  Chrome is not in /Applications (fine for a dry run)."
  else
    say "3/4  Chrome is not in /Applications."
    say "Install Google Chrome, then load the folder by hand: chrome://extensions, Developer"
    say "mode, Load unpacked, and pick:"
    say "  $SRC"
    exit 1
  fi
else
  say "3/4  Chrome found."
fi

if [[ $MODE == "dry" ]]; then
  say "4/4  dry run: clipboard and browser left alone."
  exit 0
fi

printf '%s' "$SRC" | pbcopy
open -a "Google Chrome" "chrome://extensions" 2>/dev/null || open -a "Google Chrome" || true
say "4/4  chrome://extensions is open, and the folder path is on your clipboard."
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
say "To update later, use the update button in the extension, or run this script again"
say "with --update-only. That replaces the folder with the newest version and the extension"
say "reloads itself into it."
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
