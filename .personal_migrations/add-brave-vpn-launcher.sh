#!/usr/bin/env bash

set -Eeuo pipefail

# Compatibility entry point; --app and --replace also support non-browser apps.
exec python3 "$(dirname "$(readlink -f "$0")")/setup-vpn-apps.py" launcher "$@"
