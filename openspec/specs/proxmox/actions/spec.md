## Purpose

Defines the Proxmox operations Backstage exposes as registered actions — their names, inputs, outputs, safety attributes and failure semantics — so that software templates, MCP clients and any other action consumer get the same behavior from the same contract.

## Requirements

### Requirement: Proxmox actions are published through the actions registry

The system SHALL register its actions in the Backstage actions registry under the plugin id `proxmox`, so that each action is addressable as `proxmox:<action-name>`. Every action SHALL declare a title, a description, an input schema, an output schema, and safety attributes. No action SHALL declare a secrets schema, because consumers that drive actions from software templates cannot supply secrets.

#### Scenario: Actions are discoverable

- **WHEN** the actions registry is queried for the actions of the `proxmox` plugin by an authenticated caller
- **THEN** the response lists every registered Proxmox action with its id, description and input and output schemas

#### Scenario: Anonymous invocation

- **WHEN** an action is invoked without credentials
- **THEN** the invocation is rejected as not allowed and no Proxmox request is made

#### Scenario: Input that does not match the schema

- **WHEN** an action is invoked with input missing a required field or with a field of the wrong type
- **THEN** the invocation fails with an input error naming the offending field and no Proxmox request is made

### Requirement: Every action accepts a connection selector

Every action SHALL accept an optional `connection` input naming the Proxmox instance to act on, resolved as defined by the `proxmox/connections` capability. Every action SHALL include the resolved connection's title in its output.

#### Scenario: Acting on a named instance

- **WHEN** an action is invoked with `connection` set to a configured connection's title
- **THEN** the operation is performed against that instance
- **AND** the output reports that connection's title

### Requirement: Safety attributes reflect what each action does

Read-only actions SHALL declare `readOnly: true` and `destructive: false`. Actions that create or modify resources SHALL declare `readOnly: false`. Actions that can remove or interrupt a running resource SHALL declare `destructive: true`. Actions whose repeated invocation with the same input converges on the same state SHALL declare `idempotent: true`.

#### Scenario: Read-only action in a dry run

- **WHEN** a software template containing only read-only, non-destructive Proxmox steps is dry-run
- **THEN** the dry run executes those steps

#### Scenario: Destructive action in a dry run

- **WHEN** a software template containing `proxmox:delete-vm` is dry-run
- **THEN** that step is not executed against Proxmox

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

### Requirement: Proxmox API errors are reported faithfully

When the Proxmox API returns an error, the action SHALL fail with an error that preserves the HTTP status and the Proxmox message. An HTTP 403 SHALL be reported as a permission error naming the attempted operation, and an HTTP 404 SHALL be reported as a not-found error naming the missing resource.

#### Scenario: Insufficient Proxmox permissions

- **WHEN** the configured credentials lack the privilege for the requested operation and Proxmox answers 403
- **THEN** the action fails with a permission error naming the operation and the connection

#### Scenario: Unknown guest

- **WHEN** an action targets a VMID that does not exist and Proxmox answers 404
- **THEN** the action fails with a not-found error naming the VMID and node

### Requirement: Action — list nodes

`proxmox:list-nodes` SHALL return the cluster's nodes with their name, status, and CPU and memory usage. It SHALL be read-only and idempotent, and SHALL take no input beyond the connection selector.

#### Scenario: Listing nodes

- **WHEN** `proxmox:list-nodes` is invoked against a configured instance
- **THEN** the output contains one entry per node, each with at least a name and a status

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

### Requirement: Action — create VM

`proxmox:create-vm` SHALL create a QEMU virtual machine on a named node. It SHALL accept a name, and optional VMID, cores, sockets, memory, OS type, network device, disk, storage, tags, pool and description. When no VMID is given it SHALL allocate the next free VMID from Proxmox and return it. It SHALL not be idempotent.

#### Scenario: Creating a VM with an allocated VMID

- **WHEN** `proxmox:create-vm` is invoked with a name and no VMID
- **THEN** a VM with that name is created and the output reports the allocated VMID, the node and the task identifier

#### Scenario: Creating a VM with an explicit VMID

- **WHEN** `proxmox:create-vm` is invoked with a VMID that is free
- **THEN** the VM is created with that VMID

#### Scenario: VMID already in use

- **WHEN** `proxmox:create-vm` is invoked with a VMID that already exists
- **THEN** the action fails with an error stating that the VMID is already in use

### Requirement: Action — update VM configuration

`proxmox:update-vm-config` SHALL modify the configuration of an existing QEMU VM, accepting any subset of name, cores, sockets, memory, tags, description and pool, and applying only the fields provided. It SHALL be idempotent and SHALL return the guest's configuration after the update.

#### Scenario: Changing memory only

- **WHEN** `proxmox:update-vm-config` is invoked with only a memory value
- **THEN** the VM's memory is changed and its other configuration is left untouched

#### Scenario: Re-applying the same configuration

- **WHEN** the same update is invoked twice
- **THEN** both invocations succeed and the resulting configuration is the same

#### Scenario: No fields to update

- **WHEN** the action is invoked with no configuration fields
- **THEN** the action fails with an input error stating that at least one field must be provided

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

### Requirement: Action — create resource pool

`proxmox:create-pool` SHALL create a Proxmox resource pool with a given id and optional comment.

#### Scenario: Creating a pool

- **WHEN** `proxmox:create-pool` is invoked with a pool id that does not exist
- **THEN** the pool is created and the output reports its id

#### Scenario: Pool already exists

- **WHEN** the pool id already exists
- **THEN** the action fails with an error stating that the pool already exists

### Requirement: Action — update resource pool

`proxmox:update-pool` SHALL modify an existing pool's comment and SHALL add named VMs or storages to it. It SHALL be idempotent and SHALL return the pool's members after the update.

#### Scenario: Updating a pool comment

- **WHEN** `proxmox:update-pool` is invoked with a new comment
- **THEN** the pool's comment is changed and its members are unchanged

#### Scenario: Adding members

- **WHEN** the action is invoked with a list of VMIDs to add
- **THEN** those guests belong to the pool afterwards and the output lists the pool's members

#### Scenario: Adding a member twice

- **WHEN** the same VMID is added in two consecutive invocations
- **THEN** both invocations succeed and the guest appears once in the pool

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
