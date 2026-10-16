import { describe, expect, it } from 'vitest';
import { digestCanonicalJson, type JsonValue } from '../../../../src/eval-core/contracts/index.js';
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
  it('seals the Codex reconnect interpretation in judge identity', () => {
    const identity = createJudgeProviderRuntimeIdentity({
      executorId: 'codex', model: 'gpt-test',
      executorRuntime: { ...EXECUTOR_RUNTIME, executor: 'codex' },
    });
    expect(JSON.stringify(identity)).toContain('codex-reconnect/v2');
    const manifest = identity.implementationManifest;
    const evidence = manifest?.coverageKind === 'fingerprint-plus-facets'
      ? manifest.facets.find((facet) => facet.facetId === 'executor.runtime') : undefined;
    expect(evidence?.value).toMatchObject({ protocolAdapterVersion: 'codex-reconnect/v2' });
    expect(identity.fingerprint).toBe(digestCanonicalJson({
      derivation: 'omk.judge-provider-runtime/v2', executorId: 'codex', model: 'gpt-test',
      deployment: { coverage: 'remote-opaque' }, executorRuntime: evidence!.value,
    }));
  });

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
    const manifest = identity.implementationManifest;
    if (manifest?.coverageKind !== 'fingerprint-plus-facets') throw new Error('Missing provider facets');
    const runtime = manifest.facets.find(facet => facet.facetId === 'executor.runtime')!.value;
    expect(runtime).toMatchObject({ protocolAdapterVersion: 'openai-chat-completions/v3' });
    expect(identity.fingerprint).toBe(digestCanonicalJson({
      derivation: 'omk.judge-provider-runtime/v3', executorId: 'openai-api', model: 'gpt-test',
      deployment: { coverage: 'remote-opaque' }, executorRuntime: runtime,
    }));
    const previousRuntime = { ...runtime as Record<string, JsonValue> };
    delete previousRuntime.protocolAdapterVersion;
    expect(identity.fingerprint).not.toBe(digestCanonicalJson({
      derivation: 'omk.judge-provider-runtime/v2', executorId: 'openai-api', model: 'gpt-test',
      deployment: { coverage: 'remote-opaque' }, executorRuntime: previousRuntime,
    }));
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
