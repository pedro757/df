# Personal migrations

## T3 Code + Tailscale HTTPS inside a WireGuard namespace

`setup-t3code-tailscale.py` installs the localhost-only bridges needed to keep
T3 Code inside `wg2-run` while using the host's Tailscale HTTPS endpoint.

Prerequisites:

- An existing namespace and launcher, such as `wg2-netns.service` and `wg2-run`
  from `setup-wg2-netns.sh`.
- Python 3, systemd, socat and a connected Tailscale client.
- MagicDNS and HTTPS enabled for the tailnet; T3's user must already have any
  Tailscale permissions required to configure Serve.

Run as the desktop user, **not** with `sudo`:

```bash
~/.personal_migrations/setup-t3code-tailscale.py --dry-run
~/.personal_migrations/setup-t3code-tailscale.py
```

The migration discovers the current Unix user, UID and Tailscale hostname. It
creates all four services, installs a standalone management command, and saves
machine-specific settings under `$XDG_CONFIG_HOME` (or `~/.config`). Only the
system listener and namespace name-lookup files require administrator approval.
Rerunning preserves the original backups and applies changed settings.

Other namespace or ports:

```bash
~/.personal_migrations/setup-t3code-tailscale.py --namespace wg3 --backend-port 4773 --https-port 8443
```

T3 must use the same ports. The migration does not change T3's settings or menu
entry: keep launching it through the chosen namespace's `NAME-run` command.
It also does not change routes, firewall rules, Tailscale operators or other
applications' Serve mappings. Private Unix sockets connect the host and
namespace; the extra TCP listeners bind only to localhost. TLS verification stays
enabled, and ordinary internet traffic remains routed through the VPN.

Manage the default installation:

```bash
t3code-wg2-bridge status
t3code-wg2-bridge install
# Quit T3 before removal:
t3code-wg2-bridge remove
```

For `--namespace wg3`, the command is `t3code-wg3-bridge`. Removal works without a
running Tailscale connection. It disables the four services and restores the
namespace-specific hosts/resolver state, preserving unrelated later edits.
Disabled user units and the standalone command remain for reinstalling. Existing
backups from the original T3/wg2 bridge are supported.

Name-lookup changes apply only to newly launched namespace processes. If the
namespace is destroyed/recreated, restart T3 and its three user bridge services.
The host bridge occupies the chosen backend port on host localhost, so a second
T3 backend outside the namespace cannot use that same host port.

Offline checks (no administrator access, live services or network required):

```bash
python3 -m unittest discover -s ~/.personal_migrations/tests -v
```
