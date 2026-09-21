#!/usr/bin/env bash
#
# Puts Ad Zapper's updater on a schedule, or takes it off again.
#
# Chrome never updates an extension that did not come from the Web Store, so
# something on the machine has to. This registers a launchd job that runs the
# installer's --update-only path every six hours: it fetches the newest source,
# swaps the folder only when there is something newer, and writes update.json
# into the folder. The extension reads that marker and reloads itself into it, so
# the update lands without anybody clicking the reload arrow.
#
# Usage:
#   ./install/autoupdate-macos.sh --install [folder]   # default: ~/Applications/Ad Zapper
#   ./install/autoupdate-macos.sh --status
#   ./install/autoupdate-macos.sh --remove
#   ./install/autoupdate-macos.sh --run-now
set -euo pipefail

LABEL="com.sloemo.ad-zapper-updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ad-zapper-updater.log"
MODE="install"
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --install) MODE="install" ;;
    --remove) MODE="remove" ;;
    --status) MODE="status" ;;
    --run-now) MODE="run-now" ;;
    -*) echo "unknown option: $arg"; exit 2 ;;
    *) TARGET="$arg" ;;
  esac
done

[[ -n "$TARGET" ]] || TARGET="$HOME/Applications/Ad Zapper"
INSTALLER="$TARGET/install/install-macos.sh"
say() { printf '%s\n' "$*"; }

case "$MODE" in
  install)
    [[ -f "$INSTALLER" ]] || { say "no installer at $INSTALLER (point this at the extension folder)"; exit 1; }
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALLER</string>
    <string>--update-only</string>
  </array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null; then
      say "Auto-update registered."
      say "  checks   every 6 hours, and at login"
      say "  runs     $INSTALLER --update-only"
      say "  log      $LOG"
      say "  remove   $0 --remove"
    else
      say "launchd refused the job. The plist is written at $PLIST, so this may work:"
      say "  launchctl load -w \"$PLIST\""
      exit 1
    fi
    ;;
  remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    say "Auto-update removed. The extension keeps working; it just stops updating itself."
    ;;
  status)
    [[ -f "$PLIST" ]] && say "registered:   $PLIST" || say "registered:   no"
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|runs|last exit code" | head -4 || true
    [[ -f "$INSTALLER" ]] && say "installer:    $INSTALLER"
    if [[ -f "$TARGET/update.json" ]]; then
      say "marker:       $(cat "$TARGET/update.json")"
    else
      say "marker:       none yet"
    fi
    if [[ -f "$LOG" ]]; then
      say "recent log:"
      tail -3 "$LOG" || true
    fi
    ;;
  run-now)
    [[ -f "$INSTALLER" ]] || { say "no installer at $INSTALLER"; exit 1; }
    bash "$INSTALLER" --update-only
    ;;
esac
