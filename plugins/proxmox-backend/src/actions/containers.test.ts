import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { completedTask, setupActions } from '../__testUtils__/actionHarness';

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

describe('proxmox:get-container', () => {
  it('reads a container and reports its hostname', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/nodes/pve/lxc/201/status/current', {
        data: { status: 'stopped' },
      })
      .on('GET', '/nodes/pve/lxc/201/config', {
        data: { hostname: 'cache-01', memory: 512 },
      });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('get-container', {
      node: 'pve',
      vmid: 201,
    });

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

describe('proxmox:create-container', () => {
  const TASK = 'UPID:pve:0006:vzcreate:203:root@pam:';

  it('creates a container and allocates a VMID', async () => {
    const proxmox = FakeProxmox.create()
      .on('GET', '/cluster/nextid', { data: '203' })
      .on('POST', '/nodes/pve/lxc', { data: TASK });
    completedTask(proxmox, 'pve', TASK);
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('create-container', {
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
      invoke('create-container', {
        node: 'pve',
        hostname: 'cache-02',
        ostemplate: 'local:vztmpl/nope.tar.zst',
      }),
    ).rejects.toThrow(/nope.tar.zst' does not exist/);
  });
});

describe('proxmox:set-container-power-state', () => {
  it('starts a stopped container', async () => {
    const proxmox = powerFake('lxc', 201, 'stopped');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-container-power-state', {
      node: 'pve',
      vmid: 201,
      state: 'start',
    });

    expect(output).toMatchObject({ status: 'running', changed: true });
  });

  it('offers only the states Proxmox supports for containers', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const states = (
      actions.find(a => a.name === 'set-container-power-state')!.schema
        .input as any
    ).properties.state.enum;

    expect(states).toEqual(['start', 'stop', 'shutdown', 'reboot']);
  });

  it('rejects suspend without calling Proxmox', async () => {
    const proxmox = powerFake('lxc', 201, 'running');
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('set-container-power-state', {
        node: 'pve',
        vmid: 201,
        state: 'suspend',
      }),
    ).rejects.toThrow(/Invalid input/);
    expect(proxmox.requests).toHaveLength(0);
  });
});

describe('proxmox:delete-container', () => {
  it('deletes a stopped container', async () => {
    const proxmox = deleteFake('lxc', 201, 'stopped');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('delete-container', {
      node: 'pve',
      vmid: 201,
    });

    expect(output).toMatchObject({
      vmid: 201,
      taskId: DELETE_TASK,
      exitStatus: 'OK',
    });
    expect(
      proxmox.requestsFor('POST', '/nodes/pve/lxc/201/status/stop'),
    ).toHaveLength(0);
  });

  it('refuses to delete a running container', async () => {
    const proxmox = deleteFake('lxc', 201, 'running');
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('delete-container', { node: 'pve', vmid: 201 }),
    ).rejects.toThrow(
      /container 201 on node pve is running; set stopIfRunning/,
    );
    expect(proxmox.requestsFor('DELETE', '/nodes/pve/lxc/201')).toHaveLength(0);
  });

  it('stops a running container first when asked to', async () => {
    const proxmox = deleteFake('lxc', 201, 'running');
    const { invoke } = setupActions({ proxmox });

    await invoke('delete-container', {
      node: 'pve',
      vmid: 201,
      stopIfRunning: true,
    });

    expect(
      proxmox.requestsFor('POST', '/nodes/pve/lxc/201/status/stop'),
    ).toHaveLength(1);
    expect(proxmox.requestsFor('DELETE', '/nodes/pve/lxc/201')).toHaveLength(1);
  });
});
