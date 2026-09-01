import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { completedTask, setupActions } from '../__testUtils__/actionHarness';

const TASK = 'UPID:pve:0003:qmstart:101:root@pam:';

function guestFake(guestType: 'qemu' | 'lxc', vmid: number, initial: string) {
  let status = initial;
  const base = `/nodes/pve/${guestType}/${vmid}`;
  const proxmox = FakeProxmox.create()
    .on('GET', `${base}/status/current`, () => ({ data: { status } }))
    .on('POST', `${base}/status/start`, () => {
      status = 'running';
      return { data: TASK };
    })
    .on('POST', `${base}/status/stop`, () => {
      status = 'stopped';
      return { data: TASK };
    });
  return completedTask(proxmox, 'pve', TASK);
}

describe('proxmox:set-vm-power-state', () => {
  it('starts a stopped VM', async () => {
    const proxmox = guestFake('qemu', 101, 'stopped');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-vm-power-state', {
      node: 'pve',
      vmid: 101,
      state: 'start',
    });

    expect(output).toMatchObject({ status: 'running', changed: true, taskId: TASK });
  });

  it('does nothing when the VM is already in the requested state', async () => {
    const proxmox = guestFake('qemu', 101, 'running');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('set-vm-power-state', {
      node: 'pve',
      vmid: 101,
      state: 'start',
    });

    expect(output).toMatchObject({ status: 'running', changed: false });
    expect(proxmox.requestsFor('POST', '/nodes/pve/qemu/101/status/start')).toHaveLength(
      0,
    );
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

describe('proxmox:set-container-power-state', () => {
  it('starts a stopped container', async () => {
    const proxmox = guestFake('lxc', 201, 'stopped');
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
    const proxmox = guestFake('lxc', 201, 'running');
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
