import { ConflictError } from '@backstage/errors';
import { ProxmoxClient } from '../client/ProxmoxClient';
import { resolveProxmoxTask } from '../client/tasks';
import {
  connectionOutputField,
  ProxmoxActionDeps,
  taskOutputFields,
  Zod,
} from './helpers';

/**
 * Operations VMs and LXC containers share.
 *
 * Proxmox addresses both through the same endpoints, differing only in one
 * path segment, so reading, powering and deleting are written once here and
 * used by both `vms.ts` and `containers.ts`. Each action keeps its own schema,
 * because that is where the two genuinely differ.
 */

/** The Proxmox API path segment for a kind of instance. */
export type ProxmoxKind = 'qemu' | 'lxc';

/** The API path of one VM or container. */
export function instancePath(node: string, kind: ProxmoxKind, vmid: number) {
  return `/nodes/${encodeURIComponent(node)}/${kind}/${vmid}`;
}

/**
 * Allocates a VMID, or verifies that the requested one is free.
 *
 * `/cluster/nextid` doubles as a validator: passing a `vmid` asks Proxmox
 * whether that id is available, which turns "already in use" into a clear
 * failure before anything is created.
 */
export async function resolveVmid(
  client: ProxmoxClient,
  requested: number | undefined,
): Promise<number> {
  if (requested === undefined) {
    const next = await client.get<string | number>('/cluster/nextid');
    return Number(next);
  }
  try {
    await client.get<string | number>('/cluster/nextid', { vmid: requested });
  } catch (error) {
    throw new ConflictError(
      `VMID ${requested} is already in use on this Proxmox instance`,
      error instanceof Error ? error : undefined,
    );
  }
  return requested;
}

type CurrentStatus = { status?: string; name?: string; uptime?: number };

/** Reads one instance's status and configuration. */
export async function readInstance(
  client: ProxmoxClient,
  node: string,
  kind: ProxmoxKind,
  vmid: number,
) {
  const base = instancePath(node, kind, vmid);
  const status = await client.get<CurrentStatus>(`${base}/status/current`);
  const config =
    (await client.get<Record<string, unknown>>(`${base}/config`)) ?? {};

  return {
    connectionTitle: client.connectionTitle,
    node,
    vmid,
    status: status?.status ?? 'unknown',
    uptime: status?.uptime,
    config,
  };
}

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

/** The Proxmox status a power state request converges on, when it has one. */
const TARGET_STATUS: Record<string, string | undefined> = {
  start: 'running',
  resume: 'running',
  stop: 'stopped',
  shutdown: 'stopped',
  suspend: 'paused',
  reboot: undefined,
};

type PowerInput = {
  node: string;
  vmid: number;
  state: string;
  waitForCompletion: boolean;
  timeoutSeconds: number;
};

/**
 * Brings a VM or container to a requested power state, short-circuiting when
 * it is already there.
 */
export async function setPowerState(
  client: ProxmoxClient,
  deps: ProxmoxActionDeps,
  kind: ProxmoxKind,
  label: string,
  input: PowerInput,
  logger: { info(message: string): void },
) {
  const base = instancePath(input.node, kind, input.vmid);
  const current = await client.get<CurrentStatus>(`${base}/status/current`);
  const target = TARGET_STATUS[input.state];

  if (target && current?.status === target) {
    logger.info(
      `Proxmox ${label} ${input.vmid} is already ${target}; nothing to do for "${input.state}"`,
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
    `Requesting "${input.state}" for Proxmox ${label} ${input.vmid} on node ${input.node}`,
  );
  const taskId = await client.post<string>(`${base}/status/${input.state}`);

  const task = await resolveProxmoxTask({
    client,
    node: input.node,
    taskId,
    waitForCompletion: input.waitForCompletion,
    timeoutSeconds: input.timeoutSeconds,
    operation: `${input.state} of ${label} ${input.vmid}`,
    sleep: deps.sleep,
  });

  const after = await client.get<CurrentStatus>(`${base}/status/current`);

  return {
    connectionTitle: client.connectionTitle,
    node: input.node,
    vmid: input.vmid,
    status: after?.status ?? target ?? 'unknown',
    changed: true,
    ...task,
  };
}

type DeleteInput = {
  node: string;
  vmid: number;
  stopIfRunning: boolean;
  purge: boolean;
  waitForCompletion: boolean;
  timeoutSeconds: number;
};

/**
 * Removes a VM or container, refusing a running one unless the caller asked
 * for it to be stopped first.
 */
export async function deleteInstance(
  client: ProxmoxClient,
  deps: ProxmoxActionDeps,
  kind: ProxmoxKind,
  label: string,
  input: DeleteInput,
  logger: { info(message: string): void },
) {
  const base = instancePath(input.node, kind, input.vmid);

  const current = await client.get<CurrentStatus>(`${base}/status/current`);
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

/** The options both delete actions accept. */
export function deleteOptionFields(z: Zod, label: string) {
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

/** The output both delete actions report. */
export function deleteOutputFields(z: Zod) {
  return {
    ...connectionOutputField(z),
    node: z.string(),
    vmid: z.number(),
    ...taskOutputFields(z),
  };
}

/** The output both power state actions report. */
export function powerOutputFields(z: Zod, label: string) {
  return {
    ...connectionOutputField(z),
    node: z.string(),
    vmid: z.number(),
    status: z.string().describe(`Status of the ${label} after the operation`),
    changed: z
      .boolean()
      .describe(`False when the ${label} was already in the requested state`),
    ...taskOutputFields(z),
  };
}
