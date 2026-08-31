import { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { z } from 'zod/v3';
import {
  getProxmoxAuthMethod,
  ProxmoxAuthValue,
  ProxmoxConnection,
  ProxmoxConnectionMatch,
  proxmoxConnectionType,
} from './proxmoxConnectionType';

/** The plugin id connections are matched against. */
export const PROXMOX_PLUGIN_ID = 'proxmox';

/** Where a connection was read from. */
export type ProxmoxConnectionSource = 'connections' | 'proxmox.connections';

/** A resolved connection, annotated with the config key it came from. */
export type ResolvedProxmoxConnection = ProxmoxConnection & {
  source: ProxmoxConnectionSource;
};

type Logger = { warn(message: string): void; debug(message: string): void };

function describe(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.errors
      .map(issue =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      )
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function readMatch(value: unknown, label: string): ProxmoxConnectionMatch | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = z
    .object({ plugins: z.array(z.string()).min(1) })
    .strict()
    .safeParse(value);
  if (!parsed.success) {
    throw new InputError(
      `Invalid "match" on ${label}: ${describe(parsed.error)}`,
    );
  }
  return parsed.data;
}

function matchesThisPlugin(match: ProxmoxConnectionMatch | undefined): boolean {
  return !match || match.plugins.includes(PROXMOX_PLUGIN_ID);
}

function validateAuth(
  rawAuth: unknown,
  label: string,
): ProxmoxAuthValue[] {
  if (!Array.isArray(rawAuth) || rawAuth.length === 0) {
    throw new InputError(
      `${label} must configure at least one auth method under "auth"`,
    );
  }

  const result: ProxmoxAuthValue[] = [];
  for (const entry of rawAuth) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InputError(`${label} has an auth entry that is not an object`);
    }
    const {
      method,
      title,
      match: rawAuthMatch,
      ...rest
    } = entry as Record<string, unknown>;

    if (typeof method !== 'string') {
      throw new InputError(
        `${label} has an auth entry without a "method" field`,
      );
    }
    const authMethod = getProxmoxAuthMethod(method);
    if (!authMethod) {
      throw new InputError(
        `${label} declares unsupported auth method "${method}"; supported methods are ${proxmoxConnectionType.authMethods
          .map(m => m.method)
          .join(', ')}`,
      );
    }
    if (!matchesThisPlugin(readMatch(rawAuthMatch, `${label} auth "${method}"`))) {
      continue;
    }

    const parsed = authMethod.configSchema.safeParse(rest);
    if (!parsed.success) {
      throw new InputError(
        `Invalid "${method}" auth on ${label}: ${describe(parsed.error)}`,
      );
    }
    result.push({
      ...parsed.data,
      method: authMethod.method,
      title: typeof title === 'string' && title ? title : authMethod.title,
    } as ProxmoxAuthValue);
  }
  return result;
}

function validateConnection(
  raw: unknown,
  source: ProxmoxConnectionSource,
  index: number,
): ResolvedProxmoxConnection | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputError(
      `Entry ${index} of "${source}" is not a connection object`,
    );
  }
  const {
    type: _type,
    title: rawTitle,
    match: rawMatch,
    auth: rawAuth,
    ...configFields
  } = raw as Record<string, unknown>;

  const title = typeof rawTitle === 'string' && rawTitle ? rawTitle : undefined;
  const label = `Proxmox connection ${title ? `"${title}"` : `at "${source}[${index}]"`}`;

  const match = readMatch(rawMatch, label);
  if (!matchesThisPlugin(match)) {
    return undefined;
  }

  const parsed = proxmoxConnectionType.configSchema.safeParse(configFields);
  if (!parsed.success) {
    throw new InputError(`Invalid ${label}: ${describe(parsed.error)}`);
  }

  const auth = validateAuth(rawAuth, label);
  if (auth.length === 0) {
    return undefined;
  }

  return {
    ...parsed.data,
    type: 'proxmox',
    title: title ?? '',
    match,
    auth,
    source,
  };
}

function readRawEntries(
  config: Config,
  key: string,
  onlyProxmoxType: boolean,
): unknown[] {
  const raw = config.getOptional(key);
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new InputError(`Expected "${key}" config to be an array`);
  }
  return raw.filter(entry => {
    const type = (entry as { type?: unknown } | null)?.type;
    // Entries of other connection types belong to other consumers of the
    // connections config and are none of this plugin's business.
    return onlyProxmoxType ? type === 'proxmox' : type === undefined || type === 'proxmox';
  });
}

/** Host used to detect duplicate connections, per the `host` lookup strategy. */
export function connectionHost(connection: { baseUrl: string }): string {
  return new URL(connection.baseUrl).host;
}

function assignDefaultTitles(connections: ResolvedProxmoxConnection[]): void {
  const untitled = connections.filter(c => !c.title);
  for (const connection of untitled) {
    connection.title =
      connections.length > 1
        ? `${proxmoxConnectionType.title} (${connectionHost(connection)})`
        : proxmoxConnectionType.title;
  }
}

/**
 * Reads Proxmox connections from the Backstage connection configuration.
 *
 * Entries are taken from the top-level `connections` array (only those with
 * `type: proxmox`; other types are ignored rather than rejected) and from the
 * plugin-owned `proxmox.connections` key, and the union of both is returned.
 */
export function resolveProxmoxConnections(options: {
  config: Config;
  logger?: Logger;
}): ResolvedProxmoxConnection[] {
  const { config, logger } = options;

  const raw: Array<[unknown, ProxmoxConnectionSource, number]> = [
    ...readRawEntries(config, 'connections', true).map(
      (entry, index) => [entry, 'connections' as const, index] as const,
    ),
    ...readRawEntries(config, 'proxmox.connections', false).map((entry, index) => [entry, 'proxmox.connections' as const, index] as const),
  ].map(entry => [...entry] as [unknown, ProxmoxConnectionSource, number]);

  const connections: ResolvedProxmoxConnection[] = [];
  for (const [entry, source, index] of raw) {
    const connection = validateConnection(entry, source, index);
    if (connection) {
      connections.push(connection);
    } else {
      logger?.debug(
        `Ignoring Proxmox connection at "${source}[${index}]" because it is not scoped to the ${PROXMOX_PLUGIN_ID} plugin`,
      );
    }
  }

  const seenHosts = new Map<string, ResolvedProxmoxConnection>();
  for (const connection of connections) {
    const host = connectionHost(connection);
    const existing = seenHosts.get(host);
    if (existing) {
      throw new InputError(
        `Duplicate Proxmox connection for host "${host}", configured in both "${existing.source}" and "${connection.source}"`,
      );
    }
    seenHosts.set(host, connection);
  }

  assignDefaultTitles(connections);

  logger?.debug(
    `Resolved ${connections.length} Proxmox connection${
      connections.length === 1 ? '' : 's'
    } from configuration`,
  );

  return connections;
}
