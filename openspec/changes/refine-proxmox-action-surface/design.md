## Context

See `proposal.md` — Why. The relevant existing shape, all of it in `plugins/proxmox-backend`:

- `helpers.ts` exposes `guestFields(z)` (`node`, `vmid`, `guestType: 'qemu' | 'lxc'`) and `guestPath(node, guestType, vmid)`; `getGuest.ts`, `setGuestPowerState.ts` and `deleteGuest.ts` each take `guestType` and vary only the URL segment.
- `client/tasks.ts` has `waitForProxmoxTask({ client, node, taskId, timeoutSeconds, operation, sleep, now })`, which polls `/nodes/{node}/tasks/{upid}/status` with bounded backoff and throws on a non-`OK` exit status or on timeout, and `resolveProxmoxTask`, which normalises the id and honours `waitForCompletion`.
- Action ids come from `${pluginId}:${name}`; the scaffolder mirrors registry actions into template actions and computes `supportsDryRun = readOnly === true && destructive === false`. `create-vm` is `readOnly: false`, so create steps are skipped in a dry run.
- `examples/proxmox-templates/*.yaml` holds one single-step template per action, and `src/actions/templates.test.ts` asserts the 1:1 mapping by globbing that directory.

A Proxmox task id is a colon-delimited UPID whose **second field is the node**: `UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>:`. That is what makes `wait-for-tasks` possible without asking the caller for a node.

Naming and the showcase template were settled with the user: the surface uses "vm" and "container" throughout (so `create-lxc` is renamed), and `wait-for-tasks` gets both a per-action template and a multi-step showcase.

## Goals / Non-Goals

**Goals:**

- Each action's schema describes exactly one guest kind, with no `guestType` discriminator and no fields that apply to only half the inputs.
- Splitting three actions into six does not triple the code: the per-kind actions share one implementation each.
- Several resources can be created concurrently from one template and awaited in a single step, with every failure reported rather than just the first.
- Removals are complete in one change: no template, test or doc still references a removed action id.

**Non-Goals:**

- No compatibility aliases for the removed ids (see D2).
- No change to connections, auth, TLS, error mapping or the Proxmox client beyond what the new actions need.
- No general "run these steps in parallel" scaffolder facility — `wait-for-tasks` covers the Proxmox-task case only.
- No `update-container-config` counterpart to `update-vm-config`; nobody has asked for it and this change is already wide.

## Decisions

### D1 — Split the action, share the implementation

Each pair is produced by one factory parameterised by guest kind, e.g. `createGetGuestAction({ kind: 'qemu', name: 'get-vm', title: …, nameField: 'name' })` registered twice. The schemas and titles differ per kind; the request/response handling does not. `helpers.ts` loses `guestFields` and gains `vmFields(z)` and `containerFields(z)`, both `{ node, vmid }` with kind-specific descriptions; `guestPath` keeps its internal `qemu | lxc` parameter because that is what the Proxmox URL actually is.

Alternative considered: six independent modules. Rejected — the divergence between kinds is a handful of strings and, for power state, one enum; duplicating the status/task/error handling six ways is where drift starts.

### D2 — Remove the old ids outright, no deprecated aliases

`get-guest`, `set-guest-power-state`, `delete-guest` and `create-lxc` stop being registered. Keeping them as aliases was considered and rejected: the actions registry has no deprecation marker, so an alias is indistinguishable from a real action in the scaffolder's action list and in the MCP tool list — clients would see eighteen actions with no signal which seven not to use. The surface is one change old and its only known callers are this repo's own templates, which are updated in the same change. The removal is recorded with a migration note in the delta spec and in the README.

### D3 — `create-lxc` becomes `create-container`

Chosen by the user over keeping `create-lxc` or naming the new actions `-lxc`. It makes every guest action read `<verb>-vm` / `<verb>-container`, at the cost of renaming an existing action. Inputs and outputs are untouched, so the migration is the id alone. `lxc` survives only where it is Proxmox's own vocabulary: the API path segment and the `ostemplate` volume name.

### D4 — `wait-for-tasks` reads the node from the UPID

Input is `taskIds: string[]`; the node for each is parsed from field 2 of the UPID, validated with a regex that requires the `UPID:` prefix and a non-empty node. A malformed id fails the whole action with an `InputError` naming it, before any polling — polling the wrong node would otherwise 404 in a way that looks like a missing task.

Alternative considered: `tasks: Array<{ taskId, node }>`. Rejected because a scaffolder step can only forward what an earlier step returned, and earlier steps return `taskId` as a plain string; making template authors zip ids with nodes is friction that buys nothing the UPID does not already carry. A `node` input is not offered as an override either — if the UPID is unparseable, the right answer is to fix the caller, not to guess.

Behaviour details:

- Ids are de-duplicated before polling, so the same task passed twice is polled and reported once.
- All tasks are polled concurrently against one shared deadline, so the timeout is wall-clock for the set rather than per task multiplied by the list length. Concurrency is bounded (a small fixed limit) so a fifty-task list does not open fifty sockets at once.
- Results are collected with `Promise.allSettled`, so **every** failed or timed-out task appears in the error, not just the first to reject. `waitForProxmoxTask` keeps throwing on first failure for its single-task callers; the aggregation lives in the new action.
- Output is `tasks: [{ taskId, node, exitStatus }]` plus the usual `connectionTitle`.

### D5 — `taskIds` is optional and defaults to `[]`

An empty list succeeds without polling. This is what makes the showcase template dry-runnable: in a dry run the create steps are skipped, so `${{ steps['create-a'].output.taskId }}` renders to nothing and the scaffolder drops the key. The trade-off is that a mistyped input silently no-ops instead of failing loudly. Accepted, because the alternative — a required `taskIds` — makes every template containing this action fail its dry run, which is the check most likely to catch a broken template before it touches real infrastructure.

### D6 — `wait-for-tasks` is read-only

It only reads task status. `readOnly: true, destructive: false, idempotent: true` makes it dry-run safe, which D5 depends on. That it is typically used alongside destructive work does not make the action itself destructive; the create steps carry that flag.

### D7 — `delete-pool` refuses a non-empty pool by default

Proxmox rejects `DELETE /pools/{poolid}` while the pool has members, so the action reads the pool first and fails with the member list rather than surfacing a bare Proxmox error. `removeMembers: true` detaches them first (`PUT /pools/{poolid}` with the member list and `delete=1`) and then deletes. Deleting a pool never deletes its guests or storages, and the README says so — "delete pool" is the phrase most likely to be misread as destroying its contents.

### D8 — Showcase templates live in a subdirectory

`examples/proxmox-templates/showcase/` holds multi-step templates; the top level keeps exactly one single-step template per action. The per-action test globs the top level only, so the 1:1 invariant it enforces stays meaningful, and "is this a showcase?" is a directory question rather than a naming convention someone has to remember. Both directories are registered as catalog locations.

The showcase itself: two `create-vm` steps with `waitForCompletion: false`, then one `wait-for-tasks` step fed both task ids, then outputs reporting both VMIDs.

### D9 — Kind mismatches are reported as not-found

Asking Proxmox for `/nodes/{node}/qemu/{vmid}` where the VMID is a container does not reliably return 404 — Proxmox answers 500 with a message like `Configuration file 'nodes/pve/qemu-server/201.conf' does not exist`. The client's error mapping gains one case: a 500 whose message says a configuration file does not exist becomes a `NotFoundError`. This keeps "wrong kind" and "no such guest" indistinguishable to the caller, which is what the spec asks for and is the honest answer — from the caller's point of view there is no VM with that id.

## Risks / Trade-offs

- **A breaking rename lands with no deprecation window** → Mitigated by scope: the actions are one change old, every in-repo caller is updated in the same change, and the delta spec carries a migration note per removed id. Anyone outside this repo gets a clear "action not registered" error from the scaffolder naming the unknown id.
- **UPID parsing is a guess about a format Proxmox does not version** → The regex is deliberately loose (prefix plus a non-empty second field) and failure is loud and immediate. The seeded dev instances and the fake both produce real-shaped UPIDs, and a unit test pins the format.
- **Concurrent polling multiplies load on the Proxmox API** → Bounded concurrency plus the existing backoff. A template awaiting a handful of tasks is the expected case; the bound keeps a pathological list from behaving badly.
- **`wait-for-tasks` cannot tell "task finished long ago" from "task never existed"** → Proxmox keeps task status for finished tasks, but a very old or pruned UPID 404s. That surfaces as a not-found error naming the task, which is the best available answer.
- **The action count grows from nine to fourteen** → More entries in the MCP tool list and the scaffolder action list. This is the deliberate trade of the split: a longer list of precise actions beats a short list of actions whose schemas describe two things at once.
- **Two template shapes now exist** → The subdirectory split (D8) keeps the distinction mechanical, and the per-action test still fails if any action loses its template.

## Migration Plan

Additive and destructive changes land together, in this order, so the tree is never in a state where a template references an action that does not exist:

1. `helpers.ts` per-kind field builders and the shared action factories.
2. The six split actions and the `create-container` rename, replacing the four old modules and their tests.
3. `wait-for-tasks` and `delete-pool`, with the client's not-found mapping from D9.
4. Templates: six split, one renamed, two added, one showcase; `app-config.yaml` catalog locations updated in the same step.
5. README action table and the create-many-then-wait note.

Nothing persists state, so rollback is reverting the commit. A deployment that reverts while a template referencing a new action id is still in someone's catalog gets a clear unknown-action failure, not a silent misbehaviour.

## Open Questions

- Whether `set-container-power-state` should keep a `force` option for `stop` (Proxmox's container stop is already abrupt). Deferrable: it is an additive optional input that changes no existing behaviour.
- Whether `wait-for-tasks` should also report each task's log tail on failure. Useful for debugging a failed create, but it is another Proxmox call per failed task and can be added without changing the action's contract.
