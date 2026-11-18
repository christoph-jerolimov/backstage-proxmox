import { ProxmoxFetch } from '../client/ProxmoxClient';

/** A request the fake Proxmox instance received. */
export type FakeRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: URLSearchParams;
  headers: Record<string, string>;
  dispatcher: unknown;
};

/** What a route responds with. `data` is wrapped in the Proxmox envelope. */
export type FakeResponse = {
  status?: number;
  data?: unknown;
  raw?: string;
  errors?: Record<string, string>;
};

type Responder = FakeResponse | ((request: FakeRequest) => FakeResponse);

/**
 * A stand-in for the Proxmox VE API. Routes are matched on method and path
 * (the `/api2/json` prefix and the query string are stripped first), and every
 * request is recorded so tests can assert on headers and bodies.
 */
export class FakeProxmox {
  readonly requests: FakeRequest[] = [];
  private readonly routes = new Map<string, Responder>();

  static create() {
    return new FakeProxmox();
  }

  on(method: string, path: string, responder: Responder): this {
    this.routes.set(`${method} ${path}`, responder);
    return this;
  }

  /** Requests recorded for one route. */
  requestsFor(method: string, path: string): FakeRequest[] {
    return this.requests.filter(
      request => request.method === method && request.path === path,
    );
  }

  get fetch(): ProxmoxFetch {
    return async (url, init) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/api2\/json/, '');
      const request: FakeRequest = {
        method: init.method,
        path,
        query: parsed.searchParams,
        body: new URLSearchParams(init.body ?? ''),
        headers: init.headers,
        dispatcher: init.dispatcher,
      };
      this.requests.push(request);

      const route = this.routes.get(`${init.method} ${path}`);
      if (!route) {
        return jsonResponse({
          status: 501,
          raw: `no fake route for ${init.method} ${path}`,
        });
      }
      return jsonResponse(typeof route === 'function' ? route(request) : route);
    };
  }
}

function jsonResponse(response: FakeResponse) {
  const status = response.status ?? 200;
  const body =
    response.raw ??
    JSON.stringify(
      response.errors
        ? { data: null, errors: response.errors }
        : { data: response.data ?? null },
    );
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Status ${status}`,
    text: async () => body,
  };
}

/** A logger that records what it was told, for assertions on warnings. */
export function recordingLogger() {
  const entries: Array<{ level: string; message: string }> = [];
  const record = (level: string) => (message: string) =>
    entries.push({ level, message });
  return {
    entries,
    logger: {
      error: record('error'),
      warn: record('warn'),
      info: record('info'),
      debug: record('debug'),
      child: () => recordingLogger().logger,
    } as any,
    messages: () => entries.map(entry => entry.message),
  };
}
