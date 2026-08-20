#!/usr/bin/env bash

set -Eeuo pipefail

backendPort=4096
bridgePort=4097

usage() {
  cat <<'EOF'
Expose OpenCode through Tailscale Serve, including when launched with wg2-run.

Usage:
  ./setup-opencode-tailscale.sh [options]

Options:
  --backend-port PORT  OpenCode service port (default: 4096)
  --bridge-port PORT   Host-side Tailscale bridge port (default: 4097)
  -h, --help           Show this help

The stable command is `opencode`. If a separate `opencode2` beta executable is
installed, the script wraps that command too.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

requireCommand() {
  command -v "$1" &>/dev/null || die "Required command not found: $1"
}

validatePort() {
  [[ $1 =~ ^[0-9]+$ ]] && ((1 <= 10#$1 && 10#$1 <= 65535)) || \
    die "Invalid port: $1"
}

findRealCommand() {
  local name=$1 wrapper=$2 directory candidate
  local oldIFS=$IFS

  IFS=:
  for directory in $PATH; do
    [[ -n $directory ]] || directory=.
    candidate=$directory/$name
    [[ -x $candidate && ! -d $candidate ]] || continue
    if [[ -e $wrapper ]] && [[ $candidate -ef $wrapper ]]; then
      continue
    fi
    printf '%s\n' "$candidate"
    IFS=$oldIFS
    return 0
  done
  IFS=$oldIFS
  return 1
}

while (($# > 0)); do
  case $1 in
    --backend-port)
      (($# >= 2)) || die '--backend-port requires a value'
      backendPort=$2
      shift 2
      ;;
    --bridge-port)
      (($# >= 2)) || die '--bridge-port requires a value'
      bridgePort=$2
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

[[ $EUID -ne 0 ]] || die 'Run this migration as the desktop user, not with sudo'
validatePort "$backendPort"
validatePort "$bridgePort"
[[ $backendPort != "$bridgePort" ]] || die 'Backend and bridge ports must differ'

for commandName in curl fish flock jq openssl readlink socat systemctl tailscale; do
  requireCommand "$commandName"
done

binDirectory=$HOME/.local/bin
libexecDirectory=$HOME/.local/libexec
fishDirectory=${XDG_CONFIG_HOME:-"$HOME/.config"}/fish/conf.d
systemdDirectory=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
wrapper=$libexecDirectory/opencode-tailscale-wrapper
stableLink=$binDirectory/opencode
betaLink=$binDirectory/opencode2
serviceFile=$systemdDirectory/opencode-tailscale-bridge.service
serviceConfig=${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode/service.json

stableCommand=$(findRealCommand opencode "$wrapper") || \
  die 'Could not find the real opencode executable outside the wrapper path'
betaCommand=$(findRealCommand opencode2 "$wrapper" || true)

"$stableCommand" service set hostname 127.0.0.1 >/dev/null || \
  die 'This OpenCode installation does not support the V2 background service'
"$stableCommand" service set port "$backendPort" >/dev/null

password=$(jq -r '.password // empty' "$serviceConfig" 2>/dev/null || true)
if [[ -z $password ]]; then
  password=$(openssl rand -hex 16)
  "$stableCommand" service set password "$password" >/dev/null
fi

install -d "$binDirectory" "$libexecDirectory" "$fishDirectory" "$systemdDirectory"

cat > "$wrapper" <<EOF
#!/usr/bin/env bash

set -u

backend_port=$backendPort
command_name=\$(basename "\$0")
runtime_dir=\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}
socket=\$runtime_dir/opencode-tailscale.sock
pid_file=\$runtime_dir/opencode-tailscale-socat.pid
lock_file=\$runtime_dir/opencode-tailscale.lock
log_file=\$runtime_dir/opencode-tailscale-socat.log
self=\$(readlink -f "\$0")

find_real_command() {
  local directory candidate old_ifs=\$IFS
  IFS=:
  for directory in \$PATH; do
    [[ -n \$directory ]] || directory=.
    candidate=\$directory/\$command_name
    [[ -x \$candidate && ! -d \$candidate ]] || continue
    [[ \$(readlink -f "\$candidate") != "\$self" ]] || continue
    printf '%s\\n' "\$candidate"
    IFS=\$old_ifs
    return 0
  done
  IFS=\$old_ifs

  candidate=\$HOME/.local/libexec/\$command_name-real
  if [[ -x \$candidate && \$(readlink -f "\$candidate") != "\$self" ]]; then
    printf '%s\\n' "\$candidate"
    return 0
  fi

  return 1
}

real_opencode=\$(find_real_command) || {
  printf 'Real %s executable not found\\n' "\$command_name" >&2
  exit 127
}

exec 9>"\$lock_file"
flock 9

relay_pid=
[[ ! -r \$pid_file ]] || read -r relay_pid < "\$pid_file"

relay_matches_namespace=false
if [[ \$relay_pid =~ ^[0-9]+\$ ]] && kill -0 "\$relay_pid" 2>/dev/null && [[ -S \$socket ]]; then
  relay_namespace=\$(readlink "/proc/\$relay_pid/ns/net" 2>/dev/null || true)
  current_namespace=\$(readlink /proc/self/ns/net 2>/dev/null || true)
  [[ -n \$relay_namespace && \$relay_namespace == "\$current_namespace" ]] && relay_matches_namespace=true
fi

if [[ \$relay_matches_namespace != true ]]; then
  if [[ \$relay_pid =~ ^[0-9]+\$ ]] && kill -0 "\$relay_pid" 2>/dev/null; then
    kill "\$relay_pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "\$relay_pid" 2>/dev/null || break
      sleep 0.05
    done
  fi

  rm -f "\$socket"
  nohup /usr/bin/socat \\
    "UNIX-LISTEN:\$socket,fork,unlink-early,mode=600" \\
    "TCP:127.0.0.1:\$backend_port" >"\$log_file" 2>&1 &
  relay_pid=\$!
  printf '%s\\n' "\$relay_pid" > "\$pid_file"

  for _ in {1..20}; do
    [[ -S \$socket ]] && break
    kill -0 "\$relay_pid" 2>/dev/null || break
    sleep 0.05
  done
fi

flock -u 9
exec 9>&-

if ! tailscale serve --bg --yes http://127.0.0.1:$bridgePort >/dev/null 2>&1; then
  printf 'Warning: could not update the Tailscale Serve route\\n' >&2
fi

exec "\$real_opencode" "\$@"
EOF
chmod 0755 "$wrapper"

installWrapperLink() {
  local link=$1 name
  if [[ -e $link && ! -L $link ]]; then
    name=$(basename "$link")
    mv -f "$link" "$libexecDirectory/$name-real"
  fi
  ln -sfn "$wrapper" "$link"
}

installWrapperLink "$stableLink"
if [[ -n $betaCommand ]]; then
  installWrapperLink "$betaLink"
fi

cat > "$fishDirectory/opencode-tailscale.fish" <<'EOF'
# Resolve the namespace-aware OpenCode wrapper before the installed binary.
fish_add_path --prepend --move $HOME/.local/bin
EOF

cat > "$serviceFile" <<EOF
[Unit]
Description=Bridge Tailscale Serve to OpenCode's active network namespace

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:$bridgePort,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:%t/opencode-tailscale.sock
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now opencode-tailscale-bridge.service

PATH="$binDirectory:$PATH" "$stableLink" service restart >/dev/null
tailscale serve --bg --yes "http://127.0.0.1:$bridgePort" >/dev/null

status=$(curl -sS -u "opencode:$password" -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 15 "http://127.0.0.1:$bridgePort/")
[[ $status == 200 ]] || die "OpenCode bridge verification returned HTTP $status"

printf '\nOpenCode Tailscale bridge installed successfully.\n'
printf 'Run normally: opencode\n'
printf 'Run through wg2: wg2-run opencode\n'
printf 'Login username: opencode\n'
printf 'Login password: %s\n' "$password"
printf 'Tailscale URL:\n'
tailscale serve status
