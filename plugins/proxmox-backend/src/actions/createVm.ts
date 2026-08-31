import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { ConflictError } from '@backstage/errors';
import { ProxmoxClient } from '../client/ProxmoxClient';
import { resolveProxmoxTask } from '../client/tasks';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  definedOnly,
  ProxmoxActionDeps,
  taskFields,
  taskOutputFields,
} from './helpers';

/**
 * Allocates a VMID, or verifies that the requested one is free.
 *
 * `/cluster/nextid` doubles as a validator: passing a `vmid` asks Proxmox
 * whether that id is available, which turns "already in use" into a clear
 * failure before anything is created.
 */
export async function resolveVmid(
  client: ProxmoxClient,
  requested: number | undefined,
): Promise<number> {
  if (requested === undefined) {
    const next = await client.get<string | number>('/cluster/nextid');
    return Number(next);
  }
  try {
    await client.get<string | number>('/cluster/nextid', { vmid: requested });
  } catch (error) {
    throw new ConflictError(
      `VMID ${requested} is already in use on this Proxmox instance`,
      error instanceof Error ? error : undefined,
    );
  }
  return requested;
}

export function registerCreateVm(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'create-vm',
    title: 'Create Proxmox VM',
    description:
      'Creates a QEMU virtual machine on a Proxmox node. When no VMID is given, the next free one is allocated.',
    attributes: { readOnly: false, idempotent: false, destructive: false },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          node: z.string().min(1).describe('Name of the Proxmox node, for example "pve"'),
          name: z.string().min(1).describe('Name of the new VM'),
          vmid: z
            .number()
            .int()
            .min(100)
            .optional()
            .describe('VMID to use. Left out, the next free VMID is allocated.'),
          cores: z.number().int().min(1).optional().describe('CPU cores per socket'),
          sockets: z.number().int().min(1).optional().describe('CPU sockets'),
          memory: z.number().int().min(16).optional().describe('Memory in MiB'),
          ostype: z
            .string()
            .optional()
            .describe('Proxmox OS type, for example "l26" for Linux 6.x/5.x/4.x/3.x/2.6'),
          net0: z
            .string()
            .optional()
            .describe('First network device, for example "virtio,bridge=vmbr0"'),
          disk: z
            .string()
            .optional()
            .describe('First SCSI disk, for example "local:8" for an 8 GiB volume'),
          tags: z.string().optional().describe('Semicolon separated tags, for example "web;dev"'),
          pool: z.string().optional().describe('Resource pool to add the VM to'),
          description: z.string().optional().describe('Description shown in Proxmox'),
          ...taskFields(z),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number().describe('VMID of the created VM'),
          name: z.string(),
          ...taskOutputFields(z),
        }),
    },
    action: async ({ input, logger }) => {
      const client = await clientFor(deps, input.connection);
      const vmid = await resolveVmid(client, input.vmid);

      logger.info(`Creating Proxmox VM ${vmid} ("${input.name}") on node ${input.node}`);

      const taskId = await client.post<string>(
        `/nodes/${encodeURIComponent(input.node)}/qemu`,
        definedOnly({
          vmid,
          name: input.name,
          cores: input.cores,
          sockets: input.sockets,
          memory: input.memory,
          ostype: input.ostype,
          net0: input.net0,
          scsi0: input.disk,
          tags: input.tags,
          pool: input.pool,
          description: input.description,
        }),
      );

      const task = await resolveProxmoxTask({
        client,
        node: input.node,
        taskId,
        waitForCompletion: input.waitForCompletion,
        timeoutSeconds: input.timeoutSeconds,
        operation: `creating VM ${vmid}`,
        sleep: deps.sleep,
      });

      return {
        output: {
          connectionTitle: client.connectionTitle,
          node: input.node,
          vmid,
          name: input.name,
          ...task,
        },
      };
    },
  });
}
