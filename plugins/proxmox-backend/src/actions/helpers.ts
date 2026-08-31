import { LoggerService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import { z as zod3 } from 'zod/v3';
import { ProxmoxClient } from '../client/ProxmoxClient';
import {
  ProxmoxConnectionQuery,
  ProxmoxConnectionsService,
  SelectedProxmoxConnection,
} from '../connections/ProxmoxConnectionsService';

/** The zod instance the actions registry hands to schema builders. */
export type Zod = typeof zod3;

/** Everything the action implementations need from the plugin. */
export type ProxmoxActionDeps = {
  connections: ProxmoxConnectionsService;
  logger: LoggerService;
  /** Overridable so tests can supply a client backed by a fake fetch. */
  createClient?: (options: {
    connection: SelectedProxmoxConnection;
    logger: LoggerService;
  }) => ProxmoxClient;
  /** Overridable so tests do not have to wait for real poll intervals. */
  sleep?: (ms: number) => Promise<void>;
};

/** The auth methods every action accepts, in order of preference. */
export const ACCEPTED_AUTH_METHODS = ['token', 'password'] as const;

/**
 * Turns the free-form `connection` action input into a connection query. A
 * full URL is looked up by host, anything else by title (the lookup falls back
 * to the host so a bare `host:port` also works).
 */
export function connectionQuery(selector?: string): ProxmoxConnectionQuery {
  if (!selector) {
    return {};
  }
  return selector.includes('://') ? { url: selector } : { title: selector };
}

/** Resolves the connection named by an action input and builds a client for it. */
export async function clientFor(
  deps: ProxmoxActionDeps,
  selector?: string,
): Promise<ProxmoxClient> {
  const connection = await deps.connections.find({
    type: 'proxmox',
    query: connectionQuery(selector),
    authMethods: ACCEPTED_AUTH_METHODS,
  });
  const create =
    deps.createClient ??
    (options => ProxmoxClient.create({ ...options, logger: options.logger }));
  return create({ connection, logger: deps.logger });
}

/** The `connection` input every action accepts. */
export function connectionField(z: Zod) {
  return {
    connection: z
      .string()
      .optional()
      .describe(
        'Title or host of the Proxmox connection to use. Optional when exactly one connection is configured.',
      ),
  };
}

/** The task-waiting inputs every write action accepts. */
export function taskFields(z: Zod) {
  return {
    waitForCompletion: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Wait for the Proxmox task to finish and fail if it does not succeed. Disable to return as soon as Proxmox accepts the request.',
      ),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .default(300)
      .describe('How long to wait for the Proxmox task to finish'),
  };
}

/** The fields that identify a guest. */
export function guestFields(z: Zod) {
  return {
    node: z.string().min(1).describe('Name of the Proxmox node, for example "pve"'),
    vmid: z.number().int().min(100).describe('Numeric id of the VM or container'),
    guestType: z
      .enum(['qemu', 'lxc'])
      .describe('Whether the guest is a QEMU VM ("qemu") or an LXC container ("lxc")'),
  };
}

/** The task fields every write action reports. */
export function taskOutputFields(z: Zod) {
  return {
    taskId: z
      .string()
      .describe('Proxmox task id (UPID); empty when the operation was synchronous'),
    exitStatus: z
      .string()
      .optional()
      .describe('Exit status Proxmox reported for the task, when it was awaited'),
  };
}

/** The connection title every action reports. */
export function connectionOutputField(z: Zod) {
  return {
    connectionTitle: z
      .string()
      .describe('Title of the Proxmox connection the action acted on'),
  };
}

/** Drops `undefined` entries so blank template parameters are not sent. */
export function definedOnly<T extends Record<string, unknown>>(params: T): T {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  ) as T;
}

/** Fails when an update action was given nothing to change. */
export function requireAtLeastOneField(
  params: Record<string, unknown>,
  actionName: string,
): void {
  if (Object.keys(definedOnly(params)).length === 0) {
    throw new InputError(
      `${actionName} requires at least one configuration field to update`,
    );
  }
}

/** The Proxmox API path segment for a guest type. */
export function guestPath(node: string, guestType: 'qemu' | 'lxc', vmid: number) {
  return `/nodes/${encodeURIComponent(node)}/${guestType}/${vmid}`;
}
