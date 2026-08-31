import { FakeProxmox, recordingLogger } from '../__testUtils__/fakeProxmox';
import { SelectedProxmoxConnection } from '../connections/ProxmoxConnectionsService';
import { encodeParams, ProxmoxClient } from './ProxmoxClient';

const tokenConnection: SelectedProxmoxConnection = {
  type: 'proxmox',
  title: 'Dev Proxmox',
  baseUrl: 'https://localhost:8006',
  auth: {
    method: 'token',
    title: 'API Token',
    tokenId: 'root@pam!full-access',
    secret: 'super-secret-token',
  },
};

const passwordConnection: SelectedProxmoxConnection = {
  type: 'proxmox',
  title: 'Dev Proxmox',
  baseUrl: 'https://localhost:8006',
  auth: {
    method: 'password',
    title: 'Username and Password',
    username: 'alice@pve',
    password: 'super-secret-password',
  },
};

function clientFor(
  connection: SelectedProxmoxConnection,
  proxmox: FakeProxmox,
  logger?: any,
) {
  return ProxmoxClient.create({ connection, logger, fetchApi: proxmox.fetch });
}

describe('encodeParams', () => {
  it('omits undefined and encodes booleans the way Proxmox expects', () => {
    expect(
      encodeParams({ a: 1, b: 'x y', c: true, d: false, e: undefined }),
    ).toBe('a=1&b=x+y&c=1&d=0');
  });
});

describe('ProxmoxClient', () => {
  it('sends the token authorization header and unwraps the data envelope', async () => {
    const proxmox = FakeProxmox.create().on('GET', '/nodes', {
      data: [{ node: 'pve', status: 'online' }],
    });

    const nodes = await clientFor(tokenConnection, proxmox).get('/nodes');

    expect(nodes).toEqual([{ node: 'pve', status: 'online' }]);
    const [request] = proxmox.requestsFor('GET', '/nodes');
    expect(request.headers.Authorization).toBe(
      'PVEAPIToken=root@pam!full-access=super-secret-token',
    );
    expect(request.headers.Cookie).toBeUndefined();
  });

  it('does not request a ticket for token auth', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes', { data: [] })
      .on('POST', '/access/ticket', { data: {} });

    await clientFor(tokenConnection, proxmox).get('/nodes');

    expect(proxmox.requestsFor('POST', '/access/ticket')).toHaveLength(0);
  });

  it('obtains a ticket for password auth and sends CSRF on writes only', async () => {
    const proxmox = FakeProxmox.create()
      .on('POST', '/access/ticket', {
        data: { ticket: 'PVE:ticket', CSRFPreventionToken: 'csrf-1' },
      })
      .on('GET', '/nodes', { data: [] })
      .on('POST', '/nodes/pve/qemu', { data: 'UPID:x' });

    const client = clientFor(passwordConnection, proxmox);
    await client.get('/nodes');
    await client.post('/nodes/pve/qemu', { vmid: 101 });

    const ticketRequests = proxmox.requestsFor('POST', '/access/ticket');
    expect(ticketRequests).toHaveLength(1);
    expect(ticketRequests[0].body.get('username')).toBe('alice@pve');

    const [read] = proxmox.requestsFor('GET', '/nodes');
    expect(read.headers.Cookie).toBe('PVEAuthCookie=PVE%3Aticket');
    expect(read.headers.CSRFPreventionToken).toBeUndefined();

    const [write] = proxmox.requestsFor('POST', '/nodes/pve/qemu');
    expect(write.headers.Cookie).toBe('PVEAuthCookie=PVE%3Aticket');
    expect(write.headers.CSRFPreventionToken).toBe('csrf-1');
  });

  it('reuses a ticket until it expires and then renews it', async () => {
    let issued = 0;
    const proxmox = FakeProxmox.create()
      .on('POST', '/access/ticket', () => {
        issued += 1;
        return {
          data: { ticket: `ticket-${issued}`, CSRFPreventionToken: `csrf-${issued}` },
        };
      })
      .on('GET', '/nodes', { data: [] });

    const client = clientFor(passwordConnection, proxmox);
    const now = jest.spyOn(Date, 'now');

    now.mockReturnValue(0);
    await client.get('/nodes');
    await client.get('/nodes');
    expect(issued).toBe(1);

    // Past the two hour ticket lifetime.
    now.mockReturnValue(3 * 60 * 60 * 1000);
    await client.get('/nodes');
    expect(issued).toBe(2);
    expect(proxmox.requestsFor('GET', '/nodes').at(-1)!.headers.Cookie).toBe(
      'PVEAuthCookie=ticket-2',
    );

    now.mockRestore();
  });

  it('form encodes write bodies and sets the content type', async () => {
    const proxmox = FakeProxmox.create().on('POST', '/nodes/pve/qemu', {
      data: 'UPID:x',
    });

    await clientFor(tokenConnection, proxmox).post('/nodes/pve/qemu', {
      vmid: 101,
      name: 'web 01',
      skipped: undefined,
    });

    const [request] = proxmox.requestsFor('POST', '/nodes/pve/qemu');
    expect(request.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(request.body.get('vmid')).toBe('101');
    expect(request.body.get('name')).toBe('web 01');
    expect(request.body.has('skipped')).toBe(false);
  });

  it('passes GET parameters as a query string', async () => {
    const proxmox = FakeProxmox.create().on('GET', '/cluster/nextid', { data: '101' });

    await clientFor(tokenConnection, proxmox).get('/cluster/nextid', { vmid: 101 });

    expect(proxmox.requestsFor('GET', '/cluster/nextid')[0].query.get('vmid')).toBe(
      '101',
    );
  });

  it('does not build a TLS dispatcher when verification is left on', async () => {
    const proxmox = FakeProxmox.create().on('GET', '/nodes', { data: [] });

    await clientFor(tokenConnection, proxmox).get('/nodes');

    expect(proxmox.requestsFor('GET', '/nodes')[0].dispatcher).toBeUndefined();
  });

  it('builds a dispatcher and warns once when verification is disabled', async () => {
    const proxmox = FakeProxmox.create().on('GET', '/nodes', { data: [] });
    const { logger, messages } = recordingLogger();

    const client = clientFor(
      { ...tokenConnection, skipTlsVerify: true },
      proxmox,
      logger,
    );
    await client.get('/nodes');
    await client.get('/nodes');

    expect(proxmox.requestsFor('GET', '/nodes')[0].dispatcher).toBeDefined();
    const warnings = messages().filter(m => m.includes('TLS certificate verification'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Dev Proxmox"');
  });

  describe('error mapping', () => {
    it.each([
      [401, /rejected the credentials for connection "Dev Proxmox" \(HTTP 401\)/],
      [403, /not permitted to perform GET \/nodes on Proxmox connection "Dev Proxmox"/],
      [404, /has no resource for GET \/nodes on Proxmox connection "Dev Proxmox"/],
      [500, /Proxmox request failed .* \(HTTP 500\)/],
    ])('maps HTTP %s', async (status, expected) => {
      const proxmox = FakeProxmox.create().on('GET', '/nodes', {
        status,
        errors: { detail: 'Permission check failed' },
      });

      await expect(clientFor(tokenConnection, proxmox).get('/nodes')).rejects.toThrow(
        expected,
      );
    });

    it('preserves the Proxmox message', async () => {
      const proxmox = FakeProxmox.create().on('GET', '/nodes/pve/qemu/999/config', {
        status: 404,
        errors: { vmid: 'VM 999 does not exist' },
      });

      await expect(
        clientFor(tokenConnection, proxmox).get('/nodes/pve/qemu/999/config'),
      ).rejects.toThrow(/vmid: VM 999 does not exist/);
    });

    it('redacts the token secret from errors and logs', async () => {
      const proxmox = FakeProxmox.create().on('GET', '/nodes', {
        status: 500,
        raw: 'failed for PVEAPIToken=root@pam!full-access=super-secret-token',
      });
      const { logger, messages } = recordingLogger();

      const error = await clientFor(tokenConnection, proxmox, logger)
        .get('/nodes')
        .catch(e => e as Error);

      expect(error.message).not.toContain('super-secret-token');
      expect(error.message).toContain('[REDACTED]');
      expect(messages().join('\n')).not.toContain('super-secret-token');
    });

    it('redacts the password from errors', async () => {
      const proxmox = FakeProxmox.create()
        .on('POST', '/access/ticket', {
          data: { ticket: 't', CSRFPreventionToken: 'c' },
        })
        .on('GET', '/nodes', {
          status: 500,
          raw: 'bad password super-secret-password',
        });

      const error = await clientFor(passwordConnection, proxmox)
        .get('/nodes')
        .catch(e => e as Error);

      expect(error.message).not.toContain('super-secret-password');
    });
  });
});
