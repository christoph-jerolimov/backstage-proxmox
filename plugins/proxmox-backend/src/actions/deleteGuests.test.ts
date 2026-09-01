import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { completedTask, setupActions } from '../__testUtils__/actionHarness';

const STOP_TASK = 'UPID:pve:0004:qmstop:101:root@pam:';
const DELETE_TASK = 'UPID:pve:0005:qmdestroy:101:root@pam:';

function fake(guestType: 'qemu' | 'lxc', vmid: number, status: string) {
  const base = `/nodes/pve/${guestType}/${vmid}`;
  const proxmox = FakeProxmox.create()
    .on('GET', `${base}/status/current`, { data: { status } })
    .on('POST', `${base}/status/stop`, { data: STOP_TASK })
    .on('DELETE', base, { data: DELETE_TASK });
  completedTask(proxmox, 'pve', STOP_TASK);
  return completedTask(proxmox, 'pve', DELETE_TASK);
}

describe.each([
  ['proxmox:delete-vm', 'delete-vm', 'qemu' as const, 101, 'VM'],
  ['proxmox:delete-container', 'delete-container', 'lxc' as const, 201, 'container'],
])('%s', (_id, action, guestType, vmid, label) => {
  const base = `/nodes/pve/${guestType}/${vmid}`;

  it('deletes a stopped guest', async () => {
    const proxmox = fake(guestType, vmid, 'stopped');
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke(action, { node: 'pve', vmid });

    expect(output).toMatchObject({ vmid, taskId: DELETE_TASK, exitStatus: 'OK' });
    expect(proxmox.requestsFor('POST', `${base}/status/stop`)).toHaveLength(0);
  });

  it('refuses to delete a running guest', async () => {
    const proxmox = fake(guestType, vmid, 'running');
    const { invoke } = setupActions({ proxmox });

    await expect(invoke(action, { node: 'pve', vmid })).rejects.toThrow(
      new RegExp(`${label} ${vmid} on node pve is running; set stopIfRunning`),
    );
    expect(proxmox.requestsFor('DELETE', base)).toHaveLength(0);
  });

  it('stops a running guest first when asked to', async () => {
    const proxmox = fake(guestType, vmid, 'running');
    const { invoke } = setupActions({ proxmox });

    await invoke(action, { node: 'pve', vmid, stopIfRunning: true });

    expect(proxmox.requestsFor('POST', `${base}/status/stop`)).toHaveLength(1);
    expect(proxmox.requestsFor('DELETE', base)).toHaveLength(1);
  });

  it('takes no guest type', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const found = actions.find(a => a.name === action)!;

    expect(
      (found.schema.input as { properties?: object }).properties,
    ).not.toHaveProperty('guestType');
  });
});
