import {describe, expect, it} from 'vitest';
import {createLoopbackPreviewHost} from '../src/host.js';

describe('createLoopbackPreviewHost', () => {
  it('retains events and protects JSON APIs with bearer auth', async () => {
    const host = await createLoopbackPreviewHost({
      title: 'Preview',
      token: 'test-token',
      eventRetentionLimit: 2
    });

    try {
      host.emit('first', {value: 1});
      host.emit('second', {value: 2});
      host.emit('third', {value: 3});

      const unauthorized = await fetch(new URL('/api/events', host.url));
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(new URL('/api/events', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(authorized.status).toBe(200);
      const body = await authorized.json() as {events: Array<{type: string}>};
      expect(body.events.map((event) => event.type)).toEqual(['second', 'third']);

      const lifecycle = await fetch(new URL('/api/lifecycle', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(lifecycle.status).toBe(200);
      await expect(lifecycle.json()).resolves.toMatchObject({
        title: 'Preview',
        bindHost: '127.0.0.1',
        retainedEventCount: 2,
        connectedClientCount: 0
      });
    } finally {
      await host.close();
    }
  });

  it('streams retained events to browser clients', async () => {
    const host = await createLoopbackPreviewHost({
      title: 'Preview',
      token: 'test-token'
    });

    try {
      host.emit('ready', {ok: true});
      const response = await fetch(new URL('/events', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const text = await readUntil(reader, '"ok":true');
      await reader?.cancel();
      expect(text).toContain('event: ready');
      expect(text).toContain('"ok":true');
    } finally {
      await host.close();
    }
  });

  it('passes request bodies to custom JSON routes', async () => {
    const host = await createLoopbackPreviewHost({
      title: 'Preview',
      token: 'test-token',
      routes: {
        '/api/echo': async (request) => ({
          body: await request.json()
        })
      }
    });

    try {
      const response = await fetch(new URL('/api/echo', host.url), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({message: 'hello'})
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({message: 'hello'});
    } finally {
      await host.close();
    }
  });

  it('streams route Response bodies incrementally instead of buffering them', async () => {
    const chunkSize = 64 * 1024;
    const chunkCount = 128;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const host = await createLoopbackPreviewHost({
      title: 'Preview',
      token: 'test-token',
      routes: {
        '/api/recording': () => new Response(new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            controller.enqueue(new Uint8Array(chunkSize).fill(1));
          }
        }), {
          headers: {'Content-Type': 'application/octet-stream'}
        })
      }
    });

    try {
      const response = await fetch(new URL('/api/recording', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      const reader = response.body!.getReader();

      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.byteLength).toBeGreaterThan(0);
      expect(closed).toBe(false);

      let received = first.value!.byteLength;
      for (let index = 1; index < chunkCount; index++) {
        controller.enqueue(new Uint8Array(chunkSize).fill(1));
      }
      controller.close();
      closed = true;

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += chunk.value.byteLength;
      }
      expect(received).toBe(chunkSize * chunkCount);
    } finally {
      await host.close();
    }
  });

  it('ends route Responses that have a null body', async () => {
    const host = await createLoopbackPreviewHost({
      title: 'Preview',
      token: 'test-token',
      routes: {
        '/api/empty': () => new Response(null, {status: 200, headers: {'X-Empty': 'yes'}}),
        '/api/no-content': () => new Response(null, {status: 204})
      }
    });

    try {
      const empty = await fetch(new URL('/api/empty', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(empty.status).toBe(200);
      expect(empty.headers.get('x-empty')).toBe('yes');
      await expect(empty.text()).resolves.toBe('');

      const noContent = await fetch(new URL('/api/no-content', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(noContent.status).toBe(204);
      await expect(noContent.text()).resolves.toBe('');
    } finally {
      await host.close();
    }
  });

  it('cancels the route body stream when the client disconnects', async () => {
    const errors: unknown[] = [];
    let resolveCancelled!: (reason: unknown) => void;
    const cancelled = new Promise<unknown>((resolve) => {
      resolveCancelled = resolve;
    });
    const host = await createLoopbackPreviewHost({
      title: 'Preview',
      token: 'test-token',
      onError: (error) => {
        errors.push(error);
      },
      routes: {
        '/api/recording': () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024).fill(1));
          },
          cancel(reason) {
            resolveCancelled(reason);
          }
        }))
      }
    });

    try {
      const abort = new AbortController();
      const response = await fetch(new URL('/api/recording', host.url), {
        headers: {Authorization: 'Bearer test-token'},
        signal: abort.signal
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      abort.abort();

      await withTimeout(cancelled, 2_000, 'source stream was not cancelled');

      const lifecycle = await fetch(new URL('/api/lifecycle', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(lifecycle.status).toBe(200);
      expect(errors).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('aborts the response and reports the error when the route body stream fails', async () => {
    const errors: unknown[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const host = await createLoopbackPreviewHost({
      title: 'Preview',
      token: 'test-token',
      onError: (error) => {
        errors.push(error);
      },
      routes: {
        '/api/recording': () => new Response(new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            controller.enqueue(new Uint8Array(1024).fill(1));
          }
        }))
      }
    });

    try {
      const response = await fetch(new URL('/api/recording', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);

      controller.error(new Error('disk read failed'));
      await expect(readToEnd(reader)).rejects.toThrow();
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('disk read failed');

      const lifecycle = await fetch(new URL('/api/lifecycle', host.url), {
        headers: {Authorization: 'Bearer test-token'}
      });
      expect(lifecycle.status).toBe(200);
    } finally {
      await host.close();
    }
  });
});

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  expected: string
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (!text.includes(expected)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${expected}`);
    }
    const chunk = await reader?.read();
    if (!chunk || chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value, {stream: true});
  }
  return text;
}
