#!/usr/bin/env bash

# Do not let bash -x/-v disclose the pasted profile or keys.
set +x +v
set -Eeuo pipefail
umask 077
ulimit -c 0

interface=wg2
namespace=wg2
dnsServer=10.2.0.1
targetUser=${SUDO_USER:-}
temporaryDirectory=
temporaryMounted=false
validationInterface=
reservedConfig=
editorPid=

usage() {
  cat <<'EOF'
Install an isolated WireGuard namespace and its wgN-run launcher.

Usage:
  sudo ./setup-wg2-netns.sh [options]
  sudo --preserve-env=EDITOR ./setup-wg2-netns.sh [options]

Options:
  --dns ADDRESS  DNS server used inside the namespace (default: 10.2.0.1)
  --user USER    User allowed to run wg2-run (default: invoking sudo user)
  -h, --help     Show this help

Paste a fresh provider-generated profile into the editor, save, and quit.
EDITOR (or VISUAL) must name nvim, vim, vi, or nano, without extra arguments.
The default is nvim, falling back to vim, vi, then nano. Editors run without
user configuration, plugins, swap/backup files, or persistent history.
Existing profiles/installations are not replaced: wg2, wg3, ... are tried.

Editing files live on a private, non-swappable tmpfs and are removed on exit.
This cannot erase clipboard history, guarantee process-memory erasure, protect
against root, or clean up after SIGKILL/power loss. Disable/encrypt system swap
if editor process memory must not reach disk. The installed profile remains
root-owned and mode 600 in /etc/wireguard (mode 700).

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

cleanup() {
  local status=$?
  trap - EXIT HUP INT QUIT TERM
  if [[ -n $editorPid ]]; then
    kill -TERM "$editorPid" 2>/dev/null || true
    wait "$editorPid" 2>/dev/null || true
  fi
  if [[ -n $validationInterface ]]; then
    ip link delete "$validationInterface" 2>/dev/null || true
  fi
  [[ -z $reservedConfig ]] || rm -f -- "$reservedConfig"
  if [[ $temporaryMounted == true ]]; then
    # Remove editor buffers/history as well as the profile before unmounting.
    rm -rf -- "$temporaryDirectory"/* "$temporaryDirectory"/.[!.]* "$temporaryDirectory"/..?*
    if ! umount -- "$temporaryDirectory"; then
      printf 'Warning: could not unmount private staging area %s\n' "$temporaryDirectory" >&2
      exit 1
    fi
  fi
  [[ -z $temporaryDirectory ]] || rmdir -- "$temporaryDirectory"
  exit "$status"
}

selectEditor() {
  local name
  editor=${EDITOR:-${VISUAL:-}}
  if [[ -z $editor ]]; then
    for name in nvim vim vi nano; do
      if [[ -x /usr/bin/$name ]]; then
        editor=$name
        break
      fi
    done
  fi
  # No eval, arbitrary commands, editor clients, or user-supplied flags: these
  # could retain buffers in another process or re-enable persistent state.
  case $editor in
    nvim|vim|vi|nano|/usr/bin/nvim|/usr/bin/vim|/usr/bin/vi|/usr/bin/nano)
      editor=/usr/bin/${editor##*/}
      ;;
    *) die 'EDITOR must be nvim, vim, vi, or nano (no arguments)' ;;
  esac
  [[ -x $editor ]] || die "Editor not found: $editor"
}

editConfig() {
  local editorStatus=0
  local -a arguments
  case ${editor##*/} in
    nvim)
      arguments=(-u NONE -i NONE -n --cmd 'set nomodeline noexrc noswapfile nobackup nowritebackup noundofile shada= clipboard= history=0')
      ;;
    vim|vi)
      arguments=(-N -u NONE -U NONE -i NONE -n --cmd 'set nomodeline noexrc noswapfile nobackup nowritebackup noundofile viminfo= clipboard= history=0')
      ;;
    nano)
      arguments=(--ignorercfiles --restricted)
      ;;
  esac
  printf 'Paste the %s profile, then save and quit. Quit without saving to cancel.\n' "$interface"
  (
    cd "$temporaryDirectory"
    # Isolate all editor state, including emergency saves and XDG caches.
    exec env -i PATH=/usr/bin:/bin TERM="${TERM:-xterm-256color}" \
      HOME="$temporaryDirectory" TMPDIR="$temporaryDirectory" \
      XDG_CONFIG_HOME="$temporaryDirectory" XDG_CACHE_HOME="$temporaryDirectory" \
      XDG_DATA_HOME="$temporaryDirectory" XDG_STATE_HOME="$temporaryDirectory" \
      XDG_RUNTIME_DIR="$temporaryDirectory" NVIM_LOG_FILE=/dev/null \
      "$editor" "${arguments[@]}" -- "$candidateConfig"
  ) <&0 &
  editorPid=$!
  wait "$editorPid" || editorStatus=$?
  editorPid=
  ((editorStatus == 0)) || die 'Editor exited unsuccessfully; configuration was not installed'
  [[ -s $candidateConfig && -f $candidateConfig && ! -L $candidateConfig ]] || \
    die 'No configuration saved; installation cancelled'
  chmod 600 "$candidateConfig"
}

validateConfig() {
  local line key value address mtu=1420
  local -a addresses=() values=()

  # wg-quick strip alone does not validate keys, peer settings, or addresses.
  # Never print parser diagnostics: wg can echo a malformed secret value.
  wg-quick strip "$candidateConfig" > "$temporaryDirectory/stripped.conf" 2>/dev/null || \
    die 'Invalid WireGuard configuration (details suppressed to protect secrets)'
  extractPrivateKey "$candidateConfig" >/dev/null || die 'Missing Interface PrivateKey'

  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%%#*}
    [[ $line == *=* ]] || continue
    key=$(trim "${line%%=*}")
    value=$(trim "${line#*=}")
    case ${key,,} in
      address)
        IFS=',' read -ra values <<< "$value"
        for address in "${values[@]}"; do
          address=$(trim "$address")
          [[ -n $address ]] || die 'Empty Address entry'
          addresses+=("$address")
        done
        ;;
      mtu)
        [[ $value =~ ^[0-9]+$ ]] || die 'Invalid MTU'
        mtu=$value
        ;;
    esac
  done < "$candidateConfig"
  ((${#addresses[@]} > 0)) || die 'The profile must include an Interface Address'

  # A down, unnumbered interface validates via WireGuard's real parser without
  # bringing up the VPN or changing host routes. Host DNS can resolve endpoints.
  local testInterface="wgv${temporaryDirectory##*.}"
  ip link add "$testInterface" type wireguard 2>/dev/null || die 'Cannot create validation interface'
  validationInterface=$testInterface
  wg setconf "$validationInterface" "$temporaryDirectory/stripped.conf" 2>/dev/null || \
    die 'Invalid WireGuard settings, keys, or endpoint (details suppressed)'
  [[ $(wg show "$validationInterface" allowed-ips) == *'0.0.0.0/0'* ]] || \
    die 'The profile must include 0.0.0.0/0 in AllowedIPs'
  ip link set dev "$validationInterface" mtu "$mtu" 2>/dev/null || die 'Invalid MTU'

  # Validate addresses in a disposable namespace; never add host addresses/routes.
  unshare --net -- /usr/bin/bash -c '
    for address in "$@"; do
      ip address add "$address" dev lo || exit 1
    done
  ' bash "${addresses[@]}" 2>/dev/null || die 'Invalid Interface Address or network namespace unavailable'
  ip link delete "$validationInterface"
  validationInterface=
  rm -f -- "$temporaryDirectory/stripped.conf"
}

trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

extractPrivateKey() {
  local config=$1 line key value

  while IFS= read -r line || [[ -n $line ]]; do
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
[[ -n $targetUser && $targetUser != root ]] || die 'Specify the desktop user with --user USER'
id "$targetUser" &>/dev/null || die "User not found: $targetUser"
[[ $dnsServer =~ ^[0-9A-Fa-f:.]+$ ]] || die "Invalid DNS server address: $dnsServer"

for commandName in ip wg wg-quick systemctl install getent mount umount runuser setpriv stat sudo visudo flock unshare mktemp sed; do
  requireCommand "$commandName"
done

selectEditor
[[ -t 0 && -t 1 ]] || die 'Run this installer in an interactive terminal'

# Serialize name selection and installation without reading secrets as the user.
exec {lockFd}> /run/setup-wg-netns.lock
flock -n "$lockFd" || die 'Another WireGuard namespace installer is running'
[[ ! -L /etc/wireguard ]] || die '/etc/wireguard must not be a symlink'
install -d -o root -g root -m700 /etc/wireguard

index=2
while true; do
  interface=wg$index
  namespace=$interface
  destinationConfig=/etc/wireguard/$interface.conf
  occupied=false
  for path in "$destinationConfig" "/run/netns/$namespace" "/etc/netns/$namespace" \
    "/etc/systemd/system/$interface-netns.service" "/etc/sudoers.d/$interface-run" \
    "/usr/local/sbin/$interface-netns" "/usr/local/bin/$interface-run" \
    "/usr/local/libexec/$interface-enter" "/usr/local/libexec/$interface-user-exec"; do
    if [[ -e $path || -L $path ]]; then occupied=true; break; fi
  done
  if [[ $occupied == false ]] && ! ip link show "$interface" &>/dev/null; then
    break
  fi
  index=$((index + 1))
  ((index <= 65535)) || die 'No free WireGuard namespace name found'
done
fwmark=$(printf '0x%x' "$((0x776732 + index - 2))")
rulePriority=$((10000 + index - 2))

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM
temporaryDirectory=$(mktemp -d /run/setup-wg.XXXXXXXXXX)
# Fail closed on kernels without tmpfs noswap support; never use disk-backed /tmp.
mount -t tmpfs -o nosuid,nodev,noexec,noswap,size=16M,mode=0700 tmpfs "$temporaryDirectory" || \
  die 'Cannot mount private non-swappable tmpfs for editing'
temporaryMounted=true
candidateConfig=$temporaryDirectory/$interface.conf
editConfig
validateConfig

candidatePrivateKey=$(extractPrivateKey "$candidateConfig") || \
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

  while IFS= read -r line || [[ -n $line ]]; do
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
insideNamespace=false

if [ "${1-}" = --inside-namespace ]; then
  insideNamespace=true
  shift
fi

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

if [ "$insideNamespace" = true ]; then
  if [ "$(/usr/bin/stat -fc %T -- /sys/fs/cgroup)" != cgroup2fs ]; then
    /usr/bin/mount -t cgroup2 -o nosuid,nodev,noexec cgroup2 /sys/fs/cgroup
  fi

  exec /usr/bin/runuser -u "$callingUser" -- \
    /usr/bin/env -i /usr/local/libexec/wg2-user-exec \
    "$environmentFile" "$@"
fi

exec /usr/bin/ip netns exec "$namespace" \
  "$0" --inside-namespace "$environmentFile" "$@"
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

for template in wg2-netns wg2-enter wg2-user-exec wg2-run wg2-netns.service; do
  sed -e "s/wg2/$interface/g" -e "s/fwmark=0x776732/fwmark=$fwmark/" \
    -e "s/rulePriority=10000/rulePriority=$rulePriority/" \
    "$temporaryDirectory/$template" > "$temporaryDirectory/rendered-$template"
done
printf 'nameserver %s\noptions edns0\n' "$dnsServer" > "$temporaryDirectory/resolv.conf"
printf '%s ALL=(root) NOPASSWD: /usr/local/libexec/%s-enter *\n' "$targetUser" "$interface" > "$temporaryDirectory/run.sudoers"
visudo -cf "$temporaryDirectory/run.sudoers"

# noclobber also rejects dangling symlinks and protects against a profile created
# since name selection. Remove a partial profile on failure, not an existing one.
(set -o noclobber; : > "$destinationConfig") 2>/dev/null || \
  die "$destinationConfig appeared during installation; refusing to overwrite it"
reservedConfig=$destinationConfig
install -o root -g root -m600 "$candidateConfig" "$destinationConfig"
reservedConfig=
rm -f -- "$candidateConfig"

install -Dm755 "$temporaryDirectory/rendered-wg2-netns" "/usr/local/sbin/$interface-netns"
install -Dm755 "$temporaryDirectory/rendered-wg2-enter" "/usr/local/libexec/$interface-enter"
install -Dm755 "$temporaryDirectory/rendered-wg2-user-exec" "/usr/local/libexec/$interface-user-exec"
install -Dm755 "$temporaryDirectory/rendered-wg2-run" "/usr/local/bin/$interface-run"
install -Dm644 "$temporaryDirectory/rendered-wg2-netns.service" "/etc/systemd/system/$interface-netns.service"
install -Dm644 "$temporaryDirectory/resolv.conf" "/etc/netns/$namespace/resolv.conf"
install -Dm440 "$temporaryDirectory/run.sudoers" "/etc/sudoers.d/$interface-run"

systemctl daemon-reload
systemctl enable --now "$interface-netns.service"

printf '\n%s namespace installed successfully (%s).\n' "$namespace" "$destinationConfig"
printf 'Run applications with: %s-run COMMAND [ARGUMENTS...]\n' "$interface"
printf 'Check the VPN IP with: %s-run curl https://ifconfig.me/ip\n' "$interface"
