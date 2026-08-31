import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { registerProxmoxActions } from './actions';
import { DefaultProxmoxConnectionsService } from './connections/ProxmoxConnectionsService';
import { resolveProxmoxConnections } from './connections/resolveConnections';

/**
 * The Proxmox backend plugin.
 *
 * Registering under its own plugin id is what gives the actions the
 * `proxmox:` namespace — the actions registry derives an action's id from the
 * id of the plugin that hosts it, so a module attached to another plugin would
 * publish its actions under that plugin's name instead.
 */
export const proxmoxPlugin = createBackendPlugin({
  pluginId: 'proxmox',
  register(env) {
    env.registerInit({
      deps: {
        actionsRegistry: actionsRegistryServiceRef,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ actionsRegistry, config, logger }) {
        const connections = resolveProxmoxConnections({ config, logger });
        if (connections.length === 0) {
          logger.info(
            'No Proxmox connection is configured; the Proxmox actions are registered but will fail until one is added to the "connections" config or to "proxmox.connections"',
          );
        } else {
          logger.info(
            `Registering Proxmox actions for ${connections.length} connection(s): ${connections
              .map(connection => connection.title)
              .join(', ')}`,
          );
        }

        registerProxmoxActions(actionsRegistry, {
          connections: DefaultProxmoxConnectionsService.create(connections),
          logger,
        });
      },
    });
  },
});
