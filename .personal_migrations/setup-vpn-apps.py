#!/usr/bin/env python3
"""One user-level entry point for isolated apps, OpenCode and the Browse bridge."""

import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


HERE = Path(__file__).resolve().parent
MARKER = "# Managed by personal-migrations setup-vpn-apps"
ALIASES = {
    "brave": ("brave-browser.desktop", "brave.desktop"),
    "t3code": ("t3code.desktop", "com.t3tools.T3Code.desktop", "t3code-url-handler.desktop"),
}


def run(*arguments, **options):
    return subprocess.run([str(value) for value in arguments], check=True, **options)


def host_run(*arguments, **options):
    # The user's systemd manager stays on the host even when this command uses wgN-run.
    return run("systemd-run", "--user", "--pipe", "--wait", "--collect", "--quiet",
               *arguments, **options)


def directory(variable, fallback):
    path = Path(os.environ.get(variable, str(fallback)))
    if not path.is_absolute() or any(char in str(path) for char in "\n\r\0"):
        raise ValueError(f"{variable} must be an absolute path without control characters.")
    return path


def locations():
    home = directory("HOME", Path.home())
    return {
        "home": home,
        "config": directory("XDG_CONFIG_HOME", home / ".config"),
        "data": directory("XDG_DATA_HOME", home / ".local/share"),
        "bin": directory("XDG_BIN_HOME", home / ".local/bin"),
    }


def read_json(path):
    if path.is_symlink():
        raise RuntimeError(f"Refusing a state/config symlink: {path}")
    if not path.exists():
        return {}
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def write(path, text, mode=0o644):
    if path.is_symlink():
        raise RuntimeError(f"Refusing to overwrite a symlink: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(path, value):
    write(path, json.dumps(value, indent=2) + "\n", 0o600)


def quote(value):
    """Desktop Exec quoting (not shell quoting); percent is a desktop field escape."""
    value = str(value).replace("%", "%%")
    value = value.replace("\\", "\\\\\\\\")
    for character in ('"', "`", "$"):
        value = value.replace(character, "\\\\" + character)
    return '"' + value + '"'


def systemd_quote(value):
    return '"' + str(value).replace("%", "%%").replace("$", "$$").replace("\\", "\\\\").replace('"', '\\"') + '"'


def application_directories(paths):
    directories = [paths["data"] / "applications"]
    for value in os.environ.get("XDG_DATA_DIRS", "/usr/local/share:/usr/share").split(":"):
        if value:
            root = Path(value)
            if not root.is_absolute():
                raise ValueError("XDG_DATA_DIRS entries must be absolute.")
            directories.append(root / "applications")
    return list(dict.fromkeys(directories))


def sources(app, paths, replace=False):
    explicit = Path(app)
    if "/" in app:
        if not explicit.is_absolute() or explicit.suffix != ".desktop" or not explicit.is_file():
            raise ValueError("Explicit launchers must be existing absolute .desktop paths.")
        return [explicit]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", app):
        raise ValueError(f"Invalid application/desktop ID: {app}")
    names = ALIASES.get(app, (app if app.endswith(".desktop") else app + ".desktop",))
    result = []
    for name in names:
        for root in application_directories(paths):
            candidate = root / name
            if candidate.is_file():
                result.append(candidate)
                break
        if result and not replace:
            break
    if not result:
        raise RuntimeError(f"No desktop entry found for {app}. Pass its absolute .desktop path.")
    return result


def vpn_exec(command, namespace, app, paths):
    tokens = shlex.split(command)
    if not tokens:
        raise ValueError("Empty desktop Exec command.")
    runner = f"{namespace}-run"
    already_isolated = re.fullmatch(r"wg[0-9]+-run", Path(tokens[0]).name)
    if already_isolated:
        if Path(tokens[0]).name != runner:
            raise RuntimeError("This launcher already uses another namespace.")
    extra = ""
    brave = Path(app).name in ("brave", "brave-browser", *ALIASES["brave"])
    if brave and not any(token.startswith("--user-data-dir") for token in tokens):
        profile = paths["config"] / f"BraveSoftware/Brave-Browser-{namespace}"
        extra = " " + quote(f"--user-data-dir={profile}")
    # Do not split the executable on whitespace: quoted AppImage paths can contain
    # spaces. Preserve desktop field codes and env arguments rather than adding a shell.
    if extra:
        field = re.search(r"(?<!\S)%[uUfF](?!\S)", command)
        command = command[:field.start()] + extra.strip() + " " + command[field.start():] if field else command + extra
    return command if already_isolated else quote(f"/usr/local/bin/{runner}") + " " + command


def render_launcher(text, namespace, app, paths, replace):
    lines = text.splitlines()
    # Some vendor entries append MimeType after their final Desktop Action.
    # Preserve those associations in the main group, where the key is valid.
    mime_types = list(dict.fromkeys(
        value for line in lines if line.startswith("MimeType=")
        for value in line[9:].split(";") if value
    ))
    result = [MARKER]
    section = ""
    main_exec = 0
    main_seen = False
    main_mime = False
    for line in lines:
        if line == MARKER:
            continue
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if section == "[Desktop Entry]":
                if mime_types and not main_mime:
                    result.append("MimeType=" + ";".join(mime_types) + ";")
                result.append("DBusActivatable=false")
            section = stripped
            main_seen |= section == "[Desktop Entry]"
        if section == "[Desktop Entry]" and line.startswith("DBusActivatable="):
            continue
        if line.startswith("MimeType="):
            if section.startswith("[Desktop Action "):
                continue
            if section == "[Desktop Entry]":
                line = "MimeType=" + ";".join(mime_types) + ";"
                main_mime = True
        if (section == "[Desktop Entry]" or section.startswith("[Desktop Action ")) and line.startswith("Exec="):
            line = "Exec=" + vpn_exec(line[5:], namespace, app, paths)
            main_exec += section == "[Desktop Entry]"
        if not replace and section == "[Desktop Entry]" and re.match(r"Name(?:\[[^]]+\])?=", line):
            line += " VPN" if namespace == "wg2" else f" VPN ({namespace})"
        result.append(line)
    if section == "[Desktop Entry]":
        if mime_types and not main_mime:
            result.append("MimeType=" + ";".join(mime_types) + ";")
        result.append("DBusActivatable=false")
    if not main_seen or main_exec != 1:
        raise ValueError("A desktop entry must have exactly one main Exec command.")
    return "\n".join(result) + "\n"


def launcher_plan(selections, namespace, paths, state):
    applications = paths["data"] / "applications"
    planned = {}
    for app, replace in selections:
        for source in sources(app, paths, replace):
            if replace:
                target = applications / source.name
            else:
                stem = app if app in ALIASES else source.stem
                target = applications / f"{stem}-{'vpn' if namespace == 'wg2' else namespace}.desktop"
            if target in planned:
                raise ValueError(f"Overlapping launcher requests: {target}")
            if target.is_symlink():
                raise RuntimeError(f"Refusing a launcher symlink: {target}")
            previous = state.get(str(target))
            before = target.read_text() if target.exists() else None
            if previous and before not in (previous["applied"], previous["before"]):
                raise RuntimeError(f"Launcher was edited since installation; preserve/reconcile it first: {target}")
            baseline = previous["baseline"] if previous else source.read_text()
            applied = render_launcher(baseline, namespace, app, paths, replace)
            if not previous and before is not None and not replace and before != applied:
                # Adopt only the previous Brave-specific migration's launcher.
                legacy = (app == "brave" and target.name == "brave-vpn.desktop"
                          and "Exec=wg2-run brave --user-data-dir=" in before)
                if not legacy:
                    raise RuntimeError(f"An unrelated VPN launcher already exists: {target}")
            planned[target] = {
                "app": app, "namespace": namespace, "baseline": baseline, "applied": applied,
                "before": previous["before"] if previous else before,
                "mode": previous["mode"] if previous else (target.stat().st_mode & 0o777 if target.exists() else 0o644),
            }
    return planned


def refresh_launchers(paths):
    if shutil.which("update-desktop-database"):
        run("update-desktop-database", paths["data"] / "applications")


def install_launchers(planned, paths, state):
    state_path = paths["data"] / "vpn-app-launchers/state.json"
    # Retain the first originals before replacing any launcher, including user entries.
    updated = {**state, **{str(path): entry for path, entry in planned.items()}}
    write_json(state_path, updated)
    for path, entry in planned.items():
        write(path, entry["applied"], entry["mode"])
    refresh_launchers(paths)


def restore_launchers(selections, paths, state, dry_run=False):
    selected = {app for app, _ in selections}
    entries = {name: entry for name, entry in state.items() if entry["app"] in selected}
    for name, entry in entries.items():
        path = Path(name)
        if path.is_symlink():
            raise RuntimeError(f"Refusing to restore a launcher symlink: {path}")
        current = path.read_text() if path.exists() else None
        if current not in (entry["applied"], entry["before"]):
            raise RuntimeError(f"Refusing to restore a launcher changed after installation: {path}")
    if dry_run:
        print(json.dumps({"restore": list(entries)}, indent=2))
        return
    for name, entry in entries.items():
        path = Path(name)
        if (path.read_text() if path.exists() else None) == entry["before"]:
            pass  # The install stopped before this file was changed, or it was already restored.
        elif entry["before"] is None:
            path.unlink()
        else:
            write(path, entry["before"], entry["mode"])
        del state[name]
    write_json(paths["data"] / "vpn-app-launchers/state.json", state)
    refresh_launchers(paths)


def browse_units(namespace, binary):
    host = f"browse-{namespace}-host.service"
    local = f"browse-{namespace}-local.service"
    service = "Restart=on-failure\nRestartSec=2\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
    return {
        "browse-relay.service": (
            "[Unit]\nDescription=Shared host Browse relay for Brave and VPN-isolated agents\n"
            "StartLimitIntervalSec=0\n\n[Service]\n"
            f"ExecStart={systemd_quote(binary)} serve\n" + service
        ),
        host: (
            "[Unit]\nDescription=Private socket access to the host Browse relay\n"
            "Wants=browse-relay.service\nAfter=browse-relay.service\nStartLimitIntervalSec=0\n\n[Service]\n"
            f"ExecStart=/usr/bin/socat UNIX-LISTEN:%t/browse-{namespace}.sock,unlink-early,fork,mode=0600 "
            "TCP4:127.0.0.1:19988,connect-timeout=5\n" + service
        ),
        local: (
            "[Unit]\nDescription=Connect VPN-isolated browsers and agents to Browse\n"
            f"Wants={host}\nAfter={host}\nStartLimitIntervalSec=0\n\n[Service]\n"
            f"ExecStart=/usr/local/bin/{namespace}-run /usr/bin/socat "
            "TCP4-LISTEN:19988,bind=127.0.0.1,reuseaddr,fork "
            f"UNIX-CONNECT:%t/browse-{namespace}.sock\n" + service
        ),
    }


def browse_status(binary, browser=None):
    """Wait for observable startup/reconnection, not a fixed startup delay."""
    deadline = time.monotonic() + 30
    while True:
        try:
            result = host_run(binary, "status", "--json", capture_output=True, text=True)
            status = json.loads(result.stdout)
            connected = status.get("extension", {}).get("browsers", [])
            if status.get("relay", {}).get("running") and (
                browser is None or any(value["id"] == browser and value["connected"] for value in connected)
            ):
                return status
        except subprocess.CalledProcessError:
            pass  # The service may have exec'd but not bound its socket yet.
        if time.monotonic() >= deadline:
            raise RuntimeError("Browse did not become ready. Check browse-relay.service and the browser extension.")
        time.sleep(0.2)


def setup_browse(namespace, paths, upgrade=False):
    if os.environ.get("OPENCODE_BROWSER_HOME") or os.environ.get("OPENCODE_BROWSER_PORT", "19988") != "19988":
        raise RuntimeError("This shared relay uses standard Browse storage and port 19988; unset custom Browse home/port overrides.")
    binary = paths["bin"] / "browse"
    units = browse_units(namespace, binary)
    root = paths["config"] / "systemd/user"
    for name in units:
        path = root / name
        if path.is_symlink():
            raise RuntimeError(f"Refusing a service symlink: {path}")
        if path.exists():
            existing = path.read_text()
            expected = {
                "browse-relay.service": (f"ExecStart={binary} serve", f"ExecStart={systemd_quote(binary)} serve"),
                f"browse-{namespace}-host.service": (f"ExecStart=/usr/bin/socat UNIX-LISTEN:%t/browse-{namespace}.sock,",),
                f"browse-{namespace}-local.service": (f"ExecStart=/usr/local/bin/{namespace}-run /usr/bin/socat ",),
            }[name]
            if not any(value in existing for value in expected):
                raise RuntimeError(f"Refusing an unrelated service: {path}")
    installed = binary.is_file()
    if upgrade or not installed:
        # Same official installer as curl | bash, but fail before execution if curl
        # fails, and defer interactive pairing until the host relay is supervised.
        with tempfile.TemporaryDirectory(prefix="browse-installer-") as temporary:
            installer = Path(temporary) / "install.sh"
            run("curl", "-fsSL", "https://opencode.ai/browse/install", "-o", installer)
            run("bash", installer, "--no-setup")
    try:
        existing = json.loads(host_run(binary, "status", "--json", capture_output=True, text=True).stdout)
    except subprocess.CalledProcessError:
        existing = {}
    if existing.get("relay", {}).get("running"):
        try:
            run("systemctl", "--user", "is-active", "--quiet", "browse-relay.service",
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(
                "A standalone Browse relay already occupies port 19988. Stop it before running this migration; "
                "the shared relay must be supervised by browse-relay.service."
            ) from error
    config = paths["config"] / "browse/config.json"
    settings = read_json(config)
    hostname_changed = settings.get("hostname", "127.0.0.1") != "127.0.0.1"
    if config.exists() and not config.with_suffix(".json.before-vpn-apps").exists():
        write(config.with_suffix(".json.before-vpn-apps"), config.read_text(), 0o600)
    settings["hostname"] = "127.0.0.1"
    write_json(config, settings)
    changed = []
    for name, text in units.items():
        path = root / name
        if not path.exists() or path.read_text() != text:
            if path.exists():
                backup = path.with_name(path.name + ".before-vpn-apps")
                if not backup.exists():
                    write(backup, path.read_text())
            write(path, text)
            changed.append(name)
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", "--now", *units)
    status = browse_status(binary)
    cli_version = run(binary, "--version", capture_output=True, text=True).stdout.strip()
    relay = status.get("relay", {})
    if "browse-relay.service" in changed or upgrade or hostname_changed or relay.get("stale") or relay.get("version") != cli_version:
        run("systemctl", "--user", "restart", "browse-relay.service")
    for name in changed:
        if name != "browse-relay.service":
            run("systemctl", "--user", "restart", name)
    browse_status(binary)
    # Official setup preserves the user's other agent settings and paired profiles.
    host_run(binary, "install", "--agent", "opencode", "--yes", "--no-open", "--no-wait")
    host_run(binary, "status")
    print("Pair each browser separately: setup-vpn-apps.py pair brave, then pair brave-vpn.")


def pair_browser(label, paths):
    """Give the newly paired profile a stable selector without revoking old keys."""
    if label not in ("brave", "brave-vpn"):
        raise ValueError("Pairing label must be brave or brave-vpn.")
    registry = paths["data"] / "browse/browsers.json"
    before = read_json(registry)
    host_run(paths["bin"] / "browse", "pair", "--wait-seconds", "600")
    after = read_json(registry)
    new = set(after) - set(before)
    if len(new) != 1:
        raise RuntimeError("No unique new browser profile was found; existing names and pairings were left untouched.")
    key = new.pop()
    reserved = {value["id"] for value in after.values()}
    for old_key, value in after.items():
        if old_key != key and value["id"] == label:
            suffix = label + "-old"
            index = 2
            while suffix in reserved:
                suffix = f"{label}-old-{index}"
                index += 1
            value["id"] = suffix
            reserved.add(suffix)
            print(f"Preserved the previous pairing as {suffix}; use browse pair --revoke {suffix} to remove it.")
    after[key]["id"] = label
    backup = registry.with_suffix(".json.before-vpn-apps")
    if not backup.exists():
        write_json(backup, before)
    write_json(registry, after)
    run("systemctl", "--user", "restart", "browse-relay.service")
    browse_status(paths["bin"] / "browse", browser=label)
    host_run(paths["bin"] / "browse", "status")


def ensure_namespace(namespace):
    runner = Path(f"/usr/local/bin/{namespace}-run")
    if not runner.exists():
        host_namespace = host_run("/usr/bin/readlink", "/proc/self/ns/net", capture_output=True, text=True).stdout.strip()
        if os.readlink("/proc/self/ns/net") != host_namespace:
            raise RuntimeError("Create a new VPN namespace from a normal host terminal, not from wgN-run.")
        user = pwd.getpwuid(os.getuid()).pw_name
        run("sudo", "--preserve-env=EDITOR,VISUAL", "bash", HERE / "setup-wg2-netns.sh",
            "--user", user, "--namespace", namespace)
    elif not Path(f"/run/netns/{namespace}").exists():
        run("sudo", "systemctl", "start", f"{namespace}-netns.service")


def check_runner(namespace):
    if not Path(f"/usr/local/bin/{namespace}-run").is_file():
        raise RuntimeError(f"Install {namespace}-run first, or use the full install action.")


def check_commands(args):
    commands = []
    if args.action == "install" and not args.skip_tailscale:
        commands += ["opencode", "tailscale", "fish", "jq", "openssl", "flock"]
    if args.action == "browse" or (args.action == "install" and not args.skip_browse):
        commands += ["curl", "socat", "systemctl", "systemd-run", "bash"]
    for command in commands:
        if not shutil.which(command):
            raise RuntimeError(f"Required command not found: {command}")


def main(arguments=None):
    parser = argparse.ArgumentParser(
        description="Set up VPN app launchers, OpenCode Tailscale access and one Browse relay for both Brave profiles.",
        epilog="Run in an independent desktop terminal, not as root. Replacement affects desktop/menu/URL launchers, not direct execution of packaged binaries.",
    )
    parser.add_argument("action", nargs="?", choices=("install", "launcher", "browse", "pair"), default="install")
    parser.add_argument("label", nargs="?", help="pair: brave or brave-vpn")
    parser.add_argument("--namespace", default="wg2")
    parser.add_argument("--app", action="append", default=[], help="Add a separate VPN launcher; repeat for multiple desktop IDs/paths (default: brave).")
    parser.add_argument("--replace", action="append", default=[], help="Replace normal user menu/URL launchers with VPN-only overrides; repeat for multiple apps.")
    parser.add_argument("--restore", action="store_true", help="launcher: restore selected apps' original launchers.")
    parser.add_argument("--skip-tailscale", action="store_true")
    parser.add_argument("--skip-browse", action="store_true")
    parser.add_argument("--opencode-backend-port", type=int, default=4096)
    parser.add_argument("--opencode-bridge-port", type=int, default=4097)
    parser.add_argument("--opencode-https-port", type=int, default=8443, help="Use a separate Tailscale HTTPS port so T3 can keep port 443.")
    parser.add_argument("--upgrade-browse", action="store_true", help="Download the current Browse binary even if already installed.")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan without downloads, file writes, authorization or service changes.")
    args = parser.parse_args(arguments)
    if os.geteuid() == 0:
        raise RuntimeError("Run as the desktop user, not with sudo.")
    if not re.fullmatch(r"wg(?:[2-9]|[1-9][0-9]{1,4})", args.namespace) or int(args.namespace[2:]) > 65535:
        raise ValueError("Namespace must be wg2 through wg65535.")
    if args.restore and args.action != "launcher":
        parser.error("--restore is only valid with launcher.")
    if args.label and args.action != "pair":
        parser.error("A browser label is only valid with pair.")
    if args.action == "pair" and args.label not in ("brave", "brave-vpn"):
        parser.error("pair requires a browser label: brave or brave-vpn.")
    if (args.app or args.replace) and args.action not in ("install", "launcher"):
        parser.error("--app and --replace are only valid with install or launcher.")
    for port in (args.opencode_backend_port, args.opencode_bridge_port, args.opencode_https_port):
        if not 1 <= port <= 65535:
            parser.error("Ports must be between 1 and 65535.")
    if args.opencode_backend_port == args.opencode_bridge_port:
        parser.error("OpenCode backend and bridge ports must differ.")
    paths = locations()
    if args.action == "pair":
        if args.dry_run:
            print(json.dumps({"pair": args.label, "relay": "host", "port": 19988}))
            return
        pair_browser(args.label, paths)
        return
    selections = [(app, False) for app in args.app] + [(app, True) for app in args.replace]
    if not selections and args.action in ("install", "launcher"):
        selections = [("brave", False)]
    state = read_json(paths["data"] / "vpn-app-launchers/state.json")
    if args.restore:
        restore_launchers(selections, paths, state, args.dry_run)
        return
    planned = launcher_plan(selections, args.namespace, paths, state)
    if args.dry_run:
        print(json.dumps({
            "namespace": args.namespace, "create_namespace_if_missing": args.action == "install",
            "launchers": {str(path): {
                "commands": [line[5:] for line in entry["applied"].splitlines() if line.startswith("Exec=")],
                "backup_existing": entry["before"] is not None,
            } for path, entry in planned.items()},
            "opencode_tailscale": args.action == "install" and not args.skip_tailscale,
            "opencode_https_port": args.opencode_https_port,
            "browse_units": browse_units(args.namespace, paths["bin"] / "browse")
            if args.action == "browse" or (args.action == "install" and not args.skip_browse) else {},
        }, indent=2))
        return
    if args.action == "install":
        check_commands(args)
        ensure_namespace(args.namespace)
    elif args.action == "browse":
        check_commands(args)
    check_runner(args.namespace)
    if args.action in ("install", "launcher"):
        install_launchers(planned, paths, state)
    if args.action == "install" and not args.skip_tailscale:
        run(f"/usr/local/bin/{args.namespace}-run", "bash", HERE / "setup-opencode-tailscale.sh",
            "--namespace", args.namespace, "--backend-port", str(args.opencode_backend_port),
            "--bridge-port", str(args.opencode_bridge_port), "--https-port", str(args.opencode_https_port))
    if args.action == "browse" or (args.action == "install" and not args.skip_browse):
        setup_browse(args.namespace, paths, args.upgrade_browse)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
