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
import { addPoolMembers } from './poolMembers';


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
          poolid: z.string().min(1).describe('Id of the pool, for example "pool-dev"'),
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

      const pools = (await client.get<Array<{ poolid: string }>>('/pools')) ?? [];
      if (pools.some(pool => pool.poolid === input.poolid)) {
        throw new ConflictError(
          `Proxmox resource pool "${input.poolid}" already exists`,
        );
      }

      logger.info(`Creating Proxmox resource pool "${input.poolid}"`);
      await client.post('/pools', definedOnly({
        poolid: input.poolid,
        comment: input.comment,
      }));

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
          comment: z.string().optional().describe('Comment of the pool after the update'),
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
        logger.info(`Updating comment of Proxmox resource pool "${input.poolid}"`);
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
