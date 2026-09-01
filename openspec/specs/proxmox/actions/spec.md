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

- **WHEN** a software template containing `proxmox:delete-guest` is dry-run
- **THEN** that step is not executed against Proxmox

### Requirement: Long-running Proxmox operations are awaited

Proxmox returns a task identifier (UPID) for operations it runs asynchronously. Actions that trigger such an operation SHALL poll the task status until it finishes or a timeout elapses, SHALL succeed only when the task's exit status is `OK`, and SHALL include the task identifier in their output. Actions SHALL accept an optional timeout and an optional flag to return as soon as the task is accepted instead of waiting.

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

### Requirement: Action — get guest

`proxmox:get-guest` SHALL return the configuration and current status of one VM or LXC container, identified by node, VMID and guest type. It SHALL be read-only and idempotent.

#### Scenario: Reading a VM

- **WHEN** `proxmox:get-guest` is invoked for an existing QEMU VM
- **THEN** the output contains the VMID, name, status, and the guest's configuration

#### Scenario: Reading an LXC container

- **WHEN** `proxmox:get-guest` is invoked for an existing LXC container with guest type `lxc`
- **THEN** the output contains that container's configuration and status

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

### Requirement: Action — set guest power state

`proxmox:set-guest-power-state` SHALL bring a VM or LXC container to a requested state of `start`, `stop`, `shutdown`, `reboot`, `suspend` or `resume`. It SHALL be destructive because it interrupts a running workload, and SHALL return the guest's status after the operation.

#### Scenario: Starting a stopped guest

- **WHEN** the action requests `start` for a stopped guest
- **THEN** the action waits for the Proxmox task and the output reports the guest as running

#### Scenario: Requesting the state a guest is already in

- **WHEN** the action requests `start` for a guest that is already running
- **THEN** the action succeeds and reports the guest as running

### Requirement: Action — delete guest

`proxmox:delete-guest` SHALL remove a VM or LXC container identified by node, VMID and guest type. It SHALL be destructive. It SHALL accept an option to stop a running guest first, and without that option a running guest SHALL NOT be deleted.

#### Scenario: Deleting a stopped guest

- **WHEN** `proxmox:delete-guest` is invoked for a stopped guest
- **THEN** the guest is removed and the output reports the VMID and the task identifier

#### Scenario: Deleting a running guest without the stop option

- **WHEN** `proxmox:delete-guest` is invoked for a running guest and the stop option is not set
- **THEN** the action fails with an error stating that the guest is running, and the guest is not removed

#### Scenario: Deleting a running guest with the stop option

- **WHEN** the same call sets the stop option
- **THEN** the guest is stopped first and then removed

### Requirement: Action — create LXC container

`proxmox:create-lxc` SHALL create an LXC container on a named node, accepting a hostname, an OS template, and optional VMID, cores, memory, swap, root filesystem storage and size, network device, tags, pool, unprivileged flag and description. When no VMID is given it SHALL allocate the next free VMID and return it.

#### Scenario: Creating a container

- **WHEN** `proxmox:create-lxc` is invoked with a hostname and an OS template
- **THEN** the container is created and the output reports the VMID, node and task identifier

#### Scenario: Missing OS template

- **WHEN** the referenced OS template does not exist on the target storage
- **THEN** the action fails with an error naming the template

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
