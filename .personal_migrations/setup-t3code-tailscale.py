#!/usr/bin/env python3
"""Set up T3 Code's Tailscale HTTPS bridge without leaving its VPN namespace."""

import argparse
from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tempfile


GENERATED = "# Managed by setup-t3code-tailscale"


@dataclass(frozen=True)
class Configuration:
    namespace: str
    user: str
    uid: int
    hostname: str
    backend_port: int = 3773
    https_port: int = 443

    def validate(self):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}", self.namespace):
            raise ValueError("Namespace must contain only letters, digits, underscores or hyphens.")
        if type(self.uid) is not int or self.uid <= 0:
            raise ValueError("A non-root desktop user is required.")
        if pwd.getpwuid(self.uid).pw_name != self.user:
            raise ValueError("The configured username does not match its UID.")
        if not re.fullmatch(r"[a-z_][a-z0-9_-]*\$?", self.user):
            raise ValueError("Unsupported desktop username.")
        if (
            len(self.hostname) > 253
            or not self.hostname.endswith(".ts.net")
            or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
                       for part in self.hostname.split("."))
        ):
            raise ValueError("Expected this machine's MagicDNS hostname ending in .ts.net.")
        for port in (self.backend_port, self.https_port):
            if type(port) is not int or not 1 <= port <= 65535:
                raise ValueError("Ports must be integers between 1 and 65535.")
        if self.backend_port == self.https_port:
            raise ValueError("The backend and HTTPS ports must differ inside the namespace.")
        return self

    @property
    def command(self):
        return f"t3code-{self.namespace}-bridge"

    @property
    def marker(self):
        return f"# Managed by {self.command}"

    @property
    def system_unit(self):
        return f"t3code-{self.namespace}-https.service"

    @property
    def begin(self):
        return f"# BEGIN {self.command}\n"

    @property
    def end(self):
        return f"# END {self.command}\n"


def run(*args, check=True, capture=False):
    return subprocess.run(args, check=check, capture_output=capture, text=True)


def atomic_write(path, text, mode=0o644):
    if path.is_symlink():
        raise RuntimeError(f"Refusing to replace a symlink: {path}")
    if path.exists() and path.read_text() == text:
        return False
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(text)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def without_alias(text, config):
    if config.begin not in text and config.end not in text:
        return text
    if text.count(config.begin) != 1 or text.count(config.end) != 1:
        raise RuntimeError("Unexpected hostname markers; inspect the namespace hosts file.")
    before, remaining = text.split(config.begin, 1)
    if config.end in before:
        raise RuntimeError("The namespace hostname markers are out of order.")
    _, after = remaining.split(config.end, 1)
    return before + after


def hosts_order(text):
    match = re.search(r"^[ \t]*hosts:[^\n]*", text, re.MULTILINE)
    if match is None:
        raise RuntimeError("No hosts database order found in nsswitch.conf.")
    return match


def files_first(text):
    match = hosts_order(text)
    sources = match.group().split(":", 1)[1].lstrip()
    if re.match(r"files(?:\s|$)", sources):
        return text
    # Keep existing NSS modules and their action clauses intact. A second files
    # lookup on a miss is harmless; moving tokens can detach an NSS action clause.
    return text[:match.start()] + "hosts: files " + sources + text[match.end():]


def user_units(config):
    namespace = config.namespace
    backend = f"t3code-{namespace}-backend.service"
    return {
        backend: f"""{config.marker}
[Unit]
Description=Expose the T3 Code backend inside {namespace} through a private Unix socket
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/local/bin/{namespace}-run /usr/bin/socat UNIX-LISTEN:%t/t3code-{namespace}-backend.sock,unlink-early,fork,mode=0600 TCP4:127.0.0.1:{config.backend_port},connect-timeout=5
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
""",
        f"t3code-{namespace}-host.service": f"""{config.marker}
[Unit]
Description=Forward host localhost T3 Code connections into {namespace}
Requires={backend}
After={backend}
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/socat TCP4-LISTEN:{config.backend_port},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:%t/t3code-{namespace}-backend.sock
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
""",
        f"t3code-{namespace}-https-host.service": f"""{config.marker}
[Unit]
Description=Make this host's Tailscale HTTPS endpoint available on a private Unix socket
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/socat UNIX-LISTEN:%t/t3code-{namespace}-https.sock,unlink-early,fork,mode=0600 TCP4:{config.hostname}:{config.https_port},connect-timeout=5
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
""",
    }


def system_unit(config):
    capabilities = (
        "AmbientCapabilities=CAP_NET_BIND_SERVICE\n"
        "CapabilityBoundingSet=CAP_NET_BIND_SERVICE\n"
        if config.https_port < 1024 else "CapabilityBoundingSet=\n"
    )
    return f"""{config.marker}
[Unit]
Description=Bridge {config.namespace} localhost HTTPS checks to this host's Tailscale endpoint
Requires={config.namespace}-netns.service
After={config.namespace}-netns.service
PartOf={config.namespace}-netns.service
StartLimitIntervalSec=0

[Service]
User={config.user}
NetworkNamespacePath=/run/netns/{config.namespace}
ExecStart=/usr/bin/socat TCP4-LISTEN:{config.https_port},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/user/{config.uid}/t3code-{config.namespace}-https.sock
Restart=on-failure
RestartSec=2
{capabilities}NoNewPrivileges=yes
RestrictAddressFamilies=AF_INET AF_UNIX
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
UMask=0077

[Install]
WantedBy={config.namespace}-netns.service
"""


def ensure_owned(path, marker):
    if path.is_symlink() or (path.exists() and marker not in path.read_text()):
        raise RuntimeError(f"Refusing to overwrite unrelated configuration: {path}")


def install_system(config, root=Path("/")):
    if not (root / f"run/netns/{config.namespace}").exists():
        raise RuntimeError(f"The {config.namespace} namespace must be running first.")
    directory = root / f"etc/netns/{config.namespace}"
    unit = root / "etc/systemd/system" / config.system_unit
    state_directory = root / "var/lib" / config.command
    state_path = state_directory / "original.json"
    for path in (directory, unit, state_directory, state_path):
        if path.is_symlink():
            raise RuntimeError(f"Refusing a symlink at a managed path: {path}")
    ensure_owned(unit, config.marker)
    if unit.exists() and f"User={config.user}\n" not in unit.read_text():
        raise RuntimeError("This namespace bridge belongs to another desktop user.")
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if "configuration" in state and state["configuration"]["uid"] != config.uid:
        raise RuntimeError("This namespace bridge belongs to another desktop user.")

    hosts = directory / "hosts"
    nss = directory / "nsswitch.conf"
    for path in (hosts, nss):
        if path.is_symlink():
            raise RuntimeError(f"Refusing to replace a symlink: {path}")
    base = without_alias(hosts.read_text() if hosts.exists() else (root / "etc/hosts").read_text(), config)
    if any(config.hostname in line.split("#", 1)[0].split() for line in base.splitlines()):
        raise RuntimeError("An unrelated namespace hosts entry already defines this Tailscale hostname.")
    nss_base = nss.read_text() if nss.exists() else (root / "etc/nsswitch.conf").read_text()
    expected_hosts = base + ("" if not base or base.endswith("\n") else "\n")
    expected_hosts += config.begin + f"127.0.0.1 {config.hostname}\n" + config.end

    for prefix, path in (("hosts", hosts), ("nss", nss)):
        if f"{prefix}_existed" not in state:
            state[f"{prefix}_existed"] = path.exists()
            state[f"{prefix}_original"] = path.read_text() if path.exists() else None
            state[f"{prefix}_mode"] = path.stat().st_mode & 0o777 if path.exists() else 0o644
    if "hosts_baseline" not in state:
        if state["hosts_existed"]:
            original = state["hosts_original"]
            state["hosts_baseline"] = original + ("" if not original or original.endswith("\n") else "\n")
        else:
            state["hosts_baseline"] = without_alias(state.get("hosts_installed", expected_hosts), config)
    state.setdefault("nss_base", nss_base)
    state.update(configuration=asdict(config), hosts_installed=expected_hosts, nss_installed=files_first(nss_base))

    state_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomic_write(state_path, json.dumps(state, indent=2) + "\n", 0o600)
    atomic_write(hosts, expected_hosts)
    atomic_write(nss, state["nss_installed"])
    active = run("/usr/bin/systemctl", "is-active", "--quiet", config.system_unit, check=False).returncode == 0
    changed = atomic_write(unit, system_unit(config))
    run("/usr/bin/systemctl", "daemon-reload")
    run("/usr/bin/systemctl", "enable", "--now", config.system_unit)
    if changed and active:
        run("/usr/bin/systemctl", "restart", config.system_unit)


def remove_system(config, root=Path("/")):
    unit = root / "etc/systemd/system" / config.system_unit
    state_directory = root / "var/lib" / config.command
    state_path = state_directory / "original.json"
    hosts = root / f"etc/netns/{config.namespace}/hosts"
    nss = hosts.with_name("nsswitch.conf")
    for path in (unit, state_directory, state_path, hosts.parent, hosts, nss):
        if path.is_symlink():
            raise RuntimeError(f"Refusing a symlink at a managed path: {path}")
    ensure_owned(unit, config.marker)
    if unit.exists() and f"User={config.user}\n" not in unit.read_text():
        raise RuntimeError("This namespace bridge belongs to another desktop user.")
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if "configuration" in state and state["configuration"]["uid"] != config.uid:
        raise RuntimeError("This namespace bridge belongs to another desktop user.")

    run("/usr/bin/systemctl", "disable", "--now", config.system_unit, check=False)
    unit.unlink(missing_ok=True)
    for prefix, path in (("hosts", hosts), ("nss", nss)):
        if not path.exists() or f"{prefix}_installed" not in state:
            continue
        current = path.read_text()
        if prefix == "hosts":
            restored = without_alias(current, config)
            baseline = state.get("hosts_baseline", without_alias(state["hosts_installed"], config))
        else:
            match = hosts_order(current)
            restored = current
            if match.group() == hosts_order(state["nss_installed"]).group():
                previous = hosts_order(state["nss_base"]).group()
                restored = current[:match.start()] + previous + current[match.end():]
            baseline = state["nss_base"]
        if restored != baseline:
            # Reinstalling must not make later unrelated edits look like our own.
            atomic_write(path, restored, path.stat().st_mode & 0o777)
        elif state[f"{prefix}_existed"]:
            atomic_write(path, state[f"{prefix}_original"], state[f"{prefix}_mode"])
            path.chmod(state[f"{prefix}_mode"])
        else:
            path.unlink()
    state_path.unlink(missing_ok=True)
    if state_directory.exists() and not any(state_directory.iterdir()):
        state_directory.rmdir()
    run("/usr/bin/systemctl", "daemon-reload")


def authorize(script, action, config):
    elevation = "/usr/bin/sudo" if sys.stdin.isatty() else "/usr/bin/pkexec"
    run(elevation, "/usr/bin/python3", str(script), "--system-action", action,
        "--configuration", json.dumps(asdict(config)))


def detect_hostname():
    status = json.loads(run("/usr/bin/tailscale", "status", "--json", capture=True).stdout)
    if status.get("BackendState") != "Running":
        raise RuntimeError("Connect this machine to Tailscale before installing the bridge.")
    return status["Self"]["DNSName"].rstrip(".").lower()


def check_prerequisites(config):
    for name in ("socat", "systemctl", "tailscale"):
        if not shutil.which(name):
            raise RuntimeError(f"Required command not found: {name}")
    if not Path(f"/usr/local/bin/{config.namespace}-run").is_file():
        raise RuntimeError(f"Install {config.namespace}-run before running this migration.")
    runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{config.uid}")
    if runtime != f"/run/user/{config.uid}":
        raise RuntimeError("This bridge requires systemd's standard /run/user/UID runtime directory.")


def main(argv=None):
    script = Path(__file__).resolve()
    inferred = re.fullmatch(r"t3code-([a-zA-Z0-9_-]+)-bridge", script.name)
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Run as the desktop user, not with sudo. Install requests administrator authorization. "
               "Requires an existing NAME-run launcher and NAME-netns.service. T3 must use the same ports. "
               "This migration does not edit T3 settings, launchers, routes, firewall rules or Tailscale permissions.",
    )
    parser.add_argument("action", nargs="?", choices=("install", "status", "remove"),
                        default="status" if inferred else "install")
    parser.add_argument("--namespace", default=inferred[1] if inferred else "wg2")
    parser.add_argument("--backend-port", type=int, help="T3 backend port (initial default: 3773)")
    parser.add_argument("--https-port", type=int, help="Tailscale HTTPS port (initial default: 443)")
    parser.add_argument("--dry-run", action="store_true", help="Print the installation plan without changing anything")
    parser.add_argument("--system-action", choices=("install", "remove"), help=argparse.SUPPRESS)
    parser.add_argument("--configuration", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.system_action:
        if os.geteuid() != 0:
            raise RuntimeError("The system configuration step requires administrator authorization.")
        config = Configuration(**json.loads(args.configuration)).validate()
        (install_system if args.system_action == "install" else remove_system)(config)
        return
    if os.geteuid() == 0:
        raise RuntimeError("Run this migration as the desktop user, not with sudo.")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}", args.namespace):
        raise ValueError("Invalid namespace name.")

    home = Path.home()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
    if not config_home.is_absolute():
        raise ValueError("XDG_CONFIG_HOME must be an absolute path.")
    config_path = config_home / f"t3code-{args.namespace}-bridge.json"
    if config_path.is_symlink():
        raise RuntimeError(f"Refusing to replace a symlink: {config_path}")
    saved = json.loads(config_path.read_text()) if config_path.exists() else {}
    account = pwd.getpwuid(os.getuid())
    config = Configuration(
        namespace=args.namespace, user=account.pw_name, uid=account.pw_uid,
        hostname=detect_hostname() if args.action == "install" else saved.get("hostname", "unused.ts.net"),
        backend_port=args.backend_port if args.backend_port is not None else saved.get("backend_port", 3773),
        https_port=args.https_port if args.https_port is not None else saved.get("https_port", 443),
    ).validate()
    units = user_units(config)
    unit_directory = config_home / "systemd/user"
    manager = home / ".local/bin" / config.command

    if args.dry_run:
        if args.action != "install":
            parser.error("--dry-run is only supported for install")
        print(json.dumps({"configuration": asdict(config), "command": str(manager),
                          "user_units": [str(unit_directory / name) for name in units],
                          "system_unit": f"/etc/systemd/system/{config.system_unit}",
                          "namespace_files": [f"/etc/netns/{config.namespace}/{name}"
                                              for name in ("hosts", "nsswitch.conf")]}, indent=2))
        return
    if args.action == "status":
        codes = [run("/usr/bin/systemctl", "--user", "--no-pager", "status", *units, check=False).returncode,
                 run("/usr/bin/systemctl", "--no-pager", "status", config.system_unit, check=False).returncode]
        if any(codes):
            raise RuntimeError("One or more bridge services are not running.")
        return
    if args.action == "remove":
        authorize(script, "remove", config)
        run("/usr/bin/systemctl", "--user", "disable", "--now", *units)
        print("Bridge disabled and namespace name-lookup settings restored. Runtime command retained for reinstall.")
        return

    check_prerequisites(config)
    for name in units:
        ensure_owned(unit_directory / name, config.marker)
    if script != manager and (manager.is_symlink() or (manager.exists()
        and GENERATED not in manager.read_text() and config.marker not in manager.read_text())):
        raise RuntimeError(f"Refusing to replace an unrelated command: {manager}")
    authorize(script, "install", config)
    unit_directory.mkdir(parents=True, exist_ok=True)
    manager.parent.mkdir(parents=True, exist_ok=True)
    changed = []
    for name, text in units.items():
        if atomic_write(unit_directory / name, text):
            changed.append(name)
    if script != manager:
        atomic_write(manager, script.read_text(), 0o755)
    atomic_write(config_path, json.dumps(asdict(config), indent=2) + "\n", 0o600)
    run("/usr/bin/systemctl", "--user", "daemon-reload")
    run("/usr/bin/systemctl", "--user", "enable", "--now", *units)
    if changed:
        run("/usr/bin/systemctl", "--user", "restart", *changed)
    print(f"Installed {config.command}. Keep T3 on backend port {config.backend_port} and HTTPS port {config.https_port}.")
    print(f"Fully quit T3, then launch it through {config.namespace}-run. No routing or firewall changes were made.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, RuntimeError, TypeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"t3code-tailscale: {error}", file=sys.stderr)
        sys.exit(1)
