import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
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

const POWER_STATES = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume'] as const;

type PowerState = (typeof POWER_STATES)[number];

/** The Proxmox status a state request converges on, when it has one. */
const TARGET_STATUS: Partial<Record<PowerState, string>> = {
  start: 'running',
  resume: 'running',
  stop: 'stopped',
  shutdown: 'stopped',
  suspend: 'paused',
};

export function registerSetGuestPowerState(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'set-guest-power-state',
    title: 'Set Proxmox Guest Power State',
    description:
      'Starts, stops, shuts down, reboots, suspends or resumes a Proxmox VM or LXC container.',
    // Interrupting a running workload is destructive even though nothing is removed.
    attributes: { readOnly: false, idempotent: false, destructive: true },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          ...guestFields(z),
          state: z
            .enum(POWER_STATES)
            .describe('The power state to bring the guest to'),
          ...taskFields(z),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number(),
          guestType: z.string(),
          status: z.string().describe('Status of the guest after the operation'),
          changed: z
            .boolean()
            .describe('False when the guest was already in the requested state'),
          ...taskOutputFields(z),
        }),
    },
    action: async ({ input, logger }) => {
      const client = await clientFor(deps, input.connection);
      const base = guestPath(input.node, input.guestType, input.vmid);

      const current = await client.get<{ status?: string }>(`${base}/status/current`);
      const target = TARGET_STATUS[input.state as PowerState];

      if (target && current?.status === target) {
        logger.info(
          `Proxmox guest ${input.vmid} is already ${target}; nothing to do for "${input.state}"`,
        );
        return {
          output: {
            connectionTitle: client.connectionTitle,
            node: input.node,
            vmid: input.vmid,
            guestType: input.guestType,
            status: target,
            changed: false,
            taskId: '',
          },
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
        output: {
          connectionTitle: client.connectionTitle,
          node: input.node,
          vmid: input.vmid,
          guestType: input.guestType,
          status: after?.status ?? target ?? 'unknown',
          changed: true,
          ...task,
        },
      };
    },
  });
}
