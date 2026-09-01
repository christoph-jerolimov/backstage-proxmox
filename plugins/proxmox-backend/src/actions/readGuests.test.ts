import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { setupActions } from '../__testUtils__/actionHarness';

describe('proxmox:get-vm', () => {
  it('reads a VM', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes/pve/qemu/101/status/current', {
        data: { status: 'stopped', uptime: 0 },
      })
      .on('GET', '/nodes/pve/qemu/101/config', {
        data: { name: 'web-01', cores: 2, memory: 2048 },
      });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('get-vm', { node: 'pve', vmid: 101 });

    expect(output).toMatchObject({
      connectionTitle: 'Dev Proxmox',
      vmid: 101,
      name: 'web-01',
      status: 'stopped',
      config: { name: 'web-01', cores: 2, memory: 2048 },
    });
  });

  it('takes no guest type', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const action = actions.find(a => a.name === 'get-vm')!;

    expect(
      (action.schema.input as { properties?: object }).properties,
    ).not.toHaveProperty('guestType');
  });

  it('reports an unknown VMID as not found', async () => {
    const proxmox = FakeProxmox.create().on(
      'GET',
      '/nodes/pve/qemu/999/status/current',
      { status: 404, errors: { vmid: 'VM 999 does not exist' } },
    );
    const { invoke } = setupActions({ proxmox });

    await expect(invoke('get-vm', { node: 'pve', vmid: 999 })).rejects.toThrow(
      /HTTP 404.*VM 999 does not exist/s,
    );
  });

  it('reports a VMID that belongs to a container as not found', async () => {
    // Proxmox answers the qemu path for a container's VMID with a 500 about a
    // missing configuration file rather than a 404.
    const proxmox = FakeProxmox.create().on(
      'GET',
      '/nodes/pve/qemu/201/status/current',
      {
        status: 500,
        errors: {
          detail:
            "Configuration file 'nodes/pve/qemu-server/201.conf' does not exist",
        },
      },
    );
    const { invoke } = setupActions({ proxmox });

    const error: Error = await invoke('get-vm', { node: 'pve', vmid: 201 }).then(
      () => {
        throw new Error('expected the action to fail');
      },
      (e: Error) => e,
    );

    expect(error.name).toBe('NotFoundError');
  });
});

describe('proxmox:get-container', () => {
  it('reads a container and reports its hostname', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes/pve/lxc/201/status/current', { data: { status: 'stopped' } })
      .on('GET', '/nodes/pve/lxc/201/config', {
        data: { hostname: 'cache-01', memory: 512 },
      });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('get-container', { node: 'pve', vmid: 201 });

    expect(output).toMatchObject({
      vmid: 201,
      hostname: 'cache-01',
      status: 'stopped',
    });
    expect(output).not.toHaveProperty('name');
  });

  it('reports a VMID that belongs to a VM as not found', async () => {
    const proxmox = FakeProxmox.create().on(
      'GET',
      '/nodes/pve/lxc/101/status/current',
      {
        status: 500,
        errors: {
          detail: "Configuration file 'nodes/pve/lxc/101.conf' does not exist",
        },
      },
    );
    const { invoke } = setupActions({ proxmox });

    const error: Error = await invoke('get-container', {
      node: 'pve',
      vmid: 101,
    }).then(
      () => {
        throw new Error('expected the action to fail');
      },
      (e: Error) => e,
    );

    expect(error.name).toBe('NotFoundError');
  });
});
