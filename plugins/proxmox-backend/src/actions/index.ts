import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { registerContainerActions } from './containers';
import { ProxmoxActionDeps } from './helpers';
import { registerListNodes } from './listNodes';
import {
  registerCreatePool,
  registerDeletePool,
  registerUpdatePool,
} from './pools';
import { registerVmActions } from './vms';
import { registerWaitForTasks } from './waitForTasks';

export { type ProxmoxActionDeps } from './helpers';

/** Registers every Proxmox action in the actions registry. */
export function registerProxmoxActions(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
): void {
  registerListNodes(actionsRegistry, deps);

  registerVmActions(actionsRegistry, deps);
  registerContainerActions(actionsRegistry, deps);

  registerCreatePool(actionsRegistry, deps);
  registerUpdatePool(actionsRegistry, deps);
  registerDeletePool(actionsRegistry, deps);

  registerWaitForTasks(actionsRegistry, deps);
}

/** The names of the actions this plugin registers, without the plugin prefix. */
export const PROXMOX_ACTION_NAMES = [
  'list-nodes',
  'get-vm',
  'create-vm',
  'update-vm-config',
  'set-vm-power-state',
  'delete-vm',
  'get-container',
  'create-container',
  'set-container-power-state',
  'delete-container',
  'create-pool',
  'update-pool',
  'delete-pool',
  'wait-for-tasks',
] as const;
