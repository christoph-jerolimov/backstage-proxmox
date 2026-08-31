import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { completedTask, setupActions } from '../__testUtils__/actionHarness';

const CREATE_TASK = 'UPID:pve:0001:qmcreate:101:root@pam:';

describe('proxmox:list-nodes', () => {
  it('returns one entry per node', async () => {
    const proxmox = FakeProxmox.create().on('GET', '/nodes', {
      data: [
        {
          node: 'pve',
          status: 'online',
          cpu: 0.02,
          maxcpu: 8,
          mem: 100,
          maxmem: 200,
        },
        { node: 'pve2', status: 'offline' },
      ],
    });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('list-nodes');

    expect(output).toEqual({
      connectionTitle: 'Dev Proxmox',
      nodes: [
        {
          node: 'pve',
          status: 'online',
          cpu: 0.02,
          maxcpu: 8,
          mem: 100,
          maxmem: 200,
        },
        { node: 'pve2', status: 'offline' },
      ],
    });
  });
});

describe('proxmox:get-guest', () => {
  it('reads a QEMU VM', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes/pve/qemu/101/status/current', {
        data: { status: 'stopped', uptime: 0 },
      })
      .on('GET', '/nodes/pve/qemu/101/config', {
        data: { name: 'web-01', cores: 2, memory: 2048 },
      });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('get-guest', {
      node: 'pve',
      vmid: 101,
      guestType: 'qemu',
    });

    expect(output).toMatchObject({
      vmid: 101,
      guestType: 'qemu',
      name: 'web-01',
      status: 'stopped',
      config: { name: 'web-01', cores: 2, memory: 2048 },
    });
  });

  it('reads an LXC container and uses its hostname as the name', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes/pve/lxc/201/status/current', {
        data: { status: 'stopped' },
      })
      .on('GET', '/nodes/pve/lxc/201/config', {
        data: { hostname: 'cache-01', memory: 512 },
      });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('get-guest', {
      node: 'pve',
      vmid: 201,
      guestType: 'lxc',
    });

    expect(output).toMatchObject({ name: 'cache-01', guestType: 'lxc' });
  });

  it('reports an unknown guest as not found', async () => {
    const proxmox = FakeProxmox.create().on(
      'GET',
      '/nodes/pve/qemu/999/status/current',
      { status: 404, errors: { vmid: 'VM 999 does not exist' } },
    );
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('get-guest', { node: 'pve', vmid: 999, guestType: 'qemu' }),
    ).rejects.toThrow(/HTTP 404.*VM 999 does not exist/s);
  });
});

describe('proxmox:create-vm', () => {
  function fakeWithCreate() {
    const proxmox = FakeProxmox.create().on('POST', '/nodes/pve/qemu', {
      data: CREATE_TASK,
    });
    return completedTask(proxmox, 'pve', CREATE_TASK);
  }

  it('allocates the next free VMID when none is given', async () => {
    const proxmox = fakeWithCreate().on('GET', '/cluster/nextid', {
      data: '104',
    });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('create-vm', {
      node: 'pve',
      name: 'web-02',
    });

    expect(output).toEqual({
      connectionTitle: 'Dev Proxmox',
      node: 'pve',
      vmid: 104,
      name: 'web-02',
      taskId: CREATE_TASK,
      exitStatus: 'OK',
    });
    expect(
      proxmox.requestsFor('POST', '/nodes/pve/qemu')[0].body.get('vmid'),
    ).toBe('104');
  });

  it('uses an explicit VMID when it is free', async () => {
    const proxmox = fakeWithCreate().on('GET', '/cluster/nextid', {
      data: '101',
    });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('create-vm', {
      node: 'pve',
      name: 'web-02',
      vmid: 101,
    });

    expect(output).toMatchObject({ vmid: 101 });
    expect(
      proxmox.requestsFor('GET', '/cluster/nextid')[0].query.get('vmid'),
    ).toBe('101');
  });

  it('fails when the VMID is already in use', async () => {
    const proxmox = fakeWithCreate().on('GET', '/cluster/nextid', {
      status: 400,
      errors: { vmid: 'VM 101 already exists' },
    });
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('create-vm', { node: 'pve', name: 'web-02', vmid: 101 }),
    ).rejects.toThrow(/VMID 101 is already in use/);
    expect(proxmox.requestsFor('POST', '/nodes/pve/qemu')).toHaveLength(0);
  });

  it('passes only the fields that were given', async () => {
    const proxmox = fakeWithCreate().on('GET', '/cluster/nextid', {
      data: '104',
    });
    const { invoke } = setupActions({ proxmox });

    await invoke('create-vm', {
      node: 'pve',
      name: 'web-02',
      cores: 2,
      memory: 2048,
      tags: 'web;dev',
      pool: 'pool-dev',
    });

    const body = proxmox.requestsFor('POST', '/nodes/pve/qemu')[0].body;
    expect(Object.fromEntries(body.entries())).toEqual({
      vmid: '104',
      name: 'web-02',
      cores: '2',
      memory: '2048',
      tags: 'web;dev',
      pool: 'pool-dev',
    });
  });

  it('fails when the Proxmox task fails', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/cluster/nextid', { data: '104' })
      .on('POST', '/nodes/pve/qemu', { data: CREATE_TASK })
      .on('GET', `/nodes/pve/tasks/${encodeURIComponent(CREATE_TASK)}/status`, {
        data: {
          status: 'stopped',
          exitstatus: 'storage "nope" does not exist',
        },
      });
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('create-vm', { node: 'pve', name: 'web-02' }),
    ).rejects.toThrow(
      /failed with exit status "storage "nope" does not exist"/,
    );
  });

  it('returns without polling when waiting is disabled', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/cluster/nextid', { data: '104' })
      .on('POST', '/nodes/pve/qemu', { data: CREATE_TASK });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('create-vm', {
      node: 'pve',
      name: 'web-02',
      waitForCompletion: false,
    });

    expect(output).toMatchObject({ taskId: CREATE_TASK });
    expect(output).not.toHaveProperty('exitStatus');
  });
});

describe('proxmox:update-vm-config', () => {
  const TASK = 'UPID:pve:0002:qmconfig:101:root@pam:';

  function fake() {
    const proxmox = FakeProxmox.create()
      .on('POST', '/nodes/pve/qemu/101/config', { data: TASK })
      .on('GET', '/nodes/pve/qemu/101/config', {
        data: { name: 'web-01', cores: 2, memory: 4096 },
      });
    return completedTask(proxmox, 'pve', TASK);
  }

  it('sends only the fields that were given', async () => {
    const proxmox = fake();
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('update-vm-config', {
      node: 'pve',
      vmid: 101,
      memory: 4096,
    });

    const body = proxmox.requestsFor('POST', '/nodes/pve/qemu/101/config')[0]
      .body;
    expect(Object.fromEntries(body.entries())).toEqual({ memory: '4096' });
    expect(output).toMatchObject({ config: { memory: 4096 } });
  });

  it('is idempotent when applied twice', async () => {
    const proxmox = fake();
    const { invoke } = setupActions({ proxmox });

    const first = await invoke('update-vm-config', {
      node: 'pve',
      vmid: 101,
      memory: 4096,
    });
    const second = await invoke('update-vm-config', {
      node: 'pve',
      vmid: 101,
      memory: 4096,
    });

    expect(second.output).toEqual(first.output);
  });

  it('fails when there is nothing to update', async () => {
    const proxmox = fake();
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('update-vm-config', { node: 'pve', vmid: 101 }),
    ).rejects.toThrow(/requires at least one configuration field/);
    expect(proxmox.requests).toHaveLength(0);
  });

  it('moves the VM into a pool without touching the guest config endpoint', async () => {
    const proxmox = fake()
      .on('GET', '/pools/pool-dev', { data: { members: [] } })
      .on('PUT', '/pools/pool-dev', { data: null });
    const { invoke } = setupActions({ proxmox });

    await invoke('update-vm-config', {
      node: 'pve',
      vmid: 101,
      pool: 'pool-dev',
    });

    expect(
      proxmox.requestsFor('POST', '/nodes/pve/qemu/101/config'),
    ).toHaveLength(0);
    expect(
      proxmox.requestsFor('PUT', '/pools/pool-dev')[0].body.get('vms'),
    ).toBe('101');
  });
});

describe('proxmox:set-guest-power-state', () => {
  const TASK = 'UPID:pve:0003:qmstart:101:root@pam:';

  it('starts a stopped guest and reports it running', async () => {
    let status = 'stopped';
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes/pve/qemu/101/status/current', () => ({
        data: { status },
      }))
      .on('POST', '/nodes/pve/qemu/101/status/start', () => {
        status = 'running';
        return { data: TASK };
      });
    completedTask(proxmox, 'pve', TASK);
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-guest-power-state', {
      node: 'pve',
      vmid: 101,
      guestType: 'qemu',
      state: 'start',
    });

    expect(output).toMatchObject({
      status: 'running',
      changed: true,
      taskId: TASK,
    });
  });

  it('succeeds without acting when the guest is already in the requested state', async () => {
    const proxmox = FakeProxmox.create().on(
      'GET',
      '/nodes/pve/qemu/101/status/current',
      { data: { status: 'running' } },
    );
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-guest-power-state', {
      node: 'pve',
      vmid: 101,
      guestType: 'qemu',
      state: 'start',
    });

    expect(output).toMatchObject({ status: 'running', changed: false });
    expect(
      proxmox.requestsFor('POST', '/nodes/pve/qemu/101/status/start'),
    ).toHaveLength(0);
  });

  it('works for LXC containers too', async () => {
    const proxmox = FakeProxmox.create().on(
      'GET',
      '/nodes/pve/lxc/201/status/current',
      { data: { status: 'stopped' } },
    );
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-guest-power-state', {
      node: 'pve',
      vmid: 201,
      guestType: 'lxc',
      state: 'stop',
    });

    expect(output).toMatchObject({ status: 'stopped', changed: false });
  });
});

describe('proxmox:delete-guest', () => {
  const STOP_TASK = 'UPID:pve:0004:qmstop:101:root@pam:';
  const DELETE_TASK = 'UPID:pve:0005:qmdestroy:101:root@pam:';

  function fake(status: string) {
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes/pve/qemu/101/status/current', { data: { status } })
      .on('POST', '/nodes/pve/qemu/101/status/stop', { data: STOP_TASK })
      .on('DELETE', '/nodes/pve/qemu/101', { data: DELETE_TASK });
    completedTask(proxmox, 'pve', STOP_TASK);
    return completedTask(proxmox, 'pve', DELETE_TASK);
  }

  it('deletes a stopped guest', async () => {
    const proxmox = fake('stopped');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('delete-guest', {
      node: 'pve',
      vmid: 101,
      guestType: 'qemu',
    });

    expect(output).toMatchObject({
      vmid: 101,
      taskId: DELETE_TASK,
      exitStatus: 'OK',
    });
    expect(
      proxmox.requestsFor('POST', '/nodes/pve/qemu/101/status/stop'),
    ).toHaveLength(0);
  });

  it('refuses to delete a running guest', async () => {
    const proxmox = fake('running');
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('delete-guest', { node: 'pve', vmid: 101, guestType: 'qemu' }),
    ).rejects.toThrow(/is running; set stopIfRunning/);
    expect(proxmox.requestsFor('DELETE', '/nodes/pve/qemu/101')).toHaveLength(
      0,
    );
  });

  it('stops a running guest first when asked to', async () => {
    const proxmox = fake('running');
    const { invoke } = setupActions({ proxmox });

    await invoke('delete-guest', {
      node: 'pve',
      vmid: 101,
      guestType: 'qemu',
      stopIfRunning: true,
    });

    expect(
      proxmox.requestsFor('POST', '/nodes/pve/qemu/101/status/stop'),
    ).toHaveLength(1);
    expect(proxmox.requestsFor('DELETE', '/nodes/pve/qemu/101')).toHaveLength(
      1,
    );
  });
});

describe('proxmox:create-lxc', () => {
  const TASK = 'UPID:pve:0006:vzcreate:203:root@pam:';

  it('creates a container and allocates a VMID', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/cluster/nextid', { data: '203' })
      .on('POST', '/nodes/pve/lxc', { data: TASK });
    completedTask(proxmox, 'pve', TASK);
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('create-lxc', {
      node: 'pve',
      hostname: 'cache-02',
      ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
      storage: 'local',
      rootfsSize: 4,
    });

    expect(output).toMatchObject({
      vmid: 203,
      hostname: 'cache-02',
      exitStatus: 'OK',
    });
    const body = proxmox.requestsFor('POST', '/nodes/pve/lxc')[0].body;
    expect(body.get('rootfs')).toBe('local:4');
    expect(body.get('ostemplate')).toBe(
      'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
    );
  });

  it('surfaces a missing OS template', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/cluster/nextid', { data: '203' })
      .on('POST', '/nodes/pve/lxc', {
        status: 500,
        errors: {
          ostemplate: "volume 'local:vztmpl/nope.tar.zst' does not exist",
        },
      });
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('create-lxc', {
        node: 'pve',
        hostname: 'cache-02',
        ostemplate: 'local:vztmpl/nope.tar.zst',
      }),
    ).rejects.toThrow(/nope.tar.zst' does not exist/);
  });
});
