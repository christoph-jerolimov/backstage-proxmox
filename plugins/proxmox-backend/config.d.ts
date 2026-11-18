export interface Config {
  /**
   * Configuration for the Proxmox actions plugin.
   *
   * Proxmox connections are normally declared in the top-level `connections`
   * array with `type: proxmox`. This key accepts exactly the same entries and
   * exists because the connections framework does not yet allow plugins to
   * register their own connection type, so a future Backstage version could
   * reject an unknown `proxmox` entry in `connections`.
   */
  proxmox?: {
    connections?: Array<{
      /** Always `proxmox`. May be left out under this key. */
      type?: 'proxmox';
      /** Human readable name, used to select this instance from an action. */
      title?: string;
      /** Restricts this connection to the listed plugins. */
      match?: {
        plugins: string[];
      };
      /** Base URL of the Proxmox VE instance, including the port. */
      baseUrl: string;
      /**
       * Disables TLS certificate verification. Development instances with
       * self-signed certificates only.
       */
      skipTlsVerify?: boolean;
      /** Path to a PEM file with the CA that issued the instance certificate. */
      caFile?: string;
      /** The auth methods this connection may be used with. At least one. */
      auth: Array<
        | {
            method: 'token';
            title?: string;
            match?: { plugins: string[] };
            /** Token id of the form `user@realm!tokenName`. */
            tokenId: string;
            /**
             * Token secret.
             * @visibility secret
             */
            secret: string;
          }
        | {
            method: 'password';
            title?: string;
            match?: { plugins: string[] };
            /** Proxmox user of the form `user@realm`. */
            username: string;
            /**
             * Password for the Proxmox user.
             * @visibility secret
             */
            password: string;
          }
      >;
    }>;
  };
}
