import { z } from 'zod/v3';

/**
 * The definition of the `proxmox` connection type.
 *
 * The shape deliberately mirrors an upstream `ConnectionType` from
 * `@backstage/connections`: a `type`, a `title`, a cardinality, a lookup
 * strategy, a strict connection config schema and a list of auth methods that
 * each carry their own schema. `@backstage/connections` does not export
 * `createConnectionType` and its type registry is closed, so the definition
 * lives here and is applied by this plugin's own resolver. When custom
 * connection types become registerable upstream, this definition can be handed
 * to the framework unchanged and the resolver dropped — the configuration
 * written by adopters stays the same either way.
 */

const connectionConfigSchema = z
  .object({
    baseUrl: z
      .string()
      .refine(
        value => {
          try {
            const url = new URL(value);
            return url.protocol === 'https:' || url.protocol === 'http:';
          } catch {
            return false;
          }
        },
        {
          message:
            'must be an absolute http(s) URL, for example https://proxmox.example.com:8006',
        },
      )
      .describe('Base URL of the Proxmox VE instance, including the port'),
    skipTlsVerify: z
      .boolean()
      .optional()
      .describe(
        'Disables TLS certificate verification for this instance. Intended for development instances with self-signed certificates only.',
      ),
    caFile: z
      .string()
      .optional()
      .describe(
        'Path to a PEM file with the certificate authority that issued the instance certificate',
      ),
  })
  .strict();

const tokenAuthSchema = z
  .object({
    tokenId: z
      .string()
      .regex(
        /^[^@!\s]+@[^@!\s]+![^@!\s]+$/,
        'must have the form user@realm!tokenName, for example root@pam!full-access',
      )
      .describe('Proxmox API token id'),
    secret: z.string().min(1).describe('Proxmox API token secret'),
  })
  .strict();

const passwordAuthSchema = z
  .object({
    username: z
      .string()
      .regex(
        /^[^@!\s]+@[^@!\s]+$/,
        'must have the form user@realm, for example alice@pve',
      )
      .describe('Proxmox user, including the realm'),
    password: z.string().min(1).describe('Password for the Proxmox user'),
  })
  .strict();

/** The auth methods the `proxmox` connection type supports. */
export const proxmoxAuthMethods = ['token', 'password'] as const;

/** One of the auth methods the `proxmox` connection type supports. */
export type ProxmoxAuthMethod = (typeof proxmoxAuthMethods)[number];

/** The `proxmox` connection type definition. */
export const proxmoxConnectionType = {
  type: 'proxmox',
  title: 'Proxmox VE',
  cardinality: 'multiton',
  lookupStrategy: 'host',
  configSchema: connectionConfigSchema,
  authMethods: [
    {
      method: 'token' as const,
      title: 'API Token',
      configSchema: tokenAuthSchema,
    },
    {
      method: 'password' as const,
      title: 'Username and Password',
      configSchema: passwordAuthSchema,
    },
  ],
} as const;

/** The connection-level fields of a `proxmox` connection. */
export type ProxmoxConnectionConfig = z.infer<typeof connectionConfigSchema>;

/** A resolved auth entry, with the title the connection type guarantees. */
export type ProxmoxAuthValue =
  | ({ method: 'token'; title: string } & z.infer<typeof tokenAuthSchema>)
  | ({ method: 'password'; title: string } & z.infer<
      typeof passwordAuthSchema
    >);

/** Restricts a connection or auth entry to a set of plugins. */
export type ProxmoxConnectionMatch = { plugins: string[] };

/** A fully resolved and validated Proxmox connection. */
export type ProxmoxConnection<
  TAuthMethod extends ProxmoxAuthMethod = ProxmoxAuthMethod,
> = ProxmoxConnectionConfig & {
  type: 'proxmox';
  title: string;
  match?: ProxmoxConnectionMatch;
  auth: Extract<ProxmoxAuthValue, { method: TAuthMethod }>[];
};

/** Returns the auth method definition for a method name, if it is supported. */
export function getProxmoxAuthMethod(method: string) {
  return proxmoxConnectionType.authMethods.find(m => m.method === method);
}
