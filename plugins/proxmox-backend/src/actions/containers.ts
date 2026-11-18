import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { resolveProxmoxTask } from '../client/tasks';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  containerFields,
  definedOnly,
  ProxmoxActionDeps,
  taskFields,
  taskOutputFields,
} from './helpers';
import {
  CONTAINER_POWER_STATES,
  deleteInstance,
  deleteOptionFields,
  deleteOutputFields,
  powerOutputFields,
  readInstance,
  resolveVmid,
  setPowerState,
} from './lifecycle';

/** Every action that acts on an LXC container. */
export function registerContainerActions(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
): void {
  registerGetContainer(actionsRegistry, deps);
  registerCreateContainer(actionsRegistry, deps);
  registerSetContainerPowerState(actionsRegistry, deps);
  registerDeleteContainer(actionsRegistry, deps);
}

function registerGetContainer(
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
      const container = await readInstance(
        client,
        input.node,
        'lxc',
        input.vmid,
      );
      return {
        output: {
          ...container,
          hostname: container.config.hostname as string | undefined,
        },
      };
    },
  });
}

function registerCreateContainer(
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

function registerSetContainerPowerState(
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
      output: z => z.object(powerOutputFields(z, 'container')),
    },
    action: async ({ input, logger }) => ({
      output: await setPowerState(
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

function registerDeleteContainer(
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
          ...deleteOptionFields(z, 'container'),
          ...taskFields(z),
        }),
      output: z => z.object(deleteOutputFields(z)),
    },
    action: async ({ input, logger }) => ({
      output: await deleteInstance(
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
