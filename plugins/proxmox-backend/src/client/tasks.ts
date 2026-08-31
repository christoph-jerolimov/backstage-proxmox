import { ProxmoxClient } from './ProxmoxClient';

/** The status document Proxmox returns for a task. */
export type ProxmoxTaskStatus = {
  status: 'running' | 'stopped';
  exitstatus?: string;
  type?: string;
  node?: string;
};

/** The result of a Proxmox task, as reported in action outputs. */
export type ProxmoxTaskResult = {
  taskId: string;
  exitStatus?: string;
};

const INITIAL_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 5000;
const POLL_BACKOFF_FACTOR = 1.5;

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Waits for a Proxmox task to finish.
 *
 * Proxmox answers write requests with a task id (UPID) rather than a result,
 * so an action that returned as soon as the request was accepted would report
 * success for work that fails moments later. Polling until the task is
 * `stopped` and requiring an `OK` exit status is what makes a failed Proxmox
 * job a failed template step.
 */
export async function waitForProxmoxTask(options: {
  client: ProxmoxClient;
  node: string;
  taskId: string;
  timeoutSeconds: number;
  operation: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ProxmoxTaskResult> {
  const {
    client,
    node,
    taskId,
    timeoutSeconds,
    operation,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = options;

  const deadline = now() + timeoutSeconds * 1000;
  let interval = INITIAL_POLL_INTERVAL_MS;

  for (;;) {
    const status = await client.get<ProxmoxTaskStatus>(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(
        taskId,
      )}/status`,
    );

    if (status?.status === 'stopped') {
      if (status.exitstatus !== 'OK') {
        throw new Error(
          `Proxmox task ${taskId} for ${operation} failed with exit status "${
            status.exitstatus ?? 'unknown'
          }"`,
        );
      }
      return { taskId, exitStatus: status.exitstatus };
    }

    if (now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutSeconds}s waiting for Proxmox task ${taskId} (${operation}); the task may still be running and can be inspected in Proxmox`,
      );
    }

    await sleep(interval);
    interval = Math.min(
      Math.round(interval * POLL_BACKOFF_FACTOR),
      MAX_POLL_INTERVAL_MS,
    );
  }
}

/**
 * Normalizes the task id a Proxmox write endpoint returned, and waits for the
 * task unless the caller opted out.
 */
export async function resolveProxmoxTask(options: {
  client: ProxmoxClient;
  node: string;
  taskId: unknown;
  waitForCompletion: boolean;
  timeoutSeconds: number;
  operation: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ProxmoxTaskResult> {
  const { taskId, waitForCompletion, ...rest } = options;

  if (typeof taskId !== 'string' || !taskId) {
    // A few endpoints complete synchronously and return no UPID.
    return { taskId: '' };
  }
  if (!waitForCompletion) {
    return { taskId };
  }
  return waitForProxmoxTask({ ...rest, taskId });
}
