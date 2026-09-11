import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  EVALUATION_RESULT_MEDIA_TYPE,
  evaluate,
  loadEvaluationResult,
  prepareEvaluation,
  rescore,
  saveEvaluationResult,
} from 'oh-my-knowledge';
import { canonicalizeJson, digestCanonicalJson } from 'oh-my-knowledge/eval-core';

// Reference host storage: ContentStore.put / ContentResolver.resolve over node:fs.
// Storage belongs to the host — OMK never discovers, provisions, or scans it; the
// Runtime only calls the explicitly injected put()/resolve() ports. Credentials,
// tenancy, retention, and the physical root stay on the host side.
export function createFileContentStore(contentDir) {
  const pathOf = (digest) => join(contentDir, `${digest.slice('sha256:'.length)}.json`);
  return {
    store: {
      async put({ value, classification, mediaType, digest }) {
        // Fail closed: persist only when OMK's digest matches the host's own
        // recomputation over the canonical JSON bytes.
        if (digestCanonicalJson(value) !== digest) {
          throw new Error('Content digest mismatch at store boundary.');
        }
        // A stored result carries Dataset Gold, so Runtime always declares this pair; anything
        // else means this store is being handed content that is not an evaluation result.
        if (classification !== 'gold' || mediaType !== EVALUATION_RESULT_MEDIA_TYPE) {
          throw new Error('Evaluation results must be stored as gold under the result media type.');
        }
        await writeFile(
          pathOf(digest),
          canonicalizeJson({ value, classification, mediaType }),
          'utf8',
        );
        // size is optional; when returned it must equal the canonical byte length.
        return { mediaType, digest, size: Buffer.byteLength(canonicalizeJson(value), 'utf8') };
      },
    },
    resolver: {
      async resolve(descriptor) {
        const record = JSON.parse(await readFile(pathOf(descriptor.digest), 'utf8'));
        // Storage-integrity re-check: proves the bytes did not change, NOT where
        // they came from. Provenance is the independent verifier's job below.
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
// production it belongs to your signing/audit service (KMS, transparency log,
// internal attestation authority) — never to OMK.
const attestationKey = randomBytes(32);

function signReceipt(receipt) {
  return createHmac('sha256', attestationKey).update(canonicalizeJson(receipt)).digest('hex');
}

// Consumer-side verifier: releases digest sets ONLY from the signed audit receipt
// witnessed at production time. Two anti-patterns are deliberately avoided here:
// 1. Checksum-only verification (content matches its digest) is insufficient by
//    contract — a tampered store would then vouch for itself.
// 2. Parsing the stored envelope and echoing its bundle claims back is equally
//    insufficient: the envelope is exactly what a compromised store could forge.
// Only certify what the host independently authenticated; everything else stays
// empty and the Runtime fails closed on unauthenticated claims.
export function createAuditReceiptVerifier(auditReceiptPath, observed = {}) {
  return {
    verifierId: 'example.audit-receipt-verifier/v1',
    async verify({ reference, planDigest }) {
      const { receipt, signature } = JSON.parse(await readFile(auditReceiptPath, 'utf8'));
      const expected = Buffer.from(signReceipt(receipt), 'hex');
      const actual = Buffer.from(signature, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('Audit receipt signature failed.');
      }
      if (receipt.resultDigest !== reference.digest) {
        throw new Error('Audit receipt does not cover the referenced result.');
      }
      observed.planDigest = planDigest;
      return {
        verifiedResultDigest: reference.digest,
        attestationDigest: `sha256:${signature}`,
        verifiedProvenanceBundleDigests: receipt.verifiedProvenanceBundleDigests,
        verifiedCacheRecordDigests: receipt.verifiedCacheRecordDigests,
        verifiedPolicyExecutionDigests: receipt.verifiedPolicyExecutionDigests,
      };
    },
  };
}

// Fixed simulated answers, as in run.mjs: no model calls, no accounts.
const answers = {
  baseline: { '法国的首都是哪里？': '巴黎', '英国的首都是哪里？': '伦敦', '日本的首都是哪里？': '京都' },
  candidate: { '法国的首都是哪里？': '巴黎', '英国的首都是哪里？': '伦敦', '日本的首都是哪里？': '东京' },
};
let targetInvocations = 0;
const executor = {
  executorId: 'example.answer-service/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ prompt: z.string() }).strict(),
    config: z.object({ deployment: z.enum(['baseline', 'candidate']) }).strict(),
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
  fingerprintFacets: { deploymentRevision: 'result-store-example-1' },
  async execute({ input, config, signal }) {
    targetInvocations += 1;
    signal.throwIfAborted();
    return { output: answers[config.deployment][input.prompt] };
  },
};

// The consumer re-declares the exact same contract from a fresh object, as a
// second process would from its own declaration source.
function declaration() {
  return {
    dataset: {
      datasetId: 'result-store-example',
      samples: [
        { sampleId: 'one', input: { prompt: '法国的首都是哪里？' }, expected: '巴黎' },
        { sampleId: 'two', input: { prompt: '英国的首都是哪里？' }, expected: '伦敦' },
        { sampleId: 'three', input: { prompt: '日本的首都是哪里？' }, expected: '东京' },
      ],
    },
    variants: [{
      variantId: 'baseline',
      artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
      execution: { executor, config: { deployment: 'baseline' } },
    }, {
      variantId: 'candidate',
      artifact: {
        name: 'answer-prompt',
        kind: 'prompt',
        source: 'inline',
        content: 'Answer with the expected label.',
      },
      execution: { executor, config: { deployment: 'candidate' } },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' }],
    comparisons: [{
      comparisonId: 'baseline-vs-candidate',
      controlVariantId: 'baseline',
      treatmentVariantIds: ['candidate'],
      metricIds: ['correct'],
    }],
    analyses: [{
      analysisId: 'baseline-vs-candidate-correct',
      analysisKind: 'comparison-interval',
      statistic: 'mean-difference',
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: 'candidate',
      metricId: 'correct',
      confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
    }],
    decision: {
      decisionKind: 'analysis',
      analysisId: 'baseline-vs-candidate-correct',
    },
    experiment: { seed: 'result-store-example-seed', sampling: { samplingKind: 'paired' } },
    policy: {
      execution: { maxConcurrency: 2 },
      evaluation: { maxConcurrency: 2 },
    },
  };
}

const storeRoot = await mkdtemp(join(tmpdir(), 'omk-result-store-example-'));
try {
  const contentDir = join(storeRoot, 'content');
  const auditDir = join(storeRoot, 'audit');
  await mkdir(contentDir, { recursive: true });
  await mkdir(auditDir, { recursive: true });
  const { store, resolver } = createFileContentStore(contentDir);

  // --- Process 1: produce, save, and sign the production witness. ---
  const result = await evaluate(declaration(), { runId: 'result-store-producer' });
  if (result.status !== 'completed') throw new Error(result.error.code);
  assert.equal(targetInvocations, 6);

  const reference = await saveEvaluationResult({ result, store });

  // The producing host witnessed the run: its own executor served every call and
  // the canonical Runtime handed back the live result in this process. That
  // witness — not the stored envelope — is the host's independent position for
  // authenticating provenance. Sign it into the host's own audit trail.
  const receipt = {
    resultDigest: reference.digest,
    verifiedProvenanceBundleDigests: [
      result.artifacts.execution.bundleDigest,
      result.artifacts.evaluation.bundleDigest,
      result.artifacts.analysis.bundleDigest,
    ],
    // This run reused no cached records, so the witness saw zero cache receipts.
    // Certify only what you actually authenticated; cache digests must come from
    // receipts recorded at reuse time and are never inferred from a Bundle claim.
    verifiedCacheRecordDigests: [],
    verifiedPolicyExecutionDigests: [result.artifacts.decision.decisionDigest],
  };
  const auditReceiptPath = join(auditDir, `${reference.digest.slice('sha256:'.length)}.json`);
  await writeFile(
    auditReceiptPath,
    canonicalizeJson({ receipt, signature: signReceipt(receipt) }),
    'utf8',
  );

  // --- Process 2 (simulated): re-declare, load through the trust boundary. ---
  const prepared = await prepareEvaluation(declaration());
  // As if read back from the host's result index across a serialization boundary.
  const persistedReference = JSON.parse(JSON.stringify(reference));

  // Fail-closed demo: a checksum-only verifier that authenticates nothing beyond
  // storage integrity cannot restore the result.
  await assert.rejects(
    loadEvaluationResult({
      prepared,
      reference: persistedReference,
      resolver,
      verifier: {
        verifierId: 'example.checksum-only-verifier/v1',
        async verify({ reference: requested }) {
          return {
            verifiedResultDigest: requested.digest,
            attestationDigest: `sha256:${createHash('sha256')
              .update(requested.digest)
              .digest('hex')}`,
            verifiedProvenanceBundleDigests: [],
            verifiedCacheRecordDigests: [],
            verifiedPolicyExecutionDigests: [],
          };
        },
      },
    }),
    (error) => error?.code === 'EVAL_RUNTIME_RESULT_CONTENT_INVALID',
  );

  const observed = {};
  const restored = await loadEvaluationResult({
    prepared,
    reference: persistedReference,
    resolver,
    verifier: createAuditReceiptVerifier(auditReceiptPath, observed),
  });
  // The stored envelope's planDigest (seen by the verifier) matches the sealed
  // plan the consumer just prepared, and the restored result is content-identical
  // to the original.
  assert.equal(observed.planDigest, prepared.planDigest);
  assert.deepStrictEqual(restored, result);
  assert.notEqual(restored, result);

  // --- Reuse the restored result: rescore with a corrected Gold label. ---
  const rescoreInput = declaration();
  rescoreInput.dataset.samples[2].expected = '京都';
  const rescored = await rescore(rescoreInput, restored, { runId: 'result-store-rescored' });
  // The Execution stage is reused from the restored result: no extra target call.
  assert.equal(targetInvocations, 6);
  assert.equal(rescored.artifacts.execution, restored.artifacts.execution);
  assert.notEqual(
    rescored.artifacts.evaluation.bundleDigest,
    restored.artifacts.evaluation.bundleDigest,
  );

  console.log(JSON.stringify({
    savedReference: reference,
    planDigest: prepared.planDigest,
    verifierObservedPlanDigest: observed.planDigest,
    restoreMatchesOriginal: true,
    checksumOnlyVerifierRejectedWith: 'EVAL_RUNTIME_RESULT_CONTENT_INVALID',
    targetInvocations,
    rescore: {
      runId: rescored.runId,
      executionStageReused: true,
      verdict: rescored.artifacts.decision?.verdict ?? null,
    },
  }, null, 2));
} finally {
  await rm(storeRoot, { recursive: true, force: true });
}
