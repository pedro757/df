#!/usr/bin/env bash

set -Eeuo pipefail

applicationsDirectory=${XDG_DATA_HOME:-"$HOME/.local/share"}/applications
desktopFile=$applicationsDirectory/brave-vpn.desktop

install -d "$applicationsDirectory"

cat > "$desktopFile" <<EOF
[Desktop Entry]
Version=1.0
Name=Brave VPN
GenericName=Web Browser
Comment=Browse through the wg2 Proton VPN namespace
Exec=wg2-run brave --user-data-dir=$HOME/.config/BraveSoftware/Brave-Browser-wg2 %U
Terminal=false
Type=Application
Icon=brave-desktop
StartupNotify=true
StartupWMClass=brave-browser
Categories=Network;WebBrowser;
Keywords=browser;vpn;proton;wg2;
EOF

command -v update-desktop-database &>/dev/null && \
  update-desktop-database "$applicationsDirectory"

if command -v omarchy &>/dev/null; then
  omarchy restart walker || true
fi
