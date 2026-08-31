## 1. Plugin scaffold

- [x] 1.1 Create `plugins/proxmox-backend` with `package.json` (name `@internal/plugin-proxmox-backend`, `backstage.role: backend-plugin`, license `UNLICENSED`), `tsconfig.json`, `README.md` and `src/index.ts`; verify `yarn install` succeeds and the workspace is picked up by `yarn workspaces list`
- [x] 1.2 Add dependencies `@backstage/backend-plugin-api`, `@backstage/config`, `@backstage/errors`, `zod` and dev dependencies `@backstage/backend-test-utils`, `@backstage/cli`, pinned to the versions the repo already locks; verify `yarn workspace @internal/plugin-proxmox-backend tsc` runs clean
- [x] 1.3 Add `createBackendPlugin({ pluginId: 'proxmox' })` in `src/plugin.ts` depending on `actionsRegistryServiceRef` from `@backstage/backend-plugin-api/alpha` and `coreServices.rootConfig`/`logger`, registering no actions yet; verify a unit test using `startTestBackend` boots the plugin without error

## 2. Connection configuration

- [x] 2.1 Define the `proxmox` connection type in `src/connections/proxmoxConnectionType.ts` — strict zod schema for `baseUrl`, `skipTlsVerify`, `caFile`, plus `token` and `password` auth method schemas — mirroring the upstream `ConnectionType` field layout per design D3; verify unit tests reject unknown fields and accept the documented example
- [x] 2.2 Implement `resolveProxmoxConnections(config)` reading `connections` (filtering `type: proxmox`, ignoring other types) and `proxmox.connections`, applying `match.plugins`, default titles and duplicate-host detection; verify unit tests cover both sources, a non-proxmox entry being ignored, a scoped-out connection, a missing/empty `auth` array, an unknown auth method and a duplicate host
- [x] 2.3 Implement `find({ type, query, authMethods })` selecting one connection by `url` host or `title` (or the single configured one when the query is empty) and one auth entry by the caller's preference order; verify unit tests cover single-connection defaulting, the ambiguous multi-connection error listing titles, explicit selection, preference order and the no-acceptable-auth-method error
- [x] 2.4 Add `config.d.ts` declaring the `proxmox.connections` key with secret fields marked as such; verify `yarn workspace @internal/plugin-proxmox-backend lint` and a backend start with an example config produce no config-schema warnings

## 3. Proxmox API client

- [x] 3.1 Implement `ProxmoxClient` over `fetch` with a per-connection `https.Agent` honouring `skipTlsVerify` (logging one warning per connection) and `caFile`, form-encoded request bodies and `{ data }` envelope unwrapping; verify unit tests with a mocked fetch cover agent options and body encoding
- [x] 3.2 Implement `token` auth (`Authorization: PVEAPIToken=<tokenId>=<secret>`) and `password` auth (ticket + CSRF, cached until expiry, CSRF header on non-GET only); verify unit tests assert the headers per method, that no ticket request is made for token auth, and that an expired ticket is transparently renewed
- [x] 3.3 Map Proxmox HTTP errors onto `@backstage/errors` types — 401 to an authentication error naming the connection, 403 to a permission error naming the operation, 404 to a not-found error naming the resource — and redact secrets from all messages and logs; verify unit tests assert the error types, the messages, and that no secret appears in either
- [x] 3.4 Implement the UPID helper: post, then poll `/nodes/{node}/tasks/{upid}/status` with bounded backoff until `status: stopped`, succeeding only on `exitstatus: OK`, honouring `waitForCompletion` and `timeoutSeconds` and always returning the task id; verify unit tests cover success, non-OK exit status, timeout (task id present in the error) and the no-wait path

## 4. Actions

- [x] 4.1 Add a shared action helper that resolves the connection from the optional `connection` input, builds a client and returns `connectionTitle` in every output; verify a unit test asserts the resolution error surfaces when no connection is configured
- [x] 4.2 Register `proxmox:list-nodes` (`readOnly`, `idempotent`, `destructive: false`); verify a unit test invoking it through `actionsRegistryServiceMock` returns one entry per node with name and status
- [x] 4.3 Register `proxmox:get-guest` (`readOnly`, `idempotent`, `destructive: false`) handling `guestType` of `qemu` and `lxc`; verify unit tests cover both guest types and the 404 not-found mapping
- [x] 4.4 Register `proxmox:create-vm`, allocating the next free VMID via `/cluster/nextid` when none is given; verify unit tests cover allocation, an explicit free VMID, and the already-in-use failure
- [x] 4.5 Register `proxmox:update-vm-config` (`idempotent`) applying only the provided fields and returning the resulting configuration; verify unit tests cover a single-field update, repeated application and the empty-input error
- [x] 4.6 Register `proxmox:set-guest-power-state` (`destructive: true`) for start/stop/shutdown/reboot/suspend/resume; verify unit tests cover starting a stopped guest and requesting the state a guest is already in
- [x] 4.7 Register `proxmox:delete-guest` (`destructive: true`) refusing a running guest unless the stop option is set; verify unit tests cover the stopped case, the refusal, and stop-then-delete
- [x] 4.8 Register `proxmox:create-lxc` with VMID allocation; verify unit tests cover creation and the missing-OS-template failure
- [x] 4.9 Register `proxmox:create-pool` and `proxmox:update-pool` (`update-pool` `idempotent`); verify unit tests cover creation, the already-exists failure, comment update, adding members and adding the same member twice
- [x] 4.10 Assert across all actions that none declares `schema.secrets` and that attributes match the spec table; verify a unit test iterating the registered actions checks both

## 5. Backend and app wiring

- [ ] 5.1 Add `@internal/plugin-proxmox-backend` to `packages/backend/package.json` and `backend.add(import('@internal/plugin-proxmox-backend'))` to `packages/backend/src/index.ts`; verify `yarn workspace backend start` boots and `GET /api/proxmox/.backstage/actions/v1/actions` lists the nine actions
- [ ] 5.2 Add `proxmox` to `backend.actions.pluginSources` in `app-config.yaml`; verify the scaffolder's actions endpoint (`/api/scaffolder/v2/actions`) lists the `proxmox:*` ids
- [ ] 5.3 Add a commented `connections:` example block for the local dev instance to `app-config.yaml`, matching `pve8`/`pve9` (`https://localhost:8006`, `skipTlsVerify: true`, `root@pam!full-access`); verify a checkout with the block commented out starts unchanged

## 6. Software templates

- [ ] 6.1 Create `examples/proxmox-templates/` with one template per action, each a single step invoking its action by registry id, with required/optional parameters and defaults matching the seeded dev resources (node `pve`, storage `local`, pools `pool-dev`/`pool-prod`); verify each file parses and every action has exactly one template
- [ ] 6.2 Ensure optional parameters are omitted from the step input when blank rather than passed empty; verify by running a create template with only required parameters against a dev instance and confirming Proxmox defaults are used
- [ ] 6.3 Declare template outputs surfacing the identifying values (VMID, node, pool id, task id, connection title) and set a consistent owner and type on every template; verify the scaffolder result page shows them after a successful run
- [ ] 6.4 Register the templates as catalog locations in `app-config.yaml` with `rules: [allow: [Template]]`; verify they appear in the scaffolder after backend start

## 7. Verification and documentation

- [ ] 7.1 Run `yarn tsc`, `yarn lint:all` and `yarn test:all`; verify all pass with the new package included
- [ ] 7.2 Manually run every template against a running `pve9` dev instance and record the outcome per action in the plugin README; verify each read action returns the seeded fixtures and each write action's effect is visible via `pvesh`/the Proxmox UI
- [ ] 7.3 Verify dry-run behavior: a template of read-only steps dry-runs, and a template containing `proxmox:delete-guest` does not execute that step in a dry run
- [ ] 7.4 Write the plugin README covering the `connections:` and `proxmox.connections` config shapes, both auth methods, the `skipTlsVerify` warning, the recommended scoped-token setup over `root@pam!full-access`, the action table with attributes, and the connections-framework limitation and migration path from design D2/D3; verify a reader can configure the plugin from the README alone
