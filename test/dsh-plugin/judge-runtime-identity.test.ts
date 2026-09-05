import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../src/eval-core/contracts/index.js';
import type { ExecutorRuntimeFingerprint } from '../../src/executors/contracts/runtime.js';
import { createJudgeProviderRuntimeIdentity } from '../../src/eval-hosts/node/judge-provider-identity.js';

const RUNTIME: ExecutorRuntimeFingerprint = {
  executor: 'dsh-host',
  model: 'deepseek-test',
  runtimeKind: 'agent-sdk',
  fingerprint: digestCanonicalJson({ dsh: 1 }),
  binary: {
    name: '@deepseek-ai/dsh',
    source: 'path',
    version: '1.2.3',
    path: '/private/dsh/entrypoint.js',
    error: 'must not be persisted',
    package: { name: '@deepseek-ai/dsh', version: '1.2.3', error: 'private error' },
  },
  sdk: { name: 'oh-my-knowledge', version: '1.0.0', error: 'private error' },
  auditability: { status: 'partial', reasons: ['plugin graph is not fully attested'] },
  capabilities: {
    systemPrompt: 'native',
    costUSD: 'reported',
    trace: 'native',
    skillIsolation: 'full-no-partial',
  },
};

describe('DSH judge Runtime identity', () => {
  it('keeps an undeclared deployment opaque and excludes private host diagnostics', () => {
    const identity = createJudgeProviderRuntimeIdentity({
      executorId: 'dsh-host',
      model: 'deepseek-test',
      executorRuntime: RUNTIME,
    });

    expect(identity).toMatchObject({
      fingerprintBasis: 'opaque',
      assuranceLevel: 'unknown',
    });
    expect(JSON.stringify(identity)).not.toContain('/private/dsh/entrypoint.js');
    expect(JSON.stringify(identity)).not.toContain('must not be persisted');
    expect(JSON.stringify(identity)).not.toContain('private error');
  });

  it('binds a declared deployment revision without overstating partial host assurance', () => {
    const first = createJudgeProviderRuntimeIdentity({
      executorId: 'dsh-host',
      model: 'deepseek-test',
      deploymentRevision: 'host-release-1',
      executorRuntime: RUNTIME,
    });
    const second = createJudgeProviderRuntimeIdentity({
      executorId: 'dsh-host',
      model: 'deepseek-test',
      deploymentRevision: 'host-release-2',
      executorRuntime: RUNTIME,
    });

    expect(first).toMatchObject({
      fingerprintBasis: 'self-reported',
      assuranceLevel: 'unknown',
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});
