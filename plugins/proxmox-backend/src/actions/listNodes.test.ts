import { FakeProxmox } from '../__testUtils__/fakeProxmox';
import { setupActions } from '../__testUtils__/actionHarness';

describe('proxmox:list-nodes', () => {
  it('returns one entry per node', async () => {
    const proxmox = FakeProxmox.create().on('GET', '/nodes', {
      data: [
        { node: 'pve', status: 'online', cpu: 0.02, maxcpu: 8, mem: 100, maxmem: 200 },
        { node: 'pve2', status: 'offline' },
      ],
    });
    const { invoke } = setupActions({ proxmox });

    const { output } = await invoke('list-nodes');

    expect(output).toEqual({
      connectionTitle: 'Dev Proxmox',
      nodes: [
        { node: 'pve', status: 'online', cpu: 0.02, maxcpu: 8, mem: 100, maxmem: 200 },
        { node: 'pve2', status: 'offline' },
      ],
    });
  });
});
