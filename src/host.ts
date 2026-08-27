import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {AddressInfo} from 'node:net';
import type {JsonResponse, PreviewEvent, PreviewEventPayload, PreviewRouteHandler} from './types.js';

export interface LoopbackPreviewHostOptions {
  readonly title: string;
  readonly clientScript?: string;
  readonly routes?: Record<string, PreviewRouteHandler>;
  readonly onConnect?: (request: Request) => void | Promise<void>;
  readonly onEvent?: (event: PreviewEvent) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
  readonly bindHost?: '127.0.0.1' | '::1';
  readonly port?: number;
  readonly eventRetentionLimit?: number;
  readonly token?: string;
}

export interface LoopbackPreviewHost {
  readonly token: string;
  readonly url: string;
  readonly events: readonly PreviewEvent[];
  snapshot(): LoopbackPreviewSnapshot;
  emit(type: string, payload: PreviewEventPayload): PreviewEvent;
  close(): Promise<void>;
}

export interface LoopbackPreviewSnapshot {
  readonly title: string;
  readonly url: string;
  readonly bindHost: '127.0.0.1' | '::1';
  readonly port: number;
  readonly startedAt: string;
  readonly retainedEventCount: number;
  readonly connectedClientCount: number;
}

type Client = {
  readonly response: ServerResponse;
};

export async function createLoopbackPreviewHost(options: LoopbackPreviewHostOptions): Promise<LoopbackPreviewHost> {
  const host = new NodeLoopbackPreviewHost(options);
  await host.listen();
  return host;
}

class NodeLoopbackPreviewHost implements LoopbackPreviewHost {
  readonly token: string;

  #server: Server;
  #url = '';
  #port = 0;
  #startedAt = '';
  #nextEventId = 1;
  #events: PreviewEvent[] = [];
  #clients = new Set<Client>();

  readonly #options: Required<Pick<LoopbackPreviewHostOptions, 'title' | 'bindHost' | 'port' | 'eventRetentionLimit'>> &
    Omit<LoopbackPreviewHostOptions, 'title' | 'bindHost' | 'port' | 'eventRetentionLimit'>;

  constructor(options: LoopbackPreviewHostOptions) {
    this.token = options.token ?? randomBytes(24).toString('base64url');
    this.#options = {
      ...options,
      title: options.title,
      bindHost: options.bindHost ?? '127.0.0.1',
      port: options.port ?? 0,
      eventRetentionLimit: options.eventRetentionLimit ?? 100
    };
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  get url(): string {
    return this.#url;
  }

  get events(): readonly PreviewEvent[] {
    return this.#events;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#options.port, this.#options.bindHost, () => {
        this.#server.off('error', reject);
        const address = this.#server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine preview host address'));
          return;
        }
        this.#port = address.port;
        this.#startedAt = new Date().toISOString();
        this.#url = buildPreviewUrl(this.#options.bindHost, address, this.token);
        resolve();
      });
    });
  }

  snapshot(): LoopbackPreviewSnapshot {
    return {
      title: this.#options.title,
      url: this.#url,
      bindHost: this.#options.bindHost,
      port: this.#port,
      startedAt: this.#startedAt,
      retainedEventCount: this.#events.length,
      connectedClientCount: this.#clients.size
    };
  }

  emit(type: string, payload: PreviewEventPayload): PreviewEvent {
    const event: PreviewEvent = {
      id: this.#nextEventId++,
      type,
      payload,
      createdAt: new Date().toISOString()
    };
    this.#events.push(event);
    if (this.#events.length > this.#options.eventRetentionLimit) {
      this.#events.splice(0, this.#events.length - this.#options.eventRetentionLimit);
    }

    for (const client of this.#clients) {
      writeSseEvent(client.response, event);
    }
    void this.#options.onEvent?.(event);
    return event;
  }

  async close(): Promise<void> {
    for (const client of this.#clients) {
      client.response.end();
    }
    this.#clients.clear();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async #handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    try {
      const request = toRequest(incoming);
      const url = new URL(request.url);
      if (!this.#isAuthorized(request, url)) {
        sendJson(outgoing, 401, {error: 'unauthorized'});
        return;
      }

      if (url.pathname === '/') {
        sendHtml(outgoing, this.#options.title, this.#options.clientScript ?? defaultClientScript());
        return;
      }
      if (url.pathname === '/api/events') {
        sendJson(outgoing, 200, {events: this.#events});
        return;
      }
      if (url.pathname === '/api/lifecycle') {
        sendJson(outgoing, 200, this.snapshot());
        return;
      }
      if (url.pathname === '/events') {
        await this.#connectClient(request, outgoing);
        return;
      }

      const route = this.#options.routes?.[url.pathname];
      if (route) {
        await sendRouteResponse(outgoing, await route(request));
        return;
      }

      sendJson(outgoing, 404, {error: 'not_found'});
    } catch (error) {
      void this.#options.onError?.(error);
      if (!outgoing.headersSent) {
        sendJson(outgoing, 500, {error: 'internal_error'});
      } else {
        outgoing.end();
      }
    }
  }

  async #connectClient(request: Request, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const client = {response};
    this.#clients.add(client);
    for (const event of this.#events) {
      writeSseEvent(response, event);
    }
    await this.#options.onConnect?.(request);
    response.on('close', () => {
      this.#clients.delete(client);
    });
  }

  #isAuthorized(request: Request, url: URL): boolean {
    const queryToken = url.searchParams.get('token');
    const auth = request.headers.get('authorization');
    const bearerToken = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    return secureTokenEqual(queryToken, this.token) || secureTokenEqual(bearerToken, this.token);
  }
}

function buildPreviewUrl(host: string, address: AddressInfo, token: string): string {
  const hostname = host === '::1' ? '[::1]' : host;
  return `http://${hostname}:${address.port}/?token=${encodeURIComponent(token)}`;
}

function secureTokenEqual(actual: string | null | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function toRequest(incoming: IncomingMessage): Request {
  const host = incoming.headers.host ?? '127.0.0.1';
  return new Request(`http://${host}${incoming.url ?? '/'}`, {
    method: incoming.method ?? 'GET',
    headers: incoming.headers as HeadersInit
  });
}

async function sendRouteResponse(outgoing: ServerResponse, response: JsonResponse | Response): Promise<void> {
  if (response instanceof Response) {
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  sendJson(outgoing, response.status ?? 200, response.body ?? {}, response.headers);
}

function sendJson(outgoing: ServerResponse, status: number, body: unknown, headers?: HeadersInit): void {
  outgoing.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...Object.fromEntries(new Headers(headers).entries())
  });
  outgoing.end(JSON.stringify(body));
}

function sendHtml(outgoing: ServerResponse, title: string, clientScript: string): void {
  outgoing.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  outgoing.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><script>${clientScript}</script></body></html>`);
}

function writeSseEvent(response: ServerResponse, event: PreviewEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function defaultClientScript(): string {
  return `
const source = new EventSource('/events' + location.search);
source.onmessage = (event) => console.log('[preview]', event.data);
`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
