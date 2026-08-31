import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type EvaluationDefinition,
  type JsonValue,
  type RuntimeIdentity,
  type RuntimeImplementationFacet,
  type UsageRecord,
} from '../../../evaluation-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorTrialContext,
} from '../../../evaluation-core/execution/index.js';
import type { RuntimeBindingOf } from '../types.js';
import type { OmkBindingResourceLeaseAccess } from '../resource-leases/types.js';
import {
  assertCodexIdentityFilesUnchanged,
  captureCodexIdentityFiles,
  type CapturedCodexIdentityFile,
} from './codex-content-identity.js';
import {
  captureCodexEnvironment,
  type CodexEnvironmentEntry,
} from './codex-environment.js';
import { mergeOutputClassification } from './classified-environment.js';
import {
  codexSdkExecutorCapabilities,
  parseCodexSdkStream,
  type ParsedCodexSdkStream,
} from './codex-sdk-protocol.js';
import {
  CODEX_SDK_RESOURCE_PROFILE,
  captureCodexRunState,
  captureCodexTarget,
  promptForCodexTrial,
  selectCodexSandbox,
  type CapturedCodexTarget,
  type CodexRunState,
} from './codex-resources.js';
import {
  resolveInstalledCodexSdkRuntime,
  type CodexSdkRuntimeResolver,
  type ResolvedCodexSdkRuntime,
} from './codex-sdk-runtime.js';
import { createSameProcessExecutorAdapter } from './same-process.js';

export {
  CODEX_SDK_READ_ONLY_SANDBOX_ID,
  CODEX_SDK_WORKSPACE_WRITE_SANDBOX_ID,
  createCodexSdkCoreSchemaValidators,
} from './codex-sdk-protocol.js';
export {
  resolveInstalledCodexSdkRuntime,
  type CodexSdkClient,
  type CodexSdkClientOptions,
  type CodexSdkRuntimeResolver,
  type CodexSdkThread,
  type CodexSdkThreadOptions,
  type ResolvedCodexSdkRuntime,
} from './codex-sdk-runtime.js';

export const CODEX_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION = '1.1.0' as const;
export const DEFAULT_CODEX_SDK_MAX_EVENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CODEX_SDK_MAX_PROMPT_BYTES = 2 * 1024 * 1024;

export type CodexSdkEnvironmentEntry = CodexEnvironmentEntry;

export interface CodexSdkCoreConfiguration {
  /** Complete classified environment. Nothing is inherited from process.env. */
  readonly environment?: Readonly<Record<string, CodexSdkEnvironmentEntry>>;
  readonly maxEventBytes?: number;
  readonly maxPromptBytes?: number;
  /** Trusted host seam for offline conformance tests and alternative module resolvers. */
  readonly runtimeResolver?: CodexSdkRuntimeResolver;
}

export interface CreateCodexSdkExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly sdk?: CodexSdkCoreConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

interface CapturedConfiguration {
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: JsonValue[];
  readonly environmentOutputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxEventBytes: number;
  readonly maxPromptBytes: number;
}

interface CodexSdkRunState {
  readonly resources: CodexRunState;
  readonly codexHome: string;
}

function fail(
  code: string,
  stage: 'infrastructure' | 'execution',
  message: string,
  usage?: UsageRecord,
): never {
  throw new ExecutionPortFailure({ code, stage, message }, usage);
}

function selectCodexSdkSandbox(
  target: CapturedCodexTarget,
): 'read-only' | 'workspace-write' {
  return selectCodexSandbox(target.config, CODEX_SDK_RESOURCE_PROFILE);
}

function captureConfiguration(
  input: Readonly<CodexSdkCoreConfiguration>,
): CapturedConfiguration {
  const environment = captureCodexEnvironment(input.environment);
  if (Object.keys(environment.values).some((key) => key.toLowerCase() === 'codex_home')) {
    throw new TypeError('Codex SDK environment must not override adapter-owned CODEX_HOME.');
  }
  const maxEventBytes = input.maxEventBytes ?? DEFAULT_CODEX_SDK_MAX_EVENT_BYTES;
  const maxPromptBytes = input.maxPromptBytes ?? DEFAULT_CODEX_SDK_MAX_PROMPT_BYTES;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
    throw new TypeError('Codex SDK maxEventBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes <= 0) {
    throw new TypeError('Codex SDK maxPromptBytes must be a positive safe integer.');
  }
  return Object.freeze({
    environment: environment.values,
    environmentIdentity: environment.identity,
    environmentOutputClassification: environment.outputClassification,
    maxEventBytes,
    maxPromptBytes,
  });
}

function captureRuntime(runtime: ResolvedCodexSdkRuntime): Readonly<{
  sdkVersion: string;
  codexVersion: string;
  createClient: ResolvedCodexSdkRuntime['createClient'];
  contentIdentityFiles: ResolvedCodexSdkRuntime['contentIdentityFiles'];
}> {
  if (
    typeof runtime.sdkVersion !== 'string'
    || runtime.sdkVersion.trim() === ''
    || typeof runtime.codexVersion !== 'string'
    || runtime.codexVersion.trim() === ''
    || typeof runtime.createClient !== 'function'
    || !Array.isArray(runtime.contentIdentityFiles)
  ) throw new TypeError('Codex SDK runtime resolver returned an invalid result.');
  const contentIdentityFiles = structuredClone(runtime.contentIdentityFiles);
  const facetIds = new Set(contentIdentityFiles.map((file) => file.facetId));
  if (
    !facetIds.has('codex-sdk.package-manifest')
    || !facetIds.has('codex-sdk.entrypoint')
    || !facetIds.has('codex.package-manifest')
    || !facetIds.has('codex-native.package-manifest')
    || !facetIds.has('codex-native.executable')
  ) throw new TypeError('Codex SDK runtime identity coverage is incomplete.');
  return Object.freeze({
    sdkVersion: runtime.sdkVersion,
    codexVersion: runtime.codexVersion,
    createClient: runtime.createClient.bind(runtime),
    contentIdentityFiles: Object.freeze(contentIdentityFiles),
  });
}

function identityManifest(
  configuration: CapturedConfiguration,
  target: CapturedCodexTarget,
  runtime: ReturnType<typeof captureRuntime>,
  files: readonly CapturedCodexIdentityFile[],
): RuntimeIdentity['implementationManifest'] {
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      adapterVersion: CODEX_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      cancellation: 'node-spawn-abort-signal-via-sdk',
      clientLifecycle: 'per-attempt',
      processIsolation: 'sdk-child-per-attempt',
      sourceProtocol: '@openai/codex-sdk runStreamed',
    },
  }, {
    facetId: 'adapter.environment',
    value: { entries: [...configuration.environmentIdentity] },
  }, {
    facetId: 'adapter.input-projection',
    value: {
      artifact: 'entrypoint-instructions-plus-supporting-files',
      directoryEntrypoint: 'SKILL.md',
      envelope: 'canonical-json',
      executionContext: 'executionContext-field',
      task: 'task-field',
      version: 'omk.codex-sdk-prompt/v1',
    },
  }, {
    facetId: 'adapter.limits',
    value: {
      maxEventBytes: configuration.maxEventBytes,
      maxPromptBytes: configuration.maxPromptBytes,
    },
  }, {
    facetId: 'codex.fixed-controls',
    value: {
      approvalPolicy: 'never',
      codexHome: 'private-empty-per-run',
      networkAccessPolicy: 'workspace-write-disabled-read-only-runtime-default',
      projectRules: 'workspace-discovery-active-sdk-limitation',
      session: 'fresh-thread-per-attempt-private-persistence',
      shellEnvironmentInheritance: 'none',
      transportRetries: 'provider-runtime-opaque',
      webSearch: 'disabled',
    },
  }, {
    facetId: 'codex.runtime-coverage',
    value: {
      coverage: 'sdk-package-tree-plus-bundled-native-tree-reverified-before-run',
      files: files.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
      sdkVersion: runtime.sdkVersion,
      codexVersion: runtime.codexVersion,
    },
  }, {
    facetId: 'runtime.binding',
    value: {
      behaviorConfigDigest: target.binding.behaviorConfigDigest,
      deploymentCoverage: 'remote-opaque',
      effort: target.binding.qualification.effort ?? null,
      model: target.binding.qualification.model,
      protocolId: target.binding.protocolId,
      sandbox: selectCodexSdkSandbox(target),
      skillDiscovery: 'runtime-default',
      toolPolicy: 'runtime-default',
      toolSchemaCoverage: 'runtime-default-unresolved',
      workspace: target.config.behavior.workspace === undefined
        ? 'private-ephemeral-run'
        : 'copy-on-write-overlay',
    },
  }];
  return { coverageKind: 'fingerprint-plus-facets', facets };
}

async function resolveIdentity(
  configuration: CapturedConfiguration,
  target: CapturedCodexTarget,
  runtime: ReturnType<typeof captureRuntime>,
): Promise<{ identity: RuntimeIdentity; files: readonly CapturedCodexIdentityFile[] }> {
  const capabilities = codexSdkExecutorCapabilities();
  const files = await captureCodexIdentityFiles(runtime.contentIdentityFiles, 'Codex SDK');
  await assertCodexIdentityFilesUnchanged(files, {
    adapterLabel: 'Codex SDK',
    cancellationCode: 'OMK_CODEX_SDK_CANCELLED',
    identityChangedCode: 'OMK_CODEX_SDK_IDENTITY_CHANGED',
  });
  const evidence = files.map(({ facetId, digest, size }) => ({ facetId, digest, size }));
  const identity = RuntimeIdentitySchema.parse({
    implementationId: target.binding.implementationId,
    version: runtime.sdkVersion,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.codex-sdk-content-fingerprint/v1',
      adapterVersion: CODEX_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      sdkVersion: runtime.sdkVersion,
      codexVersion: runtime.codexVersion,
      capabilities,
      evidence,
    }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'declared',
    capabilities,
    implementationManifest: identityManifest(configuration, target, runtime, files),
  });
  return {
    identity: deepFreezeCanonicalJson(identity),
    files,
  };
}

function partialUsage(events: readonly unknown[]): UsageRecord | undefined {
  try {
    return parseCodexSdkStream(events).usage;
  } catch {
    return undefined;
  }
}

async function executeCodexSdk(
  configuration: CapturedConfiguration,
  target: CapturedCodexTarget,
  runtime: ReturnType<typeof captureRuntime>,
  files: readonly CapturedCodexIdentityFile[],
  state: CodexSdkRunState,
  trial: Readonly<ExecutorTrialContext>,
  attempt: Readonly<ExecutorAttemptContext>,
): Promise<ParsedCodexSdkStream> {
  if (attempt.signal.aborted) {
    fail('OMK_CODEX_SDK_CANCELLED', 'execution', 'Codex SDK execution was cancelled.');
  }
  let streamed: { readonly events: AsyncIterable<unknown> };
  try {
    const client = await runtime.createClient({
      env: { ...configuration.environment, CODEX_HOME: state.codexHome },
    });
    await assertCodexIdentityFilesUnchanged(files, {
      adapterLabel: 'Codex SDK',
      cancellationCode: 'OMK_CODEX_SDK_CANCELLED',
      identityChangedCode: 'OMK_CODEX_SDK_IDENTITY_CHANGED',
      signal: attempt.signal,
    });
    const thread = client.startThread({
      model: target.binding.qualification.model,
      sandboxMode: selectCodexSdkSandbox(target),
      workingDirectory: state.resources.workingDirectory,
      skipGitRepoCheck: true,
      ...(target.binding.qualification.effort === undefined ? {} : {
        modelReasoningEffort: target.binding.qualification.effort,
      }),
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
    });
    streamed = await thread.runStreamed(
      promptForCodexTrial(
        trial,
        state.resources,
        configuration.maxPromptBytes,
        CODEX_SDK_RESOURCE_PROFILE,
      ),
      { signal: attempt.signal },
    );
  } catch (error) {
    if (error instanceof ExecutionPortFailure) throw error;
    if (attempt.signal.aborted) {
      fail('OMK_CODEX_SDK_CANCELLED', 'execution', 'Codex SDK execution was cancelled.');
    }
    await assertCodexIdentityFilesUnchanged(files, {
      adapterLabel: 'Codex SDK',
      cancellationCode: 'OMK_CODEX_SDK_CANCELLED',
      identityChangedCode: 'OMK_CODEX_SDK_IDENTITY_CHANGED',
      signal: attempt.signal,
    });
    if (attempt.signal.aborted) {
      fail('OMK_CODEX_SDK_CANCELLED', 'execution', 'Codex SDK execution was cancelled.');
    }
    fail(
      'OMK_CODEX_SDK_SESSION_FAILED',
      'infrastructure',
      'Codex SDK attempt session could not be created.',
    );
  }
  const events: unknown[] = [];
  let eventBytes = 0;
  let invalidEvent = false;
  let outputLimitExceeded = false;
  try {
    for await (const event of streamed.events) {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(event);
      } catch {
        invalidEvent = true;
        continue;
      }
      if (encoded === undefined) {
        invalidEvent = true;
        continue;
      }
      eventBytes += Buffer.byteLength(encoded);
      if (!Number.isSafeInteger(eventBytes) || eventBytes > configuration.maxEventBytes) {
        outputLimitExceeded = true;
      }
      if (!outputLimitExceeded) events.push(event);
    }
    if (invalidEvent) {
      fail(
        'OMK_CODEX_SDK_PROTOCOL_INVALID',
        'execution',
        'Codex SDK returned an invalid event.',
        partialUsage(events),
      );
    }
    if (outputLimitExceeded) {
      fail(
        'OMK_CODEX_SDK_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'Codex SDK events exceeded the adapter byte limit.',
        partialUsage(events),
      );
    }
    return parseCodexSdkStream(events);
  } catch (error) {
    if (error instanceof ExecutionPortFailure) throw error;
    const usage = partialUsage(events);
    if (attempt.signal.aborted) {
      fail('OMK_CODEX_SDK_CANCELLED', 'execution', 'Codex SDK execution was cancelled.', usage);
    }
    await assertCodexIdentityFilesUnchanged(files, {
      adapterLabel: 'Codex SDK',
      cancellationCode: 'OMK_CODEX_SDK_CANCELLED',
      identityChangedCode: 'OMK_CODEX_SDK_IDENTITY_CHANGED',
      signal: attempt.signal,
    });
    if (attempt.signal.aborted) {
      fail('OMK_CODEX_SDK_CANCELLED', 'execution', 'Codex SDK execution was cancelled.', usage);
    }
    fail(
      'OMK_CODEX_SDK_EXECUTION_FAILED',
      'execution',
      'Codex SDK execution failed.',
      usage,
    );
  }
}

async function disposeSdkRun(state: CodexSdkRunState): Promise<void> {
  let disposeFailed = false;
  try {
    await state.resources.requestDispose();
  } catch {
    disposeFailed = true;
  }
  try {
    await rm(state.codexHome, { recursive: true, force: true });
  } catch {
    disposeFailed = true;
  }
  if (disposeFailed) {
    fail(
      'OMK_CODEX_SDK_RUN_DISPOSE_FAILED',
      'infrastructure',
      'Codex SDK run resources could not be disposed.',
    );
  }
}

/**
 * Creates a binding-local Codex SDK Core Executor. Core remains the sole owner
 * of retry, timeout, budget, cache, and attempt cancellation policy.
 */
export async function createCodexSdkExecutorAdapter(
  input: Readonly<CreateCodexSdkExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  if (typeof input.sessionIsolationKey !== 'string' || input.sessionIsolationKey.trim() === '') {
    throw new TypeError('Codex SDK adapter requires a non-empty sessionIsolationKey.');
  }
  const sdkConfiguration = input.sdk ?? {};
  const target = captureCodexTarget(
    input.target,
    input.binding,
    CODEX_SDK_RESOURCE_PROFILE,
  );
  const configuration = captureConfiguration(sdkConfiguration);
  const runtime = captureRuntime(await (
    sdkConfiguration.runtimeResolver ?? resolveInstalledCodexSdkRuntime
  )());
  const { identity, files } = await resolveIdentity(configuration, target, runtime);
  const resourceLeases = Object.freeze({
    forRun: input.resourceLeases.forRun.bind(input.resourceLeases),
  });
  return createSameProcessExecutorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey,
    resourceLeases,
    implementation: {
      async openRun({ resources }) {
        const resourceState = await captureCodexRunState(
          resources,
          target,
          CODEX_SDK_RESOURCE_PROFILE,
        );
        let codexHome: string | undefined;
        try {
          codexHome = await mkdtemp(join(tmpdir(), 'omk-codex-sdk-home-'));
          return Object.freeze({ resources: resourceState, codexHome });
        } catch {
          await Promise.allSettled([
            resourceState.requestDispose(),
            ...(codexHome === undefined ? [] : [
              rm(codexHome, { recursive: true, force: true }),
            ]),
          ]);
          fail(
            'OMK_CODEX_SDK_SESSION_FAILED',
            'infrastructure',
            'Codex SDK run session could not be created.',
          );
        }
      },
      openTrial({ runState, trial }) {
        if (
          trial.protocolId !== target.binding.protocolId
          || trial.targetId !== target.binding.targetId
          || canonicalizeJson(trial.targetConfig ?? null)
            !== canonicalizeJson(target.target.config ?? null)
        ) {
          fail(
            'OMK_CODEX_SDK_TRIAL_MISMATCH',
            'infrastructure',
            'Codex SDK trial does not match the sealed Target binding.',
          );
        }
        runState.resources.acquireTrial();
        return undefined;
      },
      async execute({ runState, trial, attempt }) {
        await assertCodexIdentityFilesUnchanged(files, {
          adapterLabel: 'Codex SDK',
          cancellationCode: 'OMK_CODEX_SDK_CANCELLED',
          identityChangedCode: 'OMK_CODEX_SDK_IDENTITY_CHANGED',
          signal: attempt.signal,
        });
        const parsed = await executeCodexSdk(
          configuration,
          target,
          runtime,
          files,
          runState,
          trial,
          attempt,
        );
        if (parsed.terminalStatus === 'failed') {
          fail(
            'OMK_CODEX_SDK_TURN_FAILED',
            'execution',
            'Codex SDK reported a failed turn.',
            parsed.usage,
          );
        }
        const outputClassification = mergeOutputClassification(
          runState.resources.classification,
          configuration.environmentOutputClassification,
        );
        return {
          ...(parsed.output === undefined ? {} : {
            output: {
              value: parsed.output,
              classification: outputClassification,
              mediaType: 'text/plain',
            },
          }),
          ...(parsed.trace === undefined ? {} : {
            trace: {
              value: parsed.trace,
              classification: outputClassification,
              mediaType: 'application/vnd.omk.source-neutral-trace+json',
            },
          }),
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        };
      },
      disposeTrial({ runState }) {
        return runState.resources.releaseTrial();
      },
      disposeRun({ runState }) {
        return disposeSdkRun(runState);
      },
    },
  });
}
