import { PROXMOX_ACTION_NAMES } from './index';
import { setupActions } from '../__testUtils__/actionHarness';

describe('Proxmox action registration', () => {
  it('registers every action exactly once', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();

    expect(actions.map(action => action.name).sort()).toEqual(
      [...PROXMOX_ACTION_NAMES].sort(),
    );
  });

  it('declares attributes that match what each action does', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const attributes = Object.fromEntries(
      actions.map(action => [action.name, action.attributes]),
    );

    expect(attributes['list-nodes']).toEqual({
      readOnly: true,
      idempotent: true,
      destructive: false,
    });
    expect(attributes['get-guest']).toEqual({
      readOnly: true,
      idempotent: true,
      destructive: false,
    });
    expect(attributes['set-guest-power-state'].destructive).toBe(true);
    expect(attributes['delete-guest'].destructive).toBe(true);
    expect(attributes['update-vm-config'].idempotent).toBe(true);
    expect(attributes['update-pool'].idempotent).toBe(true);
  });

  it('marks only the read-only actions as dry-run safe', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();

    const dryRunnable = actions
      .filter(
        action =>
          action.attributes.readOnly === true &&
          action.attributes.destructive === false,
      )
      .map(action => action.name)
      .sort();

    expect(dryRunnable).toEqual(['get-guest', 'list-nodes']);
  });

  it('declares no secrets schema, which templates cannot supply', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();

    for (const action of actions) {
      expect(action.schema.secrets).toBeUndefined();
    }
  });

  it('lets every action name the connection to act on', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();

    for (const action of actions) {
      const input = action.schema.input as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(input.properties).toHaveProperty('connection');
      expect(input.required ?? []).not.toContain('connection');
    }
  });

  it('reports the connection it acted on', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();

    for (const action of actions) {
      const output = action.schema.output as {
        properties?: Record<string, unknown>;
      };
      expect(output.properties).toHaveProperty('connectionTitle');
    }
  });

  it('fails with a clear message when no connection is configured', async () => {
    const { invoke } = setupActions({ connections: [] });

    await expect(invoke('list-nodes')).rejects.toThrow(
      /No Proxmox connection is configured/,
    );
  });

  it('acts on the connection the input names', async () => {
    const { invoke, proxmox } = setupActions({
      connections: [
        {
          type: 'proxmox',
          title: 'One',
          baseUrl: 'https://one.example.com:8006',
          auth: [
            { method: 'token', tokenId: 'root@pam!t', secret: 'secret-one' },
          ],
        },
        {
          type: 'proxmox',
          title: 'Two',
          baseUrl: 'https://two.example.com:8006',
          auth: [
            { method: 'token', tokenId: 'root@pam!t', secret: 'secret-two' },
          ],
        },
      ],
    });
    proxmox.on('GET', '/nodes', { data: [{ node: 'pve', status: 'online' }] });

    const result = await invoke('list-nodes', { connection: 'Two' });

    expect(result.output).toMatchObject({ connectionTitle: 'Two' });
  });

  it('refuses to guess when several connections are configured', async () => {
    const { invoke } = setupActions({
      connections: [
        {
          type: 'proxmox',
          title: 'One',
          baseUrl: 'https://one.example.com:8006',
          auth: [
            { method: 'token', tokenId: 'root@pam!t', secret: 'secret-one' },
          ],
        },
        {
          type: 'proxmox',
          title: 'Two',
          baseUrl: 'https://two.example.com:8006',
          auth: [
            { method: 'token', tokenId: 'root@pam!t', secret: 'secret-two' },
          ],
        },
      ],
    });

    await expect(invoke('list-nodes')).rejects.toThrow(/"One", "Two"/);
  });

  it('rejects input that does not match the schema before calling Proxmox', async () => {
    const { invoke, proxmox } = setupActions();

    await expect(
      invoke('get-guest', { node: 'pve', vmid: 101 }),
    ).rejects.toThrow(/Invalid input/);
    expect(proxmox.requests).toHaveLength(0);
  });
});
