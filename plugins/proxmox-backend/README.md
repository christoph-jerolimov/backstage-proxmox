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

| Action                              | Read-only | Destructive | Idempotent | What it does                                          |
| ----------------------------------- | --------- | ----------- | ---------- | ----------------------------------------------------- |
| `proxmox:list-nodes`                | yes       | no          | yes        | Lists cluster nodes with status and usage             |
| `proxmox:get-vm`                    | yes       | no          | yes        | Reads a VM's config and status                        |
| `proxmox:get-container`             | yes       | no          | yes        | Reads a container's config and status                 |
| `proxmox:create-vm`                 | no        | no          | no         | Creates a QEMU VM, allocating a VMID if none is given |
| `proxmox:create-container`          | no        | no          | no         | Creates an LXC container from an OS template          |
| `proxmox:update-vm-config`          | no        | no          | yes        | Applies the given config fields to a VM               |
| `proxmox:set-vm-power-state`        | no        | **yes**     | no         | start / stop / shutdown / reboot / suspend / resume   |
| `proxmox:set-container-power-state` | no        | **yes**     | no         | start / stop / shutdown / reboot                      |
| `proxmox:delete-vm`                 | no        | **yes**     | no         | Removes a VM                                          |
| `proxmox:delete-container`          | no        | **yes**     | no         | Removes a container                                   |
| `proxmox:create-pool`               | no        | no          | no         | Creates a resource pool                               |
| `proxmox:update-pool`               | no        | no          | yes        | Changes a pool's comment and adds members             |
| `proxmox:delete-pool`               | no        | **yes**     | no         | Removes a pool. Never deletes its members             |
| `proxmox:wait-for-tasks`            | yes       | no          | yes        | Waits for a list of Proxmox tasks to finish           |

VMs and containers have separate actions rather than one action with a
`guestType`, so each schema describes exactly one thing — a VM has `cores` and
`sockets`, a container has `swap` and a rootfs, and Proxmox offers `suspend`
and `resume` for VMs only.

Only the read-only actions support scaffolder dry runs; a template containing a
destructive step logs `Skipping because … does not support dry-run` instead of
executing it.

### Creating several resources at once

Every write action waits for its Proxmox task by default, so a template that
creates three VMs waits for each one before starting the next. To run them
concurrently, disable the wait and await the tasks together:

```yaml
steps:
  - id: create-first
    action: proxmox:create-vm
    input:
      node: pve
      name: web-01
      waitForCompletion: false # returns as soon as Proxmox accepts it

  - id: create-second
    action: proxmox:create-vm
    input:
      node: pve
      name: web-02
      waitForCompletion: false

  - id: wait
    action: proxmox:wait-for-tasks
    input:
      taskIds:
        - ${{ steps['create-first'].output.taskId }}
        - ${{ steps['create-second'].output.taskId }}
```

`proxmox:wait-for-tasks` fails the run unless every task exited `OK`, and names
**all** of the failures, not just the first. It reads each task's node from the
task id, so nothing but the ids the earlier steps returned is needed. An empty
list succeeds without doing anything, which is what keeps a template like this
dry-runnable — in a dry run the create steps are skipped and no task ids reach
the waiting step.

`examples/proxmox-templates/showcase/create-two-vms-and-wait.yaml` is this
pattern as a runnable template.

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

## Migrating from the earlier action names

The guest actions used to take a `guestType` of `qemu` or `lxc`. They are now
one action per guest kind, and the container create action was renamed to match:

| Removed                         | Use instead                                                         |
| ------------------------------- | ------------------------------------------------------------------- |
| `proxmox:get-guest`             | `proxmox:get-vm` or `proxmox:get-container`                         |
| `proxmox:set-guest-power-state` | `proxmox:set-vm-power-state` or `proxmox:set-container-power-state` |
| `proxmox:delete-guest`          | `proxmox:delete-vm` or `proxmox:delete-container`                   |
| `proxmox:create-lxc`            | `proxmox:create-container`                                          |

Drop the `guestType` input; everything else is unchanged. Two details worth
knowing: `get-vm` reports `name` where `get-container` reports `hostname`, and
`set-container-power-state` does not offer `suspend` or `resume` — Proxmox does
not support them for containers, so those requests failed at the API before and
are now rejected as invalid input before any request is made.

`proxmox:delete-pool` removes a pool only. Its member VMs, containers and
storages are never deleted; `removeMembers` detaches them from the pool so the
pool itself can be removed.

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

| Template                                     | Action                                           | Result against the stand-in                        |
| -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Proxmox — List Nodes                         | `proxmox:list-nodes`                             | Returned the node with status and usage            |
| Proxmox — Get VM                             | `proxmox:get-vm`                                 | Read VM 101, config and status                     |
| Proxmox — Get Container                      | `proxmox:get-container`                          | Read container 201, reporting its hostname         |
| Proxmox — Create VM                          | `proxmox:create-vm`                              | Allocated a VMID, created the VM, awaited the task |
| Proxmox — Create Container                   | `proxmox:create-container`                       | Created the container from an OS template          |
| Proxmox — Update VM Configuration            | `proxmox:update-vm-config`                       | Applied only the given field; others untouched     |
| Proxmox — Set VM Power State                 | `proxmox:set-vm-power-state`                     | Started a stopped VM, reported it running          |
| Proxmox — Set Container Power State          | `proxmox:set-container-power-state`              | Started a stopped container                        |
| Proxmox — Delete VM                          | `proxmox:delete-vm`                              | Stopped and removed a running VM                   |
| Proxmox — Delete Container                   | `proxmox:delete-container`                       | Removed a stopped container                        |
| Proxmox — Create Resource Pool               | `proxmox:create-pool`                            | Created the pool                                   |
| Proxmox — Update Resource Pool               | `proxmox:update-pool`                            | Updated the comment and added a member             |
| Proxmox — Delete Resource Pool               | `proxmox:delete-pool`                            | Detached the member, then removed the pool         |
| Proxmox — Wait for Tasks                     | `proxmox:wait-for-tasks`                         | Succeeded on an empty list without polling         |
| Proxmox — Create Two VMs and Wait (showcase) | `proxmox:create-vm` ×2, `proxmox:wait-for-tasks` | Both VMs created and both tasks awaited            |

Also confirmed end to end:

- **Concurrency.** In the showcase run, both `create-vm` requests were issued
  before the first task poll — the creates do not serialise.
- **Blank optional parameters.** Running the create-VM template with only node
  and name posts exactly `vmid` and `name` to Proxmox, nothing empty.
- **Dry runs.** The read-only templates (`list-nodes`, `get-vm`,
  `get-container`, `wait-for-tasks`) execute; every destructive one logs
  `Skipping because … does not support dry-run` and makes no Proxmox call. The
  showcase dry-runs cleanly: its two create steps are skipped and the awaiting
  step ignores the placeholder values the dry run substitutes for their
  outputs, making no Proxmox call.
- **Catalog.** All 15 templates register — 14 `proxmox-action`, one
  `proxmox-showcase` — and all 14 actions appear in the scaffolder.

## Development

```bash
yarn workspace @internal/plugin-proxmox-backend test
```

Unit tests run against a fake Proxmox instance (`src/__testUtils__/`), so they
need no Proxmox and no network. They cover connection resolution and lookup,
both auth methods, TLS options, error mapping, secret redaction, UPID polling
(success, failure, timeout, no-wait), each action, and the templates' agreement
with the action schemas.
