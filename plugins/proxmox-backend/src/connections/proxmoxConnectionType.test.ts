import { getProxmoxAuthMethod, proxmoxConnectionType } from './proxmoxConnectionType';

describe('proxmoxConnectionType', () => {
  const { configSchema } = proxmoxConnectionType;

  it('accepts the documented example', () => {
    expect(
      configSchema.parse({
        baseUrl: 'https://localhost:8006',
        skipTlsVerify: true,
      }),
    ).toEqual({ baseUrl: 'https://localhost:8006', skipTlsVerify: true });
  });

  it('rejects unknown fields', () => {
    const result = configSchema.safeParse({
      baseUrl: 'https://localhost:8006',
      host: 'localhost',
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['a relative URL', 'localhost:8006'],
    ['a non-http protocol', 'ftp://localhost:8006'],
    ['nothing at all', undefined],
  ])('rejects a baseUrl that is %s', (_name, baseUrl) => {
    expect(configSchema.safeParse({ baseUrl }).success).toBe(false);
  });

  it('validates token auth', () => {
    const token = getProxmoxAuthMethod('token')!;
    expect(
      token.configSchema.parse({
        tokenId: 'root@pam!full-access',
        secret: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      tokenId: 'root@pam!full-access',
      secret: '00000000-0000-4000-8000-000000000001',
    });
    expect(
      token.configSchema.safeParse({ tokenId: 'root@pam', secret: 'x' }).success,
    ).toBe(false);
  });

  it('validates password auth', () => {
    const password = getProxmoxAuthMethod('password')!;
    expect(
      password.configSchema.parse({ username: 'alice@pve', password: 'secret' }),
    ).toEqual({ username: 'alice@pve', password: 'secret' });
    expect(
      password.configSchema.safeParse({ username: 'alice', password: 'x' }).success,
    ).toBe(false);
  });

  it('has no auth method beyond token and password', () => {
    expect(proxmoxConnectionType.authMethods.map(m => m.method)).toEqual([
      'token',
      'password',
    ]);
    expect(getProxmoxAuthMethod('none')).toBeUndefined();
  });
});
