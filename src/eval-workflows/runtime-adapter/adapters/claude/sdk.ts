import { lstat, mkdtemp, rm } from 'node:fs/promises';
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
} from '../../../../evaluation-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorAttemptResult,
} from '../../../../evaluation-core/execution/index.js';
import {
  buildSdkHookCallback,
  type SdkHookHandle,
} from '../../../../executors/mock-runtime/runtime.js';
import type { RuntimeBindingOf } from '../../types.js';
import type { OmkBindingResourceLeaseAccess } from '../../resource-leases/types.js';
import {
  captureClassifiedEnvironment,
  mergeOutputClassification,
  type ClassifiedEnvironmentEntry,
} from '../shared/classified-environment.js';
import {
  assertIdentityFilesUnchanged,
  captureIdentityFiles,
  type CapturedIdentityFile,
} from '../shared/content-identity.js';
import {
  CLAUDE_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  claudeSdkExecutorCapabilities,
  parseClaudeSdkStream,
  type ParsedClaudeSdkStream,
} from './sdk-protocol.js';
import {
  CLAUDE_SDK_RESOURCE_PROFILE,
  captureClaudeCliRunState,
  captureClaudeCliTarget,
  disposeClaudeCliTrial,
  openClaudeCliTrial,
  type CapturedClaudeCliTarget,
  type ClaudeCliRunState,
  type ClaudeCliTrialState,
} from './resources.js';
import {
  resolveInstalledClaudeSdkRuntime,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryOptions,
  type ClaudeSdkRuntimeResolver,
  type ResolvedClaudeSdkRuntime,
} from './sdk-runtime.js';
import { createSameProcessExecutorAdapter } from '../shared/same-process.js';
import { attachSourceNeutralMockStats } from '../../source-neutral-trace.js';

export {
  CLAUDE_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  createClaudeSdkCoreSchemaValidators,
} from './sdk-protocol.js';
export {
  resolveInstalledClaudeSdkRuntime,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryInput,
  type ClaudeSdkQueryOptions,
  type ClaudeSdkRuntimeResolver,
  type ResolvedClaudeSdkRuntime,
} from './sdk-runtime.js';

export const MINIMUM_CLAUDE_SDK_CORE_VERSION = '0.3.143' as const;
export const DEFAULT_CLAUDE_SDK_MAX_EVENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CLAUDE_SDK_MAX_INPUT_BYTES = 2 * 1024 * 1024;

export type ClaudeSdkEnvironmentEntry = ClassifiedEnvironmentEntry;

export interface ClaudeSdkCoreConfiguration {
  /** Complete classified environment. Nothing is inherited from process.env. */
  readonly environment?: Readonly<Record<string, ClaudeSdkEnvironmentEntry>>;
  readonly maxEventBytes?: number;
  readonly maxInputBytes?: number;
  /** Trusted host seam for offline conformance tests and alternative module resolvers. */
  readonly runtimeResolver?: ClaudeSdkRuntimeResolver;
}

export interface CreateClaudeSdkExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly sdk?: ClaudeSdkCoreConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

interface CapturedConfiguration {
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: JsonValue[];
  readonly environmentOutputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxEventBytes: number;
  readonly maxInputBytes: number;
}

interface CapturedRuntime {
  readonly sdkVersion: string;
  readonly claudeCodeVersion: string;
  readonly contentIdentityFiles: ResolvedClaudeSdkRuntime['contentIdentityFiles'];
  readonly createQuery: ResolvedClaudeSdkRuntime['createQuery'];
}

const ADAPTER_OWNED_ENVIRONMENT = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_CRON',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
  'DISABLE_AUTOUPDATER',
]);

function fail(
  code: string,
  stage: 'infrastructure' | 'execution',
  message: string,
  usage?: UsageRecord,
): never {
  throw new ExecutionPortFailure({ code, stage, message }, usage);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Claude SDK ${label} must be a positive safe integer.`);
  }
  return value;
}

function captureConfiguration(input: Readonly<ClaudeSdkCoreConfiguration>): CapturedConfiguration {
  const supplied: Record<string, ClassifiedEnvironmentEntry> = structuredClone(
    input.environment ?? {},
  );
  const normalizedEnvironmentKeys = new Map<string, string>();
  for (const key of Object.keys(supplied)) {
    const normalized = key.toUpperCase();
    const existing = normalizedEnvironmentKeys.get(normalized);
    if (existing !== undefined && existing !== key) {
      throw new TypeError('Claude SDK environment keys must be case-insensitively unique.');
    }
    normalizedEnvironmentKeys.set(normalized, key);
  }
  for (const key of ADAPTER_OWNED_ENVIRONMENT) {
    if (normalizedEnvironmentKeys.has(key)) {
      throw new TypeError(`Claude SDK environment must not override adapter-owned ${key}.`);
    }
  }
  for (const key of [
    'CLAUDE_CODE_DISABLE_ATTACHMENTS',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
    'CLAUDE_CODE_DISABLE_CRON',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
    'DISABLE_AUTOUPDATER',
  ]) {
    supplied[key] = {
      value: '1',
      identity: { identityKind: 'behavior', value: true },
    };
  }
  const environment = captureClassifiedEnvironment(supplied);
  return Object.freeze({
    environment: environment.values,
    environmentIdentity: environment.identity,
    environmentOutputClassification: environment.outputClassification,
    maxEventBytes: positiveSafeInteger(
      input.maxEventBytes ?? DEFAULT_CLAUDE_SDK_MAX_EVENT_BYTES,
      'maxEventBytes',
    ),
    maxInputBytes: positiveSafeInteger(
      input.maxInputBytes ?? DEFAULT_CLAUDE_SDK_MAX_INPUT_BYTES,
      'maxInputBytes',
    ),
  });
}

function semverTuple(value: string, label: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) throw new TypeError(`Claude SDK ${label} has an invalid version.`);
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (tuple.some((part) => !Number.isSafeInteger(part))) {
    throw new TypeError(`Claude SDK ${label} has an invalid version.`);
  }
  return tuple;
}

function assertMinimumSdkVersion(value: string): void {
  const actual = semverTuple(value, 'runtime');
  const minimum = semverTuple(MINIMUM_CLAUDE_SDK_CORE_VERSION, 'minimum');
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw new TypeError(
        `Claude SDK Core adapter requires ${MINIMUM_CLAUDE_SDK_CORE_VERSION} or newer.`,
      );
    }
  }
}

function captureRuntime(runtime: ResolvedClaudeSdkRuntime): CapturedRuntime {
  if (
    typeof runtime.sdkVersion !== 'string'
    || typeof runtime.claudeCodeVersion !== 'string'
    || typeof runtime.createQuery !== 'function'
    || !Array.isArray(runtime.contentIdentityFiles)
  ) throw new TypeError('Claude SDK runtime resolver returned an invalid result.');
  assertMinimumSdkVersion(runtime.sdkVersion);
  semverTuple(runtime.claudeCodeVersion, 'bundled Claude Code');
  const contentIdentityFiles = structuredClone(runtime.contentIdentityFiles);
  const facetIds = new Set(contentIdentityFiles.map((file) => file.facetId));
  if (
    !facetIds.has('claude-sdk.package-manifest')
    || !facetIds.has('claude-sdk.entrypoint')
    || !facetIds.has('claude-native.package-manifest')
    || !facetIds.has('claude-native.executable')
  ) throw new TypeError('Claude SDK runtime identity coverage is incomplete.');
  return Object.freeze({
    sdkVersion: runtime.sdkVersion,
    claudeCodeVersion: runtime.claudeCodeVersion,
    contentIdentityFiles: Object.freeze(contentIdentityFiles),
    createQuery: runtime.createQuery.bind(runtime),
  });
}

function identityManifest(
  configuration: CapturedConfiguration,
  target: CapturedClaudeCliTarget,
  runtime: CapturedRuntime,
  files: readonly CapturedIdentityFile[],
): RuntimeIdentity['implementationManifest'] {
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      adapterVersion: CLAUDE_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      cancellation: 'sdk-abort-controller-plus-query-close',
      processIsolation: 'sdk-child-per-attempt',
      sourceProtocol: '@anthropic-ai/claude-agent-sdk query',
    },
  }, {
    facetId: 'adapter.environment',
    value: { entries: [...configuration.environmentIdentity] },
  }, {
    facetId: 'adapter.input-projection',
    value: {
      artifactInstructions: 'claude-code-preset-append',
      directoryEntrypoint: 'SKILL.md',
      supportingFiles: 'canonical-user-envelope',
      promptTransport: 'sdk-query-string',
      version: 'omk.claude-sdk-prompt/v1',
    },
  }, {
    facetId: 'adapter.limits',
    value: {
      maxEventBytes: configuration.maxEventBytes,
      maxInputBytes: configuration.maxInputBytes,
    },
  }, {
    facetId: 'claude.fixed-controls',
    value: {
      configDirectory: 'private-per-attempt',
      implicitAttachments: 'disabled',
      managedPolicy: 'host-level-opaque-and-non-overridable',
      memory: 'claude-md-and-auto-memory-disabled',
      mcp: 'strict-sdk-config',
      nonessentialTraffic: 'disabled',
      permissionMode: 'bypassPermissions',
      persistentBackgroundWork: 'disabled',
      sessionPersistence: 'disabled',
      settingSources: [],
      updater: 'disabled',
    },
  }, {
    facetId: 'claude.runtime-coverage',
    value: {
      bundledClaudeCodeVersion: runtime.claudeCodeVersion,
      coverage: 'sdk-package-tree-plus-bundled-native-tree-reverified-before-query',
      files: files.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
      sdkVersion: runtime.sdkVersion,
    },
  }, {
    facetId: 'runtime.binding',
    value: {
      behaviorConfigDigest: target.binding.behaviorConfigDigest,
      deploymentCoverage: 'remote-opaque',
      effort: target.binding.qualification.effort ?? null,
      model: target.binding.qualification.model,
      protocolId: target.binding.protocolId,
      providerTransportRetries: 'runtime-opaque',
      sandbox: 'none',
      skillDiscovery: target.config.behavior.allowedSkills === undefined
        ? 'runtime-default-with-private-user-config'
        : 'disabled',
      toolPolicy: 'sample-scoped-sealed-control',
      workspace: 'sample-scoped-sealed-control',
    },
  }];
  return { coverageKind: 'fingerprint-plus-facets', facets };
}

async function resolveIdentity(
  configuration: CapturedConfiguration,
  target: CapturedClaudeCliTarget,
  runtime: CapturedRuntime,
): Promise<{ identity: RuntimeIdentity; files: readonly CapturedIdentityFile[] }> {
  const capabilities = claudeSdkExecutorCapabilities();
  const files = await captureIdentityFiles(runtime.contentIdentityFiles, 'Claude SDK');
  await assertIdentityFilesUnchanged(files, {
    adapterLabel: 'Claude SDK',
    cancellationCode: 'OMK_CLAUDE_SDK_CANCELLED',
    identityChangedCode: 'OMK_CLAUDE_SDK_IDENTITY_CHANGED',
  });
  const evidence = files.map(({ facetId, digest, size }) => ({ facetId, digest, size }));
  const identity = RuntimeIdentitySchema.parse({
    implementationId: target.binding.implementationId,
    version: runtime.sdkVersion,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.claude-sdk-content-fingerprint/v1',
      adapterVersion: CLAUDE_SDK_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      sdkVersion: runtime.sdkVersion,
      claudeCodeVersion: runtime.claudeCodeVersion,
      capabilities,
      evidence,
    }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'declared',
    capabilities,
    implementationManifest: identityManifest(configuration, target, runtime, files),
  });
  return { identity: deepFreezeCanonicalJson(identity), files: Object.freeze(files) };
}

async function pathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function disposeAttemptDirectory(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    fail(
      'OMK_CLAUDE_SDK_ATTEMPT_DISPOSE_FAILED',
      'infrastructure',
      'Claude SDK attempt controls could not be disposed.',
    );
  }
  if (!(await pathAbsent(path))) {
    fail(
      'OMK_CLAUDE_SDK_ATTEMPT_DISPOSE_FAILED',
      'infrastructure',
      'Claude SDK attempt controls could not be disposed.',
    );
  }
}

function sdkOptions(
  configuration: CapturedConfiguration,
  target: CapturedClaudeCliTarget,
  runState: ClaudeCliRunState,
  trialState: ClaudeCliTrialState,
  attemptDirectory: string,
  hookHandle: SdkHookHandle | undefined,
): ClaudeSdkQueryOptions {
  const disableSkills = target.config.behavior.allowedSkills !== undefined;
  const disallowedTools = [
    ...(trialState.allowedTools === undefined ? [] : ['mcp__*']),
    ...(disableSkills ? ['Skill'] : []),
  ];
  return {
      abortController: new AbortController(),
      allowDangerouslySkipPermissions: true,
      cwd: trialState.workingDirectory,
      ...(disallowedTools.length === 0 ? {} : { disallowedTools }),
      ...(target.binding.qualification.effort === undefined
        ? {}
        : { effort: target.binding.qualification.effort }),
      env: {
        ...configuration.environment,
        CLAUDE_CONFIG_DIR: attemptDirectory,
      },
      ...(runState.mcpServers === undefined ? {
        extraArgs: {
          'mcp-config': '{"mcpServers":{}}',
          'no-chrome': null,
        },
      } : { extraArgs: { 'no-chrome': null } }),
      ...(hookHandle === undefined ? {} : {
        hooks: { PreToolUse: [{ hooks: [hookHandle.callback] }] },
      }),
      ...(runState.mcpServers === undefined
        ? {}
        : { mcpServers: structuredClone(runState.mcpServers) }),
      model: target.binding.qualification.model,
      permissionMode: 'bypassPermissions',
      persistSession: false,
      settingSources: [],
      ...(disableSkills ? { skills: [] as const } : {}),
      strictMcpConfig: true,
      ...(runState.systemInstructions === undefined ? {} : {
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: runState.systemInstructions,
        },
      }),
      ...(trialState.allowedTools === undefined
        ? {}
        : { tools: trialState.allowedTools }),
  };
}

function partialUsage(messages: readonly unknown[]): UsageRecord | undefined {
  try {
    return parseClaudeSdkStream(messages).usage;
  } catch {
    return undefined;
  }
}

async function consumeQuery(
  query: ClaudeSdkQuery,
  abortController: AbortController,
  attempt: Readonly<ExecutorAttemptContext>,
  maxEventBytes: number,
): Promise<ParsedClaudeSdkStream> {
  const messages: unknown[] = [];
  let eventBytes = 0;
  let invalidEvent = false;
  let outputLimitExceeded = false;
  try {
    for await (const message of query) {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(message);
      } catch {
        invalidEvent = true;
      }
      if (encoded === undefined) {
        invalidEvent = true;
        continue;
      }
      eventBytes += Buffer.byteLength(encoded);
      if (!Number.isSafeInteger(eventBytes) || eventBytes > maxEventBytes) {
        outputLimitExceeded = true;
        abortController.abort();
      }
      if (!outputLimitExceeded) messages.push(message);
    }
    if (outputLimitExceeded) {
      fail(
        'OMK_CLAUDE_SDK_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'Claude SDK events exceeded the adapter byte limit.',
        partialUsage(messages),
      );
    }
    if (invalidEvent) {
      fail(
        'OMK_CLAUDE_SDK_PROTOCOL_INVALID',
        'execution',
        'Claude SDK returned an invalid event.',
        partialUsage(messages),
      );
    }
    return parseClaudeSdkStream(messages);
  } catch (error) {
    if (error instanceof ExecutionPortFailure) throw error;
    const usage = partialUsage(messages);
    if (outputLimitExceeded) {
      fail(
        'OMK_CLAUDE_SDK_OUTPUT_LIMIT_EXCEEDED',
        'infrastructure',
        'Claude SDK events exceeded the adapter byte limit.',
        usage,
      );
    }
    if (attempt.signal.aborted) {
      fail('OMK_CLAUDE_SDK_CANCELLED', 'execution', 'Claude SDK execution was cancelled.', usage);
    }
    fail('OMK_CLAUDE_SDK_EXECUTION_FAILED', 'execution', 'Claude SDK execution failed.', usage);
  } finally {
    try {
      query.close();
    } catch {
      fail(
        'OMK_CLAUDE_SDK_SESSION_DISPOSE_FAILED',
        'infrastructure',
        'Claude SDK attempt session could not be disposed.',
      );
    }
  }
  fail('OMK_CLAUDE_SDK_EXECUTION_FAILED', 'infrastructure', 'Claude SDK produced no result.');
}

async function executeAttempt(
  configuration: CapturedConfiguration,
  target: CapturedClaudeCliTarget,
  runtime: CapturedRuntime,
  files: readonly CapturedIdentityFile[],
  runState: ClaudeCliRunState,
  trialState: ClaudeCliTrialState,
  attempt: Readonly<ExecutorAttemptContext>,
): Promise<ExecutorAttemptResult> {
  if (attempt.signal.aborted) {
    fail('OMK_CLAUDE_SDK_CANCELLED', 'execution', 'Claude SDK execution was cancelled.');
  }
  let attemptDirectory: string;
  try {
    attemptDirectory = await mkdtemp(join(tmpdir(), 'omk-claude-sdk-attempt-'));
  } catch {
    fail(
      'OMK_CLAUDE_SDK_ATTEMPT_MATERIALIZATION_FAILED',
      'infrastructure',
      'Claude SDK attempt controls could not be materialized.',
    );
  }
  let options: ClaudeSdkQueryOptions;
  const hookHandle = trialState.mocks === undefined
    ? undefined
    : buildSdkHookCallback([...trialState.mocks], undefined, trialState.mocksStrict);
  try {
    options = sdkOptions(
      configuration,
      target,
      runState,
      trialState,
      attemptDirectory,
      hookHandle,
    );
  } catch {
    await disposeAttemptDirectory(attemptDirectory);
    fail(
      'OMK_CLAUDE_SDK_ATTEMPT_MATERIALIZATION_FAILED',
      'infrastructure',
      'Claude SDK attempt controls could not be materialized.',
    );
  }
  let result: ParsedClaudeSdkStream | undefined;
  let executionError: unknown;
  const cancelSdk = (): void => options.abortController.abort(attempt.signal.reason);
  attempt.signal.addEventListener('abort', cancelSdk, { once: true });
  if (attempt.signal.aborted) cancelSdk();
  try {
    await assertIdentityFilesUnchanged(files, {
      adapterLabel: 'Claude SDK',
      cancellationCode: 'OMK_CLAUDE_SDK_CANCELLED',
      identityChangedCode: 'OMK_CLAUDE_SDK_IDENTITY_CHANGED',
      signal: attempt.signal,
    });
    let query: ClaudeSdkQuery;
    try {
      const candidate = await runtime.createQuery({ prompt: trialState.prompt, options });
      if (
        candidate === null
        || typeof candidate !== 'object'
        || typeof candidate[Symbol.asyncIterator] !== 'function'
        || typeof candidate.close !== 'function'
      ) {
        if (candidate !== null
            && typeof candidate === 'object'
            && 'close' in candidate
            && typeof candidate.close === 'function') {
          try { candidate.close(); } catch { /* session creation still fails closed below */ }
        }
        throw new TypeError('invalid Claude SDK query');
      }
      query = candidate;
    } catch {
      if (attempt.signal.aborted) {
        fail('OMK_CLAUDE_SDK_CANCELLED', 'execution', 'Claude SDK execution was cancelled.');
      }
      await assertIdentityFilesUnchanged(files, {
        adapterLabel: 'Claude SDK',
        cancellationCode: 'OMK_CLAUDE_SDK_CANCELLED',
        identityChangedCode: 'OMK_CLAUDE_SDK_IDENTITY_CHANGED',
        signal: attempt.signal,
      });
      fail(
        'OMK_CLAUDE_SDK_SESSION_FAILED',
        'infrastructure',
        'Claude SDK attempt session could not be created.',
      );
    }
    result = await consumeQuery(query, options.abortController, attempt, configuration.maxEventBytes);
  } catch (error) {
    executionError = error;
  } finally {
    attempt.signal.removeEventListener('abort', cancelSdk);
  }
  let disposeError: unknown;
  try {
    await disposeAttemptDirectory(attemptDirectory);
  } catch (error) {
    disposeError = error;
  }
  if (disposeError !== undefined) throw disposeError;
  if (executionError !== undefined) throw executionError;
  if (result === undefined) {
    fail('OMK_CLAUDE_SDK_EXECUTION_FAILED', 'infrastructure', 'Claude SDK produced no result.');
  }
  if (result.terminalStatus === 'failed') {
    fail(
      'OMK_CLAUDE_SDK_TURN_FAILED',
      'execution',
      'Claude SDK reported a failed turn.',
      result.usage,
    );
  }
  const outputClassification = mergeOutputClassification(
    trialState.classification,
    configuration.environmentOutputClassification,
  );
  return {
    ...(result.output === undefined ? {} : {
      output: {
        value: result.output,
        classification: outputClassification,
        mediaType: 'text/plain',
      },
    }),
    trace: {
      value: attachSourceNeutralMockStats(result.trace, hookHandle?.stats),
      classification: outputClassification,
      mediaType: 'application/vnd.omk.source-neutral-trace+json',
    },
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

/** Creates a binding-local Claude SDK Core Executor. Core owns all execution policy. */
export async function createClaudeSdkExecutorAdapter(
  input: Readonly<CreateClaudeSdkExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  if (typeof input.sessionIsolationKey !== 'string' || input.sessionIsolationKey.trim() === '') {
    throw new TypeError('Claude SDK adapter requires a non-empty sessionIsolationKey.');
  }
  const sdkConfiguration = input.sdk ?? {};
  const target = captureClaudeCliTarget(
    input.target,
    input.binding,
    CLAUDE_SDK_RESOURCE_PROFILE,
  );
  const configuration = captureConfiguration(sdkConfiguration);
  const runtime = captureRuntime(await (
    sdkConfiguration.runtimeResolver ?? resolveInstalledClaudeSdkRuntime
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
        return captureClaudeCliRunState(
          resources,
          target,
          configuration.maxInputBytes,
          CLAUDE_SDK_RESOURCE_PROFILE,
        );
      },
      async openTrial({ runState, trial }) {
        if (
          trial.protocolId !== target.binding.protocolId
          || trial.targetId !== target.binding.targetId
          || canonicalizeJson(trial.targetConfig ?? null)
            !== canonicalizeJson(target.target.config ?? null)
        ) {
          fail(
            'OMK_CLAUDE_SDK_TRIAL_MISMATCH',
            'infrastructure',
            'Claude SDK trial does not match the sealed Target binding.',
          );
        }
        runState.acquireTrial();
        try {
          return openClaudeCliTrial(
            trial,
            runState,
            configuration.maxInputBytes,
            CLAUDE_SDK_RESOURCE_PROFILE,
          );
        } catch (error) {
          await runState.releaseTrial();
          throw error;
        }
      },
      execute({ runState, trialState, attempt }) {
        return executeAttempt(
          configuration,
          target,
          runtime,
          files,
          runState,
          trialState,
          attempt,
        );
      },
      async disposeTrial({ runState }) {
        await disposeClaudeCliTrial(runState, CLAUDE_SDK_RESOURCE_PROFILE);
      },
      async disposeRun({ runState }) {
        await runState.requestDispose();
      },
    },
  });
}
