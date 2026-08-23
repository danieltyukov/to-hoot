import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { fileTimerStore } from './timers.js';

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'to-hoot-mcp-')), 'nested', 'timer.json');
}

describe('fileTimerStore', () => {
  it('reads back what it wrote, across store instances', async () => {
    const path = await scratch();
    await fileTimerStore(path).write({ taskId: 'a', startedAt: 1_700_000_000_000 });

    expect(await fileTimerStore(path).read()).toEqual({ taskId: 'a', startedAt: 1_700_000_000_000 });
  });

  it('reports no timer when the file has never been written', async () => {
    expect(await fileTimerStore(await scratch()).read()).toBeNull();
  });

  it('reports no timer rather than throwing on a corrupt file', async () => {
    const path = await scratch();
    const store = fileTimerStore(path);
    await store.write({ taskId: 'a', startedAt: 1 });
    await writeFile(path, 'not json', 'utf8');

    expect(await store.read()).toBeNull();
  });

  it('reports no timer when the file holds the wrong shape', async () => {
    const path = await scratch();
    const store = fileTimerStore(path);
    await store.write({ taskId: 'a', startedAt: 1 });
    await writeFile(path, JSON.stringify({ taskId: 7, startedAt: 'soon' }), 'utf8');

    expect(await store.read()).toBeNull();
  });

  it('clears the timer on write(null)', async () => {
    const path = await scratch();
    const store = fileTimerStore(path);
    await store.write({ taskId: 'a', startedAt: 1 });
    await store.write(null);

    expect(await store.read()).toBeNull();
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('clears an already cleared timer without complaining', async () => {
    const store = fileTimerStore(await scratch());
    await expect(store.write(null)).resolves.toBeUndefined();
  });
});
