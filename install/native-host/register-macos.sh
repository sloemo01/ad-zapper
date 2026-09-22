#!/bin/bash
# Registers the native messaging host that lets the extension's update button run
# the installer itself, instead of copying a command for you to paste.
#
#   bash install/native-host/register-macos.sh            register
#   bash install/native-host/register-macos.sh --remove    unregister
#
# Chrome reads one JSON file per host from
# ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/.
# The allowed_origins entry is the unpacked extension's id, which Chrome derives
# from the absolute path of the folder it loaded. Move that folder and the id
# changes, so run this again after moving it.
set -euo pipefail

HOST_NAME='com.sloemo.ad_zapper_updater'
TARGET="${AD_ZAPPER_DIR:-$HOME/Applications/Ad Zapper}"
HOST="$TARGET/install/native-host/ad-zapper-host.py"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"
SUPPORT_DIR="$CHROME_DIR/NativeMessagingHosts"
MANIFEST="$SUPPORT_DIR/$HOST_NAME.json"
EXTENSION_ID="${AD_ZAPPER_EXTENSION_ID:-cpphobhbpoecbnicbeajhdcdkjdmahjf}"

if [[ "${1:-}" == '--remove' ]]; then
  rm -f "$MANIFEST"
  echo "Ad Zapper native updater unregistered"
  exit 0
fi

if [[ ! -f "$HOST" ]]; then
  echo "cannot register: no host at $HOST" >&2
  exit 1
fi

chmod +x "$HOST"
mkdir -p "$SUPPORT_DIR"

AD_ZAPPER_HOST="$HOST" AD_ZAPPER_HOST_NAME="$HOST_NAME" AD_ZAPPER_ID="$EXTENSION_ID" AD_ZAPPER_MANIFEST="$MANIFEST" python3 - <<'PY'
import json
import os

path = os.environ['AD_ZAPPER_HOST']
with open(os.environ['AD_ZAPPER_MANIFEST'], 'w') as handle:
    json.dump({
        'name': os.environ['AD_ZAPPER_HOST_NAME'],
        'description': 'Ad Zapper updater: runs the installer when the update button is clicked',
        'path': path,
        'type': 'stdio',
        'allowed_origins': ['chrome-extension://%s/' % os.environ['AD_ZAPPER_ID']]
    }, handle, indent=2)
    handle.write('\n')
print('registered %s -> %s' % (os.environ['AD_ZAPPER_HOST_NAME'], path))
PY

echo "extension id allowed: $EXTENSION_ID"
echo "if Chrome was already open, restart it once so the host is picked up"
