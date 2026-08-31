import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { ProxmoxClient } from '../client/ProxmoxClient';
import { resolveProxmoxTask } from '../client/tasks';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  definedOnly,
  guestPath,
  ProxmoxActionDeps,
  requireAtLeastOneField,
  taskFields,
  taskOutputFields,
} from './helpers';
import { addPoolMembers } from './poolMembers';

export function registerUpdateVmConfig(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'update-vm-config',
    title: 'Update Proxmox VM Configuration',
    description:
      'Changes the configuration of an existing Proxmox VM. Only the fields that are given are applied; everything else is left untouched.',
    attributes: { readOnly: false, idempotent: true, destructive: false },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          node: z.string().min(1).describe('Name of the Proxmox node'),
          vmid: z.number().int().min(100).describe('VMID of the VM to update'),
          name: z.string().optional().describe('New name for the VM'),
          cores: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('CPU cores per socket'),
          sockets: z.number().int().min(1).optional().describe('CPU sockets'),
          memory: z.number().int().min(16).optional().describe('Memory in MiB'),
          tags: z.string().optional().describe('Semicolon separated tags'),
          description: z
            .string()
            .optional()
            .describe('Description shown in Proxmox'),
          pool: z
            .string()
            .optional()
            .describe('Resource pool the VM should belong to'),
          ...taskFields(z),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number(),
          config: z
            .record(z.any())
            .describe('The VM configuration after the update'),
          ...taskOutputFields(z),
        }),
    },
    action: async ({ input, logger }) => {
      const changes = definedOnly({
        name: input.name,
        cores: input.cores,
        sockets: input.sockets,
        memory: input.memory,
        tags: input.tags,
        description: input.description,
      });
      requireAtLeastOneField(
        { ...changes, pool: input.pool },
        'proxmox:update-vm-config',
      );

      const client = await clientFor(deps, input.connection);
      const base = guestPath(input.node, 'qemu', input.vmid);

      let task = { taskId: '' } as Awaited<
        ReturnType<typeof resolveProxmoxTask>
      >;
      if (Object.keys(changes).length > 0) {
        logger.info(
          `Updating configuration of Proxmox VM ${input.vmid} on node ${input.node}`,
        );
        const taskId = await client.post<string>(`${base}/config`, changes);
        task = await resolveProxmoxTask({
          client,
          node: input.node,
          taskId,
          waitForCompletion: input.waitForCompletion,
          timeoutSeconds: input.timeoutSeconds,
          operation: `updating VM ${input.vmid}`,
          sleep: deps.sleep,
        });
      }

      if (input.pool) {
        // Pool membership is not part of the guest config endpoint.
        await addPoolMembers(client as ProxmoxClient, input.pool, [input.vmid]);
      }

      const config = await client.get<Record<string, unknown>>(
        `${base}/config`,
      );

      return {
        output: {
          connectionTitle: client.connectionTitle,
          node: input.node,
          vmid: input.vmid,
          config: config ?? {},
          ...task,
        },
      };
    },
  });
}
