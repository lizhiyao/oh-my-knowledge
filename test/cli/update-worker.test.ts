import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('../../dist/cli/lib/update-fetch-worker.js', import.meta.url));

it('compiled worker queries both publishing channels and preserves notification state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omk-update-worker-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ version: request.url!.endsWith('/next') ? '2.0.0-beta.1' : '1.9.0' }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    for (const channel of ['next', 'latest']) {
      const cache = join(root, `${channel}.json`);
      const notified = { lastNotifiedVersion: '1.0.0', lastNotifiedAt: '2026-09-10T00:00:00.000Z' };
      await writeFile(cache, JSON.stringify({ ...notified, lastCheckedAt: '2020-01-01T00:00:00.000Z' }));
      const output = await execute(process.execPath, [worker, cache, `http://127.0.0.1:${address.port}`, 'oh-my-knowledge', channel], {
        cwd: root, timeout: 7000, env: { ...process.env, HOME: root, OMK_HOME: root },
      });
      expect(output).toEqual({ stdout: '', stderr: '' });
      expect(JSON.parse(await readFile(cache, 'utf8'))).toMatchObject({
        ...notified, latestVersion: channel === 'next' ? '2.0.0-beta.1' : '1.9.0',
      });
    }
    expect(requests).toEqual(['/oh-my-knowledge/next', '/oh-my-knowledge/latest']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
