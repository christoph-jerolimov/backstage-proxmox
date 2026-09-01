import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { registerCreateContainer } from './createContainer';
import { registerCreateVm } from './createVm';
import { registerDeleteContainer, registerDeleteVm } from './deleteGuests';
import { ProxmoxActionDeps } from './helpers';
import { registerListNodes } from './listNodes';
import {
  registerCreatePool,
  registerDeletePool,
  registerUpdatePool,
} from './pools';
import {
  registerSetContainerPowerState,
  registerSetVmPowerState,
} from './powerState';
import { registerGetContainer, registerGetVm } from './readGuests';
import { registerUpdateVmConfig } from './updateVmConfig';
import { registerWaitForTasks } from './waitForTasks';

export { type ProxmoxActionDeps } from './helpers';

/** Registers every Proxmox action in the actions registry. */
export function registerProxmoxActions(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
): void {
  registerListNodes(actionsRegistry, deps);

  registerGetVm(actionsRegistry, deps);
  registerGetContainer(actionsRegistry, deps);

  registerCreateVm(actionsRegistry, deps);
  registerCreateContainer(actionsRegistry, deps);

  registerUpdateVmConfig(actionsRegistry, deps);

  registerSetVmPowerState(actionsRegistry, deps);
  registerSetContainerPowerState(actionsRegistry, deps);

  registerDeleteVm(actionsRegistry, deps);
  registerDeleteContainer(actionsRegistry, deps);

  registerCreatePool(actionsRegistry, deps);
  registerUpdatePool(actionsRegistry, deps);
  registerDeletePool(actionsRegistry, deps);

  registerWaitForTasks(actionsRegistry, deps);
}

/** The names of the actions this plugin registers, without the plugin prefix. */
export const PROXMOX_ACTION_NAMES = [
  'list-nodes',
  'get-vm',
  'get-container',
  'create-vm',
  'create-container',
  'update-vm-config',
  'set-vm-power-state',
  'set-container-power-state',
  'delete-vm',
  'delete-container',
  'create-pool',
  'update-pool',
  'delete-pool',
  'wait-for-tasks',
] as const;
