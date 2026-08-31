import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { registerCreateLxc } from './createLxc';
import { registerCreateVm } from './createVm';
import { registerDeleteGuest } from './deleteGuest';
import { registerGetGuest } from './getGuest';
import { ProxmoxActionDeps } from './helpers';
import { registerListNodes } from './listNodes';
import { registerCreatePool, registerUpdatePool } from './pools';
import { registerSetGuestPowerState } from './setGuestPowerState';
import { registerUpdateVmConfig } from './updateVmConfig';

export { type ProxmoxActionDeps } from './helpers';

/** Registers every Proxmox action in the actions registry. */
export function registerProxmoxActions(
  actionsRegistry: ActionsRegistryService,
  deps: ProxmoxActionDeps,
): void {
  registerListNodes(actionsRegistry, deps);
  registerGetGuest(actionsRegistry, deps);
  registerCreateVm(actionsRegistry, deps);
  registerUpdateVmConfig(actionsRegistry, deps);
  registerSetGuestPowerState(actionsRegistry, deps);
  registerDeleteGuest(actionsRegistry, deps);
  registerCreateLxc(actionsRegistry, deps);
  registerCreatePool(actionsRegistry, deps);
  registerUpdatePool(actionsRegistry, deps);
}

/** The names of the actions this plugin registers, without the plugin prefix. */
export const PROXMOX_ACTION_NAMES = [
  'list-nodes',
  'get-guest',
  'create-vm',
  'update-vm-config',
  'set-guest-power-state',
  'delete-guest',
  'create-lxc',
  'create-pool',
  'update-pool',
] as const;
