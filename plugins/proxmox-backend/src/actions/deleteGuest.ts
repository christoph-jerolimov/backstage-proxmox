import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { ConflictError } from '@backstage/errors';
import { resolveProxmoxTask } from '../client/tasks';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  guestFields,
  guestPath,
  ProxmoxActionDeps,
  taskFields,
  taskOutputFields,
} from './helpers';

export function registerDeleteGuest(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'delete-guest',
    title: 'Delete Proxmox Guest',
    description:
      'Removes a Proxmox VM or LXC container. A running guest is only removed when stopIfRunning is set.',
    attributes: { readOnly: false, idempotent: false, destructive: true },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          ...guestFields(z),
          stopIfRunning: z
            .boolean()
            .optional()
            .default(false)
            .describe('Stop the guest first when it is running, instead of failing'),
          purge: z
            .boolean()
            .optional()
            .default(false)
            .describe('Also remove the guest from backup jobs and HA resource configuration'),
          ...taskFields(z),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number(),
          guestType: z.string(),
          ...taskOutputFields(z),
        }),
    },
    action: async ({ input, logger }) => {
      const client = await clientFor(deps, input.connection);
      const base = guestPath(input.node, input.guestType, input.vmid);

      const current = await client.get<{ status?: string }>(`${base}/status/current`);
      if (current?.status === 'running') {
        if (!input.stopIfRunning) {
          throw new ConflictError(
            `Proxmox guest ${input.vmid} on node ${input.node} is running; set stopIfRunning to stop it before deleting`,
          );
        }
        logger.info(`Stopping Proxmox guest ${input.vmid} before deleting it`);
        const stopTaskId = await client.post<string>(`${base}/status/stop`);
        await resolveProxmoxTask({
          client,
          node: input.node,
          taskId: stopTaskId,
          waitForCompletion: true,
          timeoutSeconds: input.timeoutSeconds,
          operation: `stopping guest ${input.vmid}`,
          sleep: deps.sleep,
        });
      }

      logger.info(`Deleting Proxmox guest ${input.vmid} on node ${input.node}`);
      const taskId = await client.delete<string>(
        base,
        input.purge ? { purge: true } : {},
      );

      const task = await resolveProxmoxTask({
        client,
        node: input.node,
        taskId,
        waitForCompletion: input.waitForCompletion,
        timeoutSeconds: input.timeoutSeconds,
        operation: `deleting guest ${input.vmid}`,
        sleep: deps.sleep,
      });

      return {
        output: {
          connectionTitle: client.connectionTitle,
          node: input.node,
          vmid: input.vmid,
          guestType: input.guestType,
          ...task,
        },
      };
    },
  });
}
