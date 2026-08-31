import { readFileSync } from 'fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { SelectedProxmoxConnection } from '../connections/ProxmoxConnectionsService';
import { proxmoxError, redactSecrets } from './errors';

/** The subset of `fetch` this client uses; injectable so tests can fake it. */
export type ProxmoxFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    dispatcher?: unknown;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

type Logger = { warn(message: string): void; debug(message: string): void };

/** A value that can be sent as a Proxmox request parameter. */
export type ProxmoxParamValue = string | number | boolean | undefined;

/** Request parameters, with `undefined` entries omitted from the request. */
export type ProxmoxParams = Record<string, ProxmoxParamValue>;

const TICKET_PATH = '/access/ticket';
// Proxmox tickets are valid for two hours; renew a little before that.
const TICKET_LIFETIME_MS = 2 * 60 * 60 * 1000;
const TICKET_RENEW_MARGIN_MS = 5 * 60 * 1000;

type Ticket = { ticket: string; csrfToken: string; expiresAt: number };

/** Encodes parameters the way the Proxmox API expects them. */
export function encodeParams(params: ProxmoxParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'boolean') {
      search.append(key, value ? '1' : '0');
    } else {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

/**
 * A thin client for the Proxmox VE REST API, bound to one connection and one
 * selected auth method.
 */
export class ProxmoxClient {
  private ticket: Ticket | undefined;
  private tlsWarningLogged = false;

  private constructor(
    private readonly connection: SelectedProxmoxConnection,
    private readonly logger: Logger | undefined,
    private readonly fetchApi: ProxmoxFetch,
    private readonly dispatcher: unknown,
  ) {}

  static create(options: {
    connection: SelectedProxmoxConnection;
    logger?: Logger;
    fetchApi?: ProxmoxFetch;
  }): ProxmoxClient {
    const { connection, logger } = options;

    let dispatcher: unknown;
    if (connection.skipTlsVerify || connection.caFile) {
      dispatcher = new Agent({
        connect: {
          rejectUnauthorized: !connection.skipTlsVerify,
          ...(connection.caFile
            ? { ca: readFileSync(connection.caFile, 'utf8') }
            : {}),
        },
      });
    }

    const client = new ProxmoxClient(
      connection,
      logger,
      options.fetchApi ?? (undiciFetch as unknown as ProxmoxFetch),
      dispatcher,
    );
    client.warnAboutTlsVerification();
    return client;
  }

  /** The title of the connection this client talks to. */
  get connectionTitle(): string {
    return this.connection.title;
  }

  async get<T>(path: string, params: ProxmoxParams = {}): Promise<T> {
    const query = encodeParams(params);
    return this.request<T>('GET', query ? `${path}?${query}` : path);
  }

  async post<T>(path: string, params: ProxmoxParams = {}): Promise<T> {
    return this.request<T>('POST', path, params);
  }

  async put<T>(path: string, params: ProxmoxParams = {}): Promise<T> {
    return this.request<T>('PUT', path, params);
  }

  async delete<T>(path: string, params: ProxmoxParams = {}): Promise<T> {
    return this.request<T>('DELETE', path, params);
  }

  private secrets(): string[] {
    const auth = this.connection.auth;
    return auth.method === 'token' ? [auth.secret] : [auth.password];
  }

  /** Redacts secret material from arbitrary text before it is logged. */
  redact(text: string): string {
    return redactSecrets(text, [
      ...this.secrets(),
      ...(this.ticket ? [this.ticket.ticket, this.ticket.csrfToken] : []),
    ]);
  }

  private warnAboutTlsVerification(): void {
    if (this.connection.skipTlsVerify && !this.tlsWarningLogged) {
      this.tlsWarningLogged = true;
      this.logger?.warn(
        `TLS certificate verification is disabled for Proxmox connection "${this.connection.title}". Only do this for development instances.`,
      );
    }
  }

  private async authHeaders(method: string): Promise<Record<string, string>> {
    const auth = this.connection.auth;
    if (auth.method === 'token') {
      return {
        Authorization: `PVEAPIToken=${auth.tokenId}=${auth.secret}`,
      };
    }

    const ticket = await this.getTicket();
    const headers: Record<string, string> = {
      Cookie: `PVEAuthCookie=${encodeURIComponent(ticket.ticket)}`,
    };
    if (method !== 'GET') {
      headers.CSRFPreventionToken = ticket.csrfToken;
    }
    return headers;
  }

  private async getTicket(): Promise<Ticket> {
    if (this.ticket && this.ticket.expiresAt > Date.now()) {
      return this.ticket;
    }
    const auth = this.connection.auth;
    if (auth.method !== 'password') {
      throw new Error('A ticket can only be obtained for password auth');
    }

    const data = await this.send<{
      ticket: string;
      CSRFPreventionToken: string;
    }>(
      'POST',
      TICKET_PATH,
      { username: auth.username, password: auth.password },
      {},
      `obtain an authentication ticket`,
    );

    this.ticket = {
      ticket: data.ticket,
      csrfToken: data.CSRFPreventionToken,
      expiresAt: Date.now() + TICKET_LIFETIME_MS - TICKET_RENEW_MARGIN_MS,
    };
    return this.ticket;
  }

  private async request<T>(
    method: string,
    path: string,
    params?: ProxmoxParams,
  ): Promise<T> {
    const headers = await this.authHeaders(method);
    return this.send<T>(method, path, params, headers, `${method} ${path}`);
  }

  private async send<T>(
    method: string,
    path: string,
    params: ProxmoxParams | undefined,
    headers: Record<string, string>,
    operation: string,
  ): Promise<T> {
    const url = `${this.connection.baseUrl.replace(
      /\/+$/,
      '',
    )}/api2/json${path}`;
    const body =
      params && Object.keys(params).length ? encodeParams(params) : undefined;

    const response = await this.fetchApi(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
        ...headers,
      },
      ...(body ? { body } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = raw;
    }

    if (!response.ok) {
      throw proxmoxError({
        status: response.status,
        statusText: response.statusText,
        body: parsed,
        operation,
        connectionTitle: this.connection.title,
        secrets: this.secrets(),
      });
    }

    this.logger?.debug(
      this.redact(
        `Proxmox ${operation} succeeded on "${this.connection.title}"`,
      ),
    );

    return (parsed as { data?: T } | undefined)?.data as T;
  }
}
