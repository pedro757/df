"""Offline behavioral checks; never touch real services or system configuration."""

from dataclasses import replace
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "setup-t3code-tailscale.py"
SPEC = importlib.util.spec_from_file_location("t3code_tailscale_migration", SOURCE)
migration = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = migration
SPEC.loader.exec_module(migration)


class BridgeMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="t3code-migration-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = migration.Configuration("wg3", "alice", 4242, "workstation.example.ts.net", 4888, 8443)
        for directory in ("run/netns", "etc/netns/wg3", "etc/systemd/system"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        (self.root / "run/netns/wg3").touch()
        (self.root / "etc/hosts").write_text("127.0.0.1 localhost\n::1 localhost\n")
        self.nss_base = "passwd: files systemd\nhosts: resolve [!UNAVAIL=return] files myhostname dns\n"
        (self.root / "etc/nsswitch.conf").write_text(self.nss_base)
        self.hosts = self.root / "etc/netns/wg3/hosts"
        self.nss = self.hosts.with_name("nsswitch.conf")
        self.state = self.root / "var/lib/t3code-wg3-bridge/original.json"
        self.unit = self.root / "etc/systemd/system/t3code-wg3-https.service"

        def command_result(*args, **kwargs):
            active = args[1:3] == ("is-active", "--quiet")
            return subprocess.CompletedProcess(args, 0 if not active or self.unit.exists() else 3)

        self.commands = patch.object(migration, "run", side_effect=command_result).start()
        self.addCleanup(patch.stopall)

    def install(self):
        migration.install_system(self.config, self.root)

    def remove(self):
        migration.remove_system(self.config, self.root)

    def test_install_is_repeatable_and_undo_restores_preexisting_files_and_permissions(self):
        original = "127.0.0.1 localhost\n192.0.2.8 private-host\n"
        self.hosts.write_text(original)
        self.hosts.chmod(0o640)
        self.nss.write_text(self.nss_base)
        self.install()
        first_state = json.loads(self.state.read_text())
        self.commands.reset_mock()
        self.install()

        self.assertEqual(json.loads(self.state.read_text()), first_state)
        self.assertEqual(self.hosts.read_text().count(self.config.begin), 1)
        self.assertFalse(any(call.args[1] == "restart" for call in self.commands.call_args_list))
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o600)
        self.remove()
        self.assertEqual(self.hosts.read_text(), original)
        self.assertEqual(stat.S_IMODE(self.hosts.stat().st_mode), 0o640)
        self.assertEqual(self.nss.read_text(), self.nss_base)
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.state.exists())

    def test_undo_removes_namespace_files_created_by_the_migration(self):
        self.install()
        self.assertIn("127.0.0.1 workstation.example.ts.net", self.hosts.read_text())
        self.remove()
        self.assertFalse(self.hosts.exists())
        self.assertFalse(self.nss.exists())

    def test_undo_preserves_unrelated_edits_after_installation(self):
        self.install()
        self.hosts.write_text(self.hosts.read_text() + "192.0.2.9 added-later\n")
        self.nss.write_text(self.nss.read_text().replace("passwd: files systemd", "passwd: files"))
        self.remove()
        self.assertIn("192.0.2.9 added-later", self.hosts.read_text())
        self.assertNotIn(self.config.hostname, self.hosts.read_text())
        self.assertEqual(self.nss.read_text(), self.nss_base.replace("passwd: files systemd", "passwd: files"))

    def test_reconfiguration_keeps_original_backups_and_restarts_changed_listener(self):
        self.hosts.write_text("127.0.0.1 localhost\n")
        self.install()
        self.config = replace(self.config, hostname="renamed.example.ts.net", https_port=9443)
        self.commands.reset_mock()
        self.install()
        self.assertNotIn("workstation.example.ts.net", self.hosts.read_text())
        self.assertIn("127.0.0.1 renamed.example.ts.net", self.hosts.read_text())
        self.assertIn("TCP4-LISTEN:9443", self.unit.read_text())
        self.commands.assert_any_call("/usr/bin/systemctl", "restart", self.config.system_unit)
        self.remove()
        self.assertEqual(self.hosts.read_text(), "127.0.0.1 localhost\n")

    def test_reinstall_then_undo_keeps_unrelated_edits_made_after_first_install(self):
        self.hosts.write_text("127.0.0.1 localhost\n")
        self.nss.write_text(self.nss_base)
        self.install()
        self.hosts.write_text(self.hosts.read_text() + "192.0.2.11 added-before-reinstall\n")
        self.nss.write_text(self.nss.read_text().replace("passwd: files systemd", "passwd: files"))
        self.install()
        self.remove()
        self.assertEqual(self.hosts.read_text(), "127.0.0.1 localhost\n192.0.2.11 added-before-reinstall\n")
        self.assertEqual(self.nss.read_text(), self.nss_base.replace("passwd: files systemd", "passwd: files"))

    def test_existing_unrelated_hostname_or_unit_is_not_overwritten(self):
        self.hosts.write_text(f"192.0.2.10 {self.config.hostname}\n")
        with self.assertRaisesRegex(RuntimeError, "unrelated namespace hosts"):
            self.install()
        self.assertFalse(self.state.exists())
        self.assertFalse(self.unit.exists())
        self.assertEqual(self.commands.call_count, 0)
        self.hosts.unlink()
        self.unit.write_text("[Service]\nExecStart=/some/unrelated/application\n")
        with self.assertRaisesRegex(RuntimeError, "unrelated configuration"):
            self.install()
        with self.assertRaisesRegex(RuntimeError, "unrelated configuration"):
            self.remove()
        self.assertEqual(self.commands.call_count, 0)

    def test_symlink_is_rejected_without_changing_its_target(self):
        target = self.root / "unrelated"
        target.write_text("untouched\n")
        self.hosts.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.install()
        self.assertEqual(target.read_text(), "untouched\n")
        self.assertFalse(self.state.exists())
        self.assertEqual(self.commands.call_count, 0)

    def test_another_users_bridge_is_not_stopped_or_replaced(self):
        self.install()
        state = json.loads(self.state.read_text())
        state["configuration"]["uid"] = 9000
        self.state.write_text(json.dumps(state))
        self.commands.reset_mock()
        with self.assertRaisesRegex(RuntimeError, "another desktop user"):
            self.install()
        with self.assertRaisesRegex(RuntimeError, "another desktop user"):
            self.remove()
        self.assertEqual(self.commands.call_count, 0)

    def test_legacy_backup_without_configuration_can_still_be_removed(self):
        self.install()
        state = json.loads(self.state.read_text())
        del state["configuration"]
        self.state.write_text(json.dumps(state))
        self.remove()
        self.assertFalse(self.hosts.exists())
        self.assertFalse(self.nss.exists())
        self.assertFalse(self.state.exists())

    def test_files_first_keeps_nss_action_clauses_and_is_idempotent(self):
        updated = migration.files_first(self.nss_base)
        self.assertIn("hosts: files resolve [!UNAVAIL=return] files myhostname dns\n", updated)
        self.assertEqual(migration.files_first(updated), updated)

    def test_unit_generation_uses_configured_identity_ports_and_localhost_only(self):
        unit = migration.system_unit(self.config)
        self.assertIn("User=alice\n", unit)
        self.assertIn("NetworkNamespacePath=/run/netns/wg3\n", unit)
        self.assertIn("TCP4-LISTEN:8443,bind=127.0.0.1", unit)
        self.assertIn("/run/user/4242/t3code-wg3-https.sock", unit)
        self.assertNotIn("CAP_NET_BIND_SERVICE", unit)
        self.assertIn("CAP_NET_BIND_SERVICE", migration.system_unit(replace(self.config, https_port=443)))
        units = migration.user_units(self.config)
        self.assertIn("TCP4:127.0.0.1:4888", units["t3code-wg3-backend.service"])
        self.assertIn("TCP4-LISTEN:4888,bind=127.0.0.1", units["t3code-wg3-host.service"])

    def test_invalid_settings_are_rejected_before_generating_privileged_configuration(self):
        with patch.object(migration.pwd, "getpwuid", return_value=SimpleNamespace(pw_name="alice")):
            self.config.validate()
            for changes in (
                {"namespace": "../outside"},
                {"namespace": "wg3\nExecStart=/bin/false"},
                {"uid": 0},
                {"user": "another-user"},
                {"hostname": "external.example.com"},
                {"hostname": "example.ts.net,other-target"},
                {"backend_port": 0},
                {"https_port": 65536},
                {"https_port": True},
                {"https_port": self.config.backend_port},
            ):
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    replace(self.config, **changes).validate()

    def test_cli_bootstraps_all_user_files_and_reuses_saved_ports_without_restart(self):
        home = self.root / "home/alice"
        config_home = home / "custom-config"
        account = SimpleNamespace(pw_name="alice", pw_uid=4242)
        with (
            patch.dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(config_home)),
            patch.object(migration.os, "getuid", return_value=4242),
            patch.object(migration.os, "geteuid", return_value=4242),
            patch.object(migration.pwd, "getpwuid", return_value=account),
            patch.object(migration, "detect_hostname", return_value=self.config.hostname) as hostname,
            patch.object(migration, "check_prerequisites"),
            patch.object(migration, "authorize") as authorize,
            redirect_stdout(io.StringIO()),
        ):
            migration.main(["install", "--bridge-only", "--namespace", "wg3", "--backend-port", "4888", "--https-port", "8443"])
            for name, text in migration.user_units(self.config).items():
                self.assertEqual((config_home / "systemd/user" / name).read_text(), text)
            self.assertEqual((home / ".local/bin/t3code-wg3-bridge").read_text(), SOURCE.read_text())
            saved = json.loads((config_home / "t3code-wg3-bridge.json").read_text())
            self.assertEqual(saved["backend_port"], 4888)
            self.assertEqual(saved["https_port"], 8443)
            self.commands.reset_mock()
            migration.main(["install", "--namespace", "wg3"])
            self.assertFalse(any(call.args[2] == "restart" for call in self.commands.call_args_list))
            hostname.side_effect = AssertionError("Removal must not contact Tailscale")
            migration.main(["remove", "--namespace", "wg3"])
            self.assertEqual(authorize.call_args.args[1:], ("remove", self.config))

    def test_dry_run_reports_plan_without_creating_files_or_authorizing_root(self):
        home = self.root / "home/alice"
        output = io.StringIO()
        with (
            patch.dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config")),
            patch.object(migration.os, "getuid", return_value=4242),
            patch.object(migration.os, "geteuid", return_value=4242),
            patch.object(migration.pwd, "getpwuid", return_value=SimpleNamespace(pw_name="alice", pw_uid=4242)),
            patch.object(migration, "detect_hostname", return_value=self.config.hostname),
            patch.object(migration, "authorize") as authorize,
            redirect_stdout(output),
        ):
            migration.main(["--dry-run", "--bridge-only", "--namespace", "wg3", "--backend-port", "4888", "--https-port", "8443"])
        self.assertFalse(home.exists())
        authorize.assert_not_called()
        plan = json.loads(output.getvalue())
        self.assertEqual(plan["configuration"]["uid"], 4242)
        self.assertEqual(plan["configuration"]["hostname"], self.config.hostname)
        self.assertEqual(len(plan["user_units"]), 3)


if __name__ == "__main__":
    unittest.main()
