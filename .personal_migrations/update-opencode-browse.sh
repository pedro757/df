#!/usr/bin/env bash

set -Eeuo pipefail

# Update the binary and its systemd-owned host relay together, without changing
# browser profiles, pairing credentials, namespace bridges or OpenCode settings.
# A verified user-owned standalone relay on the shared port is handed to systemd.
# Pass --restart-only after already running the official curl | bash installer.
exec python3 "$(dirname "$(readlink -f "$0")")/setup-vpn-apps.py" update-browse "$@"
