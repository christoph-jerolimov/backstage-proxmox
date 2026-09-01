## Why

This repository already ships a full Proxmox VE dev environment (`pve8/`, `pve9/`) whose stated purpose is "e.g. for a Backstage Proxmox plugin", but there is no plugin — `plugins/` is empty and nothing in the backend talks to Proxmox. Developers who want to provision VMs, LXC containers or resource pools from Backstage have to leave the portal and use the Proxmox UI or `pvesh`.

Registering Proxmox operations in the **actions registry** rather than as bespoke scaffolder actions means each operation is written once and is immediately usable from three surfaces: software templates (the scaffolder mirrors registry actions into its template action registry), the MCP actions endpoint (already enabled in this backend), and any future direct API consumer.

## What Changes

- **New backend plugin `@internal/plugin-proxmox-backend`** (plugin id `proxmox`) in `plugins/proxmox-backend`, registering actions through `actionsRegistryServiceRef` from `@backstage/backend-plugin-api/alpha`.
- **Proxmox connections are read from the new Backstage connection configuration** — the top-level `connections:` array in `app-config.yaml`, using a `proxmox` connection type with `token` (PVE API token) and `password` (ticket + CSRF) auth methods. Because the framework's connection type registry is closed (see Impact), the plugin resolves and validates `type: proxmox` entries itself against a schema shaped like an upstream `ConnectionType`, and exposes them through a `find({ type, query, authMethods })` lookup mirroring `ConnectionsService`.
- **Nine actions** covering read and write operations against the Proxmox VE REST API:
  - `proxmox:list-nodes`, `proxmox:get-guest` — read-only, dry-run safe
  - `proxmox:create-vm`, `proxmox:update-vm-config`, `proxmox:set-guest-power-state`, `proxmox:delete-guest`
  - `proxmox:create-lxc`
  - `proxmox:create-pool`, `proxmox:update-pool`
- **Proxmox task (UPID) handling**: write endpoints return a task id; actions poll `/nodes/{node}/tasks/{upid}/status` and fail on a non-`OK` exit status, so a template step fails when the Proxmox job fails.
- **One software template per action** under `examples/proxmox-templates/`, each exercising exactly one action, registered as catalog locations so every action is testable from the scaffolder UI against the `pve8`/`pve9` dev instances.
- **Backend and app-config wiring**: `backend.add(import('@internal/plugin-proxmox-backend'))`, `proxmox` added to `backend.actions.pluginSources`, and a commented example `connections:` block pointing at the local dev instance.

## Capabilities

### New Capabilities

- `proxmox/connections`: how Proxmox instances are declared in Backstage configuration, how a connection and auth method are selected for a request, and how credentials become Proxmox API auth headers.
- `proxmox/actions`: the set of actions registered in the actions registry — names, inputs, outputs, attributes (read-only / destructive / idempotent), Proxmox task handling and error semantics.
- `proxmox/software-templates`: the per-action example templates, their parameters and their role as the manual test surface for the actions.

### Modified Capabilities

None — this repository has no existing specs under `openspec/specs/`.

## Impact

- **New code**: `plugins/proxmox-backend/` (plugin, connection resolution, Proxmox API client, nine actions, unit tests), `examples/proxmox-templates/` (nine templates).
- **Modified**: `packages/backend/package.json` (dependency), `packages/backend/src/index.ts` (register plugin), `app-config.yaml` (`backend.actions.pluginSources`, catalog locations for the templates, example `connections:` block), root `README.md` / `plugins/README.md` (usage notes).
- **Dependencies**: `@backstage/backend-plugin-api` (alpha entry point), `@backstage/config`, `@backstage/errors`, `zod` v3 — the actions registry passes `zod/v3` to schema builders. No new runtime HTTP client; `fetch` with a configurable TLS agent is enough.
- **Framework risk to accept explicitly**: the connections framework is experimental and its connection type registry is closed. `@backstage/connections@0.3.0` exports only `connectionTypes` (13 built-in types, no `proxmox`) and `buildConnectionsFromConfig`, which throws `InputError: Unrecognised connection type` on anything else; `createConnectionType` is not exported, and the service ref (`connectionsServiceRef`, `declareConnection`) lives in the unpublished `@backstage/connections-node`. So the plugin cannot register a type with the framework or inject `ConnectionsService`, and a `type: proxmox` entry under `connections:` would be rejected by any future component that validates the whole array. The plugin therefore also accepts the identical connection list under its own `proxmox.connections` key as an escape hatch, and the design records the migration path for when custom connection types land upstream.
- **Security**: actions perform privileged, partly destructive operations on infrastructure. Destructive actions are marked `destructive: true` so the scaffolder excludes them from dry runs, `skipTlsVerify` is opt-in per connection and intended for the self-signed dev instances only, and secrets stay in config (`${ENV}`) rather than in template parameters.
