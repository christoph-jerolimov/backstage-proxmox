import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  ProxmoxActionDeps,
} from './helpers';

type NodeEntry = {
  node: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
};

export function registerListNodes(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'list-nodes',
    title: 'List Proxmox Nodes',
    description:
      'Lists the nodes of a Proxmox VE cluster with their status and resource usage.',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z => z.object({ ...connectionField(z) }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          nodes: z.array(
            z.object({
              node: z.string().describe('Name of the node'),
              status: z.string().describe('Node status, for example "online"'),
              cpu: z
                .number()
                .optional()
                .describe('Current CPU usage as a fraction'),
              maxcpu: z.number().optional().describe('Number of CPUs'),
              mem: z.number().optional().describe('Used memory in bytes'),
              maxmem: z.number().optional().describe('Total memory in bytes'),
              uptime: z.number().optional().describe('Uptime in seconds'),
            }),
          ),
        }),
    },
    action: async ({ input }) => {
      const client = await clientFor(deps, input.connection);
      const nodes = (await client.get<NodeEntry[]>('/nodes')) ?? [];
      return {
        output: {
          connectionTitle: client.connectionTitle,
          nodes: nodes.map(node => ({
            node: node.node,
            status: node.status ?? 'unknown',
            cpu: node.cpu,
            maxcpu: node.maxcpu,
            mem: node.mem,
            maxmem: node.maxmem,
            uptime: node.uptime,
          })),
        },
      };
    },
  });
}
