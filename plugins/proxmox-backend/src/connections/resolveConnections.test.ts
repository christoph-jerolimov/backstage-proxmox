import { ConfigReader } from '@backstage/config';
import { recordingLogger } from '../__testUtils__/fakeProxmox';
import { resolveProxmoxConnections } from './resolveConnections';

const tokenAuth = [
  { method: 'token', tokenId: 'root@pam!full-access', secret: 'shh' },
];

function resolve(data: object) {
  return resolveProxmoxConnections({ config: new ConfigReader(data) });
}

describe('resolveProxmoxConnections', () => {
  it('reads a connection from the connections config', () => {
    const connections = resolve({
      connections: [
        {
          type: 'proxmox',
          title: 'Local dev Proxmox',
          baseUrl: 'https://localhost:8006',
          skipTlsVerify: true,
          auth: tokenAuth,
        },
      ],
    });

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      type: 'proxmox',
      title: 'Local dev Proxmox',
      baseUrl: 'https://localhost:8006',
      skipTlsVerify: true,
      source: 'connections',
    });
    expect(connections[0].auth).toEqual([
      {
        method: 'token',
        title: 'API Token',
        tokenId: 'root@pam!full-access',
        secret: 'shh',
      },
    ]);
  });

  it('reads a connection from the plugin owned config key', () => {
    const connections = resolve({
      proxmox: {
        connections: [{ baseUrl: 'https://localhost:8006', auth: tokenAuth }],
      },
    });

    expect(connections).toHaveLength(1);
    expect(connections[0].source).toBe('proxmox.connections');
    expect(connections[0].baseUrl).toBe('https://localhost:8006');
  });

  it('unions both sources', () => {
    const connections = resolve({
      connections: [
        { type: 'proxmox', baseUrl: 'https://one.example.com:8006', auth: tokenAuth },
      ],
      proxmox: {
        connections: [{ baseUrl: 'https://two.example.com:8006', auth: tokenAuth }],
      },
    });

    expect(connections.map(c => c.source)).toEqual([
      'connections',
      'proxmox.connections',
    ]);
  });

  it('ignores connections of other types rather than rejecting them', () => {
    const connections = resolve({
      connections: [
        { type: 'github', host: 'github.com', auth: [{ method: 'token', token: 'x' }] },
        { type: 'aws', auth: [{ method: 'account', mainAccount: true }] },
        { type: 'proxmox', baseUrl: 'https://localhost:8006', auth: tokenAuth },
      ],
    });

    expect(connections).toHaveLength(1);
    expect(connections[0].type).toBe('proxmox');
  });

  it('returns nothing when no connection is configured', () => {
    expect(resolve({})).toEqual([]);
    expect(resolve({ connections: [] })).toEqual([]);
  });

  it('skips a connection scoped to other plugins', () => {
    const connections = resolve({
      connections: [
        {
          type: 'proxmox',
          baseUrl: 'https://localhost:8006',
          match: { plugins: ['catalog'] },
          auth: tokenAuth,
        },
      ],
    });

    expect(connections).toEqual([]);
  });

  it('keeps a connection scoped to this plugin', () => {
    const connections = resolve({
      connections: [
        {
          type: 'proxmox',
          baseUrl: 'https://localhost:8006',
          match: { plugins: ['proxmox'] },
          auth: tokenAuth,
        },
      ],
    });

    expect(connections).toHaveLength(1);
  });

  it('skips auth entries scoped to other plugins, and the connection when none remain', () => {
    expect(
      resolve({
        connections: [
          {
            type: 'proxmox',
            baseUrl: 'https://localhost:8006',
            auth: [{ ...tokenAuth[0], match: { plugins: ['catalog'] } }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    ['a missing auth array', { baseUrl: 'https://localhost:8006' }],
    ['an empty auth array', { baseUrl: 'https://localhost:8006', auth: [] }],
  ])('rejects %s', (_name, entry) => {
    expect(() => resolve({ connections: [{ type: 'proxmox', ...entry }] })).toThrow(
      /at least one auth method/,
    );
  });

  it('rejects an unknown auth method and names it', () => {
    expect(() =>
      resolve({
        connections: [
          {
            type: 'proxmox',
            baseUrl: 'https://localhost:8006',
            auth: [{ method: 'oauth', token: 'x' }],
          },
        ],
      }),
    ).toThrow(/unsupported auth method "oauth"/);
  });

  it('rejects an invalid baseUrl and names the connection', () => {
    expect(() =>
      resolve({
        connections: [
          { type: 'proxmox', title: 'Broken', baseUrl: 'nope', auth: tokenAuth },
        ],
      }),
    ).toThrow(/Invalid Proxmox connection "Broken".*baseUrl/s);
  });

  it('rejects an invalid auth entry and names the method', () => {
    expect(() =>
      resolve({
        connections: [
          {
            type: 'proxmox',
            baseUrl: 'https://localhost:8006',
            auth: [{ method: 'token', tokenId: 'root@pam', secret: 'x' }],
          },
        ],
      }),
    ).toThrow(/Invalid "token" auth.*tokenId/s);
  });

  it('rejects two connections that resolve to the same host', () => {
    expect(() =>
      resolve({
        connections: [
          { type: 'proxmox', baseUrl: 'https://localhost:8006', auth: tokenAuth },
        ],
        proxmox: {
          connections: [
            { baseUrl: 'https://localhost:8006/', auth: tokenAuth },
          ],
        },
      }),
    ).toThrow(/Duplicate Proxmox connection for host "localhost:8006"/);
  });

  it('assigns a default title, qualified by host when there are several', () => {
    expect(
      resolve({
        connections: [
          { type: 'proxmox', baseUrl: 'https://one.example.com:8006', auth: tokenAuth },
        ],
      })[0].title,
    ).toBe('Proxmox VE');

    expect(
      resolve({
        connections: [
          { type: 'proxmox', baseUrl: 'https://one.example.com:8006', auth: tokenAuth },
          { type: 'proxmox', baseUrl: 'https://two.example.com:8006', auth: tokenAuth },
        ],
      }).map(c => c.title),
    ).toEqual([
      'Proxmox VE (one.example.com:8006)',
      'Proxmox VE (two.example.com:8006)',
    ]);
  });

  it('defaults the auth entry title to the auth method title', () => {
    const [connection] = resolve({
      connections: [
        {
          type: 'proxmox',
          baseUrl: 'https://localhost:8006',
          auth: [
            ...tokenAuth,
            { method: 'password', username: 'alice@pve', password: 'pw' },
          ],
        },
      ],
    });

    expect(connection.auth.map(a => a.title)).toEqual([
      'API Token',
      'Username and Password',
    ]);
  });

  it('rejects a connections config that is not an array', () => {
    expect(() => resolve({ connections: { type: 'proxmox' } })).toThrow(
      /"connections" config to be an array/,
    );
  });

  it('logs why a connection was skipped', () => {
    const { logger, messages } = recordingLogger();
    resolveProxmoxConnections({
      config: new ConfigReader({
        connections: [
          {
            type: 'proxmox',
            baseUrl: 'https://localhost:8006',
            match: { plugins: ['catalog'] },
            auth: tokenAuth,
          },
        ],
      }),
      logger,
    });

    expect(messages().join('\n')).toMatch(/not scoped to the proxmox plugin/);
  });
});
