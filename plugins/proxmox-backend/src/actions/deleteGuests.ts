import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { ConflictError } from '@backstage/errors';
import { ProxmoxClient } from '../client/ProxmoxClient';
import { resolveProxmoxTask } from '../client/tasks';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  containerFields,
  guestPath,
  ProxmoxActionDeps,
  taskFields,
  taskOutputFields,
  vmFields,
} from './helpers';

type DeleteInput = {
  connection?: string;
  node: string;
  vmid: number;
  stopIfRunning: boolean;
  purge: boolean;
  waitForCompletion: boolean;
  timeoutSeconds: number;
};

/**
 * Removes a guest, refusing a running one unless the caller asked for it to be
 * stopped first. Shared by the VM and container actions, which differ only in
 * the API path segment and the wording.
 */
async function deleteGuest(
  client: ProxmoxClient,
  deps: ProxmoxActionDeps,
  guestType: 'qemu' | 'lxc',
  label: string,
  input: DeleteInput,
  logger: { info(message: string): void },
) {
  const base = guestPath(input.node, guestType, input.vmid);

  const current = await client.get<{ status?: string }>(`${base}/status/current`);
  if (current?.status === 'running') {
    if (!input.stopIfRunning) {
      throw new ConflictError(
        `Proxmox ${label} ${input.vmid} on node ${input.node} is running; set stopIfRunning to stop it before deleting`,
      );
    }
    logger.info(`Stopping Proxmox ${label} ${input.vmid} before deleting it`);
    const stopTaskId = await client.post<string>(`${base}/status/stop`);
    await resolveProxmoxTask({
      client,
      node: input.node,
      taskId: stopTaskId,
      waitForCompletion: true,
      timeoutSeconds: input.timeoutSeconds,
      operation: `stopping ${label} ${input.vmid}`,
      sleep: deps.sleep,
    });
  }

  logger.info(`Deleting Proxmox ${label} ${input.vmid} on node ${input.node}`);
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
    operation: `deleting ${label} ${input.vmid}`,
    sleep: deps.sleep,
  });

  return {
    connectionTitle: client.connectionTitle,
    node: input.node,
    vmid: input.vmid,
    ...task,
  };
}

function deleteOptions(z: Parameters<typeof connectionOutputField>[0], label: string) {
  return {
    stopIfRunning: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        `Stop the ${label} first when it is running, instead of failing`,
      ),
    purge: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Also remove it from backup jobs and HA resource configuration',
      ),
  };
}

function deleteOutput(z: Parameters<typeof connectionOutputField>[0]) {
  return {
    ...connectionOutputField(z),
    node: z.string(),
    vmid: z.number(),
    ...taskOutputFields(z),
  };
}

export function registerDeleteVm(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'delete-vm',
    title: 'Delete Proxmox VM',
    description:
      'Removes a Proxmox QEMU virtual machine. A running VM is only removed when stopIfRunning is set.',
    attributes: { readOnly: false, idempotent: false, destructive: true },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          ...vmFields(z),
          ...deleteOptions(z, 'VM'),
          ...taskFields(z),
        }),
      output: z => z.object(deleteOutput(z)),
    },
    action: async ({ input, logger }) => ({
      output: await deleteGuest(
        await clientFor(deps, input.connection),
        deps,
        'qemu',
        'VM',
        input,
        logger,
      ),
    }),
  });
}

export function registerDeleteContainer(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'delete-container',
    title: 'Delete Proxmox Container',
    description:
      'Removes a Proxmox LXC container. A running container is only removed when stopIfRunning is set.',
    attributes: { readOnly: false, idempotent: false, destructive: true },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          ...containerFields(z),
          ...deleteOptions(z, 'container'),
          ...taskFields(z),
        }),
      output: z => z.object(deleteOutput(z)),
    },
    action: async ({ input, logger }) => ({
      output: await deleteGuest(
        await clientFor(deps, input.connection),
        deps,
        'lxc',
        'container',
        input,
        logger,
      ),
    }),
  });
}
