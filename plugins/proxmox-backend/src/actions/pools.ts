import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { ConflictError } from '@backstage/errors';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  definedOnly,
  ProxmoxActionDeps,
  requireAtLeastOneField,
} from './helpers';
import { addPoolMembers, readPool } from './poolMembers';

export function registerCreatePool(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'create-pool',
    title: 'Create Proxmox Resource Pool',
    description: 'Creates a Proxmox resource pool.',
    attributes: { readOnly: false, idempotent: false, destructive: false },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          poolid: z
            .string()
            .min(1)
            .describe('Id of the pool, for example "pool-dev"'),
          comment: z.string().optional().describe('Comment shown in Proxmox'),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          poolid: z.string(),
        }),
    },
    action: async ({ input, logger }) => {
      const client = await clientFor(deps, input.connection);

      const pools =
        (await client.get<Array<{ poolid: string }>>('/pools')) ?? [];
      if (pools.some(pool => pool.poolid === input.poolid)) {
        throw new ConflictError(
          `Proxmox resource pool "${input.poolid}" already exists`,
        );
      }

      logger.info(`Creating Proxmox resource pool "${input.poolid}"`);
      await client.post(
        '/pools',
        definedOnly({
          poolid: input.poolid,
          comment: input.comment,
        }),
      );

      return {
        output: {
          connectionTitle: client.connectionTitle,
          poolid: input.poolid,
        },
      };
    },
  });
}

export function registerUpdatePool(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'update-pool',
    title: 'Update Proxmox Resource Pool',
    description:
      'Changes the comment of a Proxmox resource pool and adds VMs or storages to it. Members that already belong to the pool are left alone.',
    attributes: { readOnly: false, idempotent: true, destructive: false },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          poolid: z.string().min(1).describe('Id of the pool to update'),
          comment: z.string().optional().describe('New comment for the pool'),
          vms: z
            .array(z.number().int().min(100))
            .optional()
            .describe('VMIDs of guests to add to the pool'),
          storages: z
            .array(z.string().min(1))
            .optional()
            .describe('Names of storages to add to the pool'),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          poolid: z.string(),
          comment: z
            .string()
            .optional()
            .describe('Comment of the pool after the update'),
          members: z
            .array(
              z.object({
                vmid: z.number().optional(),
                storage: z.string().optional(),
                type: z.string().optional(),
              }),
            )
            .describe('Members of the pool after the update'),
        }),
    },
    action: async ({ input, logger }) => {
      requireAtLeastOneField(
        {
          comment: input.comment,
          vms: input.vms?.length ? input.vms : undefined,
          storages: input.storages?.length ? input.storages : undefined,
        },
        'proxmox:update-pool',
      );

      const client = await clientFor(deps, input.connection);

      if (input.comment !== undefined) {
        logger.info(
          `Updating comment of Proxmox resource pool "${input.poolid}"`,
        );
        await client.put(`/pools/${encodeURIComponent(input.poolid)}`, {
          comment: input.comment,
        });
      }

      const pool = await addPoolMembers(
        client,
        input.poolid,
        input.vms ?? [],
        input.storages ?? [],
      );
      return {
        output: {
          connectionTitle: client.connectionTitle,
          poolid: input.poolid,
          comment: pool.comment,
          members: (pool.members ?? []).map(member => ({
            vmid: member.vmid,
            storage: member.storage,
            type: member.type,
          })),
        },
      };
    },
  });
}

export function registerDeletePool(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'delete-pool',
    title: 'Delete Proxmox Resource Pool',
    description:
      'Removes a Proxmox resource pool. The pool must be empty, unless removeMembers is set. The member VMs, containers and storages themselves are never deleted.',
    attributes: { readOnly: false, idempotent: false, destructive: true },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          poolid: z.string().min(1).describe('Id of the pool to remove'),
          removeMembers: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              'Detach the pool members first instead of failing. The guests and storages themselves are not deleted.',
            ),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          poolid: z.string(),
          removedMembers: z
            .array(z.string())
            .describe('Members that were detached from the pool before it was removed'),
        }),
    },
    action: async ({ input, logger }) => {
      const client = await clientFor(deps, input.connection);

      // Proxmox refuses to delete a pool that still has members, so the
      // members are read first to fail with a message that names them.
      const pool = await readPool(client, input.poolid);
      const members = pool.members ?? [];
      const memberLabels = members.map(member =>
        typeof member.vmid === 'number'
          ? `guest ${member.vmid}`
          : `storage ${member.storage}`,
      );

      if (memberLabels.length > 0 && !input.removeMembers) {
        throw new ConflictError(
          `Proxmox resource pool "${input.poolid}" still has ${
            memberLabels.length
          } member(s): ${memberLabels.join(
            ', ',
          )}. Set removeMembers to detach them, which does not delete them.`,
        );
      }

      if (memberLabels.length > 0) {
        logger.info(
          `Detaching ${memberLabels.length} member(s) from Proxmox resource pool "${input.poolid}"`,
        );
        const vms = members
          .filter(member => typeof member.vmid === 'number')
          .map(member => member.vmid)
          .join(',');
        const storage = members
          .filter(member => typeof member.storage === 'string')
          .map(member => member.storage)
          .join(',');
        await client.put(`/pools/${encodeURIComponent(input.poolid)}`, {
          ...(vms ? { vms } : {}),
          ...(storage ? { storage } : {}),
          delete: true,
        });
      }

      logger.info(`Deleting Proxmox resource pool "${input.poolid}"`);
      await client.delete(`/pools/${encodeURIComponent(input.poolid)}`);

      return {
        output: {
          connectionTitle: client.connectionTitle,
          poolid: input.poolid,
          removedMembers: memberLabels,
        },
      };
    },
  });
}
