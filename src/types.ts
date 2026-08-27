export type Awaitable<T> = T | Promise<T>;

export interface Publication<TParsed, TSummary> {
  readonly sourcePath: string;
  readonly parsed: TParsed;
  readonly summary: TSummary;
  readonly contentHash: string;
  readonly publishedAt: Date;
  readonly sequence: number;
}

export type PreviewEventPayload = Record<string, unknown> | readonly unknown[] | string | number | boolean | null;

export interface PreviewEvent {
  readonly id: number;
  readonly type: string;
  readonly payload: PreviewEventPayload;
  readonly createdAt: string;
}

export interface JsonResponse {
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly body?: unknown;
}

export type PreviewRouteHandler = (request: Request) => Awaitable<JsonResponse | Response>;
