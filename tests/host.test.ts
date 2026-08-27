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
});

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
