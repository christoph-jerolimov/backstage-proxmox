import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { SelectedProxmoxConnection } from '../connections/ProxmoxConnectionsService';
import { ProxmoxClient } from './ProxmoxClient';
import { resolveProxmoxTask, waitForProxmoxTask } from './tasks';

const connection: SelectedProxmoxConnection = {
  type: 'proxmox',
  title: 'Dev Proxmox',
  baseUrl: 'https://localhost:8006',
  auth: {
    method: 'token',
    title: 'API Token',
    tokenId: 'root@pam!t',
    secret: '00000000-0000-4000-8000-000000000001',
  },
};

const TASK_ID = 'UPID:pve:0000:qmcreate:101:root@pam:';
const STATUS_PATH = `/nodes/pve/tasks/${encodeURIComponent(TASK_ID)}/status`;

function setup(statuses: Array<{ status: string; exitstatus?: string }>) {
  const proxmox = FakeProxmox.create();
  let call = 0;
  proxmox.on('GET', STATUS_PATH, () => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    return { data: status };
  });
  const client = ProxmoxClient.create({ connection, fetchApi: proxmox.fetch });
  return { proxmox, client, calls: () => call };
}

const noSleep = async () => {};

describe('waitForProxmoxTask', () => {
  it('succeeds when the task stops with exit status OK', async () => {
    const { client } = setup([{ status: 'stopped', exitstatus: 'OK' }]);

    await expect(
      waitForProxmoxTask({
        client,
        node: 'pve',
        taskId: TASK_ID,
        timeoutSeconds: 30,
        operation: 'creating VM 101',
        sleep: noSleep,
      }),
    ).resolves.toEqual({ taskId: TASK_ID, exitStatus: 'OK' });
  });

  it('polls until the task stops', async () => {
    const { client, calls } = setup([
      { status: 'running' },
      { status: 'running' },
      { status: 'stopped', exitstatus: 'OK' },
    ]);

    await waitForProxmoxTask({
      client,
      node: 'pve',
      taskId: TASK_ID,
      timeoutSeconds: 30,
      operation: 'creating VM 101',
      sleep: noSleep,
    });

    expect(calls()).toBe(3);
  });

  it('fails and reports the exit status when the task fails', async () => {
    const { client } = setup([
      { status: 'stopped', exitstatus: 'unable to create VM 101 - storage does not exist' },
    ]);

    await expect(
      waitForProxmoxTask({
        client,
        node: 'pve',
        taskId: TASK_ID,
        timeoutSeconds: 30,
        operation: 'creating VM 101',
        sleep: noSleep,
      }),
    ).rejects.toThrow(
      /failed with exit status "unable to create VM 101 - storage does not exist"/,
    );
  });

  it('times out with the task id in the message', async () => {
    const { client } = setup([{ status: 'running' }]);
    let clock = 0;

    await expect(
      waitForProxmoxTask({
        client,
        node: 'pve',
        taskId: TASK_ID,
        timeoutSeconds: 10,
        operation: 'creating VM 101',
        sleep: async () => {
          clock += 5000;
        },
        now: () => clock,
      }),
    ).rejects.toThrow(
      new RegExp(`Timed out after 10s waiting for Proxmox task ${TASK_ID}`),
    );
  });
});

describe('resolveProxmoxTask', () => {
  it('returns immediately without polling when waiting is disabled', async () => {
    const { client, calls } = setup([{ status: 'running' }]);

    await expect(
      resolveProxmoxTask({
        client,
        node: 'pve',
        taskId: TASK_ID,
        waitForCompletion: false,
        timeoutSeconds: 30,
        operation: 'creating VM 101',
        sleep: noSleep,
      }),
    ).resolves.toEqual({ taskId: TASK_ID });
    expect(calls()).toBe(0);
  });

  it('tolerates an endpoint that returns no task id', async () => {
    const { client, calls } = setup([{ status: 'running' }]);

    await expect(
      resolveProxmoxTask({
        client,
        node: 'pve',
        taskId: null,
        waitForCompletion: true,
        timeoutSeconds: 30,
        operation: 'creating a pool',
        sleep: noSleep,
      }),
    ).resolves.toEqual({ taskId: '' });
    expect(calls()).toBe(0);
  });
});
