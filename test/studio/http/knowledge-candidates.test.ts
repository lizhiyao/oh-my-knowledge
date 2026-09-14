import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';

describe('Studio candidate action boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-candidate-api-'));
  const workspace = join(root, 'knowledge');
  const source = join(root, 'source.jsonl');
  let server: ReturnType<typeof createReportServer>;
  let url: string;
  beforeAll(async () => {
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '方法：发布之前核对当前版本。' }] } }));
    server = createReportServer({ port: 0, observationsDir: join(root, 'observations'), analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors') });
    url = await server.start();
  });
  afterAll(async () => { await server?.stop(); rmSync(root, { recursive: true, force: true }); });
  const post = (body: Record<string, unknown>, origin?: string) => fetch(`${url}/api/knowledge/candidates`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ workspace, ...body }),
  });
  it('uses the selected local workspace and shared capture operation', async () => {
    expect(await (await post({ operation: 'list' })).json()).toEqual([]);
    const captured = await post({ operation: 'capture', source });
    expect(captured.status).toBe(200);
    const snapshot = await captured.json() as { snapshotId: string };
    expect(snapshot.snapshotId).toBeTruthy();
    const generated = await post({ operation: 'generate', snapshot: snapshot.snapshotId, runId: randomUUID() });
    expect(generated.status).toBe(200);
    expect(await generated.json()).toMatchObject({ status: 'completed', committed: [expect.objectContaining({ knowledgeId: expect.any(String) })] });
    expect((await post({ operation: 'delete-source', snapshot: snapshot.snapshotId })).status).toBe(200);
  });
  it('rejects cross-origin mutation before touching a source', async () => {
    const response = await post({ operation: 'capture', source }, 'https://untrusted.example');
    expect(response.status).toBe(403);
  });
  it('does not expose raw filesystem exceptions or accept unrecognized request fields', async () => {
    const invalid = await post({ operation: 'capture', source: join(root, 'private-missing-file') });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(root);
    expect((await post({ operation: 'list', approved: true })).status).toBe(400);
  });
});
