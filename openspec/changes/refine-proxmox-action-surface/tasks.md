## 1. Shared groundwork

- [x] 1.1 Replace `guestFields` in `helpers.ts` with `vmFields(z)` and `containerFields(z)` (`node`, `vmid`, kind-specific descriptions), keeping `guestPath` internal; verify `yarn tsc` is clean and existing helper tests pass
- [x] 1.2 Add the not-found mapping from design D9 to `client/errors.ts` — a 500 whose Proxmox message says a configuration file does not exist becomes `NotFoundError`; verify a unit test covers both the 500-configuration-file case and that other 500s still map to a generic error

## 2. Split the guest actions

- [x] 2.1 Replace `getGuest.ts` with a shared factory registering `proxmox:get-vm` and `proxmox:get-container` (VM reports `name`, container reports `hostname`); verify unit tests cover reading each kind, an unknown VMID, and asking for a VMID of the other kind returning a not-found error
- [x] 2.2 Replace `setGuestPowerState.ts` with a factory registering `proxmox:set-vm-power-state` (start/stop/shutdown/reboot/suspend/resume) and `proxmox:set-container-power-state` (start/stop/shutdown/reboot only); verify unit tests cover starting a stopped guest of each kind, the already-in-that-state no-op, and that `suspend` on a container is rejected as an input error with no Proxmox request
- [x] 2.3 Replace `deleteGuest.ts` with a factory registering `proxmox:delete-vm` and `proxmox:delete-container`; verify unit tests cover deleting a stopped guest, refusing a running one, and stop-then-delete, for both kinds
- [x] 2.4 Rename `createLxc.ts` to `createContainer.ts` registering `proxmox:create-container` with unchanged inputs and outputs; verify the existing create-container tests pass under the new action id
- [x] 2.5 Update `actions/index.ts` and `PROXMOX_ACTION_NAMES`, and confirm no source, test or doc still references `get-guest`, `set-guest-power-state`, `delete-guest`, `create-lxc` or `guestType`; verify with a repo-wide grep that returns nothing outside `openspec/changes/`

## 3. New actions

- [x] 3.1 Add a UPID parser that extracts the node from `UPID:<node>:…` and rejects anything malformed; verify unit tests cover a real-shaped UPID, a UPID with an empty node, and a non-UPID string
- [x] 3.2 Register `proxmox:wait-for-tasks` (read-only, idempotent, `taskIds` optional defaulting to `[]`) polling all tasks concurrently against one shared deadline with bounded concurrency, de-duplicating ids, and aggregating results with `Promise.allSettled`; verify unit tests cover all-succeed, one failure, two failures both named in the error, a timeout naming the still-running tasks, an empty list making no Proxmox request, a malformed id failing before any polling, and a duplicate id polled once
- [x] 3.3 Register `proxmox:delete-pool` (destructive) reading the pool first, failing with the member list unless `removeMembers` is set and otherwise detaching members before deleting; verify unit tests cover an empty pool, a non-empty pool refused with its members named, detach-then-delete leaving the guests intact, and an unknown pool reported as not found
- [x] 3.4 Assert the whole registered surface: fourteen actions, the expected attribute table, no `schema.secrets`, every action accepting `connection` and reporting `connectionTitle`; verify by extending the existing registry test

## 4. Templates

- [x] 4.1 Split, rename and add the per-action templates in `examples/proxmox-templates/` so each of the fourteen actions has exactly one single-step template; verify the template test's 1:1 assertion passes
- [x] 4.2 Add `examples/proxmox-templates/showcase/create-two-vms-and-wait.yaml` — two `create-vm` steps with `waitForCompletion: false`, then one `wait-for-tasks` step fed both task ids, with outputs reporting both VMIDs; verify it parses and its steps reference only registered action ids
- [x] 4.3 Update `templates.test.ts` to glob the top level for the per-action invariant and to check showcase templates separately (steps reference registered actions, parameters it collects are passed through); verify the suite passes
- [x] 4.4 Update the catalog locations in `app-config.yaml` for the renamed, split, added and showcase templates; verify a backend start lists all fifteen templates in the catalog

## 5. Documentation

- [x] 5.1 Update the README action table to the fourteen actions with their attributes, and document the create-many-then-wait pattern with the showcase template as the example; verify the table matches the registered actions one for one
- [x] 5.2 Document the removed action ids and their replacements in the README, including that `delete-pool` never deletes member guests or storages; verify a reader can migrate an existing template from the README alone

## 6. Verification

- [x] 6.1 Run `yarn tsc`, `yarn lint:all`, `yarn prettier:check` on the changed files, and `CI=true yarn test`; verify all pass
- [x] 6.2 Run every per-action template and the showcase end to end through the scaffolder against a Proxmox stand-in; verify each completes with the expected outputs and that the showcase requests both VMs before awaiting either
- [x] 6.3 Verify dry-run behaviour: the read-only templates including `wait-for-tasks` dry-run, the destructive ones are skipped, and the showcase dry-runs with its create steps skipped and the awaiting step succeeding without polling
- [x] 6.4 Record the per-action verification outcomes in the README's verification section, keeping the note that a live Proxmox instance run is still outstanding
