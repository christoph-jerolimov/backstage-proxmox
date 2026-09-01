import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { InputError } from '@backstage/errors';
import { ProxmoxClient } from '../client/ProxmoxClient';
import { nodeFromTaskId, waitForProxmoxTask } from '../client/tasks';
import {
  clientFor,
  connectionField,
  connectionOutputField,
  ProxmoxActionDeps,
} from './helpers';

/** How many tasks are polled at once, so a long list stays well behaved. */
const MAX_CONCURRENT_POLLS = 8;

type Outcome =
  | { taskId: string; node: string; exitStatus: string }
  | { taskId: string; node: string; error: Error };

/** Runs `work` over `items`, at most `limit` at a time. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) {
          return;
        }
        results[index] = await work(items[index]);
      }
    })(),
  );

  await Promise.all(workers);
  return results;
}

export function registerWaitForTasks(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
) {
  actionsRegistry.register({
    name: 'wait-for-tasks',
    title: 'Wait for Proxmox Tasks',
    description: [
      'Waits for a list of Proxmox tasks (UPIDs) to finish, and fails unless every one of them succeeded.',
      'Use it to start several operations with waitForCompletion disabled and await them all in one step.',
      'The node each task ran on is read from its task id.',
    ].join(' '),
    // Polling task status changes nothing, which also makes this dry-run safe.
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z =>
        z.object({
          ...connectionField(z),
          taskIds: z
            .array(z.string())
            .optional()
            .default([])
            .describe(
              'Proxmox task ids to wait for. An empty list succeeds without doing anything, so a dry run of a template whose create steps were skipped still passes.',
            ),
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(3600)
            .optional()
            .default(600)
            .describe('How long to wait for all of the tasks together'),
        }),
      output: z =>
        z.object({
          ...connectionOutputField(z),
          tasks: z
            .array(
              z.object({
                taskId: z.string(),
                node: z.string().describe('Node the task ran on'),
                exitStatus: z.string().describe('Exit status Proxmox reported'),
              }),
            )
            .describe('One entry per awaited task, in the order given'),
        }),
    },
    action: async ({ input, logger }) => {
      // Duplicates would be polled and reported twice for no benefit.
      const taskIds = [...new Set(input.taskIds)];

      if (taskIds.length === 0) {
        // No connection is resolved: with nothing to poll there is nothing to
        // connect to, and this is the path a dry run takes once the create
        // steps that would have produced task ids are skipped.
        logger.info('No Proxmox tasks to wait for');
        return { output: { connectionTitle: '', tasks: [] } };
      }

      const malformed = taskIds.filter(taskId => !nodeFromTaskId(taskId));
      if (malformed.length > 0) {
        throw new InputError(
          `Not a Proxmox task id: ${malformed
            .map(taskId => `"${taskId}"`)
            .join(', ')}. Task ids look like "UPID:<node>:...", as returned by the Proxmox actions.`,
        );
      }

      const client: ProxmoxClient = await clientFor(deps, input.connection);
      logger.info(
        `Waiting for ${taskIds.length} Proxmox task${
          taskIds.length === 1 ? '' : 's'
        }`,
      );

      // One shared deadline: the timeout is wall-clock for the whole set, not
      // per task multiplied by the length of the list.
      const now = () => Date.now();
      const deadline = now() + input.timeoutSeconds * 1000;

      const outcomes = await mapWithLimit<string, Outcome>(
        taskIds,
        MAX_CONCURRENT_POLLS,
        async taskId => {
          const node = nodeFromTaskId(taskId)!;
          try {
            const result = await waitForProxmoxTask({
              client,
              node,
              taskId,
              timeoutSeconds: Math.max(
                1,
                Math.ceil((deadline - now()) / 1000),
              ),
              operation: `awaiting task ${taskId}`,
              sleep: deps.sleep,
            });
            return { taskId, node, exitStatus: result.exitStatus ?? 'OK' };
          } catch (error) {
            // Collected rather than thrown, so every failure is reported
            // instead of only the first task to reject.
            return { taskId, node, error: error as Error };
          }
        },
      );

      const failures = outcomes.filter(
        (outcome): outcome is Extract<Outcome, { error: Error }> =>
          'error' in outcome,
      );
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} of ${taskIds.length} Proxmox task${
            taskIds.length === 1 ? '' : 's'
          } did not succeed:\n${failures
            .map(failure => `  - ${failure.taskId}: ${failure.error.message}`)
            .join('\n')}`,
        );
      }

      return {
        output: {
          connectionTitle: client.connectionTitle,
          tasks: outcomes as Array<{
            taskId: string;
            node: string;
            exitStatus: string;
          }>,
        },
      };
    },
  });
}
