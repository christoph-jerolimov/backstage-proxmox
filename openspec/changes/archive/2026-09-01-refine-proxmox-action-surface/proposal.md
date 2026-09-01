## Why

The Proxmox actions ship three actions that take a `guestType` of `qemu` or `lxc` — `get-guest`, `set-guest-power-state` and `delete-guest`. Folding both guest kinds into one action looked like it kept the surface small, but it pushes a Proxmox implementation detail into every caller: a template author has to know that a container is `lxc` and a VM is `qemu`, the generated JSON Schema cannot express that a VM has `cores` and `sockets` while a container has `swap` and a rootfs, and an MCP client picking a tool sees "guest" where the user asked about a container. Splitting them per guest kind makes each action's schema describe exactly one thing.

Two gaps also showed up while using the actions:

- Every write action either blocks until its Proxmox task finishes or returns a task id nobody can act on. Creating several resources in one template therefore serialises: each step waits before the next starts. There is no way to fire the creates off with `waitForCompletion: false` and then wait for all of them together.
- Pools can be created and updated but not removed, so a template that provisions a pool has no counterpart that tears it down.

## What Changes

- **BREAKING**: `proxmox:get-guest` is replaced by **`proxmox:get-vm`** and **`proxmox:get-container`**.
- **BREAKING**: `proxmox:set-guest-power-state` is replaced by **`proxmox:set-vm-power-state`** and **`proxmox:set-container-power-state`**.
- **BREAKING**: `proxmox:delete-guest` is replaced by **`proxmox:delete-vm`** and **`proxmox:delete-container`**.
- **BREAKING**: `proxmox:create-lxc` is renamed to **`proxmox:create-container`**, so the whole surface speaks of VMs and containers rather than mixing in Proxmox's `lxc` path segment.
- The `guestType` input disappears from every action; each action targets one guest kind. Per-kind inputs and outputs become specific — `set-container-power-state` drops the `suspend` and `resume` states Proxmox does not offer for containers, and the split read actions report `name` for a VM and `hostname` for a container.
- **New action `proxmox:wait-for-tasks`**: takes an array of Proxmox task ids (UPIDs) and waits for all of them, succeeding only when every task exits `OK` and reporting each task's outcome. The node is read from the UPID, so callers pass only what earlier steps returned. It is read-only, so it works in dry runs, and an empty list is a no-op — which is what a dry run of a create-then-wait template produces once the create steps are skipped.
- **New action `proxmox:delete-pool`**: removes a resource pool. Proxmox refuses to delete a pool that still has members, so the action fails with a clear message naming them, unless `removeMembers` is set, in which case members are detached first.
- **Templates**: one template per action as before, so the three splits and the rename become six and one renamed templates, plus new templates for `wait-for-tasks` and `delete-pool` — fifteen in total. One of them is new in kind: a **multi-step showcase template** that creates two VMs with `waitForCompletion: false` and then waits for both with `proxmox:wait-for-tasks`, demonstrating the pattern the action exists for.

## Capabilities

### New Capabilities

None — this reshapes capabilities that already exist.

### Modified Capabilities

- `proxmox/actions`: the guest actions are replaced by per-kind actions, `create-lxc` is renamed, and two actions are added. The requirements describing `get guest`, `set guest power state`, `delete guest` and `create LXC container` are replaced; requirements for `wait for tasks` and `delete resource pool` are added.
- `proxmox/software-templates`: the one-template-per-action requirement stays, but the rule that every template runs exactly one step is relaxed so a single showcase template may chain steps, and the showcase itself becomes a requirement.

## Impact

- **Modified**: `plugins/proxmox-backend/src/actions/` — `getGuest.ts`, `setGuestPowerState.ts` and `deleteGuest.ts` are replaced by per-kind modules, `createLxc.ts` is renamed, `helpers.ts` loses `guestFields` and gains per-kind field builders, and `index.ts` registers fourteen actions. New modules for `waitForTasks` and `deletePool`. Unit tests move with them.
- **Modified**: `examples/proxmox-templates/` — three templates split into six, one renamed, two added, one showcase added; `app-config.yaml` catalog locations follow.
- **Modified**: `plugins/proxmox-backend/README.md` — the action table, and a note on the create-many-then-wait pattern.
- **No change**: the connections capability, the Proxmox client, auth, TLS and error mapping. `wait-for-tasks` reuses the existing UPID polling helper.
- **Migration**: anyone calling the removed action ids must switch to the per-kind ones and drop `guestType`. This repo's own templates are the only known callers. The old ids are removed rather than kept as aliases — see design.md for why.
- **Risk**: `wait-for-tasks` derives the node from the UPID string. If a UPID is malformed or from another cluster, the action must fail clearly rather than poll the wrong node.
