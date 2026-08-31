## Context

See `proposal.md` — Why. The design-relevant facts, all verified against the packages this repo already locks (`backstage.json` = 1.54.0; `@backstage/backend-plugin-api` 1.10.0, `@backstage/backend-defaults` 0.17.7, `@backstage/plugin-scaffolder-backend` 4.0.4, `@backstage/plugin-mcp-actions-backend` 0.2.1):

**Actions registry.** `actionsRegistryServiceRef` is exported from `@backstage/backend-plugin-api/alpha` (service id `alpha.core.actionsRegistry`, plugin-scoped). Its default factory is already in `defaultServiceFactories`, and it mounts `/.backstage/actions/v1|v2/...` on the owning plugin's router automatically — no wiring needed beyond depending on the ref. `DefaultActionsRegistryService.register()` derives the action id as `` `${pluginMetadata.getId()}:${options.name}` ``, so the namespace comes from the **host plugin id**. A `createBackendModule` attached to an existing plugin would inherit that plugin's id, which is why this must be a `createBackendPlugin` with `pluginId: 'proxmox'`.

**Schema shape.** `schema.input` / `schema.output` are callbacks `(zod: typeof z) => AnyZodObject`, not bare schemas, and the `z` handed in is `zod/v3`. Attribute defaults are `readOnly: false`, `idempotent: false`, and `destructive: attributes?.destructive ?? !attributes?.readOnly` — so **destructive defaults to `true`** and must be set explicitly on the safe actions.

**Scaffolder bridge.** No bridge module exists; `@backstage/plugin-scaffolder-backend` depends on `actionsServiceRef` directly, and `DefaultTemplateActionRegistry.list()` merges registry actions into the template action registry under the same `pluginId:name` id, with `supportsDryRun = readOnly === true && destructive === false`, and spreads each top-level key of the action's `output` object into scaffolder step outputs. It invokes with `{ id, input, credentials }` only — **no secrets** — so an action declaring `schema.secrets` throws when driven from a template. `DefaultActionsService.list()` reads `backend.actions.pluginSources` and returns nothing for plugins absent from that list, so `proxmox` must be added to the existing list in `app-config.yaml`.

**Connections.** `@backstage/connections@0.3.0` (part of 1.54.0) is a common library: it exports the `ConnectionsService` interface, the `ConfiguredConnection` types, `connectionTypes` and `buildConnectionsFromConfig`. It does **not** export `createConnectionType`, and `connectionTypes` is a closed set of 13 built-ins with no `proxmox`. The Node implementation — `connectionsServiceRef`, `connectionsServiceFactory`, `DefaultConnectionsService`, `declareConnection` — moved into `@backstage/connections-node`, which is `private: true` and not published to npm. `buildConnectionsFromConfig` throws `InputError: Unrecognised connection type` for any type outside the built-in registry, and nothing in the released packages calls it yet. The framework is explicitly experimental ("the Connections API is still early") and there is no `config.d.ts` in Backstage declaring the `connections` key.

**Test targets.** `pve8/` and `pve9/` start seeded single-node Proxmox VE instances at `https://localhost:8006` with a self-signed certificate, pinned API token secrets, node `pve`, storages `local` and `backup`, pools `pool-dev` and `pool-prod`, VMs 101/102 and LXC 201/202.

## Goals / Non-Goals

**Goals:**

- One Proxmox operation is written once and reachable from software templates, MCP and the actions HTTP API, with identical behavior.
- Proxmox instances are configured in the shape the connections framework defines, so adopting the framework later is a config-compatible move rather than a rewrite.
- Every action has a runnable manual test against the repository's own dev instances.
- Failures from Proxmox — permissions, missing resources, failed async tasks — surface as failed template steps with the Proxmox message intact.

**Non-Goals:**

- No frontend plugin, no entity pages, no catalog provider ingesting Proxmox guests as catalog entities. Actions only.
- No cluster-level operations (migration, HA, backup jobs, storage or user administration).
- No attempt to register a `proxmox` type with the connections framework or to vendor `@backstage/connections-node`.
- No abstraction over Proxmox API versions beyond what PVE 8 and PVE 9 share; the seeded environments behave identically for the endpoints used.

## Decisions

### D1 — A standalone backend plugin, not a module on the scaffolder

`createBackendPlugin({ pluginId: 'proxmox' })` in `plugins/proxmox-backend`. A `createBackendModule` on `scaffolder` was the alternative: it would need no `pluginSources` entry, but action ids would become `scaffolder:create-vm`, colliding with the scaffolder's own namespace and tying Proxmox actions to the scaffolder rather than to the registry. A dedicated plugin id also gives Proxmox its own permission and discovery surface. Cost: one line in `backend.actions.pluginSources`.

### D2 — Read the `connections:` array, filter `type: proxmox`, resolve it ourselves

The plugin reads the top-level `connections` config array with `config.getOptionalConfigArray('connections')`, keeps entries whose `type` is `proxmox`, ignores the rest, and validates the kept entries with its own zod schema. It also reads `proxmox.connections` and unions the two. This honors "read the Proxmox configuration from the new Backstage connection configuration" as literally as 1.54.0 permits.

Alternatives rejected:

- *Use `ConnectionsService` via `connectionsServiceRef`* — impossible; the ref lives in an unpublished package.
- *Use `buildConnectionsFromConfig`* — it rejects `type: proxmox` outright, so it cannot see our entries at all.
- *Plugin-owned config only (`proxmox.instances`)* — safe, but ignores the explicit request and creates a shape that has to be migrated later.

The plugin ignores non-`proxmox` entries rather than validating the whole array, so it never rejects a `github` or `aws` connection that is none of its business.

### D3 — Mirror the upstream connection-type contract exactly

The `proxmox` connection type is defined in plugin code with the same fields an upstream `ConnectionType` has — `type`, `title`, `cardinality: 'multiton'`, `lookupStrategy: 'host'`, a strict connection `configSchema`, and `authMethods` each with `method`, `title` and its own schema — and the lookup is `find({ type, query, authMethods })` returning one connection with one selected auth entry, matching `ConnectionsService`. Config entries therefore carry `type`, `title?`, `match?.plugins`, the connection fields, and a non-empty `auth` array, exactly as `validateConnection` in `@backstage/connections` requires. When custom connection types become registerable, the definition is handed to the framework and the local resolver deleted; the YAML does not change.

```yaml
connections:
  - type: proxmox
    title: Local dev Proxmox
    baseUrl: https://localhost:8006
    skipTlsVerify: true # dev instances use a self-signed certificate
    auth:
      - method: token
        tokenId: root@pam!full-access
        secret: ${PROXMOX_TOKEN_SECRET}
```

Auth methods: `token` (`tokenId`, `secret`) and `password` (`username`, `password`). `none` is not offered — the Proxmox API has no useful unauthenticated surface.

### D4 — Two auth methods, ticket caching for `password`

`token` sends `Authorization: PVEAPIToken=<tokenId>=<secret>` and needs nothing else — this is the path the dev environments and any service account should use, and it is the default preference order for every action. `password` posts to `/access/ticket`, caches the ticket and CSRF token in memory per connection until shortly before expiry, sends `PVEAuthCookie` on every request and `CSRFPreventionToken` on every non-`GET`. `password` exists because the seeded environment deliberately tests both paths and because some Proxmox deployments issue no tokens; it is not the recommended production setup.

### D5 — Poll UPIDs; do not fire and forget

Proxmox write endpoints return a UPID string rather than a result. A shared helper posts the request, then polls `/nodes/{node}/tasks/{upid}/status` with a bounded backoff until `status === 'stopped'`, and fails unless `exitstatus === 'OK'`. Every write action takes `waitForCompletion` (default `true`) and `timeoutSeconds` (default 300) and returns `taskId`. Without this, a template step would report success for a Proxmox job that failed seconds later — the single most likely way for this plugin to lie to a user. The UPID is always returned, including on timeout, so the operation stays traceable in Proxmox.

### D6 — `fetch` with a per-connection dispatcher, not a Proxmox SDK

A thin `ProxmoxClient` over `fetch`, constructed per connection with a TLS dispatcher carrying `rejectUnauthorized` and any `ca` from `caFile`. This is undici's `fetch` and undici's `Agent`, **not** Node's global `fetch` with an `https.Agent` as first drafted: the global `fetch` is undici-backed and ignores an `https.Agent` entirely, and an `Agent` from the npm `undici` package is only reliably accepted by that package's own `fetch`. `undici` is therefore a direct dependency (it is already in the lockfile transitively), and the client takes an injectable `fetchApi` so tests run against a fake without touching the network. Proxmox's API is a flat, well-documented REST surface with form-encoded request bodies and a `{ data: ... }` envelope; existing Node clients for it are thin, unmaintained or both, and would still need the UPID and auth handling written here. Keeping it in-repo also keeps the dependency footprint to that one package.

### D7 — TLS verification on by default, opt-out per connection

`skipTlsVerify` defaults to `false` and is set per connection, never globally, and logs a warning naming the connection when enabled. The dev instances need it; a production instance with a real certificate must not have it. `caFile` covers the middle case of a private CA.

### D8 — Nine actions, guest type as an input rather than parallel VM and LXC actions

Read and lifecycle operations take a `guestType` of `qemu` or `lxc` and vary only the URL segment, so `get-guest`, `set-guest-power-state` and `delete-guest` each handle both. Creation genuinely differs — VMs take cores/sockets/disks, containers take an OS template and a rootfs — so `create-vm` and `create-lxc` stay separate. This yields a smaller, more honest action surface than eleven near-duplicates.

### D9 — No `schema.secrets` on any action

The scaffolder bridge invokes with `{ id, input, credentials }` and no secrets, so any action declaring a secrets schema fails when run from a template — which is this change's primary test surface. All credentials come from configuration instead, which is also where they belong: template parameters are visible in task inputs and logs.

### D10 — Templates as flat example files, one step each

`examples/proxmox-templates/<action>.yaml`, one template per action, each with a single step and the action's inputs as parameters, registered as catalog locations alongside the existing `examples/template/template.yaml`. Single-step templates keep each template a test of exactly one action; a combined "provision a VM" template would be nicer to use but would stop being a per-action test the moment one step failed. Blank optional parameters need no special handling in the templates: the scaffolder renders step inputs through `JSON.parse(JSON.stringify(input), …)`, and a reviver returning `undefined` deletes the key, so an unset parameter is dropped rather than sent as an empty value. This was confirmed end to end rather than assumed — running the create-VM template with only `node` and `name` posts exactly `vmid` and `name` to Proxmox — so no empty-string coercion is needed in the action schemas.

### D11 — Unit tests against a mocked Proxmox, dev instances for manual verification

Actions are tested with `actionsRegistryServiceMock` from `@backstage/backend-test-utils/alpha` (which prefixes ids with `test:`) and a mocked `fetch`, covering input validation, auth header construction, UPID polling success/failure/timeout, and error mapping. Nothing in CI talks to a real Proxmox: the dev environments need rootful podman and a privileged container. The templates are the manual verification path, documented in the plugin README.

## Risks / Trade-offs

- **A future Backstage version validates the whole `connections` array and rejects `type: proxmox`** → This is the main risk of D2, and it breaks backend startup, not just this plugin. Mitigations: the identical shape is accepted under `proxmox.connections`, which is unaffected; the plugin README documents both and the one-line move between them; the resolver reports which source each connection came from so the failure mode is obvious.
- **The connections framework's eventual custom-type mechanism differs from what is mirrored here, or never arrives** → BEP-0014 states connection types are not extensible by ecosystem plugins, so `proxmox` may never be expressible upstream. The local definition is self-contained and keeps working either way; only the resolver is throwaway.
- **The actions registry API is `@alpha` and may change** → Registration is confined to one file per action with a shared helper; a signature change is a mechanical edit. The repo already depends on this surface through `plugin-mcp-actions-backend`.
- **Destructive actions are reachable from the scaffolder by anyone who can run a template** → `destructive: true` keeps them out of dry runs but does not gate execution. Actions run with the initiator's credentials, and Proxmox's own ACLs are the real boundary — the seeded `svc-backstage@pve!readonly` token cannot write, by design. The README recommends a scoped token per connection rather than `root@pam!full-access`, and `visibilityPermission` is left as a documented follow-up.
- **Waiting on UPIDs holds a scaffolder step open** → Bounded by `timeoutSeconds` (default 300) with `waitForCompletion: false` as an escape hatch. A timeout returns the UPID so the job can be followed in Proxmox.
- **PVE 8 and PVE 9 differences** → Only endpoints common to both are used, and both dev environments exist to catch a divergence. Any future version-specific behavior belongs in the client, not in the actions.
- **Nine actions plus nine templates is a large first change** → The client, auth and UPID helpers are shared, so per-action cost is a schema and a request. The actions are independent, so the task breakdown can land them incrementally with the plugin usable after the first one.

## Migration Plan

Additive; nothing existing changes behavior. Order: plugin skeleton and connection resolution, then client and UPID helper, then actions, then templates, then wiring (`packages/backend`, `app-config.yaml`).

`app-config.yaml` ships a **commented** `connections:` block, so a checkout without a Proxmox instance is unaffected and no unknown top-level key is introduced by default. Without configuration the actions register and appear in the registry but fail with "no Proxmox connection is configured" when invoked, which is the correct behavior for an unconfigured integration.

Rollback is removing the `backend.add(...)` line and the `proxmox` entry from `backend.actions.pluginSources`; the actions disappear from the scaffolder and templates that reference them fail as unknown actions. Nothing persists state, so there is nothing to unwind.

## Open Questions

- Whether to add a `visibilityPermission` to the destructive actions so they can be restricted by the permission framework rather than by Proxmox ACLs alone. Deferrable: it is an additive field on registration and changes no input, output or template.
- Whether `create-vm` should also attach a disk by default rather than leaving storage to the caller. The seeded dev guests are config-only, so either choice is testable there; this can be settled from real usage without changing the action's contract.
