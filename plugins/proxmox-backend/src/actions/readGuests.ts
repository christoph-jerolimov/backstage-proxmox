import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { ProxmoxClient } from '../client/ProxmoxClient';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  containerFields,
  guestPath,
  ProxmoxActionDeps,
  vmFields,
} from './helpers';

type GuestStatus = { status?: string; name?: string; uptime?: number };

/**
 * Reads one guest's status and configuration. Both kinds are read the same
 * way; only the API path segment differs, so `get-vm` and `get-container`
 * share this and differ in their schemas alone.
 */
async function readGuest(
  client: ProxmoxClient,
  node: string,
  guestType: 'qemu' | 'lxc',
  vmid: number,
) {
  const base = guestPath(node, guestType, vmid);
  const status = await client.get<GuestStatus>(`${base}/status/current`);
  const config = (await client.get<Record<string, unknown>>(`${base}/config`)) ?? {};

  return {
    connectionTitle: client.connectionTitle,
    node,
    vmid,
    status: status?.status ?? 'unknown',
    uptime: status?.uptime,
    config,
  };
}

export function registerGetVm(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'get-vm',
    title: 'Get Proxmox VM',
    description:
      'Reads the configuration and current status of a Proxmox QEMU virtual machine.',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z => z.object({ ...connectionField(z), ...vmFields(z) }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number(),
          name: z.string().optional().describe('Name of the virtual machine'),
          status: z
            .string()
            .describe('Current status, for example "running" or "stopped"'),
          uptime: z.number().optional().describe('Uptime in seconds'),
          config: z
            .record(z.any())
            .describe('The VM configuration as Proxmox reports it'),
        }),
    },
    action: async ({ input }) => {
      const client = await clientFor(deps, input.connection);
      const guest = await readGuest(client, input.node, 'qemu', input.vmid);
      return {
        output: { ...guest, name: guest.config.name as string | undefined },
      };
    },
  });
}

export function registerGetContainer(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'get-container',
    title: 'Get Proxmox Container',
    description:
      'Reads the configuration and current status of a Proxmox LXC container.',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z => z.object({ ...connectionField(z), ...containerFields(z) }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number(),
          hostname: z.string().optional().describe('Hostname of the container'),
          status: z
            .string()
            .describe('Current status, for example "running" or "stopped"'),
          uptime: z.number().optional().describe('Uptime in seconds'),
          config: z
            .record(z.any())
            .describe('The container configuration as Proxmox reports it'),
        }),
    },
    action: async ({ input }) => {
      const client = await clientFor(deps, input.connection);
      const guest = await readGuest(client, input.node, 'lxc', input.vmid);
      return {
        output: {
          ...guest,
          hostname: guest.config.hostname as string | undefined,
        },
      };
    },
  });
}
