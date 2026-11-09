#!/usr/bin/env python3
"""Set up T3 Code's Tailscale HTTPS bridge without leaving its VPN namespace."""

import argparse
from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import pwd
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile


GENERATED = "# Managed by setup-t3code-tailscale"
DESKTOP_DEFAULTS = {
    "localEnvironmentEnabled": True,
    "serverExposureMode": "local-only",
    "tailscaleServeEnabled": False,
    "tailscaleServePort": 443,
}


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
        if path.stat().st_mode & 0o777 != mode:
            path.chmod(mode)
            return True
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


def desktop_exec(text):
    section = None
    entries = []
    for index, line in enumerate(text.splitlines(keepends=True)):
        stripped = line.strip()
        if stripped.startswith("["):
            section = stripped
        elif section == "[Desktop Entry]" and stripped.startswith("Exec="):
            entries.append((index, stripped[5:]))
    if len(entries) != 1:
        raise RuntimeError("Expected one Exec command in the T3 desktop entry.")
    return entries[0]


def replace_desktop_exec(text, command):
    index, _ = desktop_exec(text)
    lines = text.splitlines(keepends=True)
    ending = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
    lines[index] = "Exec=" + command + ending
    return "".join(lines)


def desktop_quote(value):
    # Desktop entries use double quotes, not shell single-quote escaping.
    escaped = value.replace("%", "%%")
    for character in ("\\", '"', "`", "$"):
        escaped = escaped.replace(character, "\\" + character)
    return '"' + escaped + '"'


def app_command(value, config, previous, wrapper):
    tokens = [token.replace("%%", "%") for token in shlex.split(value)]
    if tokens and tokens[0] == str(wrapper):
        if not previous or not previous.get("app_command"):
            raise RuntimeError("Cannot resolve the original T3 executable; use --desktop-executable.")
        return previous["app_command"]
    if tokens and re.fullmatch(r"t3code-.+-desktop", Path(tokens[0]).name):
        raise RuntimeError("Remove the desktop setup for the other namespace before installing this one.")
    environment = []
    while tokens:
        name = Path(tokens[0]).name
        if name == f"{config.namespace}-run" or re.fullmatch(r"wg\d+-run", name):
            tokens.pop(0)
        elif name == "env":
            tokens.pop(0)
            while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
                assignment = tokens.pop(0)
                if assignment.split("=", 1)[0] not in {
                    "T3CODE_HOME", "T3CODE_PORT", "T3CODE_HOST", "T3CODE_DESKTOP_LAUNCHER_PATH", "T3_BOOT_SERVICE_UNIT",
                }:
                    environment.append(assignment)
            if tokens and tokens[0].startswith("-"):
                raise RuntimeError("Unsupported env options in the launcher; use --desktop-executable.")
        else:
            break
    if tokens and tokens[0] == str(wrapper):
        if not previous or not previous.get("app_command"):
            raise RuntimeError("Cannot resolve the original T3 executable; use --desktop-executable.")
        return (["/usr/bin/env", *environment] if environment else []) + previous["app_command"]
    if tokens and re.fullmatch(r"t3code-.+-desktop", Path(tokens[0]).name):
        raise RuntimeError("Remove the desktop setup for the other namespace before installing this one.")
    tokens = [token for token in tokens if token not in ("%U", "%u", "%F", "%f")]
    if not tokens or any(re.search(r"%[ick]", token) for token in tokens):
        raise RuntimeError("Unsupported desktop field codes; use --desktop-executable.")
    executable = shutil.which(tokens[0]) if not Path(tokens[0]).is_absolute() else tokens[0]
    if not executable or not os.access(executable, os.X_OK):
        raise RuntimeError(f"Desktop executable is missing or not executable: {tokens[0]}")
    if "t3code" not in re.sub(r"[^a-z0-9]", "", Path(executable).name.lower()):
        raise RuntimeError("The desktop entry does not launch T3 Code; use --desktop-executable.")
    if any("__service-launcher" in token or "/apps/server/" in token for token in tokens):
        raise RuntimeError("The entry launches a server, not the T3 desktop application.")
    tokens[0] = executable
    return (["/usr/bin/env", *environment] if environment else []) + tokens


def background_service(t3_home, home):
    result = run("/usr/bin/systemctl", "--user", "show", "t3code.service",
                 "--property=LoadState,UnitFileState,ActiveState,Environment", check=False, capture=True)
    values = dict(line.split("=", 1) for line in (result.stdout or "").splitlines() if "=" in line)
    if values.get("LoadState", "not-found") == "not-found":
        return {"present": False, "enabled": False, "active": False}
    environment = dict(part.split("=", 1) for part in shlex.split(values.get("Environment", "")) if "=" in part)
    service_home = Path(environment.get("T3CODE_HOME", str(home / ".t3"))).expanduser().resolve()
    if service_home != t3_home.resolve():
        raise RuntimeError("t3code.service uses a different T3 home; refusing to stop an unrelated server.")
    enabled = values.get("UnitFileState", "disabled")
    if enabled not in ("enabled", "enabled-runtime", "disabled", "static"):
        raise RuntimeError(f"Unsupported T3 background-service state: {enabled}")
    return {"present": True, "enabled": enabled in ("enabled", "enabled-runtime"),
            "runtime_enabled": enabled == "enabled-runtime", "active": values.get("ActiveState") == "active"}


def prepare_desktop(config, home, config_home, executable=None, t3_home=None):
    data_home = Path(os.environ.get("XDG_DATA_HOME") or home / ".local/share")
    if not data_home.is_absolute():
        raise ValueError("XDG_DATA_HOME must be an absolute path.")
    state_path = data_home / config.command / "desktop-original.json"
    if state_path.is_symlink():
        raise RuntimeError(f"Refusing a desktop-backup symlink: {state_path}")
    previous = json.loads(state_path.read_text()) if state_path.exists() else None
    requested_home = t3_home or os.environ.get("T3CODE_HOME") or (previous or {}).get("t3_home")
    t3_home = Path(requested_home or home / ".t3").expanduser().absolute()
    if previous and previous["t3_home"] != str(t3_home):
        raise RuntimeError("Remove the previous desktop setup before changing --t3-home.")
    wrapper = home / ".local/bin" / f"t3code-{config.namespace}-desktop"
    manager = home / ".local/bin" / config.command
    ensure_owned(wrapper, config.marker)
    applications = data_home / "applications"
    directories = [applications, *[Path(part) / "applications" for part in
                   os.environ.get("XDG_DATA_DIRS", "/usr/local/share:/usr/share").split(":") if part]]
    launchers = {}
    selected = None
    explicit = None
    if executable:
        explicit_path = str(Path(executable).expanduser())
        explicit_path = shutil.which(explicit_path) or str(Path(explicit_path).resolve())
        if not Path(explicit_path).is_absolute() or not os.access(explicit_path, os.X_OK):
            raise RuntimeError("--desktop-executable must identify an executable T3 desktop application.")
        explicit = [explicit_path]
    seen = set()
    for directory in directories:
        if not directory.is_dir():
            continue
        for source in sorted(directory.glob("*.desktop"), key=lambda path: (path.name != "t3code.desktop", path.name)):
            if source.name in seen:
                continue
            seen.add(source.name)
            text = source.read_text(errors="replace")
            if "t3code" not in re.sub(r"[^a-z0-9]", "", source.stem.lower()) and not re.search(r"^Name=T3\s*Code(?:\s|$)", text, re.I | re.M):
                continue
            target = applications / source.name
            if target.is_symlink():
                raise RuntimeError(f"Refusing a desktop-entry symlink: {target}")
            _, original_exec = desktop_exec(text)
            command = explicit or app_command(original_exec, config, previous, wrapper)
            if selected is None:
                selected = command
                if not requested_home:
                    assignments = [token.split("=", 1)[1] for token in shlex.split(original_exec)
                                   if token.startswith("T3CODE_HOME=")]
                    if assignments:
                        t3_home = Path(assignments[-1]).expanduser().absolute()
            launchers[str(target)] = {"before": target.read_text() if target.exists() else None,
                                      "baseline": text, "mode": target.stat().st_mode & 0o777 if target.exists() else 0o644,
                                      "applied": replace_desktop_exec(text, desktop_quote(str(wrapper)) + " %U")}
    if selected is None:
        candidates = [explicit] if explicit else [
            [str(home / ".local/share/t3code/T3-Code.AppImage")],
            [str(home / "Downloads/t3code.AppImage")],
            [shutil.which("t3code") or ""],
            [shutil.which("t3-code") or ""],
        ]
        selected = next((candidate for candidate in candidates if candidate and candidate[0]
                         and os.access(candidate[0], os.X_OK)), None)
        if selected is None:
            raise RuntimeError("T3 desktop was not found. Install it first or pass --desktop-executable PATH.")
        text = "[Desktop Entry]\nType=Application\nName=T3 Code\nExec=" + desktop_quote(selected[0]) + " %U\nIcon=t3code\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/t3code;\n"
        target = applications / "t3code.desktop"
        if target.exists():
            raise RuntimeError(f"Refusing to replace an unrelated desktop entry: {target}")
        launchers[str(target)] = {"before": None, "baseline": text, "mode": 0o644,
                                  "applied": replace_desktop_exec(text, desktop_quote(str(wrapper)) + " %U")}
    wrapper_text = (f"#!/usr/bin/env bash\n{config.marker}\nset -euo pipefail\n"
                    f"exec /usr/bin/python3 {shlex.quote(str(manager))} launch -- \"$@\"\n")
    settings = t3_home / "userdata/desktop-settings.json"
    if settings.is_symlink():
        raise RuntimeError(f"Refusing a desktop-settings symlink: {settings}")
    settings_document = json.loads(settings.read_text()) if settings.exists() else {}
    if not isinstance(settings_document, dict):
        raise ValueError("T3 desktop settings must be a JSON object.")
    service = background_service(t3_home, home)
    return {"state_path": state_path, "previous": previous, "t3_home": str(t3_home),
            "settings": settings, "settings_document": settings_document, "wrapper": wrapper,
            "wrapper_text": wrapper_text, "app_command": selected, "launchers": launchers,
            "service": service, "settings_values": {"localEnvironmentEnabled": True,
            "serverExposureMode": "local-only", "tailscaleServeEnabled": True, "tailscaleServePort": config.https_port}}


def stop_desktop(t3_home):
    # Gracefully close only this user's T3 desktop for this data directory. Never
    # kill an arbitrary process or delete server-owner.sqlite to bypass its lock.
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            executable = os.readlink(proc / "exe")
            if "t3code" not in re.sub(r"[^a-z0-9]", "", Path(executable).name.lower()):
                continue
            command = (proc / "cmdline").read_bytes()
            if any(value in command for value in (b"--type=", b"/apps/server/", b"--appimage-mount")):
                continue
            environment = dict(part.split(b"=", 1) for part in (proc / "environ").read_bytes().split(b"\0") if b"=" in part)
            owner_home = Path(os.fsdecode(environment.get(b"T3CODE_HOME", os.fsencode(Path.home() / ".t3")))).resolve()
            if owner_home != Path(t3_home).resolve():
                continue
            descriptor = os.pidfd_open(int(proc.name))
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGTERM)
                if not select.select([descriptor], [], [], 30)[0]:
                    raise RuntimeError("T3 did not close gracefully. Close it manually and rerun; it was not force-killed.")
            finally:
                os.close(descriptor)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue


def require_independent_terminal():
    # Closing T3 must not kill the terminal/agent running this migration halfway
    # through setup. SSH and independent desktop terminals are safe entry points.
    pid = os.getppid()
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        proc = Path("/proc") / str(pid)
        try:
            name = re.sub(r"[^a-z0-9]", "", Path(os.readlink(proc / "exe")).name.lower())
            if name == "t3" or "t3code" in name:
                raise RuntimeError("Run this migration in an independent terminal, not inside T3 or one of its agents: setup closes T3 before changing its backend mode.")
            status = (proc / "status").read_text()
            parent = re.search(r"^PPid:\s+(\d+)", status, re.MULTILINE)
            pid = int(parent[1]) if parent else 0
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            break


def install_desktop(config, plan):
    path = plan["state_path"]
    previous = plan["previous"]
    state = previous or {"version": 1, "t3_home": plan["t3_home"], "files": {},
                         "settings_existed": plan["settings"].exists(),
                         "settings_original": {key: plan["settings_document"][key] for key in plan["settings_values"]
                                               if key in plan["settings_document"]}, "service": plan["service"]}
    for name, entry in plan["launchers"].items():
        state["files"].setdefault(name, {key: entry[key] for key in ("before", "baseline", "mode")})
        state["files"][name]["applied"] = entry["applied"]
    wrapper = plan["wrapper"]
    state["files"].setdefault(str(wrapper), {"before": wrapper.read_text() if wrapper.exists() else None,
                                            "mode": wrapper.stat().st_mode & 0o777 if wrapper.exists() else 0o755})
    state["files"][str(wrapper)]["applied"] = plan["wrapper_text"]
    state["files"][str(wrapper)]["applied_mode"] = 0o755
    state.update(app_command=plan["app_command"], settings_applied=plan["settings_values"], wrapper=str(wrapper))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_write(path, json.dumps(state, indent=2) + "\n", 0o600)
    stop_desktop(plan["t3_home"])
    if plan["service"]["present"]:
        run("/usr/bin/systemctl", "--user", "disable", "--now", "t3code.service")
    listener = run(f"/usr/local/bin/{config.namespace}-run", "/usr/bin/ss", "-H", "-ltn", f"sport = :{config.backend_port}", capture=True)
    if (listener.stdout or "").strip():
        raise RuntimeError("Another server still owns the namespace backend port. No ownership lock was deleted; stop it before retrying.")
    document = json.loads(plan["settings"].read_text()) if plan["settings"].exists() else {}
    document.update(plan["settings_values"])
    plan["settings"].parent.mkdir(parents=True, exist_ok=True)
    settings_mode = plan["settings"].stat().st_mode & 0o777 if plan["settings"].exists() else 0o644
    atomic_write(plan["settings"], json.dumps(document, separators=(",", ":")) + "\n", settings_mode)
    current_files = [*plan["launchers"], str(wrapper)]
    for name in current_files:
        entry = state["files"][name]
        target = Path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(target, entry["applied"], entry.get("applied_mode", entry["mode"]))


def restore_desktop(state_path):
    if not state_path.exists():
        return
    if state_path.is_symlink():
        raise RuntimeError("Refusing a desktop-backup symlink.")
    state = json.loads(state_path.read_text())
    settings = Path(state["t3_home"]) / "userdata/desktop-settings.json"
    for path in [settings, *[Path(name) for name in state["files"]]]:
        if path.is_symlink():
            raise RuntimeError(f"Refusing to restore a symlink: {path}")
    service = state["service"]
    service_now = background_service(Path(state["t3_home"]), Path.home()) if service["present"] else {"present": False}
    stop_desktop(state["t3_home"])
    if settings.exists():
        document = json.loads(settings.read_text())
        for key, value in state["settings_applied"].items():
            # T3 omits default-valued keys when it saves the document.
            if document.get(key, DESKTOP_DEFAULTS[key]) == value:
                if key in state["settings_original"]:
                    document[key] = state["settings_original"][key]
                else:
                    document.pop(key, None)
        if document or state["settings_existed"]:
            atomic_write(settings, json.dumps(document, separators=(",", ":")) + "\n", settings.stat().st_mode & 0o777)
        else:
            settings.unlink()
    for name, entry in state["files"].items():
        target = Path(name)
        if target.is_symlink():
            raise RuntimeError(f"Refusing to restore a symlink: {target}")
        if not target.exists():
            continue
        current = target.read_text()
        if "baseline" in entry:
            _, command = desktop_exec(current)
            if [token.replace("%%", "%") for token in shlex.split(command)[:1]] != [state["wrapper"]]:
                continue  # Preserve a launcher the user has redirected elsewhere.
            restored = replace_desktop_exec(current, desktop_exec(entry["baseline"])[1])
            if restored != entry["baseline"]:
                atomic_write(target, restored, target.stat().st_mode & 0o777)
                continue
        elif current != entry["applied"]:
            continue  # Preserve a wrapper edited after installation.
        if entry["before"] is None:
            target.unlink()
        else:
            atomic_write(target, entry["before"], entry["mode"])
    if service["present"] and service_now["present"]:
        if service["enabled"]:
            arguments = ["/usr/bin/systemctl", "--user", "enable"]
            if service.get("runtime_enabled"):
                arguments.append("--runtime")
            run(*arguments, "t3code.service")
        if service["active"]:
            run("/usr/bin/systemctl", "--user", "start", "t3code.service")
    state_path.unlink()


def launch_desktop(config, saved, state_path, arguments):
    if not saved.get("desktop_managed") or not state_path.exists():
        raise RuntimeError("Install the desktop-managed setup before launching through this command.")
    state = json.loads(state_path.read_text())
    environment = ["/usr/bin/env", "-u", "T3_BOOT_SERVICE_UNIT", "-u", "T3CODE_HOST",
                   f"T3CODE_HOME={state['t3_home']}", f"T3CODE_PORT={config.backend_port}",
                   f"T3CODE_DESKTOP_LAUNCHER_PATH={state['wrapper']}"]
    runner = f"/usr/local/bin/{config.namespace}-run"
    os.execv(runner, [runner, *environment, *state["app_command"], *arguments])


def wait_for_desktop(config):
    port = "" if config.https_port == 443 else f":{config.https_port}"
    endpoint = f"https://{config.hostname}{port}/.well-known/t3/environment"
    result = run(f"/usr/local/bin/{config.namespace}-run", "/usr/bin/curl", "--noproxy", "*",
                 "--fail", "--silent", "--show-error", "--max-time", "5", "--retry", "12",
                 "--retry-connrefused", "--retry-all-errors", "--retry-delay", "1", "--retry-max-time", "60",
                 "--output", "/dev/null", endpoint, check=False)
    if result.returncode:
        raise RuntimeError("T3 desktop did not become reachable over HTTPS. Check its startup dialog and Tailscale Serve permissions. Backups are retained; rerun install after fixing the cause, or use remove to restore.")


def main(argv=None):
    script = Path(__file__).resolve()
    inferred = re.fullmatch(r"t3code-([a-zA-Z0-9_-]+)-bridge", script.name)
    parser = argparse.ArgumentParser(
        description="Configure desktop-managed T3 Code with Tailscale HTTPS inside a VPN namespace.",
        epilog="Run as the desktop user, not with sudo. Install requests administrator authorization. "
               "Requires T3 desktop, a connected Tailscale client, and an existing NAME-run launcher and NAME-netns.service. "
               "The desktop owns the backend, so Sharing & access stays available. Remote access requires keeping T3 open. "
               "Routes, firewall rules and Tailscale operator permissions are not changed.",
    )
    parser.add_argument("action", nargs="?", choices=("install", "status", "remove", "launch"),
                        default="status" if inferred else "install")
    parser.add_argument("--namespace", default=inferred[1] if inferred else "wg2")
    parser.add_argument("--backend-port", type=int, help="T3 backend port (initial default: 3773)")
    parser.add_argument("--https-port", type=int, help="Tailscale HTTPS port (initial default: 443)")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--desktop-managed", dest="desktop_managed", action="store_true", default=None,
                       help="Configure T3 desktop and disable its conflicting background server (default)")
    modes.add_argument("--bridge-only", dest="desktop_managed", action="store_false",
                       help="Install only the socket bridges; do not manage T3 desktop or its background service")
    parser.add_argument("--desktop-executable", help="T3 desktop executable/AppImage if automatic discovery cannot find it")
    parser.add_argument("--t3-home", help="Existing T3 home (default: T3CODE_HOME, saved setting, or ~/.t3)")
    parser.add_argument("--no-launch", action="store_true", help="Configure desktop mode but leave T3 closed")
    parser.add_argument("--dry-run", action="store_true", help="Print the installation plan without changing anything")
    parser.add_argument("--system-action", choices=("install", "remove"), help=argparse.SUPPRESS)
    parser.add_argument("--configuration", help=argparse.SUPPRESS)
    args, extra = parser.parse_known_args(argv)
    if extra and args.action != "launch":
        parser.error("unrecognized arguments: " + " ".join(extra))

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
    desktop_managed = args.desktop_managed if args.desktop_managed is not None else saved.get("desktop_managed", True)
    if not isinstance(desktop_managed, bool):
        raise ValueError("The saved desktop_managed setting must be a boolean.")
    data_home = Path(os.environ.get("XDG_DATA_HOME") or home / ".local/share")
    if not data_home.is_absolute():
        raise ValueError("XDG_DATA_HOME must be an absolute path.")
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
    desktop_state = data_home / config.command / "desktop-original.json"
    if args.action == "launch":
        if extra[:1] == ["--"]:
            extra = extra[1:]
        launch_desktop(config, saved, desktop_state, extra)
        return
    desktop = None
    if args.action == "install" and desktop_managed:
        desktop = prepare_desktop(config, home, config_home, args.desktop_executable,
                                  args.t3_home or saved.get("t3_home"))
    elif args.action == "install" and desktop_state.exists():
        raise RuntimeError("Remove the desktop-managed setup before switching to --bridge-only.")

    if args.dry_run:
        if args.action != "install":
            parser.error("--dry-run is only supported for install")
        print(json.dumps({"configuration": asdict(config), "desktop_managed": desktop_managed,
                          "desktop": {"t3_home": desktop["t3_home"], "settings": str(desktop["settings"]),
                                      "launcher": str(desktop["wrapper"]), "menu_entries": list(desktop["launchers"]),
                                      "disable_background_service": desktop["service"]["present"],
                                      "open_desktop_after_install": not args.no_launch} if desktop else None,
                          "command": str(manager),
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
        restore_desktop(desktop_state)
        print("Bridges removed. Previous desktop settings, launchers and background-service state restored where managed.")
        print("Management command retained for reinstall; conversations were not reset or deleted.")
        return

    check_prerequisites(config)
    if desktop:
        require_independent_terminal()
        for name in ("ss", "systemd-run", "curl"):
            if not shutil.which(name):
                raise RuntimeError(f"Required desktop setup command not found: {name}")
    for name in units:
        ensure_owned(unit_directory / name, config.marker)
    if script != manager and (manager.is_symlink() or (manager.exists()
        and GENERATED not in manager.read_text() and config.marker not in manager.read_text())):
        raise RuntimeError(f"Refusing to replace an unrelated command: {manager}")
    authorize(script, "install", config)
    if desktop:
        install_desktop(config, desktop)
    unit_directory.mkdir(parents=True, exist_ok=True)
    manager.parent.mkdir(parents=True, exist_ok=True)
    changed = []
    for name, text in units.items():
        if atomic_write(unit_directory / name, text):
            changed.append(name)
    if script != manager:
        atomic_write(manager, script.read_text(), 0o755)
    configuration = {**asdict(config), "desktop_managed": desktop_managed}
    if desktop:
        configuration["t3_home"] = desktop["t3_home"]
    atomic_write(config_path, json.dumps(configuration, indent=2) + "\n", 0o600)
    run("/usr/bin/systemctl", "--user", "daemon-reload")
    run("/usr/bin/systemctl", "--user", "enable", "--now", *units)
    if changed:
        run("/usr/bin/systemctl", "--user", "restart", *changed)
    print(f"Installed {config.command}. Keep T3 on backend port {config.backend_port} and HTTPS port {config.https_port}.")
    if desktop:
        run("/usr/bin/systemctl", "--user", "reset-failed", "t3code.service", check=False)
        if not args.no_launch:
            run("/usr/bin/systemd-run", "--user", "--collect", "--description=T3 Code desktop (VPN)", str(desktop["wrapper"]))
            wait_for_desktop(config)
        print("Desktop local environment and Sharing & access are enabled; the separate background server is disabled.")
        print("Keep T3 desktop open for remote access. Its previous settings and launchers were backed up.")
    else:
        print(f"Bridge-only mode: launch your backend inside {config.namespace} using the matching ports.")
    print("No routing, firewall or Tailscale permission changes were made.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, RuntimeError, TypeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"t3code-tailscale: {error}", file=sys.stderr)
        sys.exit(1)
