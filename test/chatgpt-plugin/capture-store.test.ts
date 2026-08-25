import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { FileObservationCaptureStore } from '../../src/chatgpt-plugin/capture-store.js';
import { OBSERVATION_CAPTURE_SCOPE } from '../../src/chatgpt-plugin/principal.js';

const CAPTURE = {
  captureSourceKind: 'chatgpt_plugin',
  skillName: 'demo-skill',
  userFeedback: '需要补充失败恢复步骤。',
  captureId: 'same-host-capture-id',
  confirmedByUser: true,
} as const;

describe('file observation capture store', () => {
  it('partitions idempotency by tenant and principal without persisting raw identities', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-capture-store-'));
    const store = new FileObservationCaptureStore({ observationsDir: dir });
    const principalA = {
      tenantId: 'tenant-secret-a',
      principalId: 'principal-secret-a',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    };
    const principalB = {
      tenantId: 'tenant-secret-a',
      principalId: 'principal-secret-b',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    };
    const principalC = {
      tenantId: 'tenant-secret-c',
      principalId: 'principal-secret-a',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    };

    assert.equal((await store.create(principalA, CAPTURE)).created, true);
    assert.equal((await store.create(principalA, CAPTURE)).created, false);
    assert.equal((await store.create(principalB, CAPTURE)).created, true);
    assert.equal((await store.create(principalC, CAPTURE)).created, true);

    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.capture.json'));
    assert.equal(files.length, 3);
    assert.equal(files.some((path) => /tenant-secret|principal-secret/.test(path)), false);
    const records = files.map((path) => readFileSync(join(dir, path), 'utf8'));
    assert.equal(records.some((record) => /tenant-secret|principal-secret/.test(record)), false);
    assert.equal(records.every((record) => JSON.parse(record).schemaVersion === 1), true);
  });
});
