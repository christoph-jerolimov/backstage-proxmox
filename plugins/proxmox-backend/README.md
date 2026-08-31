# Proxmox actions backend plugin

Registers Proxmox VE operations in the Backstage **actions registry**, under
the plugin id `proxmox`. Everything registered there is available from three
places at once:

- **software templates** — the scaffolder mirrors registry actions into its
  template action registry, so `action: proxmox:create-vm` works in any
  template;
- **MCP** — this backend already runs `plugin-mcp-actions-backend`;
- the **actions HTTP API**, at `/api/proxmox/.backstage/actions/v1/actions`.

One example template per action lives in `examples/proxmox-templates/`.

## Configuration

Proxmox instances are declared in the Backstage connection configuration: the
top-level `connections` array, with `type: proxmox`.

```yaml
connections:
  - type: proxmox
    title: Local dev Proxmox
    baseUrl: https://localhost:8006
    # Development instances only — see "TLS" below.
    skipTlsVerify: true
    auth:
      - method: token
        tokenId: root@pam!full-access
        secret: ${PROXMOX_TOKEN_SECRET}
```

Add `proxmox` to `backend.actions.pluginSources` so the scaffolder picks the
actions up:

```yaml
backend:
  actions:
    pluginSources:
      - proxmox
```

Entries of other connection types (`github`, `aws`, …) in the same array are
ignored, not rejected.

### The `proxmox.connections` fallback key

The exact same entries are also accepted under a plugin-owned key:

```yaml
proxmox:
  connections:
    - baseUrl: https://localhost:8006 # "type: proxmox" may be left out here
      auth:
        - method: token
          tokenId: root@pam!full-access
          secret: ${PROXMOX_TOKEN_SECRET}
```

Why both: Backstage's connections framework is experimental and its connection
type registry is **closed**. `@backstage/connections` ships 13 built-in types,
none of them `proxmox`; it does not export `createConnectionType`; and its
`buildConnectionsFromConfig` throws `Unrecognised connection type` for anything
else. Nothing in the released packages validates the whole `connections` array
today, so a `type: proxmox` entry is safe — but if a future Backstage version
starts validating it, that entry would fail at startup. Moving the same list
under `proxmox.connections` is then the one-line fix, and the fallback key is
unaffected by the framework either way.

When custom connection types become registerable upstream, the connection type
defined in `src/connections/proxmoxConnectionType.ts` can be handed to the
framework and the local resolver deleted. The configuration above does not
change.

### Connection fields

| Field           | Required | Meaning                                                                                                                   |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`       | yes      | Absolute URL of the instance, including the port                                                                          |
| `title`         | no       | Name used to select this instance from an action. Defaults to `Proxmox VE`, qualified by host when several are configured |
| `match.plugins` | no       | Restricts the connection to the listed plugins                                                                            |
| `skipTlsVerify` | no       | Disables TLS certificate verification                                                                                     |
| `caFile`        | no       | PEM file with the CA that issued the instance certificate                                                                 |
| `auth`          | yes      | At least one auth entry                                                                                                   |

### Auth methods

`token` — an API token. This is the recommended method:

```yaml
auth:
  - method: token
    tokenId: svc-backstage@pve!readonly # user@realm!tokenName
    secret: ${PROXMOX_TOKEN_SECRET}
```

`password` — a user login. The plugin obtains a ticket, caches it until it
expires, and sends the CSRF prevention token on every write:

```yaml
auth:
  - method: password
    username: alice@pve # user@realm
    password: ${PROXMOX_PASSWORD}
```

When a connection configures both, actions prefer `token`.

**Use a scoped token, not `root@pam!full-access`.** Actions run against
Proxmox with whatever the connection is configured with, and Proxmox's own ACLs
are the real boundary — Backstage marks destructive actions so they are kept
out of dry runs, but it does not otherwise gate who may run them. Give the
service account exactly the privileges the actions you intend to use need. The
seeded `svc-backstage@pve!readonly` token in `pve8`/`pve9` is read-only on
purpose: `list-nodes` and `get-guest` work with it and every write is rejected
with 403.

### TLS

Certificates are verified by default. `skipTlsVerify: true` turns verification
off for one connection and logs a warning naming it; the `pve8`/`pve9` dev
instances need it because they present a self-signed certificate. Never set it
against a real Proxmox host — use `caFile` if the certificate comes from a
private CA.

Secrets never appear in action outputs, logs or error messages.

## Actions

Every action takes an optional `connection` (a connection title, host or URL),
which may be left out when exactly one connection is configured, and reports
`connectionTitle` in its output. Write actions take `waitForCompletion`
(default `true`) and `timeoutSeconds` (default 300), and report the Proxmox
task id (`taskId`).

| Action                          | Read-only | Destructive | Idempotent | What it does                                          |
| ------------------------------- | --------- | ----------- | ---------- | ----------------------------------------------------- |
| `proxmox:list-nodes`            | yes       | no          | yes        | Lists cluster nodes with status and usage             |
| `proxmox:get-guest`             | yes       | no          | yes        | Reads a VM or container's config and status           |
| `proxmox:create-vm`             | no        | no          | no         | Creates a QEMU VM, allocating a VMID if none is given |
| `proxmox:update-vm-config`      | no        | no          | yes        | Applies the given config fields to a VM               |
| `proxmox:set-guest-power-state` | no        | **yes**     | no         | start / stop / shutdown / reboot / suspend / resume   |
| `proxmox:delete-guest`          | no        | **yes**     | no         | Removes a VM or container                             |
| `proxmox:create-lxc`            | no        | no          | no         | Creates an LXC container from an OS template          |
| `proxmox:create-pool`           | no        | no          | no         | Creates a resource pool                               |
| `proxmox:update-pool`           | no        | no          | yes        | Changes a pool's comment and adds members             |

Only the read-only actions support scaffolder dry runs; a template containing a
destructive step logs `Skipping because … does not support dry-run` instead of
executing it.

### Proxmox tasks

Proxmox answers write requests with a task id (UPID) rather than a result, so
these actions poll `/nodes/{node}/tasks/{upid}/status` until the task stops and
fail unless its exit status is `OK`. A failed Proxmox job is therefore a failed
template step, not a step that reports success. On timeout the action fails but
still reports the task id so the job can be followed in Proxmox. Set
`waitForCompletion: false` to return as soon as Proxmox accepts the request.

### No secrets in action inputs

No action declares a `secrets` schema: the scaffolder invokes registry actions
with `{ id, input, credentials }` only, so an action requiring secrets cannot
be driven from a template. Credentials come from configuration instead, which
also keeps them out of task inputs and logs.

## Trying it out

Start one of the dev instances in `pve8/` or `pve9/` (see their READMEs), put
its token in your configuration, and run the templates from the scaffolder.

```bash
sudo podman compose -f pve9/compose.yaml up -d --build
source pve9/seed-output/tokens.env   # exports the seeded token values
```

The seeded fixtures the templates default to: node `pve`, storages `local` and
`backup`, pools `pool-dev` and `pool-prod`, VMs 101 (`web-01`) and 102
(`db-01`), containers 201 (`cache-01`) and 202 (`proxy-01`). The seeded guests
are config-only and cannot actually be started inside the container, so
`proxmox:set-guest-power-state` will report the Proxmox task failure rather
than a running guest there.

## Verification status

Every template below was executed through the real Backstage scaffolder — the
real actions-registry bridge, connection resolution, token authentication and
UPID polling — against a **scripted Proxmox stand-in** that serves the same
fixtures the `pve8`/`pve9` seed script creates. What is _not_ covered is the
real Proxmox API's exact responses; running the templates against a live
instance is still worth doing before trusting this against production
hardware, and needs a host with rootful podman.

| Template                          | Action                          | Result against the stand-in                        |
| --------------------------------- | ------------------------------- | -------------------------------------------------- |
| Proxmox — List Nodes              | `proxmox:list-nodes`            | Returned the node with status and usage            |
| Proxmox — Get Guest               | `proxmox:get-guest`             | Read VM 101 and container 201, config and status   |
| Proxmox — Create VM               | `proxmox:create-vm`             | Allocated a VMID, created the VM, awaited the task |
| Proxmox — Update VM Configuration | `proxmox:update-vm-config`      | Applied only the given field; others untouched     |
| Proxmox — Set Guest Power State   | `proxmox:set-guest-power-state` | Started a stopped guest, reported it running       |
| Proxmox — Delete Guest            | `proxmox:delete-guest`          | Stopped and removed a running guest                |
| Proxmox — Create LXC Container    | `proxmox:create-lxc`            | Created the container from an OS template          |
| Proxmox — Create Resource Pool    | `proxmox:create-pool`           | Created the pool                                   |
| Proxmox — Update Resource Pool    | `proxmox:update-pool`           | Updated the comment and added a member             |

Also confirmed end to end: leaving optional template parameters blank sends
_only_ the filled-in fields to Proxmox (the create-VM run with just node and
name posted `vmid` and `name` and nothing else); dry-running a read-only
template executes its step, while a template containing
`proxmox:delete-guest` logs `Skipping because proxmox:delete-guest does not
support dry-run` and makes no Proxmox call.

## Development

```bash
yarn workspace @internal/plugin-proxmox-backend test
```

Unit tests run against a fake Proxmox instance (`src/__testUtils__/`), so they
need no Proxmox and no network. They cover connection resolution and lookup,
both auth methods, TLS options, error mapping, secret redaction, UPID polling
(success, failure, timeout, no-wait), each action, and the templates' agreement
with the action schemas.
