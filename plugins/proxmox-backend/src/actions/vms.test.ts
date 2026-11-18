import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { completedTask, setupActions } from '../__testUtils__/actionHarness';

const CREATE_TASK = 'UPID:pve:0001:qmcreate:101:root@pam:';

const POWER_TASK = 'UPID:pve:0003:qmstart:101:root@pam:';

function powerFake(kind: 'qemu' | 'lxc', vmid: number, initial: string) {
  let status = initial;
  const base = `/nodes/pve/${kind}/${vmid}`;
  const proxmox = FakeProxmox.create()
    .on('GET', `${base}/status/current`, () => ({ data: { status } }))
    .on('POST', `${base}/status/start`, () => {
      status = 'running';
      return { data: POWER_TASK };
    })
    .on('POST', `${base}/status/stop`, () => {
      status = 'stopped';
      return { data: POWER_TASK };
    });
  return completedTask(proxmox, 'pve', POWER_TASK);
}

const STOP_TASK = 'UPID:pve:0004:qmstop:101:root@pam:';
const DELETE_TASK = 'UPID:pve:0005:qmdestroy:101:root@pam:';

function deleteFake(kind: 'qemu' | 'lxc', vmid: number, status: string) {
  const base = `/nodes/pve/${kind}/${vmid}`;
  const proxmox = FakeProxmox.create()
    .on('GET', `${base}/status/current`, { data: { status } })
    .on('POST', `${base}/status/stop`, { data: STOP_TASK })
    .on('DELETE', base, { data: DELETE_TASK });
  completedTask(proxmox, 'pve', STOP_TASK);
  return completedTask(proxmox, 'pve', DELETE_TASK);
}

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

  it('takes only a connection, a node and a VMID', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const action = actions.find(a => a.name === 'get-vm')!;

    expect(
      Object.keys(
        (action.schema.input as { properties?: object }).properties ?? {},
      ).sort(),
    ).toEqual(['connection', 'node', 'vmid']);
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

    const error: Error = await invoke('get-vm', {
      node: 'pve',
      vmid: 201,
    }).then(
      () => {
        throw new Error('expected the action to fail');
      },
      (e: Error) => e,
    );

    expect(error.name).toBe('NotFoundError');
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

  it('moves the VM into a pool without touching the VM config endpoint', async () => {
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

describe('proxmox:set-vm-power-state', () => {
  it('starts a stopped VM', async () => {
    const proxmox = powerFake('qemu', 101, 'stopped');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-vm-power-state', {
      node: 'pve',
      vmid: 101,
      state: 'start',
    });

    expect(output).toMatchObject({
      status: 'running',
      changed: true,
      taskId: POWER_TASK,
    });
  });

  it('does nothing when the VM is already in the requested state', async () => {
    const proxmox = powerFake('qemu', 101, 'running');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-vm-power-state', {
      node: 'pve',
      vmid: 101,
      state: 'start',
    });

    expect(output).toMatchObject({ status: 'running', changed: false });
    expect(
      proxmox.requestsFor('POST', '/nodes/pve/qemu/101/status/start'),
    ).toHaveLength(0);
  });

  it('accepts suspend and resume', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const states = (
      actions.find(a => a.name === 'set-vm-power-state')!.schema.input as any
    ).properties.state.enum;

    expect(states).toEqual([
      'start',
      'stop',
      'shutdown',
      'reboot',
      'suspend',
      'resume',
    ]);
  });
});

describe('proxmox:delete-vm', () => {
  it('deletes a stopped VM', async () => {
    const proxmox = deleteFake('qemu', 101, 'stopped');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('delete-vm', { node: 'pve', vmid: 101 });

    expect(output).toMatchObject({
      vmid: 101,
      taskId: DELETE_TASK,
      exitStatus: 'OK',
    });
    expect(
      proxmox.requestsFor('POST', '/nodes/pve/qemu/101/status/stop'),
    ).toHaveLength(0);
  });

  it('refuses to delete a running VM', async () => {
    const proxmox = deleteFake('qemu', 101, 'running');
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('delete-vm', { node: 'pve', vmid: 101 }),
    ).rejects.toThrow(/VM 101 on node pve is running; set stopIfRunning/);
    expect(proxmox.requestsFor('DELETE', '/nodes/pve/qemu/101')).toHaveLength(
      0,
    );
  });

  it('stops a running VM first when asked to', async () => {
    const proxmox = deleteFake('qemu', 101, 'running');
    const { invoke } = setupActions({ proxmox });

    await invoke('delete-vm', {
      node: 'pve',
      vmid: 101,
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
