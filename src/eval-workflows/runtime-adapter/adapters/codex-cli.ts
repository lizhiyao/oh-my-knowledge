import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
import {
  spawnWithSigintPropagation,
  type SpawnHelperError,
} from '../../../executors/core/subprocess.js';
import type { RuntimeBindingOf } from '../types.js';
import type { OmkBindingResourceLeaseAccess } from '../resource-leases/types.js';
import {
  assertCodexIdentityFilesUnchanged,
  captureCodexIdentityFiles,
  type CapturedCodexIdentityFile,
  type CodexContentIdentityFile,
} from './codex-content-identity.js';
import {
  captureCodexEnvironment,
  type CodexEnvironmentEntry,
} from './codex-environment.js';
import { mergeOutputClassification } from './shared/classified-environment.js';
import {
  codexCliExecutorCapabilities,
  parseCodexCliStream,
  type ParsedCodexCliStream,
} from './codex-cli-protocol.js';
import {
  captureCodexCliRunState,
  captureCodexCliTarget,
  promptForCodexCliTrial,
  selectCodexCliSandbox,
  workingDirectoryForCodexCliTrial,
  type CapturedCodexCliTarget,
  type CodexCliRunState,
} from './codex-cli-resources.js';
import { createSameProcessExecutorAdapter } from './shared/same-process.js';

export {
  CODEX_CLI_READ_ONLY_SANDBOX_ID,
  CODEX_CLI_WORKSPACE_WRITE_SANDBOX_ID,
  createCodexCliCoreSchemaValidators,
} from './codex-cli-protocol.js';

export const CODEX_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION = '1.2.0' as const;
export const DEFAULT_CODEX_CLI_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CODEX_CLI_MAX_PROMPT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CODEX_CLI_IDENTITY_PROBE_TIMEOUT_MS = 5_000;

export type CodexCliEnvironmentEntry = CodexEnvironmentEntry;

export type CodexCliContentIdentityFile = CodexContentIdentityFile;

export interface CodexCliCoreConfiguration {
  /** Absolute Codex executable. PATH lookup is intentionally unsupported. */
  readonly executablePath: string;
  /** Complete classified environment. Nothing is inherited from process.env. */
  readonly environment?: Readonly<Record<string, CodexCliEnvironmentEntry>>;
  /** Additional implementation files not reachable from executablePath evidence. */
  readonly contentIdentityFiles?: readonly CodexCliContentIdentityFile[];
  readonly maxOutputBytes?: number;
  readonly maxPromptBytes?: number;
  /** Assembly-only safety bound; it is not an execution attempt timeout. */
  readonly identityProbeTimeoutMs?: number;
}

export interface CreateCodexCliExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly command: CodexCliCoreConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

interface CapturedConfiguration {
  readonly executablePath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: JsonValue[];
  readonly environmentOutputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxOutputBytes: number;
  readonly maxPromptBytes: number;
  readonly identityProbeTimeoutMs: number;
}

function fail(
  code: string,
  stage: 'infrastructure' | 'execution',
  message: string,
  usage?: UsageRecord,
): never {
  throw new ExecutionPortFailure({ code, stage, message }, usage);
}

function captureConfiguration(input: Readonly<CodexCliCoreConfiguration>): CapturedConfiguration {
  if (!isAbsolute(input.executablePath) || input.executablePath.includes('\0')) {
    throw new TypeError('Codex CLI executablePath must be an absolute path.');
  }
  const environment = captureCodexEnvironment(input.environment);
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_CODEX_CLI_MAX_OUTPUT_BYTES;
  const maxPromptBytes = input.maxPromptBytes ?? DEFAULT_CODEX_CLI_MAX_PROMPT_BYTES;
  const identityProbeTimeoutMs = input.identityProbeTimeoutMs
    ?? DEFAULT_CODEX_CLI_IDENTITY_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError('Codex CLI maxOutputBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes <= 0) {
    throw new TypeError('Codex CLI maxPromptBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(identityProbeTimeoutMs) || identityProbeTimeoutMs <= 0) {
    throw new TypeError('Codex CLI identityProbeTimeoutMs must be a positive safe integer.');
  }
  return Object.freeze({
    executablePath: input.executablePath,
    environment: environment.values,
    environmentIdentity: environment.identity,
    environmentOutputClassification: environment.outputClassification,
    maxOutputBytes,
    maxPromptBytes,
    identityProbeTimeoutMs,
  });
}

async function runVersionProbe(
  configuration: CapturedConfiguration,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'omk-codex-identity-'));
  try {
    const internalAbort = new AbortController();
    const { child, done } = spawnWithSigintPropagation(
      configuration.executablePath,
      ['--version'],
      {
        cwd: directory,
        env: { ...configuration.environment },
        maxBuffer: Math.min(configuration.maxOutputBytes, 64 * 1024),
        timeoutMs: configuration.identityProbeTimeoutMs,
        abortSignal: internalAbort.signal,
      },
    );
    let stdinFailed = child.stdin === null;
    if (child.stdin === null) internalAbort.abort();
    else {
      child.stdin.once('error', () => {
        stdinFailed = true;
        internalAbort.abort();
      });
      child.stdin.end();
    }
    let stdout: string;
    try {
      stdout = (await done).stdout.trim();
    } catch {
      if (stdinFailed) throw new TypeError('Codex CLI version probe stdin is unavailable.');
      throw new TypeError('Codex CLI version probe failed.');
    }
    const match = /^(?:codex-cli(?:-exec)?\s+)?([^\s]+)$/.exec(stdout);
    if (match?.[1] === undefined || match[1].length > 128) {
      throw new TypeError('Codex CLI version probe returned an invalid version.');
    }
    return match[1];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertIdentityFilesUnchanged(
  files: readonly CapturedCodexIdentityFile[],
  signal?: AbortSignal,
): Promise<void> {
  await assertCodexIdentityFilesUnchanged(files, {
    adapterLabel: 'Codex CLI',
    cancellationCode: 'OMK_CODEX_CLI_CANCELLED',
    identityChangedCode: 'OMK_CODEX_CLI_IDENTITY_CHANGED',
    ...(signal === undefined ? {} : { signal }),
  });
}

function identityManifest(
  configuration: CapturedConfiguration,
  target: CapturedCodexCliTarget,
  files: readonly CapturedCodexIdentityFile[],
): RuntimeIdentity['implementationManifest'] {
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      adapterVersion: CODEX_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      cancellation: 'sigterm-then-sigkill',
      processIsolation: 'per-attempt',
      sourceProtocol: 'codex exec --json',
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
      version: 'omk.codex-cli-prompt/v1',
    },
  }, {
    facetId: 'adapter.limits',
    value: {
      maxOutputBytes: configuration.maxOutputBytes,
      maxPromptBytes: configuration.maxPromptBytes,
      identityProbeTimeoutMs: configuration.identityProbeTimeoutMs,
    },
  }, {
    facetId: 'codex.binary-coverage',
    value: {
      coverage: 'declared-files-reverified-before-spawn',
      files: files.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
    },
  }, {
    facetId: 'codex.fixed-controls',
    value: {
      approvalPolicy: 'never',
      configMode: 'strict-ignore-user-config',
      rules: 'ignored',
      session: 'ephemeral',
      shellEnvironmentInheritance: 'none',
    },
  }, {
    facetId: 'codex.launcher',
    value: {
      executablePathDigest: digestCanonicalJson(configuration.executablePath),
    },
  }, {
    facetId: 'runtime.binding',
    value: {
      behaviorConfigDigest: target.binding.behaviorConfigDigest,
      deploymentCoverage: 'remote-opaque',
      effort: target.binding.qualification.effort ?? null,
      model: target.binding.qualification.model,
      protocolId: target.binding.protocolId,
      sandbox: 'sample-scoped-sealed-control',
      skillDiscovery: 'runtime-default',
      toolPolicy: 'runtime-default',
      toolSchemaCoverage: 'runtime-default-unresolved',
      workspace: 'sample-scoped-sealed-control',
    },
  }];
  return { coverageKind: 'fingerprint-plus-facets', facets };
}

async function resolveIdentity(
  configuration: CapturedConfiguration,
  target: CapturedCodexCliTarget,
  additionalIdentityFiles: readonly CodexCliContentIdentityFile[],
): Promise<{ identity: RuntimeIdentity; files: readonly CapturedCodexIdentityFile[] }> {
  const runtimeCapabilities = codexCliExecutorCapabilities();
  const files = await captureCodexIdentityFiles([
    { facetId: 'codex-executable', path: configuration.executablePath },
    ...additionalIdentityFiles,
  ], 'Codex CLI');
  const version = await runVersionProbe(configuration);
  await assertIdentityFilesUnchanged(files);
  const evidence = files.map(({ facetId, digest, size }) => ({ facetId, digest, size }));
  const identity = RuntimeIdentitySchema.parse({
    implementationId: target.binding.implementationId,
    version,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.codex-cli-content-fingerprint/v1',
      adapterVersion: CODEX_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      version,
      capabilities: runtimeCapabilities,
      evidence,
    }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'declared',
    capabilities: runtimeCapabilities,
    implementationManifest: identityManifest(configuration, target, files),
  });
  return {
    identity: deepFreezeCanonicalJson(identity),
    files: Object.freeze(files),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexCliCoreArguments(input: Readonly<{
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  sandbox: 'read-only' | 'workspace-write';
  workingDirectory: string;
  prompt: string;
}>): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--color', 'never',
    '--sandbox', input.sandbox,
    '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="none"',
    ...(input.effort === undefined
      ? []
      : ['-c', `model_reasoning_effort=${tomlString(input.effort)}`]),
    '--model', input.model,
    '-C', input.workingDirectory,
    '--', input.prompt,
  ];
}

function processFailure(error: unknown, signal: AbortSignal): never {
  const spawnError = error as SpawnHelperError;
  if (signal.aborted || spawnError.failureKind === 'abort') {
    fail('OMK_CODEX_CLI_CANCELLED', 'execution', 'Codex CLI execution was cancelled.');
  }
  if (spawnError.failureKind === 'buffer-limit') {
    fail(
      'OMK_CODEX_CLI_OUTPUT_LIMIT_EXCEEDED',
      'infrastructure',
      'Codex CLI output exceeded the adapter byte limit.',
    );
  }
  let usage: UsageRecord | undefined;
  if (spawnError.stdout?.trim()) {
    try {
      usage = parseCodexCliStream(spawnError.stdout).usage;
    } catch {
      // The process failure remains authoritative; malformed provider details stay redacted.
    }
  }
  if (spawnError.failureKind === 'nonzero-exit') {
    fail('OMK_CODEX_CLI_EXIT_NONZERO', 'execution', 'Codex CLI exited unsuccessfully.', usage);
  }
  fail('OMK_CODEX_CLI_SPAWN_FAILED', 'infrastructure', 'Codex CLI process could not run.', usage);
}

async function executeCodex(
  configuration: CapturedConfiguration,
  target: CapturedCodexCliTarget,
  state: CodexCliRunState,
  trial: Readonly<ExecutorTrialContext>,
  attempt: Readonly<ExecutorAttemptContext>,
): Promise<ParsedCodexCliStream> {
  if (attempt.signal.aborted) {
    fail('OMK_CODEX_CLI_CANCELLED', 'execution', 'Codex CLI execution was cancelled.');
  }
  const workingDirectory = workingDirectoryForCodexCliTrial(trial, state, target);
  const args = buildCodexCliCoreArguments({
    model: target.binding.qualification.model,
    ...(target.binding.qualification.effort === undefined
      ? {}
      : { effort: target.binding.qualification.effort }),
    sandbox: selectCodexCliSandbox(
      target.config,
      trial.executionControl.workspace.workspaceMode,
    ),
    workingDirectory,
    prompt: promptForCodexCliTrial(trial, state, configuration.maxPromptBytes),
  });
  const internalAbort = new AbortController();
  const processSignal = AbortSignal.any([attempt.signal, internalAbort.signal]);
  const { child, done } = spawnWithSigintPropagation(
    configuration.executablePath,
    args,
    {
      cwd: workingDirectory,
      env: { ...configuration.environment },
      maxBuffer: configuration.maxOutputBytes,
      abortSignal: processSignal,
    },
  );
  let stdinFailed = child.stdin === null;
  if (child.stdin === null) {
    internalAbort.abort();
  } else {
    child.stdin.once('error', () => {
      stdinFailed = true;
      internalAbort.abort();
    });
    child.stdin.end();
  }
  try {
    return parseCodexCliStream((await done).stdout);
  } catch (error) {
    if (error instanceof ExecutionPortFailure) throw error;
    if (stdinFailed && !attempt.signal.aborted) {
      fail(
        'OMK_CODEX_CLI_STDIN_UNAVAILABLE',
        'infrastructure',
        'Codex CLI stdin is unavailable.',
      );
    }
    processFailure(error, attempt.signal);
  }
}

/**
 * Creates a binding-local Codex CLI Core Executor. Core remains the sole owner
 * of retry, timeout, budget, cache, and attempt cancellation policy.
 */
export async function createCodexCliExecutorAdapter(
  input: Readonly<CreateCodexCliExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  if (typeof input.sessionIsolationKey !== 'string' || input.sessionIsolationKey.trim() === '') {
    throw new TypeError('Codex CLI adapter requires a non-empty sessionIsolationKey.');
  }
  const target = captureCodexCliTarget(input.target, input.binding);
  const configuration = captureConfiguration(input.command);
  const { identity, files } = await resolveIdentity(
    configuration,
    target,
    input.command.contentIdentityFiles ?? [],
  );
  const resourceLeases = Object.freeze({
    forRun: input.resourceLeases.forRun.bind(input.resourceLeases),
  });
  return createSameProcessExecutorAdapter({
    identity,
    sessionIsolationKey: input.sessionIsolationKey,
    resourceLeases,
    implementation: {
      openRun({ resources }) {
        return captureCodexCliRunState(resources, target);
      },
      openTrial({ runState, trial }) {
        if (
          trial.protocolId !== target.binding.protocolId
          || trial.targetId !== target.binding.targetId
          || canonicalizeJson(trial.targetConfig ?? null)
            !== canonicalizeJson(target.target.config ?? null)
        ) {
          fail(
            'OMK_CODEX_CLI_TRIAL_MISMATCH',
            'infrastructure',
            'Codex CLI trial does not match the sealed Target binding.',
          );
        }
        runState.acquireTrial();
        return undefined;
      },
      async execute({ runState, trial, attempt }) {
        await assertIdentityFilesUnchanged(files, attempt.signal);
        const parsed = await executeCodex(configuration, target, runState, trial, attempt);
        if (parsed.terminalStatus === 'failed') {
          fail(
            'OMK_CODEX_CLI_TURN_FAILED',
            'execution',
            'Codex CLI reported a failed turn.',
            parsed.usage,
          );
        }
        const outputClassification = mergeOutputClassification(
          runState.classification,
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
        return runState.releaseTrial();
      },
      disposeRun({ runState }) {
        return runState.requestDispose();
      },
    },
  });
}
