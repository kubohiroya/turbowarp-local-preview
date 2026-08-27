import {createHash} from 'node:crypto';
import {watch, type FSWatcher} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Awaitable, Publication} from './types.js';

export interface StableSourceWatcherOptions<TRaw = string, TParsed = TRaw, TSummary = unknown> {
  readonly projectRoot: string;
  readonly sourcePath: string;
  readonly loadSource?: (absolutePath: string) => Awaitable<TRaw>;
  readonly parseSource?: (source: TRaw, absolutePath: string) => Awaitable<TParsed>;
  readonly summarize?: (parsed: TParsed, absolutePath: string) => Awaitable<TSummary>;
  readonly onPublication: (publication: Publication<TParsed, TSummary>) => Awaitable<void>;
  readonly onError?: (error: unknown) => Awaitable<void>;
  readonly quietWindowMs?: number;
  readonly retryIntervalMs?: number;
  readonly stabilityTimeoutMs?: number;
}

export interface StableSourceWatcher {
  readonly sourcePath: string;
  start(): void;
  publishNow(): Promise<void>;
  close(): Promise<void>;
}

const defaultQuietWindowMs = 100;
const defaultRetryIntervalMs = 50;
const defaultStabilityTimeoutMs = 2_000;

export function createStableSourceWatcher<TRaw = string, TParsed = TRaw, TSummary = unknown>(
  options: StableSourceWatcherOptions<TRaw, TParsed, TSummary>
): StableSourceWatcher {
  return new NodeStableSourceWatcher(options);
}

class NodeStableSourceWatcher<TRaw, TParsed, TSummary> implements StableSourceWatcher {
  readonly sourcePath: string;

  #watcher: FSWatcher | undefined;
  #quietTimer: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #publishing: Promise<void> = Promise.resolve();
  #lastHash: string | undefined;
  #sequence = 0;

  readonly #absolutePath: string;
  readonly #loadSource: (absolutePath: string) => Awaitable<TRaw>;
  readonly #parseSource: (source: TRaw, absolutePath: string) => Awaitable<TParsed>;
  readonly #summarize: (parsed: TParsed, absolutePath: string) => Awaitable<TSummary>;
  readonly #onPublication: (publication: Publication<TParsed, TSummary>) => Awaitable<void>;
  readonly #onError: (error: unknown) => Awaitable<void>;
  readonly #quietWindowMs: number;
  readonly #retryIntervalMs: number;
  readonly #stabilityTimeoutMs: number;

  constructor(options: StableSourceWatcherOptions<TRaw, TParsed, TSummary>) {
    this.sourcePath = resolve(options.projectRoot, options.sourcePath);
    this.#absolutePath = this.sourcePath;
    this.#loadSource = options.loadSource ?? defaultLoadSource as (absolutePath: string) => Awaitable<TRaw>;
    this.#parseSource = options.parseSource ?? ((source) => source as unknown as TParsed);
    this.#summarize = options.summarize ?? (() => undefined as TSummary);
    this.#onPublication = options.onPublication;
    this.#onError = options.onError ?? (() => undefined);
    this.#quietWindowMs = options.quietWindowMs ?? defaultQuietWindowMs;
    this.#retryIntervalMs = options.retryIntervalMs ?? defaultRetryIntervalMs;
    this.#stabilityTimeoutMs = options.stabilityTimeoutMs ?? defaultStabilityTimeoutMs;
  }

  start(): void {
    if (this.#closed || this.#watcher) {
      return;
    }

    this.#watcher = watch(this.#absolutePath, {persistent: true}, () => {
      this.#schedulePublication();
    });
    this.#watcher.on('error', (error) => {
      void this.#reportError(error);
      this.#scheduleRetry();
    });
    this.#schedulePublication();
  }

  async publishNow(): Promise<void> {
    if (this.#quietTimer) {
      clearTimeout(this.#quietTimer);
      this.#quietTimer = undefined;
    }
    this.#enqueuePublication();
    await this.#publishing;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#quietTimer) {
      clearTimeout(this.#quietTimer);
      this.#quietTimer = undefined;
    }
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#watcher?.close();
    this.#watcher = undefined;
    await this.#publishing;
  }

  #schedulePublication(delayMs = this.#quietWindowMs): void {
    if (this.#closed) {
      return;
    }
    if (this.#quietTimer) {
      clearTimeout(this.#quietTimer);
    }
    this.#quietTimer = setTimeout(() => {
      this.#quietTimer = undefined;
      this.#enqueuePublication();
    }, delayMs);
  }

  #enqueuePublication(): void {
    this.#publishing = this.#publishing.then(() => this.#publishOnce()).catch((error: unknown) => {
      void this.#reportError(error);
      this.#scheduleRetry();
    });
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retryTimer) {
      return;
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#schedulePublication(0);
    }, this.#retryIntervalMs);
  }

  async #publishOnce(): Promise<void> {
    if (this.#closed) {
      return;
    }

    const raw = await withTimeout(
      Promise.resolve(this.#loadSource(this.#absolutePath)),
      this.#stabilityTimeoutMs,
      `Timed out while loading ${this.#absolutePath}`
    );
    const hash = contentHash(raw);
    if (hash === this.#lastHash) {
      return;
    }

    const parsed = await this.#parseSource(raw, this.#absolutePath);
    const summary = await this.#summarize(parsed, this.#absolutePath);
    const publication: Publication<TParsed, TSummary> = {
      sourcePath: this.#absolutePath,
      parsed,
      summary,
      contentHash: hash,
      publishedAt: new Date(),
      sequence: ++this.#sequence
    };

    await this.#onPublication(publication);
    this.#lastHash = hash;
  }

  async #reportError(error: unknown): Promise<void> {
    try {
      await this.#onError(error);
    } catch {
      // Error reporters must not break retry scheduling.
    }
  }
}

async function defaultLoadSource(absolutePath: string): Promise<string> {
  return readFile(absolutePath, 'utf8');
}

function contentHash(value: unknown): string {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
  return createHash('sha256').update(bytes ?? '').digest('hex');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
