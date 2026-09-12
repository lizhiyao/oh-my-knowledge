import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  EXECUTED_EVALUATION_MEDIA_TYPE,
  executeEvaluation,
  loadExecutedEvaluation,
  saveExecutedEvaluation,
  scoreExecutedEvaluation,
} from 'oh-my-knowledge';
import { canonicalizeJson, digestCanonicalJson } from 'oh-my-knowledge/eval-core';

// Host storage for one execution envelope. Storage belongs to the host — OMK only
// calls the injected put()/resolve() ports and never discovers or provisions them.
// The executed envelope is Gold: Target evidence must never be handed back to a
// Target as context, so this store refuses any other classification.
export function createFileContentStore(contentDir) {
  const pathOf = (digest) => join(contentDir, `${digest.slice('sha256:'.length)}.json`);
  return {
    store: {
      async put({ value, classification, mediaType, digest }) {
        if (digestCanonicalJson(value) !== digest) {
          throw new Error('Content digest mismatch at store boundary.');
        }
        if (classification !== 'gold' || mediaType !== EXECUTED_EVALUATION_MEDIA_TYPE) {
          throw new Error('Executed envelopes must be stored as gold under the executed media type.');
        }
        await writeFile(
          pathOf(digest),
          canonicalizeJson({ value, classification, mediaType }),
          'utf8',
        );
        return { mediaType, digest, size: Buffer.byteLength(canonicalizeJson(value), 'utf8') };
      },
    },
    resolver: {
      async resolve(descriptor) {
        const record = JSON.parse(await readFile(pathOf(descriptor.digest), 'utf8'));
        // Storage integrity only: bytes did not change. Where they came from is the
        // verifier's job below.
        if (digestCanonicalJson(record.value) !== descriptor.digest) {
          throw new Error('Resolved content digest mismatch.');
        }
        if (descriptor.size !== undefined
            && Buffer.byteLength(canonicalizeJson(record.value), 'utf8') !== descriptor.size) {
          throw new Error('Resolved content size mismatch.');
        }
        return {
          value: record.value,
          classification: record.classification,
          mediaType: record.mediaType,
        };
      },
    },
  };
}

// The attestation key lives in host process memory for this example only. In
// production it belongs to your signing/audit service, never to OMK.
const attestationKey = randomBytes(32);

function signReceipt(receipt) {
  return createHmac('sha256', attestationKey).update(canonicalizeJson(receipt)).digest('hex');
}

// Consumer-side verifier: releases digest sets ONLY from the signed witness recorded
// when the Execution stage ran. Echoing the envelope's own claims back is not
// authentication — the envelope is exactly what a compromised store could forge.
export function createExecutionReceiptVerifier(auditReceiptPath, observed = {}) {
  return {
    verifierId: 'example.execution-receipt-verifier/v1',
    async verify({ reference }) {
      const { receipt, signature } = JSON.parse(await readFile(auditReceiptPath, 'utf8'));
      const expected = Buffer.from(signReceipt(receipt), 'hex');
      const actual = Buffer.from(signature, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('Execution receipt signature failed.');
      }
      if (receipt.executedDigest !== reference.digest) {
        throw new Error('Execution receipt does not cover the referenced envelope.');
      }
      observed.executedDigest = reference.digest;
      return {
        verifiedExecutedDigest: reference.digest,
        attestationDigest: `sha256:${signature}`,
        verifiedProvenanceBundleDigests: receipt.verifiedProvenanceBundleDigests,
        verifiedCacheRecordDigests: receipt.verifiedCacheRecordDigests,
      };
    },
  };
}

// Fixed simulated answers: no model calls, no accounts.
const answers = {
  'answer-prompt': { '法国的首都是哪里？': '巴黎', '英国的首都是哪里？': '伦敦', '日本的首都是哪里？': '京都' },
};
let targetInvocations = 0;
const executor = {
  executorId: 'example.answer-service/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ prompt: z.string() }).strict(),
    config: z.object({ deployment: z.enum(['answer-prompt']) }).strict(),
    output: z.string(),
  },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { deploymentRevision: 'staged-example-1' },
  async execute({ input, config, signal }) {
    targetInvocations += 1;
    signal.throwIfAborted();
    return { output: answers[config.deployment][input.prompt] };
  },
};

// Both scoring rounds re-declare the same contract from a fresh object, as a later
// process would from its own declaration source. Only the Gold label differs.
function declaration() {
  return {
    dataset: {
      datasetId: 'staged-execute-score-example',
      samples: [
        { sampleId: 'one', input: { prompt: '法国的首都是哪里？' }, expected: '巴黎' },
        { sampleId: 'two', input: { prompt: '英国的首都是哪里？' }, expected: '伦敦' },
        { sampleId: 'three', input: { prompt: '日本的首都是哪里？' }, expected: '东京' },
      ],
    },
    variants: [{
      variantId: 'answer-prompt',
      artifact: {
        name: 'answer-prompt',
        kind: 'prompt',
        source: 'inline',
        content: 'Answer with the expected label.',
      },
      execution: { executor, config: { deployment: 'answer-prompt' } },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' }],
    comparisons: [],
    analyses: [{
      analysisId: 'answer-prompt-correct',
      analysisKind: 'summary',
      statistic: 'rate',
      variantId: 'answer-prompt',
      metricId: 'correct',
    }],
    experiment: { seed: 'staged-example-seed', sampling: { samplingKind: 'solo' } },
    policy: {
      execution: { maxConcurrency: 2 },
      evaluation: { maxConcurrency: 2 },
    },
  };
}

const storeRoot = await mkdtemp(join(tmpdir(), 'omk-staged-execute-score-example-'));
try {
  const contentDir = join(storeRoot, 'content');
  const auditDir = join(storeRoot, 'audit');
  await mkdir(contentDir, { recursive: true });
  await mkdir(auditDir, { recursive: true });
  const { store, resolver } = createFileContentStore(contentDir);

  // --- Process 1: run the Target once and stop before any scoring rule exists. ---
  const executed = await executeEvaluation(declaration(), { runId: 'staged-execution' });
  assert.equal(targetInvocations, 3);
  assert.equal(executed.bundleOrigin, 'runtime');
  assert.equal(executed.bundle.records.length, 3);

  const reference = await saveExecutedEvaluation({ executed, store });

  // The producing host witnessed exactly one Execution stage: its own executor served
  // every call, and no cached record was reused. Sign that witness, not the envelope.
  const receipt = {
    executedDigest: reference.digest,
    verifiedProvenanceBundleDigests: [executed.bundle.bundleDigest],
    verifiedCacheRecordDigests: [],
  };
  const auditReceiptPath = join(auditDir, `${reference.digest.slice('sha256:'.length)}.json`);
  await writeFile(
    auditReceiptPath,
    canonicalizeJson({ receipt, signature: signReceipt(receipt) }),
    'utf8',
  );

  // --- Process 2 (simulated): re-admit the envelope and score it twice. ---
  const persistedReference = JSON.parse(JSON.stringify(reference));
  const observed = {};
  const reloaded = await loadExecutedEvaluation({
    reference: persistedReference,
    resolver,
    verifier: createExecutionReceiptVerifier(auditReceiptPath, observed),
  });
  assert.equal(observed.executedDigest, reference.digest);
  assert.equal(reloaded.bundleOrigin, 'store');
  assert.deepStrictEqual(reloaded.bundle, executed.bundle);
  assert.notEqual(reloaded.bundle, executed.bundle);

  const originalGold = declaration();
  const correctedGold = declaration();
  correctedGold.dataset.samples[2].expected = '京都';
  const original = await scoreExecutedEvaluation(originalGold, reloaded, {
    runId: 'staged-scored-original',
  });
  const corrected = await scoreExecutedEvaluation(correctedGold, reloaded, {
    runId: 'staged-scored-corrected',
  });

  // Both scorings ran on the persisted envelope: no extra Target call, and the same
  // Execution bundle identity in both results.
  assert.equal(targetInvocations, 3);
  assert.equal(original.artifacts?.execution?.bundleDigest, executed.bundle.bundleDigest);
  assert.equal(corrected.artifacts?.execution?.bundleDigest, executed.bundle.bundleDigest);
  assert.notEqual(
    original.artifacts?.evaluation?.bundleDigest,
    corrected.artifacts?.evaluation?.bundleDigest,
  );
  assert.equal(corrected.analysisResults['answer-prompt-correct'].value, 1);
  assert.equal(original.analysisResults['answer-prompt-correct'].value, 2 / 3);

  // Fail-closed demo 1: a declaration whose Execution stage changed cannot borrow
  // this envelope, even though only its prompt differs.
  const changedPrompt = declaration();
  changedPrompt.variants[0].artifact.content = 'Answer briefly.';
  await assert.rejects(
    scoreExecutedEvaluation(changedPrompt, reloaded, { runId: 'staged-scored-rejected' }),
    (error) => error?.code === 'EVAL_RUNTIME_REUSE_INVALID' && error.cause === undefined,
  );
  assert.equal(targetInvocations, 3);

  // Fail-closed demo 2: a hand-built handle has no source authority.
  await assert.rejects(
    scoreExecutedEvaluation(declaration(), structuredClone(reloaded), {
      runId: 'staged-scored-forged',
    }),
    (error) => error?.code === 'EVAL_RUNTIME_REUSE_INVALID',
  );

  // Fail-closed demo 3: storage integrity alone never restores trust. A verifier that
  // authenticates nothing beyond the digest still yields a usable envelope, but its
  // Report may claim only unknown provenance.
  const unattested = await loadExecutedEvaluation({
    reference: persistedReference,
    resolver,
    verifier: {
      verifierId: 'example.checksum-only-verifier/v1',
      async verify({ reference: requested }) {
        return {
          verifiedExecutedDigest: requested.digest,
          attestationDigest: `sha256:${createHash('sha256').update(requested.digest).digest('hex')}`,
          verifiedProvenanceBundleDigests: [],
          verifiedCacheRecordDigests: [],
        };
      },
    },
  });
  const unattestedResult = await scoreExecutedEvaluation(declaration(), unattested, {
    runId: 'staged-scored-unattested',
  });
  assert.equal(unattestedResult.report?.provenance.trust, 'unknown');
  assert.equal(corrected.report?.provenance.trust, 'declared');
  assert.equal(targetInvocations, 3);

  console.log(JSON.stringify({
    savedReference: reference,
    executionOnly: { runId: executed.runId, records: executed.bundle.records.length },
    targetInvocations,
    scored: {
      original: {
        runId: original.runId,
        answerRate: original.analysisResults['answer-prompt-correct'].value,
        provenanceTrust: original.report?.provenance.trust,
      },
      corrected: {
        runId: corrected.runId,
        answerRate: corrected.analysisResults['answer-prompt-correct'].value,
      },
      unattested: {
        runId: unattestedResult.runId,
        provenanceTrust: unattestedResult.report?.provenance.trust,
      },
    },
    rejected: [
      'changed Execution stage (EVAL_RUNTIME_REUSE_INVALID)',
      'cloned handle (EVAL_RUNTIME_REUSE_INVALID)',
    ],
  }, null, 2));
} finally {
  await rm(storeRoot, { recursive: true, force: true });
}
