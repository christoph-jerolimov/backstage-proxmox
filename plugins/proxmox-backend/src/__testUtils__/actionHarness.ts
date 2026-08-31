import { actionsRegistryServiceMock } from '@backstage/backend-test-utils/alpha';
import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { registerProxmoxActions } from '../actions';
import { ProxmoxClient } from '../client/ProxmoxClient';
import { DefaultProxmoxConnectionsService } from '../connections/ProxmoxConnectionsService';
import { resolveProxmoxConnections } from '../connections/resolveConnections';
import { FakeProxmox } from './fakeProxmox';

/** The single dev-style connection most action tests use. */
export const DEV_CONNECTION = {
  type: 'proxmox',
  title: 'Dev Proxmox',
  baseUrl: 'https://localhost:8006',
  skipTlsVerify: true,
  auth: [
    {
      method: 'token',
      tokenId: 'root@pam!full-access',
      secret: '00000000-0000-4000-8000-000000000001',
    },
  ],
};

/**
 * Registers every Proxmox action against a mocked actions registry, backed by
 * a fake Proxmox instance. Actions are invoked exactly the way the registry
 * invokes them, so input and output schemas are enforced.
 */
export function setupActions(options?: {
  proxmox?: FakeProxmox;
  connections?: object[];
}) {
  const proxmox = options?.proxmox ?? FakeProxmox.create();
  const registry = actionsRegistryServiceMock();

  const connections = DefaultProxmoxConnectionsService.create(
    resolveProxmoxConnections({
      config: new ConfigReader({
        connections: options?.connections ?? [DEV_CONNECTION],
      }),
    }),
  );

  registerProxmoxActions(registry, {
    connections,
    logger: mockServices.logger.mock(),
    createClient: ({ connection }) =>
      ProxmoxClient.create({ connection, fetchApi: proxmox.fetch }),
    sleep: async () => {},
  });

  const invoke = (name: string, input: Record<string, unknown> = {}) =>
    registry.invoke({ id: `test:${name}`, input });

  return { registry, proxmox, invoke };
}

/** A task that Proxmox reports as finished successfully. */
export function completedTask(proxmox: FakeProxmox, node: string, taskId: string) {
  return proxmox.on(
    'GET',
    `/nodes/${node}/tasks/${encodeURIComponent(taskId)}/status`,
    { data: { status: 'stopped', exitstatus: 'OK' } },
  );
}
