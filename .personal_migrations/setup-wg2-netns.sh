#!/usr/bin/env bash

set -Eeuo pipefail

interface=wg2
namespace=wg2
dnsServer=10.2.0.1
sourceConfig=
targetUser=${SUDO_USER:-}
force=false

usage() {
  cat <<'EOF'
Install an isolated wg2 WireGuard namespace and the wg2-run launcher.

Usage:
  sudo ./setup-wg2-netns.sh --config PATH [options]

Options:
  --config PATH   Fresh provider-generated WireGuard configuration (required)
  --dns ADDRESS  DNS server used inside the namespace (default: 10.2.0.1)
  --user USER    User allowed to run wg2-run (default: invoking sudo user)
  --force        Replace an existing /etc/wireguard/wg2.conf
  -h, --help     Show this help

Reusing a PrivateKey is allowed, but both copies may not work reliably when
active simultaneously. The script never prints private keys.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

requireCommand() {
  command -v "$1" &>/dev/null || die "Required command not found: $1"
}

trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

extractPrivateKey() {
  local config=$1 line key value

  while IFS= read -r line; do
    line=${line%%#*}
    [[ $line == *=* ]] || continue
    key=$(trim "${line%%=*}")
    [[ ${key,,} == privatekey ]] || continue
    value=$(trim "${line#*=}")
    [[ -n $value ]] || return 1
    printf '%s' "$value"
    return 0
  done < "$config"

  return 1
}

while (($# > 0)); do
  case $1 in
    --config)
      (($# >= 2)) || die '--config requires a path'
      sourceConfig=$2
      shift 2
      ;;
    --dns)
      (($# >= 2)) || die '--dns requires an address'
      dnsServer=$2
      shift 2
      ;;
    --user)
      (($# >= 2)) || die '--user requires a username'
      targetUser=$2
      shift 2
      ;;
    --force)
      force=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ $EUID -eq 0 ]] || die 'Run this installer with sudo'
[[ -n $sourceConfig ]] || { usage >&2; exit 2; }
[[ -f $sourceConfig ]] || die "Configuration not found: $sourceConfig"
[[ -n $targetUser && $targetUser != root ]] || die 'Specify the desktop user with --user USER'
id "$targetUser" &>/dev/null || die "User not found: $targetUser"
[[ $dnsServer =~ ^[0-9A-Fa-f:.]+$ ]] || die "Invalid DNS server address: $dnsServer"

for commandName in ip wg wg-quick systemctl install getent runuser setpriv stat sudo visudo; do
  requireCommand "$commandName"
done

destinationConfig=/etc/wireguard/wg2.conf
if [[ -e $destinationConfig && $force != true ]]; then
  die "$destinationConfig already exists; use --force to replace it"
fi

temporaryDirectory=$(mktemp -d)
trap 'rm -rf "$temporaryDirectory"' EXIT

# Give wg-quick a valid interface-sized filename while validating the profile.
install -m600 "$sourceConfig" "$temporaryDirectory/wg2.conf"
wg-quick strip "$temporaryDirectory/wg2.conf" >/dev/null

candidatePrivateKey=$(extractPrivateKey "$temporaryDirectory/wg2.conf") || \
  die 'The supplied configuration has no Interface PrivateKey'

shopt -s nullglob
for existingConfig in /etc/wireguard/*.conf; do
  [[ $existingConfig == "$destinationConfig" ]] && continue
  existingPrivateKey=$(extractPrivateKey "$existingConfig") || continue
  if [[ $candidatePrivateKey == "$existingPrivateKey" ]]; then
    printf 'Warning: the supplied profile duplicates the peer identity in %s.\n' "$existingConfig" >&2
    printf 'Only one copy may work reliably when both are active simultaneously.\n' >&2
  fi
  unset existingPrivateKey
done
unset candidatePrivateKey

cat > "$temporaryDirectory/wg2-netns" <<'NETNS_SCRIPT'
#!/usr/bin/env bash

set -Eeuo pipefail

namespace=wg2
interface=wg2
config=/etc/wireguard/wg2.conf
fwmark=0x776732
rulePriority=10000

removeHostRules() {
  while ip -4 rule delete priority "$rulePriority" fwmark "$fwmark" table main 2>/dev/null; do :; done
  while ip -6 rule delete priority "$rulePriority" fwmark "$fwmark" table main 2>/dev/null; do :; done
}

cleanup() {
  if [[ -e "/run/netns/$namespace" ]]; then
    ip -n "$namespace" link delete "$interface" 2>/dev/null || true
    ip netns delete "$namespace" 2>/dev/null || true
  else
    ip link delete "$interface" 2>/dev/null || true
  fi
  removeHostRules
}

readInterfaceSettings() {
  local line key value address
  local -a values

  while IFS= read -r line; do
    line=${line%%#*}
    [[ $line == *=* ]] || continue

    key=${line%%=*}
    value=${line#*=}
    key=${key//[[:space:]]/}

    case ${key,,} in
      address)
        IFS=',' read -ra values <<< "$value"
        for address in "${values[@]}"; do
          address=${address//[[:space:]]/}
          [[ -n $address ]] && addresses+=("$address")
        done
        ;;
      mtu)
        value=${value//[[:space:]]/}
        [[ $value =~ ^[0-9]+$ ]] || { printf 'Invalid MTU: %s\n' "$value" >&2; exit 1; }
        mtu=$value
        ;;
    esac
  done < "$config"
}

up() {
  local -a addresses=()
  local address allowedIps
  local mtu=1420

  [[ -r $config ]] || { printf 'Cannot read %s\n' "$config" >&2; exit 1; }
  [[ ! -e "/run/netns/$namespace" ]] || { printf 'Namespace %s already exists\n' "$namespace" >&2; exit 1; }
  ! ip link show "$interface" &>/dev/null || { printf 'Host interface %s already exists\n' "$interface" >&2; exit 1; }

  readInterfaceSettings
  ((${#addresses[@]} > 0)) || { printf 'No Address entry found in %s\n' "$config" >&2; exit 1; }

  trap cleanup ERR
  removeHostRules
  ip -4 rule add priority "$rulePriority" fwmark "$fwmark" table main
  ip -6 rule add priority "$rulePriority" fwmark "$fwmark" table main

  ip netns add "$namespace"
  ip -n "$namespace" link set lo up

  # The encrypted UDP socket stays in the host namespace when wg2 is moved.
  # Its mark and host rules bypass any other host-wide WireGuard default route.
  ip link add "$interface" type wireguard
  wg setconf "$interface" <(wg-quick strip "$config")
  wg set "$interface" fwmark "$fwmark"
  allowedIps=$(wg show "$interface" allowed-ips)
  ip link set "$interface" netns "$namespace"

  for address in "${addresses[@]}"; do
    ip -n "$namespace" address add "$address" dev "$interface"
  done

  ip -n "$namespace" link set dev "$interface" mtu "$mtu" up

  if [[ $allowedIps == *'0.0.0.0/0'* ]]; then
    ip -n "$namespace" route replace default dev "$interface"
  else
    printf 'The wg2 profile must include 0.0.0.0/0 in AllowedIPs\n' >&2
    return 1
  fi

  if [[ $allowedIps == *'::/0'* ]]; then
    ip -n "$namespace" -6 route replace default dev "$interface"
  fi

  trap - ERR
}

down() {
  if [[ -e "/run/netns/$namespace" ]]; then
    ip -n "$namespace" link delete "$interface" 2>/dev/null || true
    ip netns delete "$namespace"
  fi
  removeHostRules
}

case ${1:-} in
  up) up ;;
  down) down ;;
  *) printf 'Usage: %s {up|down}\n' "$0" >&2; exit 2 ;;
esac
NETNS_SCRIPT

cat > "$temporaryDirectory/wg2-enter" <<'ENTER_SCRIPT'
#!/bin/sh

set -eu

namespace=wg2
callingUser=${SUDO_USER-}
environmentFile=${1-}
shift || true

[ -n "$callingUser" ] && [ "$callingUser" != root ] || { printf 'Run this helper through sudo as a regular user\n' >&2; exit 1; }
[ "$#" -gt 0 ] || { printf 'No command provided\n' >&2; exit 2; }
[ -e "/run/netns/$namespace" ] || { printf 'Network namespace %s is not running\n' "$namespace" >&2; exit 1; }

passwdEntry=$(/usr/bin/getent passwd "$callingUser") || { printf 'Cannot resolve user %s\n' "$callingUser" >&2; exit 1; }
IFS=: read -r _ _ userId groupId _ userHome _ <<EOF
$passwdEntry
EOF
[ -n "$userId" ] && [ -n "$groupId" ] && [ -n "$userHome" ] || { printf 'Cannot resolve user %s\n' "$callingUser" >&2; exit 1; }

case $environmentFile in
  "/run/user/$userId"/wg2-run.*|/tmp/wg2-run.*) ;;
  *) printf 'Invalid environment file\n' >&2; exit 1 ;;
esac

fileMetadata=$(LC_ALL=C /usr/bin/stat -c '%u:%a:%F' -- "$environmentFile")
[ "$fileMetadata" = "$userId:600:regular file" ] || { printf 'Invalid environment file\n' >&2; exit 1; }

exec /usr/bin/ip netns exec "$namespace" /usr/bin/runuser -u "$callingUser" -- \
  /usr/bin/env -i /usr/local/libexec/wg2-user-exec \
  "$environmentFile" "$@"
ENTER_SCRIPT

cat > "$temporaryDirectory/wg2-user-exec" <<'USER_EXEC_SCRIPT'
#!/usr/bin/bash

set -euo pipefail

environmentFile=${1:-}
shift || true

[[ $# -gt 0 ]] || { printf 'No command provided\n' >&2; exit 2; }

environment=()
mapfile -d '' -t environment < "$environmentFile"
/usr/bin/rm -f -- "$environmentFile"

exec /usr/bin/env -i -- \
  "${environment[@]}" \
  /usr/bin/setpriv -- "$@"
USER_EXEC_SCRIPT

cat > "$temporaryDirectory/wg2-run" <<'RUN_SCRIPT'
#!/usr/bin/env bash

set -euo pipefail

[[ $# -gt 0 ]] || { printf 'Usage: wg2-run COMMAND [ARGUMENT...]\n' >&2; exit 2; }

commandName=$1
shift

if [[ $commandName == */* ]]; then
  commandPath=$commandName
else
  commandPath=$(command -v -- "$commandName") || {
    printf 'Command not found: %s\n' "$commandName" >&2
    exit 127
  }
fi

childPid=
environmentFile=
receivedSignal=
receivedStatus=

forwardSignal() {
  receivedSignal=$1
  receivedStatus=$2
  [[ -z $childPid ]] || kill "-$1" "$childPid" 2>/dev/null || true
}

trap '[[ -z $environmentFile ]] || rm -f -- "$environmentFile"' EXIT
trap 'forwardSignal HUP 129' HUP
trap 'forwardSignal INT 130' INT
trap 'forwardSignal QUIT 131' QUIT
trap 'forwardSignal TERM 143' TERM

originalUmask=$(umask)
umask 077
userId=$(id -u)
environmentDirectory=/run/user/$userId
directoryMetadata=$(LC_ALL=C stat -c '%u:%a:%F' -- "$environmentDirectory" 2>/dev/null || true)
[[ $directoryMetadata == "$userId:700:directory" ]] || environmentDirectory=/tmp
environmentFile=$(mktemp "$environmentDirectory/wg2-run.XXXXXX")
umask "$originalUmask"

env -0 > "$environmentFile"
[[ -z $receivedStatus ]] || exit "$receivedStatus"

sudo /usr/local/libexec/wg2-enter "$environmentFile" "$commandPath" "$@" <&0 &
childPid=$!
[[ -z $receivedSignal ]] || kill "-$receivedSignal" "$childPid" 2>/dev/null || true
status=0
while true; do
  wait "$childPid" && { status=0; break; }
  status=$?
  kill -0 "$childPid" 2>/dev/null || break
done
childPid=
exit "$status"
RUN_SCRIPT

cat > "$temporaryDirectory/wg2-netns.service" <<'SERVICE_FILE'
[Unit]
Description=WireGuard wg2 application network namespace
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/wg2-netns up
ExecStop=/usr/local/sbin/wg2-netns down

[Install]
WantedBy=multi-user.target
SERVICE_FILE

printf 'nameserver %s\noptions edns0\n' "$dnsServer" > "$temporaryDirectory/resolv.conf"
printf '%s ALL=(root) NOPASSWD: /usr/local/libexec/wg2-enter *\n' "$targetUser" > "$temporaryDirectory/wg2-run.sudoers"
visudo -cf "$temporaryDirectory/wg2-run.sudoers"

systemctl stop wg2-netns.service 2>/dev/null || true

install -Dm600 "$temporaryDirectory/wg2.conf" "$destinationConfig"
install -Dm755 "$temporaryDirectory/wg2-netns" /usr/local/sbin/wg2-netns
install -Dm755 "$temporaryDirectory/wg2-enter" /usr/local/libexec/wg2-enter
install -Dm755 "$temporaryDirectory/wg2-user-exec" /usr/local/libexec/wg2-user-exec
install -Dm755 "$temporaryDirectory/wg2-run" /usr/local/bin/wg2-run
install -Dm644 "$temporaryDirectory/wg2-netns.service" /etc/systemd/system/wg2-netns.service
install -Dm644 "$temporaryDirectory/resolv.conf" /etc/netns/wg2/resolv.conf
install -Dm440 "$temporaryDirectory/wg2-run.sudoers" /etc/sudoers.d/wg2-run

systemctl daemon-reload
systemctl enable --now wg2-netns.service

printf '\nwg2 namespace installed successfully.\n'
printf 'Run applications with: wg2-run COMMAND [ARGUMENTS...]\n'
printf 'Check the VPN IP with: wg2-run curl https://ifconfig.me/ip\n'
