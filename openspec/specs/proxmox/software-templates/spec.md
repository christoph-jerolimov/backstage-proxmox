## Purpose

Defines the example software templates that make every Proxmox action reachable and testable from the Backstage scaffolder UI, so that each registered action has a manual smoke test against the local Proxmox dev instances.

## Requirements

### Requirement: One software template per Proxmox action

The system SHALL ship exactly one software template for each registered Proxmox action, and that template SHALL execute exactly one step, invoking its action by the action's registry id. The system MAY additionally ship showcase templates that chain several steps; a showcase template SHALL NOT count as any action's per-action template.

#### Scenario: Coverage

- **WHEN** the shipped single-step templates are compared with the registered Proxmox actions
- **THEN** every action has exactly one such template and every one of them targets exactly one action

#### Scenario: Template names identify their action

- **WHEN** a template is listed in the scaffolder
- **THEN** its title names the Proxmox operation it performs and its description states which action it invokes

#### Scenario: A showcase template does not displace a per-action template

- **WHEN** a showcase template invokes an action that also has its own single-step template
- **THEN** both templates are shipped and the per-action coverage is still exactly one template per action

### Requirement: Templates surface action inputs as parameters

Each per-action template SHALL expose its action's inputs as scaffolder parameters, marking as required exactly the inputs the action requires, and SHALL pass them through to the action step unchanged. Optional inputs SHALL be omitted from the action input when the user leaves them blank rather than passed as empty values. A showcase template SHALL expose only the parameters its own steps need, and MAY supply the remaining action inputs itself.

#### Scenario: Filling in only required parameters

- **WHEN** a user runs the create-VM template supplying only the required parameters
- **THEN** the action is invoked with only those inputs and the VM is created with Proxmox defaults for the rest

#### Scenario: Leaving an optional parameter blank

- **WHEN** a user leaves an optional numeric or text parameter blank
- **THEN** that field is absent from the action input rather than sent as an empty value

#### Scenario: A showcase template supplies its own inputs

- **WHEN** a showcase template runs a step whose action input it sets itself rather than collecting from the user
- **THEN** that value is passed to the action and no parameter for it is shown

### Requirement: Templates report action results

Each template SHALL declare outputs that surface the identifying values its action returns, such as the VMID, node, pool id, task identifier and connection title, so a user can confirm what was changed without leaving Backstage.

#### Scenario: Successful run

- **WHEN** a template completes successfully
- **THEN** the scaffolder result page shows the identifying values returned by the action

#### Scenario: Failed run

- **WHEN** the action fails
- **THEN** the template run is marked failed and the step log contains the action's error message

### Requirement: Templates are registered in the catalog and usable against the dev instances

The templates SHALL be registered as catalog locations in the app configuration so they appear in the scaffolder without further setup, and their default parameter values SHALL match the resources seeded by the repository's Proxmox dev environments, so that a developer with a running dev instance can execute them unchanged.

#### Scenario: Templates appear after backend start

- **WHEN** the backend starts with the shipped configuration
- **THEN** the Proxmox templates are listed in the scaffolder

#### Scenario: Defaults match the dev environment

- **WHEN** a template offering a node, storage or pool parameter is opened
- **THEN** its defaults are values that exist in the seeded dev instances

### Requirement: Templates are owned and typed consistently

Each template SHALL declare an owner and a type so it can be filtered in the scaffolder alongside the repository's existing example template.

#### Scenario: Filtering templates

- **WHEN** a user filters the scaffolder by the Proxmox templates' type
- **THEN** all Proxmox templates are listed together

### Requirement: A showcase template demonstrates starting several tasks and awaiting them together

The system SHALL ship a template that creates more than one Proxmox resource without waiting for each, then awaits all of the resulting tasks in a single step with `proxmox:wait-for-tasks`. The template SHALL pass the task identifiers its create steps returned into the awaiting step, and SHALL fail if any of those tasks fails.

#### Scenario: Creating two VMs and awaiting both

- **WHEN** the showcase template is run
- **THEN** both VMs are requested before either is awaited
- **AND** a single step awaits both tasks
- **AND** the run reports both VMIDs

#### Scenario: One of the created resources fails

- **WHEN** one of the create steps starts a task that Proxmox later fails
- **THEN** the awaiting step fails the run and names the failed task

#### Scenario: Dry-running the showcase

- **WHEN** the showcase template is dry-run
- **THEN** the create steps are skipped because they are not read-only
- **AND** the awaiting step receives the placeholder values the dry run substitutes for their outputs, ignores them, and succeeds without polling Proxmox
