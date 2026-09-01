import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
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

/** Power states a QEMU VM accepts. */
export const VM_POWER_STATES = [
  'start',
  'stop',
  'shutdown',
  'reboot',
  'suspend',
  'resume',
] as const;

/** Power states an LXC container accepts. Proxmox has no suspend or resume. */
export const CONTAINER_POWER_STATES = [
  'start',
  'stop',
  'shutdown',
  'reboot',
] as const;

/** The Proxmox status a state request converges on, when it has one. */
const TARGET_STATUS: Record<string, string | undefined> = {
  start: 'running',
  resume: 'running',
  stop: 'stopped',
  shutdown: 'stopped',
  suspend: 'paused',
  reboot: undefined,
};

type PowerInput = {
  connection?: string;
  node: string;
  vmid: number;
  state: string;
  waitForCompletion: boolean;
  timeoutSeconds: number;
};

/**
 * Brings a guest to a requested power state, short-circuiting when it is
 * already there. Shared by the VM and container actions, which differ only in
 * the states they accept and the API path segment.
 */
async function setPowerState(
  client: ProxmoxClient,
  deps: ProxmoxActionDeps,
  guestType: 'qemu' | 'lxc',
  input: PowerInput,
  logger: { info(message: string): void },
) {
  const base = guestPath(input.node, guestType, input.vmid);
  const current = await client.get<{ status?: string }>(
    `${base}/status/current`,
  );
  const target = TARGET_STATUS[input.state];

  if (target && current?.status === target) {
    logger.info(
      `Proxmox guest ${input.vmid} is already ${target}; nothing to do for "${input.state}"`,
    );
    return {
      connectionTitle: client.connectionTitle,
      node: input.node,
      vmid: input.vmid,
      status: target,
      changed: false,
      taskId: '',
    };
  }

  logger.info(
    `Requesting "${input.state}" for Proxmox guest ${input.vmid} on node ${input.node}`,
  );
  const taskId = await client.post<string>(`${base}/status/${input.state}`);

  const task = await resolveProxmoxTask({
    client,
    node: input.node,
    taskId,
    waitForCompletion: input.waitForCompletion,
    timeoutSeconds: input.timeoutSeconds,
    operation: `${input.state} of guest ${input.vmid}`,
    sleep: deps.sleep,
  });

  const after = await client.get<{ status?: string }>(`${base}/status/current`);

  return {
    connectionTitle: client.connectionTitle,
    node: input.node,
    vmid: input.vmid,
    status: after?.status ?? target ?? 'unknown',
    changed: true,
    ...task,
  };
}

function powerOutput(z: Parameters<typeof connectionOutputField>[0]) {
  return {
    ...connectionOutputField(z),
    node: z.string(),
    vmid: z.number(),
    status: z.string().describe('Status of the guest after the operation'),
    changed: z
      .boolean()
      .describe('False when the guest was already in the requested state'),
    ...taskOutputFields(z),
  };
}

export function registerSetVmPowerState(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'set-vm-power-state',
    title: 'Set Proxmox VM Power State',
    description:
      'Starts, stops, shuts down, reboots, suspends or resumes a Proxmox QEMU virtual machine.',
    // Interrupting a running workload is destructive even though nothing is removed.
    attributes: { readOnly: false, idempotent: false, destructive: true },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          ...vmFields(z),
          state: z
            .enum(VM_POWER_STATES)
            .describe('The power state to bring the VM to'),
          ...taskFields(z),
        }),
      output: z => z.object(powerOutput(z)),
    },
    action: async ({ input, logger }) => ({
      output: await setPowerState(
        await clientFor(deps, input.connection),
        deps,
        'qemu',
        input,
        logger,
      ),
    }),
  });
}

export function registerSetContainerPowerState(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'set-container-power-state',
    title: 'Set Proxmox Container Power State',
    description:
      'Starts, stops, shuts down or reboots a Proxmox LXC container. Proxmox does not support suspending or resuming containers.',
    attributes: { readOnly: false, idempotent: false, destructive: true },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          ...containerFields(z),
          state: z
            .enum(CONTAINER_POWER_STATES)
            .describe('The power state to bring the container to'),
          ...taskFields(z),
        }),
      output: z => z.object(powerOutput(z)),
    },
    action: async ({ input, logger }) => ({
      output: await setPowerState(
        await clientFor(deps, input.connection),
        deps,
        'lxc',
        input,
        logger,
      ),
    }),
  });
}
