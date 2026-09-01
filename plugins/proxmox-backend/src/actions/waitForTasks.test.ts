import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { setupActions } from '../__testUtils__/actionHarness';
import { nodeFromTaskId } from '../client/tasks';

const A = 'UPID:pve:0001:qmcreate:101:root@pam:';
const B = 'UPID:pve:0002:qmcreate:102:root@pam:';
const C = 'UPID:pve2:0003:qmcreate:103:root@pam:';

function statusPath(taskId: string) {
  return `/nodes/${nodeFromTaskId(taskId)}/tasks/${encodeURIComponent(
    taskId,
  )}/status`;
}

function tasks(
  entries: Array<[string, { status: string; exitstatus?: string }]>,
) {
  const proxmox = FakeProxmox.create();
  for (const [taskId, status] of entries) {
    proxmox.on('GET', statusPath(taskId), { data: status });
  }
  return proxmox;
}

const OK = { status: 'stopped', exitstatus: 'OK' };

describe('nodeFromTaskId', () => {
  it('reads the node from a task id', () => {
    expect(nodeFromTaskId(A)).toBe('pve');
    expect(nodeFromTaskId(C)).toBe('pve2');
  });

  it('rejects anything that is not a task id', () => {
    expect(nodeFromTaskId('UPID::0001:x:')).toBeUndefined();
    expect(nodeFromTaskId('not-a-upid')).toBeUndefined();
    expect(nodeFromTaskId('')).toBeUndefined();
  });
});

describe('proxmox:wait-for-tasks', () => {
  it('succeeds when every task succeeds', async () => {
    const proxmox = tasks([
      [A, OK],
      [B, OK],
      [C, OK],
    ]);
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('wait-for-tasks', { taskIds: [A, B, C] });

    expect(output).toMatchObject({
      connectionTitle: 'Dev Proxmox',
      tasks: [
        { taskId: A, node: 'pve', exitStatus: 'OK' },
        { taskId: B, node: 'pve', exitStatus: 'OK' },
        { taskId: C, node: 'pve2', exitStatus: 'OK' },
      ],
    });
  });

  it('fails and names the failed task', async () => {
    const proxmox = tasks([
      [A, OK],
      [B, { status: 'stopped', exitstatus: 'storage does not exist' }],
    ]);
    const { invoke } = setupActions({ proxmox });

    await expect(invoke('wait-for-tasks', { taskIds: [A, B] })).rejects.toThrow(
      /1 of 2 Proxmox tasks did not succeed[\s\S]*storage does not exist/,
    );
  });

  it('names every failed task, not only the first', async () => {
    const proxmox = tasks([
      [A, { status: 'stopped', exitstatus: 'first failure' }],
      [B, { status: 'stopped', exitstatus: 'second failure' }],
      [C, OK],
    ]);
    const { invoke } = setupActions({ proxmox });

    const error: Error = await invoke('wait-for-tasks', {
      taskIds: [A, B, C],
    }).then(
      () => {
        throw new Error('expected the action to fail');
      },
      (e: Error) => e,
    );

    expect(error.message).toContain('2 of 3 Proxmox tasks did not succeed');
    expect(error.message).toContain('first failure');
    expect(error.message).toContain('second failure');
  });

  it('times out naming the task that was still running', async () => {
    const proxmox = tasks([
      [A, OK],
      [B, { status: 'running' }],
    ]);
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('wait-for-tasks', { taskIds: [A, B], timeoutSeconds: 1 }),
    ).rejects.toThrow(new RegExp(`Timed out[\\s\\S]*${B}`));
  });

  it('succeeds without polling when the list is empty', async () => {
    const proxmox = FakeProxmox.create();
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('wait-for-tasks', { taskIds: [] });

    expect(output).toEqual({ connectionTitle: '', tasks: [] });
    expect(proxmox.requests).toHaveLength(0);
  });

  it('succeeds without polling when no task ids are given at all', async () => {
    const proxmox = FakeProxmox.create();
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('wait-for-tasks', {});

    expect(output).toEqual({ connectionTitle: '', tasks: [] });
    expect(proxmox.requests).toHaveLength(0);
  });

  it('rejects a malformed task id before polling anything', async () => {
    const proxmox = tasks([[A, OK]]);
    const { invoke } = setupActions({ proxmox });

    await expect(
      invoke('wait-for-tasks', { taskIds: [A, 'nonsense'] }),
    ).rejects.toThrow(/Not a Proxmox task id: "nonsense"/);
    expect(proxmox.requests).toHaveLength(0);
  });

  it('polls a repeated task id once and reports it once', async () => {
    const proxmox = tasks([[A, OK]]);
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('wait-for-tasks', { taskIds: [A, A, A] });

    expect((output as any).tasks).toHaveLength(1);
    expect(proxmox.requestsFor('GET', statusPath(A))).toHaveLength(1);
  });

  it('is dry-run safe', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const action = actions.find(a => a.name === 'wait-for-tasks')!;

    expect(action.attributes).toEqual({
      readOnly: true,
      idempotent: true,
      destructive: false,
    });
  });
});
