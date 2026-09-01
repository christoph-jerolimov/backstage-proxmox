import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { ProxmoxClient } from '../client/ProxmoxClient';
import { resolveProxmoxTask } from '../client/tasks';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  definedOnly,
  ProxmoxActionDeps,
  requireAtLeastOneField,
  taskFields,
  taskOutputFields,
  vmFields,
} from './helpers';
import {
  deleteInstance,
  deleteOptionFields,
  deleteOutputFields,
  instancePath,
  powerOutputFields,
  readInstance,
  resolveVmid,
  setPowerState,
  VM_POWER_STATES,
} from './lifecycle';
import { addPoolMembers } from './poolMembers';

/** Every action that acts on a QEMU virtual machine. */
export function registerVmActions(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
): void {
  registerGetVm(actionsRegistry, deps);
  registerCreateVm(actionsRegistry, deps);
  registerUpdateVmConfig(actionsRegistry, deps);
  registerSetVmPowerState(actionsRegistry, deps);
  registerDeleteVm(actionsRegistry, deps);
}

function registerGetVm(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'get-vm',
    title: 'Get Proxmox VM',
    description:
      'Reads the configuration and current status of a Proxmox QEMU virtual machine.',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z => z.object({ ...connectionField(z), ...vmFields(z) }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          node: z.string(),
          vmid: z.number(),
          name: z.string().optional().describe('Name of the virtual machine'),
          status: z
            .string()
            .describe('Current status, for example "running" or "stopped"'),
          uptime: z.number().optional().describe('Uptime in seconds'),
          config: z
            .record(z.any())
            .describe('The VM configuration as Proxmox reports it'),
        }),
    },
    action: async ({ input }) => {
      const client = await clientFor(deps, input.connection);
      const vm = await readInstance(client, input.node, 'qemu', input.vmid);
      return {
        output: { ...vm, name: vm.config.name as string | undefined },
      };
    },
  });
}

function registerCreateVm(
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
          node: z
            .string()
            .min(1)
            .describe('Name of the Proxmox node, for example "pve"'),
          name: z.string().min(1).describe('Name of the new VM'),
          vmid: z
            .number()
            .int()
            .min(100)
            .optional()
            .describe(
              'VMID to use. Left out, the next free VMID is allocated.',
            ),
          cores: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('CPU cores per socket'),
          sockets: z.number().int().min(1).optional().describe('CPU sockets'),
          memory: z.number().int().min(16).optional().describe('Memory in MiB'),
          ostype: z
            .string()
            .optional()
            .describe(
              'Proxmox OS type, for example "l26" for Linux 6.x/5.x/4.x/3.x/2.6',
            ),
          net0: z
            .string()
            .optional()
            .describe(
              'First network device, for example "virtio,bridge=vmbr0"',
            ),
          disk: z
            .string()
            .optional()
            .describe(
              'First SCSI disk, for example "local:8" for an 8 GiB volume',
            ),
          tags: z
            .string()
            .optional()
            .describe('Semicolon separated tags, for example "web;dev"'),
          pool: z
            .string()
            .optional()
            .describe('Resource pool to add the VM to'),
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
          vmid: z.number().describe('VMID of the created VM'),
          name: z.string(),
          ...taskOutputFields(z),
        }),
    },
    action: async ({ input, logger }) => {
      const client = await clientFor(deps, input.connection);
      const vmid = await resolveVmid(client, input.vmid);

      logger.info(
        `Creating Proxmox VM ${vmid} ("${input.name}") on node ${input.node}`,
      );

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

function registerUpdateVmConfig(
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
      const base = instancePath(input.node, 'qemu', input.vmid);

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
        // Pool membership is not part of the VM config endpoint.
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

function registerSetVmPowerState(
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
      output: z => z.object(powerOutputFields(z, 'VM')),
    },
    action: async ({ input, logger }) => ({
      output: await setPowerState(
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

function registerDeleteVm(
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
          ...deleteOptionFields(z, 'VM'),
          ...taskFields(z),
        }),
      output: z => z.object(deleteOutputFields(z)),
    },
    action: async ({ input, logger }) => ({
      output: await deleteInstance(
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
