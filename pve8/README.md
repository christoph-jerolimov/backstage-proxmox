# backstage-proxmox

Development and API-testing environment for working with the
[Proxmox VE](https://www.proxmox.com/en/proxmox-virtual-environment) REST API
(e.g. for a Backstage Proxmox plugin).

`compose.yaml` starts a **single-node Proxmox VE 8** instance as a privileged
systemd container (Debian 12 + the Proxmox packages — no ISO, no nested VM).
On first boot it automatically seeds itself with **multiple users, groups,
custom roles, ACLs, resource pools, storages, VMs, LXC containers and API
tokens** so different permission levels and API use cases can be tested right
away.

> ⚠️ **Dev/test only.** The container runs privileged, uses well-known
> passwords and pinned API token secrets, and the seeded guests are
> config-only (they are never started). Never expose it beyond localhost.

## Requirements

- Podman 4+ with `podman compose` (or the Python `podman-compose`)
- Rootful podman is recommended (`sudo`): Proxmox needs a privileged
  container, `/dev/fuse` (pmxcfs mounts `/etc/pve` via FUSE) and systemd
  inside the container
- ~2 GB disk for the image, ~1 GB RAM for the running instance

## Start

```bash
sudo podman compose up -d --build
# or: sudo podman-compose up -d --build
```

The first build downloads the Proxmox VE packages (a few minutes). Watch the
instance come up and get seeded:

```bash
sudo podman ps                                        # wait for "healthy"
sudo podman logs -f proxmox                           # systemd boot log
sudo podman exec proxmox journalctl -u pve-seed -f    # seeding progress
```

When seeding is done:

- **Web UI / API**: <https://localhost:8006> (self-signed certificate)
- **Login**: `root` / `proxmox` (realm *Linux PAM*) — change it via
  `PVE_ROOT_PASSWORD` in `compose.yaml`
- **API tokens**: exported to `./seed-output/tokens.env`

Stop with `sudo podman compose down`; the Proxmox configuration (users,
tokens, guests) is persisted in named volumes. **Full reset**:

```bash
sudo podman compose down -v && rm -f seed-output/tokens.env
sudo podman compose up -d
```

## Seeded resources

### Users and permissions

| User (realm `pve`) | Password | Group | Permissions |
|---|---|---|---|
| `root@pam` | `proxmox` | – | Everything (built-in) |
| `alice@pve` | `alice12345` | `admins` | `Administrator` on `/` |
| `bob@pve` | `bob1234567` | `devops` | `PVEVMAdmin` + `VMOperator` on `/vms`, `PVEDatastoreUser` on `/storage/local` |
| `carol@pve` | `carol12345` | `readonly` | `PVEAuditor` on `/` (read-only) |
| `svc-backstage@pve` | *(none — token only)* | – | custom role `BackstageAuditor` on `/` |

Custom roles:

- **`BackstageAuditor`** — `VM.Audit, Sys.Audit, Datastore.Audit, Pool.Audit`
  (the minimal read-only set a catalog-style integration needs)
- **`VMOperator`** — `VM.Audit, VM.PowerMgmt, VM.Console`

### API tokens

Secrets are pinned to well-known values so the examples below are
copy-pasteable (the effective values are also written to
`seed-output/tokens.env`):

| Token | Secret | Privilege separation | Effective access |
|---|---|---|---|
| `root@pam!full-access` | `00000000-0000-4000-8000-000000000001` | no (inherits user) | full admin |
| `svc-backstage@pve!readonly` | `00000000-0000-4000-8000-000000000002` | yes (own ACL) | `BackstageAuditor` on `/` |
| `bob@pve!vm-admin` | `00000000-0000-4000-8000-000000000003` | yes (own ACL) | `PVEVMAdmin` on `/vms` |
| `carol@pve!auditor` | `00000000-0000-4000-8000-000000000004` | no (inherits user) | read-only everywhere |

### Guests, pools and storages

| Resource | ID | Details |
|---|---|---|
| VM `web-01` | 101 | 2 cores / 2 GB, tags `web;dev`, pool `pool-dev` |
| VM `db-01` | 102 | 4 cores / 4 GB, tags `db;prod`, pool `pool-prod` |
| LXC `cache-01` | 201 | 512 MB, tags `cache;dev`, pool `pool-dev` |
| LXC `proxy-01` | 202 | 1 GB, tags `proxy;prod`, pool `pool-prod` |
| Storage `local` | – | dir storage, all content types enabled |
| Storage `backup` | – | dir storage for backups (`/srv/pve-backup`) |

All guests are **config-only fixtures**: they show up in every list/config/
status API call (status `stopped`) but cannot actually be started inside the
container.

## Testing the API

Base URL: `https://localhost:8006/api2/json` — full reference:
[Proxmox API viewer](https://pve.proxmox.com/pve-docs/api-viewer/).
`-k` is needed because of the self-signed certificate.

### With an API token

```bash
source seed-output/tokens.env    # sets PVE_URL and PVE_TOKEN_* variables

# Everything the full-access token can see
curl -ks -H "Authorization: $PVE_TOKEN_FULL_ACCESS" "$PVE_URL/cluster/resources" | jq

# Nodes, VMs and containers on node "pve"
curl -ks -H "Authorization: $PVE_TOKEN_READONLY" "$PVE_URL/nodes" | jq
curl -ks -H "Authorization: $PVE_TOKEN_READONLY" "$PVE_URL/nodes/pve/qemu" | jq
curl -ks -H "Authorization: $PVE_TOKEN_READONLY" "$PVE_URL/nodes/pve/lxc" | jq

# VM config and status
curl -ks -H "Authorization: $PVE_TOKEN_READONLY" "$PVE_URL/nodes/pve/qemu/101/config" | jq
curl -ks -H "Authorization: $PVE_TOKEN_READONLY" "$PVE_URL/nodes/pve/qemu/101/status/current" | jq

# Pools, storages, users, ACLs
curl -ks -H "Authorization: $PVE_TOKEN_FULL_ACCESS" "$PVE_URL/pools" | jq
curl -ks -H "Authorization: $PVE_TOKEN_FULL_ACCESS" "$PVE_URL/storage" | jq
curl -ks -H "Authorization: $PVE_TOKEN_FULL_ACCESS" "$PVE_URL/access/users" | jq
curl -ks -H "Authorization: $PVE_TOKEN_FULL_ACCESS" "$PVE_URL/access/acl" | jq
```

Or without the env file, with a raw header:

```bash
curl -ks \
  -H "Authorization: PVEAPIToken=root@pam!full-access=00000000-0000-4000-8000-000000000001" \
  https://localhost:8006/api2/json/version | jq
```

### Testing permission boundaries

The different tokens exist to exercise authorization behavior:

```bash
# Read-only token: GET works ...
curl -ks -H "Authorization: $PVE_TOKEN_READONLY" "$PVE_URL/nodes/pve/qemu/101/config" | jq
# ... but writes are rejected with 403 Permission check failed
curl -ks -X POST -H "Authorization: $PVE_TOKEN_READONLY" \
  "$PVE_URL/nodes/pve/qemu/101/status/start" -o /dev/null -w '%{http_code}\n'

# Bob's token is scoped to /vms: VM APIs work, user management does not
curl -ks -H "Authorization: $PVE_TOKEN_VM_ADMIN" "$PVE_URL/nodes/pve/qemu" | jq
curl -ks -H "Authorization: $PVE_TOKEN_VM_ADMIN" "$PVE_URL/access/users" | jq   # empty/filtered

# What may I do? (per authenticated identity)
curl -ks -H "Authorization: $PVE_TOKEN_VM_ADMIN" "$PVE_URL/access/permissions" | jq
```

### With username/password (ticket + CSRF token)

Interactive sessions authenticate with a ticket cookie; write requests
additionally need the CSRF prevention token:

```bash
DATA=$(curl -ks -d "username=alice@pve" -d "password=alice12345" \
  https://localhost:8006/api2/json/access/ticket)
TICKET=$(echo "$DATA" | jq -r .data.ticket)
CSRF=$(echo "$DATA"   | jq -r .data.CSRFPreventionToken)

curl -ks -b "PVEAuthCookie=$TICKET" "$PVE_URL/cluster/resources" | jq
curl -ks -b "PVEAuthCookie=$TICKET" -H "CSRFPreventionToken: $CSRF" \
  -X PUT "$PVE_URL/pools/pool-dev" -d "comment=updated via API" | jq
```

### From inside the container

```bash
sudo podman exec proxmox pvesh get /cluster/resources --output-format json
sudo podman exec proxmox pveum user list
sudo podman exec proxmox pveum user token list root@pam
sudo podman exec proxmox qm list
sudo podman exec proxmox pct list
```

### Using it from Backstage

Point the plugin/proxy at `https://localhost:8006` with the
`svc-backstage@pve!readonly` token (the `BackstageAuditor` role is the
minimal read-only permission set), and disable TLS verification for the
self-signed certificate in dev.

## How it works

- `proxmox/Containerfile` installs `pve-manager` from the
  `pve-no-subscription` repo on Debian bookworm and masks services that
  don't work in a container (networking, HA, firewall, ZFS, ...).
- `pve-hosts-fix.service` makes sure the hostname `pve` resolves to the
  container IP before `pve-cluster` (pmxcfs) starts.
- `pve-seed.service` runs `proxmox/scripts/pve-seed.sh` once on first boot:
  it waits for the API, then creates all resources via `pveum`/`pvesh`/`qm`,
  pins the token secrets and exports them to `seed-output/tokens.env`.
  Edit that script to add your own fixtures, then do a full reset.
- State is persisted in the `pve-cluster` (pmxcfs database: users, ACLs,
  tokens, guest configs) and `pve-vz` volumes.

## Troubleshooting

- **Container restarts / `pve-cluster` fails** — check
  `sudo podman exec proxmox journalctl -u pve-cluster`. pmxcfs needs
  `/dev/fuse` and a hostname that resolves to a non-loopback IP; both are
  configured in `compose.yaml` (`privileged`, `devices`, `hostname: pve`).
- **Rootless podman** — may work on some hosts, but FUSE mounts plus a
  privileged systemd container are unreliable rootless; use `sudo`.
- **Seeding failed / partial** — `journalctl -u pve-seed` inside the
  container shows each command. The script is defensive (individual
  failures are logged as warnings), and safe to re-run:
  `sudo podman exec proxmox bash -c 'rm -f /var/lib/vz/.pve-seed-done && /usr/local/bin/pve-seed.sh'`.
- **8006 already in use** — change the host port mapping in `compose.yaml`.
