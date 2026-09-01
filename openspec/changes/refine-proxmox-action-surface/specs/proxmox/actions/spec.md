## MODIFIED Requirements

### Requirement: Long-running Proxmox operations are awaited

Proxmox returns a task identifier (UPID) for operations it runs asynchronously. Actions that trigger such an operation SHALL poll the task status until it finishes or a timeout elapses, SHALL succeed only when the task's exit status is `OK`, and SHALL include the task identifier in their output. Actions SHALL accept an optional timeout and an optional flag to return as soon as the task is accepted instead of waiting. A task identifier returned by an action that did not wait SHALL remain awaitable afterwards, so several operations can be started concurrently and awaited together.

#### Scenario: Task succeeds

- **WHEN** an action triggers a Proxmox operation that completes with exit status `OK`
- **THEN** the action succeeds and its output includes the task identifier

#### Scenario: Task fails

- **WHEN** the Proxmox task finishes with a non-`OK` exit status
- **THEN** the action fails and the error message contains the Proxmox exit status

#### Scenario: Task exceeds the timeout

- **WHEN** the task has not finished before the configured timeout elapses
- **THEN** the action fails with a timeout error that includes the task identifier so the operation can be inspected in Proxmox

#### Scenario: Caller opts out of waiting

- **WHEN** an action is invoked with the wait flag disabled
- **THEN** the action returns as soon as Proxmox accepts the request, with the task identifier in its output

#### Scenario: Awaiting tasks that were started earlier

- **WHEN** several actions are invoked with the wait flag disabled and their task identifiers are then passed to the awaiting action
- **THEN** the outcome of every one of those tasks is reported

## ADDED Requirements

### Requirement: Action — get VM

`proxmox:get-vm` SHALL return the configuration and current status of one QEMU virtual machine, identified by node and VMID. It SHALL be read-only and idempotent, and SHALL report the VM's name.

#### Scenario: Reading a VM

- **WHEN** `proxmox:get-vm` is invoked for an existing VM
- **THEN** the output contains the VMID, name, status and the VM's configuration

#### Scenario: Unknown VM

- **WHEN** the VMID does not exist
- **THEN** the action fails with a not-found error naming the VMID and node

#### Scenario: VMID belongs to a container

- **WHEN** the VMID identifies an LXC container rather than a VM
- **THEN** the action fails with a not-found error rather than returning the container

### Requirement: Action — get container

`proxmox:get-container` SHALL return the configuration and current status of one LXC container, identified by node and VMID. It SHALL be read-only and idempotent, and SHALL report the container's hostname.

#### Scenario: Reading a container

- **WHEN** `proxmox:get-container` is invoked for an existing container
- **THEN** the output contains the VMID, hostname, status and the container's configuration

#### Scenario: VMID belongs to a VM

- **WHEN** the VMID identifies a QEMU VM rather than a container
- **THEN** the action fails with a not-found error rather than returning the VM

### Requirement: Action — set VM power state

`proxmox:set-vm-power-state` SHALL bring a QEMU virtual machine to a requested state of `start`, `stop`, `shutdown`, `reboot`, `suspend` or `resume`. It SHALL be destructive because it interrupts a running workload, and SHALL return the VM's status after the operation and whether anything changed.

#### Scenario: Starting a stopped VM

- **WHEN** the action requests `start` for a stopped VM
- **THEN** the action waits for the Proxmox task and the output reports the VM as running and changed

#### Scenario: Requesting the state a VM is already in

- **WHEN** the action requests `start` for a VM that is already running
- **THEN** the action succeeds, reports the VM as running and reports that nothing changed

### Requirement: Action — set container power state

`proxmox:set-container-power-state` SHALL bring an LXC container to a requested state of `start`, `stop`, `shutdown` or `reboot`. It SHALL NOT offer `suspend` or `resume`, which Proxmox does not support for containers. It SHALL be destructive, and SHALL return the container's status after the operation and whether anything changed.

#### Scenario: Starting a stopped container

- **WHEN** the action requests `start` for a stopped container
- **THEN** the action waits for the Proxmox task and the output reports the container as running and changed

#### Scenario: Requesting a state that does not apply to containers

- **WHEN** the action is invoked with a state of `suspend`
- **THEN** the invocation fails with an input error naming the states the action accepts, and no Proxmox request is made

### Requirement: Action — delete VM

`proxmox:delete-vm` SHALL remove a QEMU virtual machine identified by node and VMID. It SHALL be destructive. It SHALL accept an option to stop a running VM first, and without that option a running VM SHALL NOT be deleted.

#### Scenario: Deleting a stopped VM

- **WHEN** `proxmox:delete-vm` is invoked for a stopped VM
- **THEN** the VM is removed and the output reports the VMID and the task identifier

#### Scenario: Deleting a running VM without the stop option

- **WHEN** the VM is running and the stop option is not set
- **THEN** the action fails with an error stating that the VM is running, and the VM is not removed

#### Scenario: Deleting a running VM with the stop option

- **WHEN** the same call sets the stop option
- **THEN** the VM is stopped first and then removed

### Requirement: Action — delete container

`proxmox:delete-container` SHALL remove an LXC container identified by node and VMID. It SHALL be destructive. It SHALL accept an option to stop a running container first, and without that option a running container SHALL NOT be deleted.

#### Scenario: Deleting a stopped container

- **WHEN** `proxmox:delete-container` is invoked for a stopped container
- **THEN** the container is removed and the output reports the VMID and the task identifier

#### Scenario: Deleting a running container without the stop option

- **WHEN** the container is running and the stop option is not set
- **THEN** the action fails with an error stating that the container is running, and the container is not removed

### Requirement: Action — create container

`proxmox:create-container` SHALL create an LXC container on a named node, accepting a hostname, an OS template, and optional VMID, cores, memory, swap, root filesystem storage and size, network device, tags, pool, unprivileged flag and description. When no VMID is given it SHALL allocate the next free VMID and return it.

#### Scenario: Creating a container

- **WHEN** `proxmox:create-container` is invoked with a hostname and an OS template
- **THEN** the container is created and the output reports the VMID, node and task identifier

#### Scenario: Missing OS template

- **WHEN** the referenced OS template does not exist on the target storage
- **THEN** the action fails with an error naming the template

### Requirement: Action — wait for tasks

`proxmox:wait-for-tasks` SHALL accept a list of Proxmox task identifiers and wait until every one of them has finished or a timeout elapses. It SHALL determine each task's node from the task identifier itself, so callers pass only the identifiers earlier actions returned. It SHALL be read-only and idempotent. It SHALL succeed only when every task exited `OK`, and SHALL report each task's identifier, node and exit status.

#### Scenario: All tasks succeed

- **WHEN** the action is given the identifiers of three tasks that all exit `OK`
- **THEN** the action succeeds and its output reports all three as succeeded

#### Scenario: One task fails

- **WHEN** one of the given tasks finishes with a non-`OK` exit status
- **THEN** the action fails, and the error names every failed task with its exit status

#### Scenario: Several tasks fail

- **WHEN** two of the given tasks fail
- **THEN** the error names both rather than only the first

#### Scenario: A task does not finish in time

- **WHEN** a task has not finished before the timeout elapses
- **THEN** the action fails with a timeout error naming the tasks that were still running

#### Scenario: Empty list

- **WHEN** the action is invoked with an empty list of task identifiers
- **THEN** the action succeeds without making any Proxmox request

#### Scenario: Placeholders from a skipped dry-run step

- **WHEN** the list contains the placeholder values a scaffolder dry run substitutes for the outputs of steps it skipped
- **THEN** those entries are ignored rather than treated as task identifiers
- **AND** any real task identifiers in the same list are still awaited

#### Scenario: Malformed task identifier

- **WHEN** a given identifier is not a Proxmox task identifier and no node can be read from it
- **THEN** the action fails with an input error naming the offending identifier, and no task is polled

#### Scenario: Duplicate identifiers

- **WHEN** the same task identifier appears more than once in the list
- **THEN** it is reported once and polled once

### Requirement: Action — delete resource pool

`proxmox:delete-pool` SHALL remove a Proxmox resource pool. It SHALL be destructive. Because Proxmox refuses to remove a pool that still has members, the action SHALL fail with an error listing the members unless an option to detach them first is set, in which case members SHALL be removed from the pool before it is deleted. Deleting a pool SHALL NOT delete its member guests or storages.

#### Scenario: Deleting an empty pool

- **WHEN** `proxmox:delete-pool` is invoked for a pool with no members
- **THEN** the pool is removed and the output reports its id

#### Scenario: Deleting a pool that still has members

- **WHEN** the pool has members and the detach option is not set
- **THEN** the action fails with an error listing the members, and the pool is not removed

#### Scenario: Deleting a pool and detaching its members

- **WHEN** the same call sets the detach option
- **THEN** the members are removed from the pool, the pool is removed, and the guests and storages themselves still exist

#### Scenario: Unknown pool

- **WHEN** the pool does not exist
- **THEN** the action fails with a not-found error naming the pool

## REMOVED Requirements

### Requirement: Action — get guest

**Reason**: Replaced by the per-kind actions `proxmox:get-vm` and `proxmox:get-container`, so each action's schema describes one guest kind instead of pushing Proxmox's `qemu`/`lxc` distinction onto callers.

**Migration**: Replace `proxmox:get-guest` with `proxmox:get-vm` or `proxmox:get-container` and drop the `guestType` input. `name` is reported by `get-vm`; `get-container` reports `hostname`.

### Requirement: Action — set guest power state

**Reason**: Replaced by `proxmox:set-vm-power-state` and `proxmox:set-container-power-state`, which also lets the container action drop the `suspend` and `resume` states Proxmox does not support for containers.

**Migration**: Replace `proxmox:set-guest-power-state` with the action for the guest kind and drop the `guestType` input. Templates using `suspend` or `resume` against a container were already failing at Proxmox and have no replacement.

### Requirement: Action — delete guest

**Reason**: Replaced by `proxmox:delete-vm` and `proxmox:delete-container`.

**Migration**: Replace `proxmox:delete-guest` with the action for the guest kind and drop the `guestType` input. The `stopIfRunning` and `purge` options are unchanged.

### Requirement: Action — create LXC container

**Reason**: Renamed to `proxmox:create-container` so the action surface speaks of VMs and containers throughout, rather than mixing in Proxmox's `lxc` path segment alongside `delete-container` and `get-container`.

**Migration**: Replace `proxmox:create-lxc` with `proxmox:create-container`. Inputs and outputs are unchanged.
