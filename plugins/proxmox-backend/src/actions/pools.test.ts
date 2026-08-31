import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { setupActions } from '../__testUtils__/actionHarness';

describe('proxmox:create-pool', () => {
  it('creates a pool that does not exist yet', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/pools', { data: [{ poolid: 'pool-prod' }] })
      .on('POST', '/pools', { data: null });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('create-pool', {
      poolid: 'pool-dev',
      comment: 'Development workloads',
    });

    expect(output).toEqual({
      connectionTitle: 'Dev Proxmox',
      poolid: 'pool-dev',
    });
    const body = proxmox.requestsFor('POST', '/pools')[0].body;
    expect(Object.fromEntries(body.entries())).toEqual({
      poolid: 'pool-dev',
      comment: 'Development workloads',
    });
  });

  it('fails when the pool already exists', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/pools', { data: [{ poolid: 'pool-dev' }] })
      .on('POST', '/pools', { data: null });
    const { invoke } = setupActions({ proxmox });

    await expect(invoke('create-pool', { poolid: 'pool-dev' })).rejects.toThrow(
      /pool "pool-dev" already exists/,
    );
    expect(proxmox.requestsFor('POST', '/pools')).toHaveLength(0);
  });
});

describe('proxmox:update-pool', () => {
  function fake(members: Array<{ vmid?: number; storage?: string; type?: string }>) {
    let current = members;
    return FakeProxmox.create()
      .on('GET', '/pools/pool-dev', () => ({
        data: { comment: 'Development workloads', members: current },
      }))
      .on('PUT', '/pools/pool-dev', request => {
        const vms = request.body.get('vms');
        if (vms) {
          current = [
            ...current,
            ...vms.split(',').map(vmid => ({ vmid: Number(vmid), type: 'qemu' })),
          ];
        }
        const storage = request.body.get('storage');
        if (storage) {
          current = [...current, ...storage.split(',').map(name => ({ storage: name }))];
        }
        return { data: null };
      });
  }

  it('updates the comment without touching the members', async () => {
    const proxmox = fake([{ vmid: 101, type: 'qemu' }]);
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('update-pool', {
      poolid: 'pool-dev',
      comment: 'Updated via Backstage',
    });

    expect(proxmox.requestsFor('PUT', '/pools/pool-dev')[0].body.get('comment')).toBe(
      'Updated via Backstage',
    );
    expect(output).toMatchObject({
      poolid: 'pool-dev',
      members: [{ vmid: 101, type: 'qemu' }],
    });
  });

  it('adds members', async () => {
    const proxmox = fake([]);
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('update-pool', {
      poolid: 'pool-dev',
      vms: [101, 102],
    });

    expect(proxmox.requestsFor('PUT', '/pools/pool-dev')[0].body.get('vms')).toBe(
      '101,102',
    );
    expect((output as any).members).toEqual([
      { vmid: 101, type: 'qemu' },
      { vmid: 102, type: 'qemu' },
    ]);
  });

  it('adds storages', async () => {
    const proxmox = fake([]);
    const { invoke } = setupActions({ proxmox });

    await invoke('update-pool', { poolid: 'pool-dev', storages: ['local'] });

    expect(proxmox.requestsFor('PUT', '/pools/pool-dev')[0].body.get('storage')).toBe(
      'local',
    );
  });

  it('adding the same member twice leaves it in the pool once', async () => {
    const proxmox = fake([]);
    const { invoke } = setupActions({ proxmox });

    await invoke('update-pool', { poolid: 'pool-dev', vms: [101] });
    const { output } = await invoke('update-pool', { poolid: 'pool-dev', vms: [101] });

    expect((output as any).members).toEqual([{ vmid: 101, type: 'qemu' }]);
    // The second call has nothing left to add, so it does not write again.
    expect(proxmox.requestsFor('PUT', '/pools/pool-dev')).toHaveLength(1);
  });

  it('only adds the members that are missing', async () => {
    const proxmox = fake([{ vmid: 101, type: 'qemu' }]);
    const { invoke } = setupActions({ proxmox });

    await invoke('update-pool', { poolid: 'pool-dev', vms: [101, 102] });

    expect(proxmox.requestsFor('PUT', '/pools/pool-dev')[0].body.get('vms')).toBe('102');
  });

  it('fails when there is nothing to update', async () => {
    const proxmox = fake([]);
    const { invoke } = setupActions({ proxmox });

    await expect(invoke('update-pool', { poolid: 'pool-dev' })).rejects.toThrow(
      /requires at least one configuration field/,
    );
    expect(proxmox.requests).toHaveLength(0);
  });
});
