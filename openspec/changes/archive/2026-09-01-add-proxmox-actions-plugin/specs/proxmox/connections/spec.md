## Purpose

Defines how Backstage learns about the Proxmox VE instances it may talk to, how one instance and one authentication method are selected for a given operation, and how that selection turns into an authenticated Proxmox REST API request.

## ADDED Requirements

### Requirement: Proxmox connections are declared in the Backstage connection configuration

The system SHALL read Proxmox instances from the top-level `connections` array in Backstage configuration, selecting entries whose `type` is `proxmox`. Each entry SHALL carry a `baseUrl` identifying the instance, an optional `title`, an optional `match.plugins` list, an optional `skipTlsVerify` flag, an optional `caFile` path, and a non-empty `auth` array. The system SHALL additionally accept an identically shaped array under the plugin-owned `proxmox.connections` configuration key, and SHALL treat the union of both sources as the configured connections.

#### Scenario: A connection is declared under the connections key

- **WHEN** configuration contains a `connections` entry with `type: proxmox`, `baseUrl: https://localhost:8006` and one auth entry
- **THEN** that instance is available to Proxmox actions
- **AND** entries in the `connections` array whose `type` is not `proxmox` are ignored rather than rejected

#### Scenario: A connection is declared under the plugin-owned key

- **WHEN** configuration contains the same entry under `proxmox.connections` instead
- **THEN** the instance is available to Proxmox actions with identical behavior

#### Scenario: No Proxmox connection is configured

- **WHEN** neither source contains a `proxmox` entry and a Proxmox action is invoked
- **THEN** the action fails with an error stating that no Proxmox connection is configured

#### Scenario: Connection scoped to other plugins

- **WHEN** a `proxmox` connection sets `match.plugins` to a list that does not include `proxmox`
- **THEN** that connection is not offered to Proxmox actions

### Requirement: Connection configuration is validated at resolution time

The system SHALL validate every `proxmox` connection against a declared schema and SHALL reject unknown fields, a missing or non-absolute `baseUrl`, an empty `auth` array, and any auth entry whose `method` is not a supported method. Validation failures SHALL name the offending connection and field.

#### Scenario: Invalid connection entry

- **WHEN** a `proxmox` connection omits `auth` or declares `auth` as an empty list
- **THEN** resolution fails with an error identifying the connection and stating that at least one auth method is required

#### Scenario: Unknown auth method

- **WHEN** an auth entry declares a `method` other than `token` or `password`
- **THEN** resolution fails with an error naming the unsupported method

#### Scenario: Duplicate instances

- **WHEN** two `proxmox` connections resolve to the same `baseUrl` host
- **THEN** resolution fails with an error reporting the duplicate

### Requirement: Connection lookup by query and auth method

The system SHALL expose a lookup that takes a connection type, a query, and a non-empty ordered list of acceptable auth methods, and returns exactly one connection together with exactly one selected auth entry. The query SHALL support selecting a connection by `url` (matched on host) or by `title`. When the query is empty and exactly one Proxmox connection is configured, that connection SHALL be selected; when the query is empty and several are configured, lookup SHALL fail and the error SHALL list the configured connection titles.

#### Scenario: Single configured connection and no selector

- **WHEN** one Proxmox connection is configured and an action is invoked without a connection selector
- **THEN** that connection is used

#### Scenario: Several configured connections and no selector

- **WHEN** two Proxmox connections are configured and an action is invoked without a connection selector
- **THEN** the action fails with an error listing the available connection titles

#### Scenario: Selecting a connection explicitly

- **WHEN** an action is invoked with a connection selector matching one configured connection's title or host
- **THEN** that connection is used regardless of how many are configured

#### Scenario: No acceptable auth method

- **WHEN** the caller accepts only `token` auth and the selected connection configures only `password` auth
- **THEN** lookup fails with an error stating that no configured auth method is acceptable

#### Scenario: Auth method preference order

- **WHEN** a connection configures both `token` and `password` auth and the caller accepts both
- **THEN** the auth method appearing first in the caller's list is selected

### Requirement: Credentials become Proxmox API authentication

The system SHALL authenticate `token` auth by sending an `Authorization: PVEAPIToken=<tokenId>=<secret>` header, where `tokenId` has the form `user@realm!tokenName`. The system SHALL authenticate `password` auth by obtaining a ticket from `/api2/json/access/ticket`, sending it as the `PVEAuthCookie` cookie, and additionally sending the `CSRFPreventionToken` header on every request that is not a `GET`. Tickets SHALL be reused until they expire and SHALL be re-obtained on expiry.

#### Scenario: Token authenticated request

- **WHEN** an action runs against a connection whose selected auth method is `token`
- **THEN** the Proxmox request carries the `PVEAPIToken` authorization header
- **AND** no ticket request is made

#### Scenario: Password authenticated write

- **WHEN** an action performing a write runs against a connection whose selected auth method is `password`
- **THEN** a ticket is obtained first
- **AND** the write request carries both the ticket cookie and the CSRF prevention token

#### Scenario: Expired ticket

- **WHEN** a cached ticket has expired and another request is made
- **THEN** a new ticket is obtained transparently and the request succeeds

#### Scenario: Rejected credentials

- **WHEN** Proxmox rejects the credentials with HTTP 401
- **THEN** the action fails with an authentication error naming the connection, and the error message does not contain the token secret or password

### Requirement: TLS verification is verified by default and opt-out per connection

The system SHALL verify TLS certificates for Proxmox requests unless a connection sets `skipTlsVerify: true`, and SHALL trust a custom certificate authority when `caFile` is set. Disabling verification SHALL be logged once per connection at warning level.

#### Scenario: Default verification

- **WHEN** a connection sets neither `skipTlsVerify` nor `caFile` and the instance presents a self-signed certificate
- **THEN** the request fails with a TLS verification error

#### Scenario: Explicit opt-out for a dev instance

- **WHEN** a connection sets `skipTlsVerify: true`
- **THEN** requests to that instance succeed against its self-signed certificate
- **AND** a warning naming the connection is logged

### Requirement: Secrets are never exposed in outputs or logs

The system SHALL NOT include token secrets, passwords, tickets, or CSRF tokens in action outputs, log messages, or error messages.

#### Scenario: Failure while authenticated

- **WHEN** any Proxmox request fails and the failure is logged and surfaced to the caller
- **THEN** neither the log entry nor the returned error contains the configured secret material
