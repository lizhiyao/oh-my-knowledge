import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
} from '../../eval-core/contracts/index.js';
import type { ExecutorRuntimeFingerprint } from '../../executors/contracts/runtime.js';

function executorRuntimeEvidence(
  runtime: Readonly<ExecutorRuntimeFingerprint>,
): JsonValue {
  return {
    executor: runtime.executor,
    model: runtime.model,
    runtimeKind: runtime.runtimeKind,
    fingerprint: runtime.fingerprint,
    capabilities: runtime.capabilities as unknown as JsonValue,
    ...(runtime.binary === undefined ? {} : {
      binary: {
        name: runtime.binary.name,
        source: runtime.binary.source,
        ...(runtime.binary.version === undefined ? {} : { version: runtime.binary.version }),
        ...(runtime.binary.contentHash === undefined
          ? {}
          : { contentHash: runtime.binary.contentHash }),
        ...(runtime.binary.package === undefined ? {} : {
          package: {
            name: runtime.binary.package.name,
            ...(runtime.binary.package.version === undefined
              ? {}
              : { version: runtime.binary.package.version }),
          },
        }),
      },
    }),
    ...(runtime.sdk === undefined ? {} : {
      sdk: {
        name: runtime.sdk.name,
        ...(runtime.sdk.version === undefined ? {} : { version: runtime.sdk.version }),
      },
    }),
    ...(runtime.auditability === undefined ? {} : {
      auditability: runtime.auditability as unknown as JsonValue,
    }),
  };
}

/** Seals local adapter evidence and an explicit remote-deployment coverage boundary. */
export function createJudgeProviderRuntimeIdentity(input: Readonly<{
  executorId: string;
  model: string;
  deploymentRevision?: string;
  executorRuntime: ExecutorRuntimeFingerprint;
}>): RuntimeIdentity {
  if (input.deploymentRevision !== undefined && input.deploymentRevision.trim() === '') {
    throw new TypeError('Judge provider deployment revision must be a non-empty string.');
  }
  if (input.executorRuntime.executor !== input.executorId
      || input.executorRuntime.model !== input.model) {
    throw new TypeError('Judge provider Runtime fingerprint differs from its selected binding.');
  }
  const executorRuntime = executorRuntimeEvidence(input.executorRuntime);
  const deployment = input.deploymentRevision === undefined
    ? { coverage: 'remote-opaque' as const }
    : { coverage: 'host-declared' as const, revision: input.deploymentRevision };
  const capabilities = {
    providerInvocation: 'single',
    model: input.model,
    deploymentCoverage: deployment.coverage,
  };
  const assuranceLevel = input.deploymentRevision === undefined
      || input.executorRuntime.auditability?.status === 'partial'
    ? 'unknown'
    : 'declared';
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: input.executorId,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.judge-provider-runtime/v1',
      executorId: input.executorId,
      model: input.model,
      deployment,
      executorRuntime,
    }),
    fingerprintBasis: input.deploymentRevision === undefined ? 'opaque' : 'self-reported',
    assuranceLevel,
    capabilities,
    implementationManifest: {
      coverageKind: 'fingerprint-plus-facets',
      facets: [{
        facetId: 'executor.runtime',
        value: executorRuntime,
      }, {
        facetId: 'provider.binding',
        value: {
          executorId: input.executorId,
          model: input.model,
        },
      }, {
        facetId: 'provider.deployment',
        value: deployment,
      }],
    },
  })) as RuntimeIdentity;
}
