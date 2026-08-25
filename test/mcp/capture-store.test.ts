import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { FileObservationCaptureStore } from '../../src/mcp/capture-store.js';
import { FileObservationFeedbackStore } from '../../src/mcp/feedback-store.js';
import { OBSERVATION_CAPTURE_SCOPE } from '../../src/mcp/principal.js';

const CAPTURE = {
  captureSourceKind: 'mcp',
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

  it('keeps read, review, and sample drafts inside the same principal partition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-feedback-store-'));
    const store = new FileObservationFeedbackStore({
      observationsDir: dir,
      now: () => new Date('2026-08-25T01:02:03.000Z'),
    });
    const principalA = {
      tenantId: 'tenant-a',
      principalId: 'principal-a',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    };
    const principalB = {
      tenantId: 'tenant-a',
      principalId: 'principal-b',
      scopes: [OBSERVATION_CAPTURE_SCOPE],
    };
    const captured = await store.create(principalA, {
      ...CAPTURE,
      evidenceSnippet: '用户授权的可见证据。',
    });

    await assert.rejects(
      () => store.get(principalB, captured.observationId),
      (error: unknown) => (error as { code?: string }).code === 'observation_not_found',
    );
    await assert.rejects(
      () => store.draftSample(principalA, {
        observationId: captured.observationId,
        prompt: '生成草稿。',
      }),
      (error: unknown) => (error as { code?: string }).code === 'observation_review_required',
    );

    const review = await store.review(principalA, {
      observationId: captured.observationId,
      verdict: 'real_issue',
      note: '已复核。',
    });
    assert.equal(review.review.verdict, 'real_issue');
    const firstDraft = await store.draftSample(principalA, {
      observationId: captured.observationId,
      prompt: '重现该 knowledge gap。',
      rubric: '回答应满足已确认的知识要求。',
      draftId: 'stable-draft-id',
    });
    const duplicateDraft = await store.draftSample(principalA, {
      observationId: captured.observationId,
      prompt: '重现该 knowledge gap。',
      rubric: '回答应满足已确认的知识要求。',
      draftId: 'stable-draft-id',
    });
    assert.equal(firstDraft.created, true);
    assert.equal(duplicateDraft.created, false);
    assert.equal(firstDraft.draft.status, 'draft');
    assert.equal(firstDraft.draft.sample.provenance, 'production-trace');
    assert.equal(firstDraft.draft.sourceEvidence[0]?.captureId.length, 24);

    const detail = await store.get(principalA, captured.observationId);
    assert.equal(detail.review?.verdict, 'real_issue');
    assert.equal(detail.evidence[0]?.evidenceSnippet, '用户授权的可见证据。');
    assert.equal(detail.captureCoverage.coverageStatus, 'partial');
    assert.equal(existsSync(join(dir, 'sample-drafts.json')), false);
  });
});
