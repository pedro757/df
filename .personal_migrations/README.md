# Personal migrations

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
