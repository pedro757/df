"""Offline migration tests: temporary homes, no VPN changes, downloads or services."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "setup-vpn-apps.py"
SPEC = importlib.util.spec_from_file_location("vpn_apps", SOURCE)
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


class VpnAppTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vpn-app-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home with spaces"
        self.paths = {
            "home": self.home, "config": self.home / ".config",
            "data": self.home / ".local/share", "bin": self.home / ".local/bin",
        }
        self.system = self.root / "system-data/applications"
        self.system.mkdir(parents=True)
        self.state_path = self.paths["data"] / "vpn-app-launchers/state.json"
        self.environment = patch.dict(os.environ, {
            "HOME": str(self.home), "XDG_CONFIG_HOME": str(self.paths["config"]),
            "XDG_DATA_HOME": str(self.paths["data"]), "XDG_BIN_HOME": str(self.paths["bin"]),
            "XDG_DATA_DIRS": str(self.system.parent), "OPENCODE_BROWSER_PORT": "19988",
            "OPENCODE_BROWSER_HOME": "",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.refresh = patch.object(migration, "refresh_launchers").start()
        self.addCleanup(patch.stopall)

    def desktop(self, name, text):
        path = self.system / name
        path.write_text(text)
        return path

    def install(self, selections, namespace="wg2"):
        state = migration.read_json(self.state_path)
        plan = migration.launcher_plan(selections, namespace, self.paths, state)
        migration.install_launchers(plan, self.paths, state)
        return plan

    def browse_installation(self):
        binary = self.paths["bin"] / "browse"
        binary.parent.mkdir(parents=True)
        binary.touch(mode=0o755)
        root = self.paths["config"] / "systemd/user"
        for name, text in migration.browse_units("wg2", binary).items():
            migration.write(root / name, text)
        status = {
            "connected": True,
            "pairingState": "connected",
            "relay": {
                "version": "0.1.0", "endpoint": "http://127.0.0.1:19988",
                "instanceId": "fixture-relay", "pid": 4242,
            },
            "extension": {"browsers": [
                {"id": "brave", "connected": True},
                {"id": "brave-vpn", "connected": True},
            ]},
        }
        return binary, root, status

    @staticmethod
    def browse_command_result(*args, **kwargs):
        output = "0.1.0\n" if args[-1] == "--version" else "4242\n" if "--property=MainPID" in args else ""
        return subprocess.CompletedProcess(args, 0, stdout=output)

    def standalone_process(self, pid=5252):
        binary = self.paths["bin"] / "browse"
        binary.parent.mkdir(parents=True)
        binary.touch(mode=0o755)
        process = self.root / "proc" / str(pid)
        process.mkdir(parents=True)
        (process / "cmdline").write_bytes(os.fsencode(binary) + b"\0serve\0")
        (process / "exe").symlink_to(binary)
        (process / "cgroup").write_text("0::/user.slice/app-terminal.scope\n")
        return binary, process

    def test_brave_companion_keeps_host_launcher_and_isolates_all_vpn_actions(self):
        original = (
            "[Desktop Entry]\nName=Brave\nName[es]=Brave\nType=Application\n"
            "Exec=brave %U\nIcon=brave\nDBusActivatable=true\nActions=private;\n"
            "MimeType=x-scheme-handler/https;\n"
            "[Desktop Action private]\nName=Private\nExec=brave --incognito %U\n"
            "MimeType=application/pdf;\n"
        )
        source = self.desktop("brave-browser.desktop", original)
        plan = self.install([("brave", False)])
        target = self.paths["data"] / "applications/brave-vpn.desktop"
        text = target.read_text()
        self.assertEqual(source.read_text(), original)
        self.assertIn("Name=Brave VPN\n", text)
        self.assertIn("Name[es]=Brave VPN\n", text)
        self.assertNotIn("DBusActivatable=true", text)
        self.assertEqual(text.count("DBusActivatable=false"), 1)
        main, action = text.split("[Desktop Action private]")
        self.assertIn("MimeType=x-scheme-handler/https;application/pdf;\n", main)
        self.assertNotIn("MimeType=", action)
        commands = [shlex.split(line[5:]) for line in text.splitlines() if line.startswith("Exec=")]
        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertEqual(command[:2], ["/usr/local/bin/wg2-run", "brave"])
            self.assertIn(f"--user-data-dir={self.paths['config']}/BraveSoftware/Brave-Browser-wg2", command)
            self.assertEqual(command[-1], "%U")
        self.install([("brave", False)])
        self.assertEqual(migration.read_json(self.state_path)[str(target)], plan[target])
        migration.restore_launchers([("brave", False)], self.paths, migration.read_json(self.state_path))
        self.assertFalse(target.exists())
        self.assertEqual(source.read_text(), original)

    def test_replace_t3_covers_menu_protocol_handlers_and_quoted_appimage_paths(self):
        appimage = self.home / "Applications/T3 Code.AppImage"
        for name in migration.ALIASES["t3code"]:
            self.desktop(name, (
                "[Desktop Entry]\nName=T3 Code\nType=Application\n"
                f'Exec="{appimage}" --flag %U\n'
                "MimeType=x-scheme-handler/t3code;\nNoDisplay=true\n"
                "[Desktop Action new]\nName=New\n"
                f'Exec="{appimage}" --new-window %U\n'
            ))
        plan = self.install([("t3code", True)])
        self.assertEqual(len(plan), 3)
        for path in plan:
            text = path.read_text()
            self.assertIn("Name=T3 Code\n", text)
            self.assertIn("MimeType=x-scheme-handler/t3code;", text)
            self.assertIn("NoDisplay=true", text)
            for line in text.splitlines():
                if line.startswith("Exec="):
                    tokens = shlex.split(line[5:])
                    self.assertEqual(tokens[:2], ["/usr/local/bin/wg2-run", str(appimage)])
                    self.assertEqual(tokens[-1], "%U")
        self.assertFalse((self.paths["data"] / "applications/t3code-vpn.desktop").exists())
        migration.restore_launchers([("t3code", True)], self.paths, migration.read_json(self.state_path))
        self.assertTrue(all(not path.exists() for path in plan))

    def test_brave_desktop_id_and_explicit_path_also_get_an_isolated_profile(self):
        source = self.desktop("brave-browser.desktop", "[Desktop Entry]\nName=Brave\nExec=brave %U\n")
        for app in ("brave-browser", str(source)):
            with self.subTest(app=app):
                plan = migration.launcher_plan([(app, False)], "wg2", self.paths, {})
                entry = next(iter(plan.values()))
                command = next(line[5:] for line in entry["applied"].splitlines() if line.startswith("Exec="))
                self.assertIn(f"--user-data-dir={self.paths['config']}/BraveSoftware/Brave-Browser-wg2", shlex.split(command))

    def test_replace_keeps_user_original_and_does_not_nest_existing_runner(self):
        applications = self.paths["data"] / "applications"
        applications.mkdir(parents=True)
        path = applications / "editor.desktop"
        original = "[Desktop Entry]\nType=Application\nName=Editor\nExec=wg3-run editor %F\n"
        path.write_text(original)
        path.chmod(0o640)
        self.install([("editor", True)], "wg3")
        self.install([("editor", True)], "wg3")
        self.assertEqual(path.read_text().count("wg3-run"), 1)
        state = migration.read_json(self.state_path)
        self.assertEqual(state[str(path)]["before"], original)
        self.assertEqual(self.state_path.stat().st_mode & 0o777, 0o600)
        migration.restore_launchers([("editor", True)], self.paths, state)
        self.assertEqual(path.read_text(), original)
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_edited_launchers_are_not_overwritten_or_restored(self):
        self.desktop("editor.desktop", "[Desktop Entry]\nType=Application\nName=Editor\nExec=editor %F\n")
        plan = self.install([("editor", True)])
        path = next(iter(plan))
        edited = path.read_text() + "# My later edit\n"
        path.write_text(edited)
        with self.assertRaisesRegex(RuntimeError, "edited"):
            self.install([("editor", True)])
        with self.assertRaisesRegex(RuntimeError, "changed"):
            migration.restore_launchers([("editor", True)], self.paths, migration.read_json(self.state_path))
        self.assertEqual(path.read_text(), edited)

    def test_interrupted_launcher_install_can_resume_without_losing_originals(self):
        for name in migration.ALIASES["t3code"]:
            self.desktop(name, "[Desktop Entry]\nType=Application\nName=T3 Code\nExec=t3code %U\n")
        original_write = migration.write
        writes = 0

        def interrupted(path, *args, **kwargs):
            nonlocal writes
            if path.suffix == ".desktop":
                writes += 1
                if writes == 2:
                    raise OSError("interrupted file write")
            return original_write(path, *args, **kwargs)

        with patch.object(migration, "write", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.install([("t3code", True)])
        plan = self.install([("t3code", True)])
        self.assertEqual(len(plan), 3)
        migration.restore_launchers([("t3code", True)], self.paths, migration.read_json(self.state_path))
        self.assertTrue(all(not path.exists() for path in plan))

    def test_symlinks_and_conflicting_side_by_side_entries_are_preserved(self):
        self.desktop("editor.desktop", "[Desktop Entry]\nType=Application\nName=Editor\nExec=editor %F\n")
        target = self.paths["data"] / "applications/editor-vpn.desktop"
        target.parent.mkdir(parents=True)
        target.write_text("unrelated launcher\n")
        with self.assertRaisesRegex(RuntimeError, "unrelated"):
            self.install([("editor", False)])
        target.unlink()
        elsewhere = self.root / "untouched"
        elsewhere.write_text("original\n")
        target.symlink_to(elsewhere)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.install([("editor", False)])
        self.assertEqual(elsewhere.read_text(), "original\n")
        self.assertFalse(self.state_path.exists())

    def test_dry_run_and_invalid_namespace_never_authorize_or_write(self):
        self.desktop("brave-browser.desktop", "[Desktop Entry]\nType=Application\nName=Brave\nExec=brave %U\n")
        output = io.StringIO()
        with patch.object(migration.os, "geteuid", return_value=1000), patch.object(migration, "run") as run:
            with redirect_stdout(output):
                migration.main(["--dry-run"])
            run.assert_not_called()
            self.assertFalse(self.home.exists())
            plan = json.loads(output.getvalue())
            self.assertTrue(plan["opencode_tailscale"])
            self.assertTrue(plan["create_namespace_if_missing"])
            self.assertEqual(len(plan["browse_units"]), 3)
            with self.assertRaisesRegex(ValueError, "Namespace"):
                migration.main(["--namespace", "wg2\nExecStart=/bin/false"])
            run.assert_not_called()

    def test_full_setup_reuses_namespace_installer_and_runs_opencode_inside_selected_vpn(self):
        self.desktop("brave-browser.desktop", "[Desktop Entry]\nType=Application\nName=Brave\nExec=brave %U\n")
        with (
            patch.object(migration.os, "geteuid", return_value=1000),
            patch.object(migration, "check_commands"),
            patch.object(migration, "check_runner"),
            patch.object(migration, "ensure_namespace") as namespace,
            patch.object(migration, "setup_browse") as browse,
            patch.object(migration, "run") as run,
        ):
            migration.main(["--namespace", "wg3"])
        namespace.assert_called_once_with("wg3")
        run.assert_called_once_with("/usr/local/bin/wg3-run", "bash", migration.HERE / "setup-opencode-tailscale.sh",
                                   "--namespace", "wg3", "--backend-port", "4096", "--bridge-port", "4097", "--https-port", "8443")
        browse.assert_called_once_with("wg3", self.paths, False)
        self.assertTrue((self.paths["data"] / "applications/brave-wg3.desktop").exists())

    def test_browse_reuses_installed_binary_and_pairings_and_restarts_only_when_needed(self):
        binary = self.paths["bin"] / "browse"
        binary.parent.mkdir(parents=True)
        binary.touch()
        registry = self.paths["data"] / "browse/browsers.json"
        registry.parent.mkdir(parents=True)
        registry.write_text('{"profile": {"id": "brave", "name": "Brave"}}')
        original = registry.read_text()
        state = {"relay": {"running": True, "version": "0.0.17", "stale": False}}

        def result(*args, **kwargs):
            return subprocess.CompletedProcess(args, 0, stdout="0.0.17\n" if args[-1] == "--version" else json.dumps(state))

        with patch.object(migration, "run", side_effect=result) as run, patch.object(migration, "host_run", side_effect=result) as host:
            migration.setup_browse("wg2", self.paths)
            root = self.paths["config"] / "systemd/user"
            for name, text in migration.browse_units("wg2", binary).items():
                self.assertEqual((root / name).read_text(), text)
            self.assertEqual(json.loads((self.paths["config"] / "browse/config.json").read_text())["hostname"], "127.0.0.1")
            self.assertEqual(registry.read_text(), original)
            self.assertFalse(any(call.args[0] in ("curl", "bash") for call in run.call_args_list))
            run.reset_mock()
            migration.setup_browse("wg2", self.paths)
            self.assertFalse(any("restart" in call.args for call in run.call_args_list))
            host.assert_any_call(binary, "install", "--agent", "opencode", "--yes", "--no-open", "--no-wait")
            state["relay"]["stale"] = True
            run.reset_mock()
            migration.setup_browse("wg2", self.paths)
            run.assert_any_call("systemctl", "--user", "restart", "browse-relay.service")
        self.assertEqual(registry.read_text(), original)

    def test_failed_download_does_not_execute_partial_installer_or_write_units(self):
        with patch.object(migration, "run", side_effect=subprocess.CalledProcessError(22, "curl")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                migration.setup_browse("wg2", self.paths)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], "curl")
        self.assertFalse(self.home.exists())

    def test_unmanaged_browse_relay_is_not_killed_or_hidden_by_a_failing_service(self):
        binary = self.paths["bin"] / "browse"
        binary.parent.mkdir(parents=True)
        binary.touch()
        for relay in ({"running": True}, {"version": "0.1.0", "pid": 4242}):
            with self.subTest(relay=relay):
                status = subprocess.CompletedProcess([], 0, stdout=json.dumps({"relay": relay}))
                with (
                    patch.object(migration, "host_run", return_value=status),
                    patch.object(migration, "run", side_effect=subprocess.CalledProcessError(3, "systemctl")) as run,
                ):
                    with self.assertRaisesRegex(RuntimeError, "standalone Browse relay"):
                        migration.setup_browse("wg2", self.paths)
                self.assertEqual(run.call_count, 1)
                self.assertFalse((self.paths["config"] / "systemd/user").exists())

    def test_unrelated_service_is_not_replaced(self):
        root = self.paths["config"] / "systemd/user"
        root.mkdir(parents=True)
        unit = root / "browse-relay.service"
        original = "[Service]\nExecStart=/some/other/program\n"
        unit.write_text(original)
        with patch.object(migration, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "unrelated service"):
                migration.setup_browse("wg2", self.paths)
        run.assert_not_called()
        self.assertEqual(unit.read_text(), original)

    def test_pair_assigns_stable_name_preserving_offline_profile_and_other_browser(self):
        registry = self.paths["data"] / "browse/browsers.json"
        before = {"old": {"id": "brave-vpn", "name": "VPN"}, "regular": {"id": "brave", "name": "Brave"}}
        migration.write_json(registry, before)

        def host(*args, **kwargs):
            if "pair" in args:
                migration.write_json(registry, {**before, "new": {"id": "brave-solcon", "name": "VPN"}})
            status = {
                "relay": {"running": True},
                "extension": {"browsers": [{"id": "brave-vpn", "connected": True}]},
            }
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(status))

        with patch.object(migration, "host_run", side_effect=host), patch.object(migration, "run"), redirect_stdout(io.StringIO()):
            migration.pair_browser("brave-vpn", self.paths)
        after = migration.read_json(registry)
        self.assertEqual(after["old"]["id"], "brave-vpn-old")
        self.assertEqual(after["new"]["id"], "brave-vpn")
        self.assertEqual(after["regular"], before["regular"])

    def test_browse_waits_for_service_readiness_and_selected_browser_reconnection(self):
        responses = [
            subprocess.CalledProcessError(4, "browse status"),
            subprocess.CompletedProcess([], 0, stdout=json.dumps({"relay": {"running": True}, "extension": {"browsers": []}})),
            subprocess.CompletedProcess([], 0, stdout=json.dumps({
                "relay": {"running": True},
                "extension": {"browsers": [{"id": "brave", "connected": True}]},
            })),
        ]
        with patch.object(migration, "host_run", side_effect=responses), patch.object(migration.time, "sleep"):
            status = migration.browse_status(self.paths["bin"] / "browse", browser="brave")
        self.assertTrue(status["extension"]["browsers"][0]["connected"])

    def test_browse_readiness_accepts_real_010_status_without_running_field(self):
        binary, _, expected = self.browse_installation()
        response = subprocess.CompletedProcess([], 0, stdout=json.dumps(expected))
        # A false not-ready result must fail immediately, not spend 30 real seconds.
        with (
            patch.object(migration, "host_run", return_value=response),
            patch.object(migration.time, "monotonic", side_effect=[0, 31]),
        ):
            self.assertEqual(migration.browse_status(binary), expected)

    def test_browse_readiness_distinguishes_offline_browsers_from_an_absent_relay(self):
        binary, _, expected = self.browse_installation()
        expected["connected"] = False
        expected["extension"]["browsers"] = []
        with patch.object(migration, "host_run", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(expected))):
            self.assertEqual(migration.browse_status(binary), expected)
        for relay in (None, {}, {"version": "0.1.0", "pid": 0}, {"running": False, "version": "0.1.0", "pid": 4242}):
            with self.subTest(relay=relay):
                response = subprocess.CompletedProcess([], 0, stdout=json.dumps({"relay": relay}))
                with (
                    patch.object(migration, "host_run", return_value=response),
                    patch.object(migration.time, "monotonic", side_effect=[0, 31]),
                ):
                    with self.assertRaisesRegex(RuntimeError, "did not become ready"):
                        migration.browse_status(binary)

    def test_update_downloads_without_setup_and_restarts_before_talking_to_old_relay(self):
        binary, root, status = self.browse_installation()
        preserved = {
            root / name: (root / name).read_bytes() for name in migration.browse_units("wg2", binary)
        }
        for path, text in (
            (self.paths["config"] / "opencode/opencode.jsonc", "// existing user configuration\n"),
            (self.paths["data"] / "browse/browsers.json", '{"profile": {"id": "brave"}}\n'),
            (self.paths["data"] / "browse/browser-tokens.json", '{"fixture": "unchanged-pairing"}\n'),
        ):
            migration.write(path, text, 0o600)
            preserved[path] = path.read_bytes()
        events = []
        restarted = False

        def command(*args, **kwargs):
            nonlocal restarted
            events.append(("command", args))
            if args == ("systemctl", "--user", "start", "browse-relay.service"):
                restarted = True
            return self.browse_command_result(*args, **kwargs)

        def host(*args, **kwargs):
            events.append(("host", args))
            if args[0] == "/usr/bin/ss":
                output = 'LISTEN 0 128 127.0.0.1:19988 0.0.0.0:* users:(("browse",pid=4242,fd=9))\n' if restarted else ""
                return subprocess.CompletedProcess(args, 0, stdout=output)
            self.assertTrue(restarted, "Browse 0.1.0 cannot query the old 0.0.17 foreground relay.")
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(status))

        output = io.StringIO()
        with patch.object(migration, "run", side_effect=command) as run, patch.object(migration, "host_run", side_effect=host), redirect_stdout(output):
            migration.update_browse("wg2", self.paths)
        self.assertEqual(events[0][1][:3], ("curl", "-fsSL", "https://opencode.ai/browse/install"))
        self.assertEqual(events[1][1][0], "bash")
        self.assertEqual(events[1][1][-1], "--no-setup")
        self.assertEqual(events[2], ("command", ("systemctl", "--user", "stop", "browse-relay.service")))
        self.assertIn("brave: connected", output.getvalue())
        self.assertIn("brave-vpn: connected", output.getvalue())
        for name in migration.browse_units("wg2", binary):
            run.assert_any_call("systemctl", "--user", "is-active", "--quiet", name)
        for path, original in preserved.items():
            self.assertEqual(path.read_bytes(), original)

    def test_restart_only_recovers_already_updated_binary_and_reports_offline_browsers(self):
        binary, _, status = self.browse_installation()
        status["extension"]["browsers"] = []
        status["connected"] = False
        output = io.StringIO()

        def result(*args, **kwargs):
            return self.browse_command_result(*args, **kwargs)

        with (
            patch.object(migration, "run", side_effect=result) as run,
            patch.object(migration, "host_run", return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(status))),
            patch.object(migration, "host_relay_pid", side_effect=[None, 4242]),
            redirect_stdout(output),
        ):
            migration.update_browse("wg2", self.paths, restart_only=True)
        self.assertFalse(any(call.args[0] in ("curl", "bash") for call in run.call_args_list))
        run.assert_any_call("systemctl", "--user", "start", "browse-relay.service")
        self.assertIn("shared relay updated to 0.1.0", output.getvalue())
        self.assertIn("brave: not connected yet", output.getvalue())
        self.assertIn("brave-vpn: not connected yet", output.getvalue())

    def test_update_reports_fresh_browser_connections_instead_of_startup_snapshot(self):
        _, _, connected = self.browse_installation()
        starting = {**connected, "connected": False, "extension": {"browsers": []}}
        responses = [
            subprocess.CompletedProcess([], 0, stdout=json.dumps(starting)),
            subprocess.CompletedProcess([], 0, stdout=json.dumps(connected)),
        ]
        output = io.StringIO()
        with (
            patch.object(migration, "run", side_effect=self.browse_command_result),
            patch.object(migration, "host_run", side_effect=responses),
            patch.object(migration, "host_relay_pid", side_effect=[None, 4242]),
            redirect_stdout(output),
        ):
            migration.update_browse("wg2", self.paths, restart_only=True)
        self.assertIn("brave: connected", output.getvalue())
        self.assertIn("brave-vpn: connected", output.getvalue())
        self.assertNotIn("not connected yet", output.getvalue())

    def test_update_failed_download_keeps_running_relay_untouched(self):
        self.browse_installation()
        with patch.object(migration, "run", side_effect=subprocess.CalledProcessError(22, "curl")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                migration.update_browse("wg2", self.paths)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], "curl")

    def test_update_refuses_missing_or_unrelated_relay_units_before_download(self):
        with patch.object(migration, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "missing"):
                migration.update_browse("wg2", self.paths)
        run.assert_not_called()
        _, root, _ = self.browse_installation()
        migration.write(root / "browse-relay.service", "[Service]\nExecStart=/unrelated/application\n")
        with patch.object(migration, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "unrelated"):
                migration.update_browse("wg2", self.paths)
        run.assert_not_called()

    def test_update_detects_stale_relay_or_failed_namespace_bridge(self):
        binary, _, status = self.browse_installation()
        status["relay"]["version"] = "0.0.17"

        def command(*args, **kwargs):
            if args[-1] == "browse-wg2-local.service" and "is-active" in args:
                raise subprocess.CalledProcessError(3, args)
            return subprocess.CompletedProcess(args, 0, stdout="0.1.0\n")

        def host(*args, **kwargs):
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(status))

        with (
            patch.object(migration, "run", side_effect=command),
            patch.object(migration, "host_run", side_effect=host),
            patch.object(migration, "host_relay_pid", return_value=None),
        ):
            with self.assertRaisesRegex(RuntimeError, "CLI is 0.1.0, but the relay is 0.0.17"):
                migration.update_browse("wg2", self.paths, restart_only=True)
            status["relay"]["version"] = "0.1.0"
            with self.assertRaises(subprocess.CalledProcessError):
                migration.update_browse("wg2", self.paths, restart_only=True)

    def test_update_dry_run_does_not_download_or_change_services(self):
        output = io.StringIO()
        with patch.object(migration.os, "geteuid", return_value=1000), patch.object(migration, "run") as run, redirect_stdout(output):
            migration.main(["update-browse", "--restart-only", "--dry-run"])
        run.assert_not_called()
        self.assertFalse(self.home.exists())
        plan = json.loads(output.getvalue())
        self.assertIsNone(plan["installer"])
        self.assertEqual(plan["restart_relay_before_status"], "browse-relay.service")
        self.assertTrue(plan["preserve_pairings"])
        self.assertTrue(plan["take_over_verified_standalone_relay"])
        self.assertTrue(plan["verify_listener_matches_systemd_pid"])

    def test_takeover_stops_restart_loop_before_releasing_verified_standalone_port(self):
        events = []
        with (
            patch.object(migration, "run", side_effect=lambda *args, **kwargs: events.append(args)),
            patch.object(migration, "host_relay_pid", return_value=5252),
            patch.object(migration, "stop_standalone_browse", side_effect=lambda *args: events.append(("terminate", *args))) as stop,
        ):
            binary = self.paths["bin"] / "browse"
            migration.restart_shared_browse(binary)
        self.assertEqual(events, [
            ("systemctl", "--user", "stop", "browse-relay.service"),
            ("terminate", 5252, binary),
            ("systemctl", "--user", "reset-failed", "browse-relay.service"),
            ("systemctl", "--user", "start", "browse-relay.service"),
        ])
        stop.assert_called_once_with(5252, binary)

    def test_refused_takeover_leaves_restart_loop_stopped_without_starting_another_relay(self):
        with (
            patch.object(migration, "run") as run,
            patch.object(migration, "host_relay_pid", return_value=5252),
            patch.object(migration, "stop_standalone_browse", side_effect=RuntimeError("unverified process")),
        ):
            with self.assertRaisesRegex(RuntimeError, "unverified"):
                migration.restart_shared_browse(self.paths["bin"] / "browse")
        run.assert_called_once_with("systemctl", "--user", "stop", "browse-relay.service")

    def test_standalone_takeover_uses_pidfd_and_graceful_term_for_current_or_deleted_binary(self):
        binary, process = self.standalone_process()
        for deleted in (False, True):
            with self.subTest(deleted=deleted):
                (process / "exe").unlink()
                (process / "exe").symlink_to(str(binary) + (" (deleted)" if deleted else ""))
                with (
                    patch.object(migration.os, "pidfd_open", return_value=101),
                    patch.object(migration.signal, "pidfd_send_signal") as signal,
                    patch.object(migration.select, "select", side_effect=[([], [], []), ([101], [], [])]),
                    patch.object(migration.os, "close") as close,
                    patch.object(migration.os, "kill") as numeric_kill,
                    redirect_stdout(io.StringIO()),
                ):
                    migration.stop_standalone_browse(5252, binary, proc_root=process.parent)
                signal.assert_called_once_with(101, migration.signal.SIGTERM)
                close.assert_called_once_with(101)
                numeric_kill.assert_not_called()

    def test_takeover_refuses_other_executable_command_user_or_service_without_signalling(self):
        binary, process = self.standalone_process()
        for mismatch in ("executable", "command", "user", "service"):
            with self.subTest(mismatch=mismatch):
                (process / "exe").unlink()
                (process / "exe").symlink_to(self.root / "unrelated" if mismatch == "executable" else binary)
                (process / "cmdline").write_bytes(os.fsencode(binary) + (b"\0install\0" if mismatch == "command" else b"\0serve\0"))
                (process / "cgroup").write_text("0::/user.slice/other-relay.service\n" if mismatch == "service" else "0::/user.slice/app-terminal.scope\n")
                uid = process.stat().st_uid + (1 if mismatch == "user" else 0)
                with (
                    patch.object(migration.os, "pidfd_open", return_value=101),
                    patch.object(migration.os, "geteuid", return_value=uid),
                    patch.object(migration.signal, "pidfd_send_signal") as signal,
                    patch.object(migration.select, "select", return_value=([], [], [])),
                    patch.object(migration.os, "close"),
                    patch.object(migration.os, "kill") as numeric_kill,
                ):
                    with self.assertRaisesRegex(RuntimeError, "unverified process|another service"):
                        migration.stop_standalone_browse(5252, binary, proc_root=process.parent)
                signal.assert_not_called()
                numeric_kill.assert_not_called()

    def test_takeover_does_not_escalate_to_force_kill_when_graceful_shutdown_times_out(self):
        binary, process = self.standalone_process()
        with (
            patch.object(migration.os, "pidfd_open", return_value=101),
            patch.object(migration.signal, "pidfd_send_signal") as signal,
            patch.object(migration.select, "select", return_value=([], [], [])),
            patch.object(migration.os, "close"),
            patch.object(migration.os, "kill") as numeric_kill,
        ):
            with self.assertRaisesRegex(RuntimeError, "no force-kill"):
                migration.stop_standalone_browse(5252, binary, proc_root=process.parent)
        signal.assert_called_once_with(101, migration.signal.SIGTERM)
        numeric_kill.assert_not_called()

    def test_takeover_does_not_signal_a_numeric_pid_if_the_listener_already_exited(self):
        with (
            patch.object(migration.os, "pidfd_open", side_effect=ProcessLookupError),
            patch.object(migration.signal, "pidfd_send_signal") as signal,
            patch.object(migration.os, "kill") as numeric_kill,
        ):
            migration.stop_standalone_browse(5252, self.paths["bin"] / "browse")
        signal.assert_not_called()
        numeric_kill.assert_not_called()

    def test_port_inspection_uses_host_and_refuses_unidentifiable_or_ambiguous_listeners(self):
        for output, expected in (
            ("", None),
            ('LISTEN 0 128 127.0.0.1:19988 0.0.0.0:* users:(("browse",pid=5252,fd=9))\n', 5252),
        ):
            with patch.object(migration, "host_run", return_value=subprocess.CompletedProcess([], 0, stdout=output)) as host:
                self.assertEqual(migration.host_relay_pid(), expected)
            host.assert_called_once_with("/usr/bin/ss", "-H", "-ltnp", "( sport = :19988 )", capture_output=True, text=True)
        for output in (
            "LISTEN 0 128 127.0.0.1:19988 0.0.0.0:*\n",
            'LISTEN users:(("browse",pid=5252,fd=9))\nLISTEN users:(("other",pid=6363,fd=9))\n',
        ):
            with patch.object(migration, "host_run", return_value=subprocess.CompletedProcess([], 0, stdout=output)):
                with self.assertRaisesRegex(RuntimeError, "Cannot safely identify"):
                    migration.host_relay_pid()

    def test_owner_verification_rejects_same_version_standalone_even_if_unit_is_starting(self):
        for managed, listener, reported in ((0, 5252, 5252), (4242, 5252, 5252), (4242, 4242, 5252)):
            with self.subTest(managed=managed, listener=listener, reported=reported):
                with (
                    patch.object(migration, "run", return_value=subprocess.CompletedProcess([], 0, stdout=f"{managed}\n")),
                    patch.object(migration, "host_relay_pid", return_value=listener),
                ):
                    with self.assertRaisesRegex(RuntimeError, "not the process owned"):
                        migration.verify_browse_owner({"relay": {"version": "0.1.2", "pid": reported}})

    def test_setup_upgrade_also_restarts_protocol_incompatible_relay_before_waiting(self):
        binary, _, status = self.browse_installation()
        restarted = False

        def command(*args, **kwargs):
            nonlocal restarted
            if args == ("systemctl", "--user", "restart", "browse-relay.service"):
                restarted = True
            return subprocess.CompletedProcess(args, 0, stdout="0.1.0\n")

        def host(*args, **kwargs):
            if not restarted:
                raise subprocess.CalledProcessError(1, args, stderr="older foreground relay")
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(status))

        with patch.object(migration, "run", side_effect=command), patch.object(migration, "host_run", side_effect=host), redirect_stdout(io.StringIO()):
            migration.setup_browse("wg2", self.paths, upgrade=True)
        self.assertTrue(restarted)

    def test_opencode_tailscale_rejects_foreign_route_but_allows_own_or_other_port(self):
        # Run the real shell preflight and jq parser, but make every other external
        # tool fail closed. Even a broken guard cannot change services or settings.
        jq = shutil.which("jq")
        self.assertIsNotNone(jq, "jq is a documented prerequisite for these migrations.")
        binary = self.root / "fake-bin"
        binary.mkdir()
        (binary / "jq").symlink_to(jq)
        calls = self.root / "calls"
        stub = (
            f"#!{sys.executable}\n"
            "import json,os,sys\nfrom pathlib import Path\n"
            "name=Path(sys.argv[0]).name\n"
            "if name=='tailscale' and sys.argv[1:]==['serve','status','--json']:\n"
            " print(json.dumps({'Web':{'host.example.ts.net:443':{'Handlers':"
            "{'/':{'Proxy':os.environ['TEST_ROUTE']}}}}}));sys.exit(0)\n"
            "with open(os.environ['TEST_CALLS'],'a') as f:f.write(name+' '+' '.join(sys.argv[1:])+'\\n')\n"
            "sys.exit(66)\n"
        )
        for name in ("tailscale", "opencode", "curl", "fish", "flock", "openssl", "readlink", "socat", "systemctl"):
            path = binary / name
            path.write_text(stub)
            path.chmod(0o755)
        env = {**os.environ, "PATH": str(binary) + ":/usr/bin:/bin", "TEST_CALLS": str(calls)}
        for route, port, conflict in (
            ("http://127.0.0.1:3773", "443", True),
            ("http://127.0.0.1:4097", "443", False),
            ("http://127.0.0.1:3773", "8443", False),
        ):
            with self.subTest(route=route, port=port):
                calls.unlink(missing_ok=True)
                result = subprocess.run(
                    ["/usr/bin/bash", str(SOURCE.with_name("setup-opencode-tailscale.sh")), "--https-port", port],
                    env={**env, "TEST_ROUTE": route}, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 1)
                self.assertEqual("already serves another application" in result.stderr, conflict)
                recorded = calls.read_text() if calls.exists() else ""
                if conflict:
                    self.assertEqual(recorded, "")
                else:
                    self.assertTrue(recorded.startswith("opencode service set hostname"))
                self.assertFalse(self.paths["config"].exists())


if __name__ == "__main__":
    unittest.main()
