import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  guestFields,
  guestPath,
  ProxmoxActionDeps,
} from './helpers';

type GuestStatus = { status?: string; name?: string; uptime?: number };

export function registerGetGuest(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'get-guest',
    title: 'Get Proxmox Guest',
    description:
      'Reads the configuration and current status of a Proxmox VM or LXC container.',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z => z.object({ ...connectionField(z), ...guestFields(z) }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number(),
          guestType: z.string(),
          name: z.string().optional().describe('VM name or container hostname'),
          status: z
            .string()
            .describe('Current status, for example "running" or "stopped"'),
          uptime: z.number().optional().describe('Uptime in seconds'),
          config: z
            .record(z.any())
            .describe('The guest configuration as Proxmox reports it'),
        }),
    },
    action: async ({ input }) => {
      const client = await clientFor(deps, input.connection);
      const base = guestPath(input.node, input.guestType, input.vmid);

      const status = await client.get<GuestStatus>(`${base}/status/current`);
      const config = await client.get<Record<string, unknown>>(
        `${base}/config`,
      );

      return {
        output: {
          connectionTitle: client.connectionTitle,
          node: input.node,
          vmid: input.vmid,
          guestType: input.guestType,
          name:
            (config?.name as string | undefined) ??
            (config?.hostname as string | undefined) ??
            status?.name,
          status: status?.status ?? 'unknown',
          uptime: status?.uptime,
          config: config ?? {},
        },
      };
    },
  });
}
