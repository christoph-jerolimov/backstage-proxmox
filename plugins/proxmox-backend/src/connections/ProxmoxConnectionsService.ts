import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import {
  ProxmoxAuthMethod,
  ProxmoxAuthValue,
  ProxmoxConnection,
} from './proxmoxConnectionType';
import { connectionHost, ResolvedProxmoxConnection } from './resolveConnections';

/**
 * How a connection is selected. Mirrors the `query` of an upstream connection
 * type with the `host` lookup strategy, extended with `title` so a connection
 * can also be named directly.
 */
export type ProxmoxConnectionQuery = {
  url?: string;
  title?: string;
};

/** A connection together with the single auth entry selected for a request. */
export type SelectedProxmoxConnection<
  TAuthMethod extends ProxmoxAuthMethod = ProxmoxAuthMethod,
> = Omit<ProxmoxConnection, 'auth'> & {
  auth: Extract<ProxmoxAuthValue, { method: TAuthMethod }>;
};

/**
 * Looks up a configured Proxmox connection.
 *
 * The contract mirrors `ConnectionsService.find` from `@backstage/connections`:
 * the caller names the connection type, a query, and the auth methods it is
 * able to use, and gets back exactly one connection with exactly one auth
 * entry selected.
 */
export interface ProxmoxConnectionsService {
  find<TAuthMethod extends ProxmoxAuthMethod>(options: {
    type: 'proxmox';
    query: ProxmoxConnectionQuery;
    authMethods: readonly [TAuthMethod, ...TAuthMethod[]];
  }): Promise<SelectedProxmoxConnection<TAuthMethod>>;
}

function hostOf(value: string): string | undefined {
  try {
    // `new URL('host:8006')` parses as a protocol with an empty host, so a
    // bare `host:port` selector has to fall through to a plain comparison.
    return new URL(value).host || undefined;
  } catch {
    return undefined;
  }
}

export class DefaultProxmoxConnectionsService implements ProxmoxConnectionsService {
  private constructor(
    private readonly connections: ResolvedProxmoxConnection[],
  ) {}

  static create(connections: ResolvedProxmoxConnection[]) {
    return new DefaultProxmoxConnectionsService(connections);
  }

  async find<TAuthMethod extends ProxmoxAuthMethod>(options: {
    type: 'proxmox';
    query: ProxmoxConnectionQuery;
    authMethods: readonly [TAuthMethod, ...TAuthMethod[]];
  }): Promise<SelectedProxmoxConnection<TAuthMethod>> {
    const connection = this.select(options.query);
    const auth = this.selectAuth(connection, options.authMethods);
    const { auth: _auth, source: _source, ...rest } = connection;
    return { ...rest, auth };
  }

  private select(query: ProxmoxConnectionQuery): ResolvedProxmoxConnection {
    if (this.connections.length === 0) {
      throw new NotFoundError(
        'No Proxmox connection is configured. Add an entry with "type: proxmox" to the "connections" config, or to "proxmox.connections".',
      );
    }

    const selector = query.url ?? query.title;
    if (!selector) {
      if (this.connections.length === 1) {
        return this.connections[0];
      }
      throw new InputError(
        `Several Proxmox connections are configured, so one must be selected: ${this.titles()}`,
      );
    }

    // A selector may be a connection title, a full URL, or a bare host — the
    // action input is a single free-form string, so all three are accepted.
    const selectorHost = hostOf(selector) ?? selector;
    const matches = this.connections.filter(
      connection =>
        connection.title.toLocaleLowerCase() === selector.toLocaleLowerCase() ||
        connectionHost(connection).toLocaleLowerCase() ===
          selectorHost.toLocaleLowerCase(),
    );

    if (matches.length === 0) {
      throw new NotFoundError(
        `No Proxmox connection matches "${selector}". Configured connections: ${this.titles()}`,
      );
    }
    if (matches.length > 1) {
      throw new InputError(
        `Several Proxmox connections match "${selector}": ${matches
          .map(c => `"${c.title}"`)
          .join(', ')}`,
      );
    }
    return matches[0];
  }

  private selectAuth<TAuthMethod extends ProxmoxAuthMethod>(
    connection: ResolvedProxmoxConnection,
    authMethods: readonly [TAuthMethod, ...TAuthMethod[]],
  ): Extract<ProxmoxAuthValue, { method: TAuthMethod }> {
    for (const method of authMethods) {
      const auth = connection.auth.find(entry => entry.method === method);
      if (auth) {
        return auth as Extract<ProxmoxAuthValue, { method: TAuthMethod }>;
      }
    }
    throw new NotAllowedError(
      `Proxmox connection "${connection.title}" configures no acceptable auth method; wanted one of ${authMethods.join(
        ', ',
      )} but it configures ${connection.auth.map(a => a.method).join(', ')}`,
    );
  }

  private titles(): string {
    return this.connections.map(c => `"${c.title}"`).join(', ');
  }
}
