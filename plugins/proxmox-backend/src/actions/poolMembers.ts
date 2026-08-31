import { ProxmoxClient } from '../client/ProxmoxClient';

/** A pool as Proxmox reports it, with its members. */
export type ProxmoxPool = {
  comment?: string;
  members?: Array<{
    vmid?: number;
    storage?: string;
    type?: string;
    id?: string;
  }>;
};

/** Reads a pool, including its current members. */
export async function readPool(
  client: ProxmoxClient,
  poolid: string,
): Promise<ProxmoxPool> {
  return (
    (await client.get<ProxmoxPool>(`/pools/${encodeURIComponent(poolid)}`)) ??
    {}
  );
}

/**
 * Adds guests and storages to a pool, skipping the ones that already belong to
 * it. Proxmox rejects a request that re-adds an existing member, so filtering
 * first is what makes adding a member twice a no-op rather than a failure.
 */
export async function addPoolMembers(
  client: ProxmoxClient,
  poolid: string,
  vmids: number[] = [],
  storages: string[] = [],
): Promise<ProxmoxPool> {
  const pool = await readPool(client, poolid);
  const members = pool.members ?? [];

  const existingVmids = new Set(
    members.filter(m => typeof m.vmid === 'number').map(m => m.vmid as number),
  );
  const existingStorages = new Set(
    members
      .filter(m => typeof m.storage === 'string')
      .map(m => m.storage as string),
  );

  const newVmids = vmids.filter(vmid => !existingVmids.has(vmid));
  const newStorages = storages.filter(
    storage => !existingStorages.has(storage),
  );

  if (newVmids.length === 0 && newStorages.length === 0) {
    return pool;
  }

  await client.put(`/pools/${encodeURIComponent(poolid)}`, {
    ...(newVmids.length ? { vms: newVmids.join(',') } : {}),
    ...(newStorages.length ? { storage: newStorages.join(',') } : {}),
  });

  return readPool(client, poolid);
}
