#!/usr/bin/env python3
"""Native messaging host for Ad Zapper's update button.

Chrome will not let an extension write files, so the extension cannot replace its
own folder. A native messaging host can: Chrome starts this program, this program
runs the installer's --update-only path, and then the extension reads the marker
the installer wrote and reloads itself into the new version.

The protocol is Chrome's: four bytes of native-endian length, then that many bytes
of UTF-8 JSON, in both directions. One request per connection, which is all the
button needs.

Registered by install/native-host/register-macos.sh, which writes the host manifest
into ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/.
"""
import json
import os
import struct
import subprocess
import sys
import time

TIMEOUT_SECONDS = 300


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack('=I', header)[0]
    if length <= 0 or length > 1024 * 1024:
        return None
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    try:
        return json.loads(body.decode('utf-8'))
    except Exception:
        return None


def send_message(payload):
    data = json.dumps(payload).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def default_target():
    override = os.environ.get('AD_ZAPPER_DIR')
    if override:
        return override
    return os.path.join(os.path.expanduser('~'), 'Applications', 'Ad Zapper')


def installed_version(target):
    try:
        with open(os.path.join(target, 'manifest.json'), 'r') as handle:
            return json.load(handle).get('version')
    except Exception:
        return None


def main():
    message = read_message()
    if not message:
        return 0

    action = str(message.get('cmd') or 'update')
    target = str(message.get('target') or '') or default_target()

    if action == 'status':
        send_message({'ok': True, 'target': target, 'version': installed_version(target)})
        return 0

    installer = os.path.join(target, 'install', 'install-macos.sh')
    if not os.path.isfile(installer):
        send_message({'ok': False, 'error': 'no installer at %s' % installer, 'target': target})
        return 0

    started = time.time()
    try:
        finished = subprocess.run(
            ['/bin/bash', installer, '--update-only'],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS
        )
        output = (finished.stdout or '') + (finished.stderr or '')
        code = finished.returncode
    except subprocess.TimeoutExpired:
        send_message({'ok': False, 'error': 'the installer did not finish in %d seconds' % TIMEOUT_SECONDS})
        return 0
    except Exception as exc:
        send_message({'ok': False, 'error': str(exc)})
        return 0

    send_message({
        'ok': code == 0,
        'target': target,
        'version': installed_version(target),
        'seconds': round(time.time() - started, 1),
        'output': output[-1500:]
    })
    return 0


if __name__ == '__main__':
    sys.exit(main())
