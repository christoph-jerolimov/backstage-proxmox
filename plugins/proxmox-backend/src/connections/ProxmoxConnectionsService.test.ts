import { ConfigReader } from '@backstage/config';
import { DefaultProxmoxConnectionsService } from './ProxmoxConnectionsService';
import { resolveProxmoxConnections } from './resolveConnections';

const token = { method: 'token', tokenId: 'root@pam!t', secret: 'shh' };
const password = { method: 'password', username: 'alice@pve', password: 'pw' };

function service(...entries: object[]) {
  return DefaultProxmoxConnectionsService.create(
    resolveProxmoxConnections({
      config: new ConfigReader({
        connections: entries.map(entry => ({ type: 'proxmox', ...entry })),
      }),
    }),
  );
}

const both = ['token', 'password'] as const;

describe('DefaultProxmoxConnectionsService', () => {
  it('fails with a clear message when nothing is configured', async () => {
    await expect(
      service().find({ type: 'proxmox', query: {}, authMethods: both }),
    ).rejects.toThrow(/No Proxmox connection is configured/);
  });

  it('uses the only configured connection when no selector is given', async () => {
    const found = await service({
      baseUrl: 'https://localhost:8006',
      auth: [token],
    }).find({ type: 'proxmox', query: {}, authMethods: both });

    expect(found.baseUrl).toBe('https://localhost:8006');
    expect(found.auth.method).toBe('token');
  });

  it('lists the titles when several are configured and none is selected', async () => {
    await expect(
      service(
        { title: 'One', baseUrl: 'https://one.example.com:8006', auth: [token] },
        { title: 'Two', baseUrl: 'https://two.example.com:8006', auth: [token] },
      ).find({ type: 'proxmox', query: {}, authMethods: both }),
    ).rejects.toThrow(/must be selected: "One", "Two"/);
  });

  it.each([
    ['a title', { title: 'Two' }],
    ['a title in another case', { title: 'two' }],
    ['a URL', { url: 'https://two.example.com:8006' }],
    ['a bare host', { title: 'two.example.com:8006' }],
  ])('selects a connection by %s', async (_name, query) => {
    const found = await service(
      { title: 'One', baseUrl: 'https://one.example.com:8006', auth: [token] },
      { title: 'Two', baseUrl: 'https://two.example.com:8006', auth: [token] },
    ).find({ type: 'proxmox', query, authMethods: both });

    expect(found.title).toBe('Two');
  });

  it('fails when no connection matches the selector', async () => {
    await expect(
      service({ title: 'One', baseUrl: 'https://one.example.com:8006', auth: [token] }).find(
        { type: 'proxmox', query: { title: 'Nope' }, authMethods: both },
      ),
    ).rejects.toThrow(/No Proxmox connection matches "Nope".*"One"/s);
  });

  it('honours the caller preference order for auth methods', async () => {
    const configured = {
      baseUrl: 'https://localhost:8006',
      auth: [token, password],
    };

    await expect(
      service(configured).find({
        type: 'proxmox',
        query: {},
        authMethods: ['token', 'password'],
      }),
    ).resolves.toMatchObject({ auth: { method: 'token' } });

    await expect(
      service(configured).find({
        type: 'proxmox',
        query: {},
        authMethods: ['password', 'token'],
      }),
    ).resolves.toMatchObject({ auth: { method: 'password' } });
  });

  it('fails when the connection has no acceptable auth method', async () => {
    await expect(
      service({ baseUrl: 'https://localhost:8006', auth: [password] }).find({
        type: 'proxmox',
        query: {},
        authMethods: ['token'],
      }),
    ).rejects.toThrow(/no acceptable auth method; wanted one of token but it configures password/);
  });

  it('returns exactly one auth entry, not the configured list', async () => {
    const found = await service({
      baseUrl: 'https://localhost:8006',
      auth: [token, password],
    }).find({ type: 'proxmox', query: {}, authMethods: both });

    expect(Array.isArray(found.auth)).toBe(false);
    expect(found.auth).toMatchObject({ method: 'token', tokenId: 'root@pam!t' });
  });
});
