import {mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it} from 'vitest';
import {createStableSourceWatcher, type StableSourceWatcher} from '../src/watcher.js';

const watchers: StableSourceWatcher[] = [];

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
});

describe('createStableSourceWatcher', () => {
  it('publishes immediately when requested', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'tlp-watcher-'));
    const sourcePath = 'source.txt';
    const absolutePath = join(projectRoot, sourcePath);
    await writeFile(absolutePath, 'manual');

    const publications: string[] = [];
    const watcher = createStableSourceWatcher({
      projectRoot,
      sourcePath,
      quietWindowMs: 10_000,
      onPublication: (publication) => {
        publications.push(publication.parsed);
      }
    });
    watchers.push(watcher);

    await watcher.publishNow();
    expect(publications).toEqual(['manual']);
  });

  it('debounces a single file and suppresses duplicate publications', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'tlp-watcher-'));
    const sourcePath = 'source.txt';
    const absolutePath = join(projectRoot, sourcePath);
    await writeFile(absolutePath, 'initial');

    const publications: string[] = [];
    const watcher = createStableSourceWatcher({
      projectRoot,
      sourcePath,
      parseSource: (source: string) => source.toUpperCase(),
      summarize: (parsed) => ({length: parsed.length}),
      quietWindowMs: 25,
      retryIntervalMs: 10,
      stabilityTimeoutMs: 500,
      onPublication: (publication) => {
        publications.push(publication.parsed);
      }
    });
    watchers.push(watcher);

    watcher.start();
    await waitFor(() => publications.length === 1);
    expect(publications).toEqual(['INITIAL']);

    await writeFile(absolutePath, 'next');
    await writeFile(absolutePath, 'next');
    await waitFor(() => publications.length === 2);
    await sleep(80);

    expect(publications).toEqual(['INITIAL', 'NEXT']);

    await watcher.publishNow();
    expect(publications).toEqual(['INITIAL', 'NEXT']);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await sleep(20);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
