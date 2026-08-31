import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import { proxmoxPlugin } from './plugin';

describe('proxmoxPlugin', () => {
  it('starts without a Proxmox connection configured', async () => {
    await expect(
      startTestBackend({
        features: [proxmoxPlugin, mockServices.rootConfig.factory({ data: {} })],
      }),
    ).resolves.toBeDefined();
  });

  it('starts with a connection configured', async () => {
    await expect(
      startTestBackend({
        features: [
          proxmoxPlugin,
          mockServices.rootConfig.factory({
            data: {
              connections: [
                {
                  type: 'proxmox',
                  title: 'Dev Proxmox',
                  baseUrl: 'https://localhost:8006',
                  skipTlsVerify: true,
                  auth: [
                    {
                      method: 'token',
                      tokenId: 'root@pam!full-access',
                      secret: '00000000-0000-4000-8000-000000000001',
                    },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('fails to start when a Proxmox connection is invalid', async () => {
    await expect(
      startTestBackend({
        features: [
          proxmoxPlugin,
          mockServices.rootConfig.factory({
            data: {
              connections: [{ type: 'proxmox', baseUrl: 'not-a-url', auth: [] }],
            },
          }),
        ],
      }),
    ).rejects.toThrow(/Invalid Proxmox connection/);
  });
});
