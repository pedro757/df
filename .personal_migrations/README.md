# Personal migrations

## Unified VPN apps + OpenCode + Browse setup

Run the unified entry point as your **desktop user in an independent host
terminal**, not with `sudo`, `wgN-run`, or inside the OpenCode service it will
restart:

```bash
# Preview: no downloads, file writes, administrator prompts or service changes.
~/.personal_migrations/setup-vpn-apps.py --app brave --replace t3code --dry-run
~/.personal_migrations/setup-vpn-apps.py --app brave --replace t3code
```

This reuses `wg2` when installed. Otherwise it invokes the secure namespace
installer with administrator approval and asks you to paste a WireGuard profile.
It then creates the requested launchers, runs the existing OpenCode/Tailscale
migration **inside the namespace**, and installs/configures Browse. Repeated
runs do not create another VPN profile or reset browser pairings.

Prerequisites are Python 3.9+, the apps you select, OpenCode V2, a connected
Tailscale client, systemd, socat, curl, fish, jq, openssl, flock, and the
WireGuard/iproute2 tools required by `setup-wg2-netns.sh`. The migration does not
install those packages, sign into Tailscale, grant Serve permissions, or install
your desktop apps. The first namespace creation requires an interactive terminal.

### Add another launcher or replace the normal one

`--app` and `--replace` are repeatable. Pass a desktop-entry ID or an absolute
`.desktop` path; the migration uses the existing app's icon, arguments, file/URL
placeholders, localized names and desktop actions.

```bash
# Only manage launchers, without reinstalling the VPN, OpenCode or Browse.
~/.personal_migrations/setup-vpn-apps.py launcher --app brave --replace t3code
~/.personal_migrations/setup-vpn-apps.py launcher --app org.example.Editor
~/.personal_migrations/setup-vpn-apps.py launcher --replace /usr/share/applications/example.desktop

# The old Brave entry point still works and accepts the same launcher options.
~/.personal_migrations/add-brave-vpn-launcher.sh --app brave --replace t3code
```

- `--app brave` keeps normal **Brave** and adds **Brave VPN**, using a separate
  namespace-specific profile so it cannot reuse a running non-VPN browser.
- `--replace t3code` keeps the normal menu names, but replaces all discovered T3
  menu and protocol-handler entries with VPN-only **user overrides**. It does
  not add a second, non-VPN T3 launcher. Desktop actions are routed through the
  VPN too, and D-Bus activation is disabled to avoid bypassing `Exec`.
- Other apps can use either mode. System/package desktop files are never edited.
  New apps with different desktop IDs/protocol handlers should have each ID
  explicitly listed with `--replace`.
- Close an app's existing non-VPN process before using its replacement:
  single-instance apps can forward launches to that old process. Replacement
  manages desktop/menu/URL launchers, not direct execution of packaged binaries
  or custom shell aliases; it is not an OS-wide ban on non-VPN execution.

Original user entries, modes and generated files are recorded privately under
`${XDG_DATA_HOME:-~/.local/share}/vpn-app-launchers/state.json`. Repeat runs
preserve the first originals. Restore selected launchers with:

```bash
~/.personal_migrations/setup-vpn-apps.py launcher --replace t3code --restore
~/.personal_migrations/setup-vpn-apps.py launcher --app brave --restore
```

Later manual edits and symlinks are not silently overwritten or restored.
Restoring a system entry's override exposes the unchanged system entry again.

### OpenCode, Tailscale and other namespaces

The unified setup defaults to OpenCode backend port **4096**, host bridge
**4097**, and Tailscale HTTPS **8443**, leaving T3's usual HTTPS **443** alone.
The standalone `setup-opencode-tailscale.sh` retains its historical HTTPS 443
default. Both refuse to replace an unrelated root handler on the selected port.

```bash
~/.personal_migrations/setup-vpn-apps.py --namespace wg3 --app brave --replace t3code
~/.personal_migrations/setup-vpn-apps.py --app brave --opencode-https-port 9443
~/.personal_migrations/setup-vpn-apps.py --app brave --skip-tailscale
~/.personal_migrations/setup-vpn-apps.py --app brave --skip-browse
```

The low-level installer still auto-selects the next free `wgN` when run by
itself. Its new `--namespace wgN` option requests a specific **unused** name and
refuses to overwrite an existing profile. The unified setup only creates it
when the corresponding runner is missing; it starts an installed namespace
service if necessary.

This does not replace `setup-t3code-tailscale.py`: that migration additionally
manages T3's desktop backend and remote Sharing & access settings, described
below. Run it separately if you need remote T3 access.

### One Browse MCP connection for Brave and Brave VPN

Browse uses the official installer from
`https://opencode.ai/browse/install` (the same installer as
`curl -fsSL https://opencode.ai/browse/install | bash`). The binary is installed
only if missing unless `--upgrade-browse` is passed. Installation defers
interactive setup until the host relay is supervised, then registers OpenCode
through `browse install --agent opencode`, preserving other agent settings.

```bash
# Configure only Browse against an already installed namespace.
~/.personal_migrations/setup-vpn-apps.py browse
~/.personal_migrations/setup-vpn-apps.py browse --upgrade-browse
```

#### Update Browse and the shared relay

For an existing installation, use the dedicated updater from an independent
terminal during a quiet period for browser automation:

```bash
~/.personal_migrations/update-opencode-browse.sh --dry-run
~/.personal_migrations/update-opencode-browse.sh
```

It downloads the official installer, installs the latest stable binary with
`--no-setup`, and restarts **`browse-relay.service` using systemd before querying
Browse**. This handles upgrades such as 0.0.17 → 0.1.0, where the new CLI refuses
to communicate with the old foreground relay. The namespace bridges stay in
place and are ensured enabled/running; CLI/relay versions, service health and
the listener's ownership by systemd's `MainPID` are verified. Browser profiles, pairing credentials, launcher files and OpenCode
configuration are not rewritten. Each browser's connection status is reported;
an offline browser does not make an otherwise successful update fail.

If `curl -fsSL https://opencode.ai/browse/install | bash` already installed the
new binary but reported that the foreground relay is still old:

```bash
~/.personal_migrations/update-opencode-browse.sh --restart-only
```

If the plain installer started a standalone relay and the service is looping
with `EADDRINUSE`, the same `--restart-only` command repairs it. The updater
pauses the restart loop, identifies the **host** port owner, and sends SIGTERM
only after verifying that it is your installed `browse serve` process. A
PID-reuse-safe handle is used; there is no broad process kill or SIGKILL.
Unknown processes, another user's process, or a relay supervised by a different
service are refused and left alone. If takeover fails, the stopped service is
left stopped rather than entering another restart loop. Browser automation is
briefly interrupted, but browser profiles and pairing records remain intact.

Use `--namespace wg3` for a different existing bridge. Missing or unrelated
service definitions are refused rather than replaced.
The updater does not recreate namespaces, revoke pairings or restart
OpenCode. If a browser remains offline, open its profile and reload its Browse
extension; if OpenCode still exposes the old tool catalog, reconnect Browse in
`/mcps`.

Three systemd **user** services start at login:

- `browse-relay.service`: the shared host relay on `127.0.0.1:19988`.
- `browse-wg2-host.service`: a private, mode-0600 Unix socket to that relay.
- `browse-wg2-local.service`: forwards the namespace's `127.0.0.1:19988` through
  that socket. Another namespace gets its own `browse-wgN-*` bridge pair.

OpenCode and Brave VPN stay inside the VPN namespace; regular Brave stays on
the host. The existing single `browse mcp` entry reaches both. No Browse port
is exposed on the LAN. Reconfiguration updates stale relay builds without
changing either browser's network namespace or deleting pairing credentials.
Use a quiet period: changing services can briefly disconnect browser automation.
An already running standalone/unsupervised Browse relay must be stopped first;
the migration refuses to kill it or hide a port conflict behind restarting units.

Install/enable the Browse extension in **each browser profile**, then pair each
one separately. Keep each command running while entering its one-time code in
that profile's **Browse Options → Pair with a code → Connect**:

```bash
~/.personal_migrations/setup-vpn-apps.py pair brave
~/.personal_migrations/setup-vpn-apps.py pair brave-vpn
browse pair --list
browse doctor
```

The pairing helper assigns stable `brave` / `brave-vpn` selectors to a newly
paired profile. An existing profile holding the same name is preserved as
`brave-old` / `brave-vpn-old` (with a numeric suffix if necessary), never
silently revoked. Remove an obsolete pairing explicitly with
`browse pair --revoke NAME`. Already working profiles need no re-pairing.
Browse service files and its hostname config retain first-run
`.before-vpn-apps` backups beside the originals.

## T3 Code + Tailscale HTTPS inside a WireGuard namespace

`setup-t3code-tailscale.py` configures the complete **desktop-managed** setup:
T3 Code runs inside `wg2-run`, its normal **Local environment** and **Sharing &
access** controls remain available, and other devices connect through Tailscale
HTTPS. There is no separate, conflicting T3 background server.

Prerequisites:

- An existing namespace and launcher, such as `wg2-netns.service` and `wg2-run`
  from `setup-wg2-netns.sh`.
- An installed T3 Code desktop application.
- Python 3.9+, a recent Linux kernel, systemd, socat, curl, iproute2 and a
  connected Tailscale client.
- MagicDNS and HTTPS enabled for the tailnet; T3's user must already have any
  Tailscale permissions required to configure Serve.

Run as the desktop user in an **independent terminal**, **not** with `sudo` or
from T3's own terminal/agent (setup closes T3 before changing its backend mode):

```bash
~/.personal_migrations/setup-t3code-tailscale.py --dry-run
~/.personal_migrations/setup-t3code-tailscale.py
```

One run discovers the current Unix user, UID, Tailscale hostname and installed
T3 desktop executable. After administrator approval, it:

1. Installs the four localhost/Unix-socket bridge services.
2. Gracefully closes an existing T3 desktop for the selected T3 home, without
   force-killing it or deleting its ownership lock.
3. Stops and disables `t3code.service` if it uses that same home. A service using
   another T3 home is not silently stopped.
4. Enables Local environment and Tailscale HTTPS in T3's desktop settings,
   keeping the backend localhost-only.
5. Creates a namespace-aware desktop launcher and updates the T3 menu entries.
   System-wide menu files are left untouched; user overrides are created instead.
6. Opens T3 and waits for its HTTPS endpoint with normal certificate verification.

**Keep the desktop app open for remote access.** Closing it closes its backend,
just as with a normal desktop-managed T3 installation. Do not enable a second
background server against that same T3 home.

Conversations, projects and credentials are not reset or copied. Repeated runs
retain original backups and update the requested settings. The script installs
the standalone `t3code-wg2-bridge` management command, and saves machine-specific
configuration under `$XDG_CONFIG_HOME` (or `~/.config`).

Only the system listener and namespace name-lookup files require administrator
approval. The script does not install T3, create VPN profiles, sign into
Tailscale, or grant Tailscale operator permissions; those prerequisites must
already be in place.

Other namespace, ports, executable or data directory:

```bash
~/.personal_migrations/setup-t3code-tailscale.py --namespace wg3 --backend-port 4773 --https-port 8443
~/.personal_migrations/setup-t3code-tailscale.py --desktop-executable "$HOME/Apps/T3-Code.AppImage"
~/.personal_migrations/setup-t3code-tailscale.py --t3-home "$HOME/.t3-work"
# Configure everything, but leave the desktop closed:
~/.personal_migrations/setup-t3code-tailscale.py --no-launch
```

The generated launcher pins the backend port and T3 home; the HTTPS port is set
in the desktop settings. Rerun the migration when changing these ports rather
than changing only the HTTPS port in the GUI. Paths containing spaces are quoted.
The normal application-menu entry continues to work after installation.

Routes, firewall rules, Tailscale operators and other applications' Serve
mappings are not changed. The extra TCP listeners bind only to localhost.
Ordinary internet traffic remains routed through the VPN.

For the previous **bridge-only** behavior, without changing T3's launchers,
settings or background service:

```bash
~/.personal_migrations/setup-t3code-tailscale.py --bridge-only
```

In that mode, configure/run your own backend inside the namespace with matching
ports. Use `remove` before switching an existing desktop-managed installation to
bridge-only mode.

Manage the default installation:

```bash
t3code-wg2-bridge status
t3code-wg2-bridge install
t3code-wg2-bridge launch
t3code-wg2-bridge remove
```

For `--namespace wg3`, the command is `t3code-wg3-bridge`. Removal works without a
running Tailscale connection. It closes the managed desktop, disables the bridges,
restores the namespace-specific hosts/resolver state, and restores managed desktop
settings/menu entries. A previously enabled/running background service is restored
to its recorded state. Unrelated later edits are preserved where possible;
redirected launchers and edited wrappers are not blindly overwritten.

Desktop backups are stored under
`${XDG_DATA_HOME:-~/.local/share}/t3code-wg2-bridge/desktop-original.json` (replace
`wg2` for another namespace); system backups are under
`/var/lib/t3code-wg2-bridge/`. Disabled bridge unit files and the standalone
management command remain available for reinstallation. Existing backups from
the original bridge-only migration are supported.

Name-lookup changes apply only to newly launched namespace processes. If the
namespace is destroyed/recreated, restart T3 and its three user bridge services.
The host bridge occupies the chosen backend port on host localhost, so a second
T3 backend outside the namespace cannot use that same host port. If another
backend still owns the namespace's port, the script stops with an error instead
of deleting a lock or killing that server. Backups remain available for recovery.

Offline checks (no administrator access, live services or network required):

```bash
python3 -m unittest discover -s ~/.personal_migrations/tests -v
```
