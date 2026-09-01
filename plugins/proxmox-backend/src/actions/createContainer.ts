import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { resolveProxmoxTask } from '../client/tasks';
import { resolveVmid } from './createVm';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  definedOnly,
  ProxmoxActionDeps,
  taskFields,
  taskOutputFields,
} from './helpers';

export function registerCreateContainer(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'create-container',
    title: 'Create Proxmox LXC Container',
    description:
      'Creates an LXC container on a Proxmox node from an OS template. When no VMID is given, the next free one is allocated.',
    attributes: { readOnly: false, idempotent: false, destructive: false },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          node: z
            .string()
            .min(1)
            .describe('Name of the Proxmox node, for example "pve"'),
          hostname: z.string().min(1).describe('Hostname of the new container'),
          ostemplate: z
            .string()
            .min(1)
            .describe(
              'OS template volume, for example "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst"',
            ),
          vmid: z
            .number()
            .int()
            .min(100)
            .optional()
            .describe(
              'VMID to use. Left out, the next free VMID is allocated.',
            ),
          cores: z.number().int().min(1).optional().describe('CPU cores'),
          memory: z.number().int().min(16).optional().describe('Memory in MiB'),
          swap: z.number().int().min(0).optional().describe('Swap in MiB'),
          storage: z
            .string()
            .optional()
            .describe('Storage for the root filesystem, for example "local"'),
          rootfsSize: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Root filesystem size in GiB. Requires storage.'),
          net0: z
            .string()
            .optional()
            .describe(
              'First network device, for example "name=eth0,bridge=vmbr0,ip=dhcp"',
            ),
          tags: z.string().optional().describe('Semicolon separated tags'),
          pool: z
            .string()
            .optional()
            .describe('Resource pool to add the container to'),
          unprivileged: z
            .boolean()
            .optional()
            .describe('Create an unprivileged container'),
          description: z
            .string()
            .optional()
            .describe('Description shown in Proxmox'),
          ...taskFields(z),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number().describe('VMID of the created container'),
          hostname: z.string(),
          ...taskOutputFields(z),
        }),
    },
    action: async ({ input, logger }) => {
      const client = await clientFor(deps, input.connection);
      const vmid = await resolveVmid(client, input.vmid);

      const rootfs =
        input.storage && input.rootfsSize
          ? `${input.storage}:${input.rootfsSize}`
          : input.storage;

      logger.info(
        `Creating Proxmox LXC container ${vmid} ("${input.hostname}") on node ${input.node}`,
      );

      const taskId = await client.post<string>(
        `/nodes/${encodeURIComponent(input.node)}/lxc`,
        definedOnly({
          vmid,
          hostname: input.hostname,
          ostemplate: input.ostemplate,
          cores: input.cores,
          memory: input.memory,
          swap: input.swap,
          rootfs,
          net0: input.net0,
          tags: input.tags,
          pool: input.pool,
          unprivileged: input.unprivileged,
          description: input.description,
        }),
      );

      const task = await resolveProxmoxTask({
        client,
        node: input.node,
        taskId,
        waitForCompletion: input.waitForCompletion,
        timeoutSeconds: input.timeoutSeconds,
        operation: `creating container ${vmid}`,
        sleep: deps.sleep,
      });

      return {
        output: {
          connectionTitle: client.connectionTitle,
          node: input.node,
          vmid,
          hostname: input.hostname,
          ...task,
        },
      };
    },
  });
}
