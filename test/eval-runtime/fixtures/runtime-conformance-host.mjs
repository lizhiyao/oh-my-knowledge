import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  RUNTIME_CHECK_RESULT_SCHEMA_VERSION,
  checkRuntime as checkRuntimeFromRoot,
} from 'oh-my-knowledge';
import { checkRuntime } from 'oh-my-knowledge/eval-runtime';

assert.equal(checkRuntimeFromRoot, checkRuntime);

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function assertPassed(result, runtimeKind) {
  assert.equal(result.schemaVersion, RUNTIME_CHECK_RESULT_SCHEMA_VERSION);
  assert.equal(result.runtimeKind, runtimeKind);
  assert.equal(result.evidenceLevel, 'behavioral-probe');
  assert.equal(result.conformant, true, JSON.stringify(result));
  assert.ok(result.checks.every((candidate) => candidate.checkStatus === 'passed'));
}

const executor = {
  executorId: 'clean-room.runtime-check-executor/v1',
  version: '1.0.0',
  schemas: { input: z.string(), output: z.string() },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'serialized' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { revision: 'clean-room-one' },
  async execute({ input, signal }) {
    if (input === 'failure') return { errorCode: 'clean-room-expected-failure' };
    if (input === 'cancellation') await waitForAbort(signal);
    return { output: input };
  },
};
const executorResult = await checkRuntime({
  runtimeKind: 'executor',
  variant: {
    variantId: 'candidate',
    artifact: { name: 'candidate', kind: 'baseline', source: 'baseline', content: null },
    execution: { executor },
  },
  success: { input: 'success', expected: 'success' },
  failure: { input: 'failure', expectedErrorCode: 'clean-room-expected-failure' },
  cancellation: { input: 'cancellation' },
});
assertPassed(executorResult, 'executor');

const values = new Map();
const contentStore = {
  async put(request) {
    values.set(request.digest, structuredClone(request));
    return { digest: request.digest, mediaType: request.mediaType };
  },
};
const contentResolver = {
  async resolve(descriptor) {
    const value = values.get(descriptor.digest);
    assert.ok(value);
    return {
      value: value.value,
      classification: value.classification,
      mediaType: value.mediaType,
    };
  },
};
assertPassed(await checkRuntime({
  runtimeKind: 'content-store',
  contentStore,
  contentResolver,
}), 'content-store');

class MemoryCache {
  entries = new Map();
  async get(key) { return this.entries.get(key); }
  async put(entry) { this.entries.set(entry.cacheKeyDigest, entry); }
}
assertPassed(await checkRuntime({
  runtimeKind: 'cache',
  cacheKind: 'execution',
  cache: new MemoryCache(),
  probeNamespace: 'clean-room-execution-cache',
}), 'cache');
assertPassed(await checkRuntime({
  runtimeKind: 'cache',
  cacheKind: 'evaluation',
  cache: new MemoryCache(),
  probeNamespace: 'clean-room-evaluation-cache',
}), 'cache');

let workspaceSequence = 0;
const workspaceRoots = [];
const workspaceProvider = {
  providerId: 'clean-room.runtime-check-workspace/v1',
  version: '1.0.0',
  async open({ signal }) {
    assert.ok(signal instanceof AbortSignal);
    const root = `/virtual/runtime-check-${workspaceSequence += 1}`;
    workspaceRoots.push(root);
    return { root, close() {} };
  },
};
const workspaceResult = await checkRuntime({
  runtimeKind: 'workspace-provider',
  provider: workspaceProvider,
  descriptor: {
    resourceId: 'clean-room-workspace',
    digest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'application/vnd.omk.workspace-tree',
    classification: 'sensitive',
    size: 1,
  },
  probeNamespace: 'clean-room-workspace-provider',
});
assertPassed(workspaceResult, 'workspace-provider');
assert.ok(workspaceRoots.every((root) => !JSON.stringify(workspaceResult).includes(root)));

const evaluator = {
  evaluatorKind: 'custom',
  evaluatorId: 'clean-room-runtime-check-evaluator',
  instrumentId: 'clean-room.runtime-check-evaluator/v1',
  metric: {
    metricId: 'clean-room-runtime-check-score',
    valueType: 'numeric',
    direction: 'higher-is-better',
    missingPolicyId: 'exclude/v1',
  },
  bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
  implementation: {
    implementationId: 'clean-room.runtime-check-evaluator/v1',
    version: '1.0.0',
    schemas: {
      bindings: z.object({
        actual: z.object({
          mode: z.enum(['score', 'missing', 'invalid', 'failure', 'cancellation']),
        }).strict(),
      }).strict(),
      value: z.number(),
      fingerprintFacets: { bindings: 'actual/v1', value: 'number/v1' },
    },
    fingerprintFacets: { revision: 'clean-room-one' },
    async evaluate({ bindings, signal }) {
      if (bindings.actual.mode === 'failure') {
        return { resultKind: 'failed', errorCode: 'clean-room-evaluator-failure' };
      }
      if (bindings.actual.mode === 'missing') {
        return { resultKind: 'missing', reasonCode: 'clean-room-evaluator-missing' };
      }
      if (bindings.actual.mode === 'invalid') {
        return { resultKind: 'invalid', reasonCode: 'clean-room-evaluator-invalid' };
      }
      if (bindings.actual.mode === 'cancellation') await waitForAbort(signal);
      return { resultKind: 'score', value: 4 };
    },
  },
};
assertPassed(await checkRuntime({
  runtimeKind: 'evaluator',
  evaluator,
  probeNamespace: 'clean-room-evaluator',
  score: { output: { mode: 'score' }, expectedValue: 4 },
  missing: { output: { mode: 'missing' }, expectedReasonCode: 'clean-room-evaluator-missing' },
  invalid: { output: { mode: 'invalid' }, expectedReasonCode: 'clean-room-evaluator-invalid' },
  failure: { output: { mode: 'failure' }, expectedErrorCode: 'clean-room-evaluator-failure' },
  cancellation: { output: { mode: 'cancellation' } },
}), 'evaluator');

const judgeSecret = 'clean-room-private-judge-error';
const judge = {
  judgeId: 'clean-room.runtime-check-judge/v1',
  version: '1.0.0',
  providerCost: { reporting: 'optional' },
  async invoke(request) {
    if (request.prompt.includes('CHECK_FAILURE')) throw new Error(judgeSecret);
    if (request.prompt.includes('CHECK_INVALID')) {
      return { invocationStatus: 'completed', output: 'not JSON' };
    }
    if (request.prompt.includes('CHECK_CANCELLATION')) await waitForAbort(request.signal);
    return {
      invocationStatus: 'completed',
      output: '{"score":5,"reason":"controlled clean-room probe"}',
      usage: {
        totalTokens: 2,
        providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
      },
    };
  },
};
const judgeResult = await checkRuntime({
  runtimeKind: 'judge',
  judge,
  model: 'clean-room-judge-model',
  probeNamespace: 'clean-room-judge',
  allowExternalCalls: true,
  success: { publicProbeText: 'CHECK_SUCCESS', expectedScore: 5 },
  invalidResponse: {
    publicProbeText: 'CHECK_INVALID',
    expectedReasonCode: 'judge-response-non-json',
  },
  failure: { publicProbeText: 'CHECK_FAILURE' },
  cancellation: { publicProbeText: 'CHECK_CANCELLATION' },
});
assertPassed(judgeResult, 'judge');
assert.equal(judgeResult.externalCalls.invocationCount, 4);
assert.equal(JSON.stringify(judgeResult).includes(judgeSecret), false);
assert.equal(JSON.stringify(judgeResult).includes('CHECK_SUCCESS'), false);
