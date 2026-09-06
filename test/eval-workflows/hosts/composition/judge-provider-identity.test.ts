import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../../../src/eval-core/contracts/index.js';
import type { ExecutorRuntimeFingerprint } from '../../../../src/executors/contracts/runtime.js';
import { createJudgeProviderRuntimeIdentity } from '../../../../src/eval-workflows/hosts/composition/judge-provider-identity.js';

const EXECUTOR_RUNTIME: ExecutorRuntimeFingerprint = {
  executor: 'openai-api',
  model: 'gpt-test',
  runtimeKind: 'api',
  fingerprint: digestCanonicalJson({ adapter: 'openai-api', version: 1 }),
  binary: {
    name: 'node',
    source: 'path',
    version: 'v24.0.0',
    path: '/private/host/node',
    error: 'must not be persisted',
    package: { name: 'openai', version: '5.0.0', error: 'must not be persisted' },
  },
  auditability: { status: 'partial', reasons: ['remote-deployment-opaque'] },
  capabilities: {
    systemPrompt: 'native',
    costUSD: 'reported',
    trace: 'none',
    skillIsolation: 'none',
  },
};

describe('Node judge provider identity', () => {
  it('treats undeclared remote judge deployments as opaque', () => {
    const identity = createJudgeProviderRuntimeIdentity({
      executorId: 'openai-api',
      model: 'gpt-test',
      executorRuntime: EXECUTOR_RUNTIME,
    });

    expect(identity).toMatchObject({
      fingerprintBasis: 'opaque',
      assuranceLevel: 'unknown',
      capabilities: { deploymentCoverage: 'remote-opaque' },
    });
    expect(JSON.stringify(identity)).not.toContain('/private/host/node');
    expect(JSON.stringify(identity)).not.toContain('must not be persisted');
  });

  it('seals an explicit deployment revision without pretending it was verified', () => {
    const completeRuntime = { ...EXECUTOR_RUNTIME, auditability: { status: 'complete' as const } };
    const first = createJudgeProviderRuntimeIdentity({
      executorId: 'openai-api',
      model: 'gpt-test',
      deploymentRevision: 'gateway-release-41',
      executorRuntime: completeRuntime,
    });
    const second = createJudgeProviderRuntimeIdentity({
      executorId: 'openai-api',
      model: 'gpt-test',
      deploymentRevision: 'gateway-release-42',
      executorRuntime: completeRuntime,
    });
    const changedAdapter = createJudgeProviderRuntimeIdentity({
      executorId: 'openai-api',
      model: 'gpt-test',
      deploymentRevision: 'gateway-release-41',
      executorRuntime: {
        ...completeRuntime,
        fingerprint: digestCanonicalJson({ adapter: 'openai-api', version: 2 }),
      },
    });

    expect(first).toMatchObject({
      fingerprintBasis: 'self-reported',
      assuranceLevel: 'declared',
      capabilities: { deploymentCoverage: 'host-declared' },
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe(changedAdapter.fingerprint);
    expect(() => createJudgeProviderRuntimeIdentity({
      executorId: 'openai-api',
      model: 'gpt-test',
      deploymentRevision: ' ',
      executorRuntime: EXECUTOR_RUNTIME,
    })).toThrow(/non-empty/);
  });

});
