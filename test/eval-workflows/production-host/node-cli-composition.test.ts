import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../../src/eval-core/contracts/index.js';
import type { ExecutorRuntimeFingerprint } from '../../../src/executors/contracts/runtime.js';
import {
  classifyNodeCliEnvironment,
} from '../../../src/eval-hosts/node/node-cli-composition.js';
import { createJudgeProviderRuntimeIdentity } from '../../../src/eval-hosts/node/judge-provider-identity.js';
import { captureClassifiedEnvironment } from '../../../src/eval-hosts/runtime-adapter/adapters/shared/classified-environment.js';

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

describe('Node CLI production environment', () => {
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

  it('preserves network routing and trust locators for isolated runtime processes', () => {
    const proxy = 'http://user:password@127.0.0.1:7890';
    const classified = classifyNodeCliEnvironment({
      PATH: '/usr/bin:/bin',
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1',
      NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
      NODE_OPTIONS: '--require=/tmp/untrusted.js',
    });

    expect(Object.keys(classified)).toEqual([
      'NODE_EXTRA_CA_CERTS',
      'NO_PROXY',
      'PATH',
      'https_proxy',
    ]);
    expect(classified.https_proxy).toEqual({
      value: proxy,
      identity: { identityKind: 'effect-locator' },
      outputTaint: 'secret',
    });
    expect(classified.NODE_OPTIONS).toBeUndefined();

    const captured = captureClassifiedEnvironment(classified);
    expect(captured.values.https_proxy).toBe(proxy);
    expect(captured.identity).toContainEqual({
      keyDigest: digestCanonicalJson('https_proxy'),
      identityKind: 'effect-locator',
      valueDigest: digestCanonicalJson(proxy),
      outputTaint: 'secret',
    });
    expect(JSON.stringify(captured.identity)).not.toContain(proxy);
    expect(captured.outputClassification).toBe('secret');
  });

  it('supports conventional upper- and lower-case proxy variables without broad inheritance', () => {
    const classified = classifyNodeCliEnvironment({
      ALL_PROXY: 'socks5://proxy.example.test:1080',
      HTTPS_PROXY: 'http://proxy.example.test:8443',
      HTTP_PROXY: 'http://proxy.example.test:8080',
      all_proxy: 'socks5://proxy.example.test:1081',
      http_proxy: 'http://proxy.example.test:8081',
      https_proxy: 'http://proxy.example.test:8444',
      no_proxy: 'localhost',
      UNRELATED_SECRET: 'must-not-cross-runtime-boundary',
    });

    expect(Object.keys(classified)).toEqual([
      'ALL_PROXY',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'all_proxy',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ]);
    expect(classified.UNRELATED_SECRET).toBeUndefined();
  });
});
