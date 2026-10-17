import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExtractionRunSchema, type ExtractionRun } from '../../src/observability/knowledge-extraction/extraction/runs.js';
import { boundedExtractionPolicy, SINGLE_EXTRACTION_POLICY, type ExtractionGenerationPolicy } from '../../src/observability/knowledge-extraction/extraction/generation-policy.js';
import { extractionQuality } from '../../src/observability/knowledge-extraction/extraction/quality.js';

const sha = `sha256:${'a'.repeat(64)}`;
function savedRun(policy: ExtractionGenerationPolicy, timeoutMs = 300_000, maxOutputTokens = policy.policyId === 'knowledge-generation-bounded/v1' ? policy.maxOutputTokens : 4096): ExtractionRun {
  const at = '2026-10-16T00:00:00Z';
  return ExtractionRunSchema.parse({ runKind: 'knowledge-extraction-run', schemaVersion: 5, runId: randomUUID(), requestDigest: sha,
    generation: 1, snapshotId: randomUUID(), sourceVersion: sha, executor: 'openai-api', model: 'authored-loopback-test',
    promptVersion: 'knowledge-extraction-v15', promptHash: sha, inputDigest: sha, actor: { actorKind: 'human', actorId: 'fixture' },
    policy, startedAt: at, status: 'generating', intents: [], committed: [], rejections: [], entityRejections: [],
    attempts: [{ attemptId: randomUUID(), startedAt: at, requestDigest: sha,
      request: { systemDigest: sha, inputDigest: sha, outputMode: 'json-schema', wireId: sha, timeoutMs, maxOutputTokens },
      producer: { producerId: 'authored-quality-fixture', producerRevision: sha, sourceChannels: [{ channel: 'fixture', maxBytes: 1024 }],
        maxOutcomeJsonBytes: 1024, proof: { scope: 'synthetic-saved-facts;not-provider-evidence' } },
      ...(policy.policyId === 'knowledge-generation-bounded/v1' ? { budget: { profileId: 'loopback-test/v1', authority: 'loopback-test-only',
        evidenceDigest: `sha256:${'0'.repeat(64)}`, inputUpperBound: 1024, outputUpperBound: maxOutputTokens, tokensReserved: 1024 + maxOutputTokens } } : {}) }],
  });
}

it('separates full budget/reask policies and request caps in quality v3 without treating key order or pending attempts as extra admission', () => {
  const policy = boundedExtractionPolicy({ maxInvocations: 2, maxReasks: 1, profileId: 'loopback-test/v1', maxTotalTokens: 2176, maxOutputTokens: 64 });
  const same = savedRun(policy);
  // Saved JSON property ordering does not create a new experimental condition.
  same.policy = Object.fromEntries(Object.entries(policy).reverse()) as ExtractionGenerationPolicy;
  const runs = [savedRun(policy), same, savedRun({ ...policy, maxTotalTokens: 3264 }), savedRun({ ...policy, maxReasks: 0 }),
    savedRun(SINGLE_EXTRACTION_POLICY), savedRun(SINGLE_EXTRACTION_POLICY, 300_000, 8192), savedRun(SINGLE_EXTRACTION_POLICY, 1000)];
  const bytes = JSON.stringify(runs);
  const report = extractionQuality(runs);
  expect(report.projectionVersion).toBe('omk.extraction-quality/v3'); expect(report.runCount).toBe(7); expect(report.groups).toHaveLength(6);
  const paired = report.groups.find(group => group.runs.total === 2)!;
  expect(paired.identity).toMatchObject({ policyId: policy.policyId, policy, timeoutMs: 300_000, maxOutputTokens: 64 });
  expect(paired.runs).toMatchObject({ generating: 2, withAdmission: 0, withoutAdmission: 2 });
  expect(paired.mentions).toMatchObject({ recorded: 0, unknownRuns: 2, acceptanceRate: null });
  expect(report.groups.filter(group => group.identity.policyId === policy.policyId).map(group => group.identity.policy)).toHaveLength(3);
  expect(JSON.stringify(runs)).toBe(bytes);
});
