import { basename, isAbsolute, join } from 'node:path';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
} from '../../../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionExecutor,
  type ExecutorAttemptContext,
  type ExecutorAttemptResult,
} from '../../../../eval-core/execution/index.js';
import {
  materializeForCliConfigDir,
  type CliMockHandle,
} from '../../../../executors/mock-runtime/runtime.js';
import {
  spawnWithSigintPropagation,
  type SpawnHelperError,
} from '../../../../executors/core/subprocess.js';
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
  type ContentIdentityFile,
} from '../shared/content-identity.js';
import {
  CLAUDE_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  claudeCliExecutorCapabilities,
  parseClaudeCliStream,
  type ParsedClaudeCliStream,
} from './cli-protocol.js';
import {
  captureClaudeCliRunState,
  captureClaudeCliTarget,
  disposeClaudeCliMockHandle,
  disposeClaudeCliTrial,
  openClaudeCliTrial,
  type CapturedClaudeCliTarget,
  type ClaudeCliRunState,
  type ClaudeCliTrialState,
} from './resources.js';
import { createSameProcessExecutorAdapter } from '../shared/omk-resource-same-process.js';
import { attachSourceNeutralMockStats } from '../../source-neutral-trace.js';

export {
  CLAUDE_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION,
  createClaudeCliCoreSchemaValidators,
} from './cli-protocol.js';

export const DEFAULT_CLAUDE_CLI_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CLAUDE_CLI_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CLAUDE_CLI_IDENTITY_PROBE_TIMEOUT_MS = 5_000;
export const MINIMUM_CLAUDE_CLI_CORE_VERSION = '2.1.226' as const;

export type ClaudeCliEnvironmentEntry = ClassifiedEnvironmentEntry;
export type ClaudeCliContentIdentityFile = ContentIdentityFile;

export interface ClaudeCliCoreConfiguration {
  /** Absolute Claude executable. PATH lookup is intentionally unsupported. */
  readonly executablePath: string;
  /** Complete classified environment. Nothing is inherited from process.env. */
  readonly environment?: Readonly<Record<string, ClaudeCliEnvironmentEntry>>;
  /** Node runtime used by the deterministic mock hook implementation. */
  readonly hookNodeExecutablePath?: string;
  /** Additional implementation files not reachable from executablePath evidence. */
  readonly contentIdentityFiles?: readonly ClaudeCliContentIdentityFile[];
  readonly maxOutputBytes?: number;
  readonly maxInputBytes?: number;
  /** Assembly-only safety bound; it is not an execution attempt timeout. */
  readonly identityProbeTimeoutMs?: number;
}

export interface CreateClaudeCliExecutorAdapterInput {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly command: ClaudeCliCoreConfiguration;
  readonly sessionIsolationKey: string;
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

interface CapturedConfiguration {
  readonly executablePath: string;
  readonly hookNodeExecutablePath?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: JsonValue[];
  readonly environmentOutputClassification: 'public' | 'sensitive' | 'secret';
  readonly maxOutputBytes: number;
  readonly maxInputBytes: number;
  readonly identityProbeTimeoutMs: number;
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
    throw new TypeError(`Claude CLI ${label} must be a positive safe integer.`);
  }
  return value;
}

async function canonicalExecutable(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new TypeError(`Claude CLI ${label} must be an absolute path.`);
  }
  try {
    return await realpath(path);
  } catch {
    throw new TypeError(`Claude CLI ${label} is unavailable.`);
  }
}

async function captureConfiguration(
  input: Readonly<ClaudeCliCoreConfiguration>,
  needsMockRuntime: boolean,
): Promise<CapturedConfiguration> {
  const executablePath = await canonicalExecutable(input.executablePath, 'executablePath');
  if (!needsMockRuntime && input.hookNodeExecutablePath !== undefined) {
    throw new TypeError(
      'Claude CLI hookNodeExecutablePath is valid only when mock interception is configured.',
    );
  }
  const hookNodeExecutablePath = needsMockRuntime
    ? await canonicalExecutable(
        input.hookNodeExecutablePath ?? process.execPath,
        'hookNodeExecutablePath',
      )
    : undefined;
  if (hookNodeExecutablePath !== undefined
      && !['node', 'node.exe'].includes(basename(hookNodeExecutablePath).toLowerCase())) {
    throw new TypeError('Claude CLI hookNodeExecutablePath must resolve to a node executable.');
  }
  const supplied: Record<string, ClassifiedEnvironmentEntry> = structuredClone(
    input.environment ?? {},
  );
  const normalizedEnvironmentKeys = new Map<string, string>();
  for (const key of Object.keys(supplied)) {
    const normalized = key.toUpperCase();
    const existing = normalizedEnvironmentKeys.get(normalized);
    if (existing !== undefined && existing !== key) {
      throw new TypeError('Claude CLI environment keys must be case-insensitively unique.');
    }
    normalizedEnvironmentKeys.set(normalized, key);
  }
  for (const key of ADAPTER_OWNED_ENVIRONMENT) {
    if (normalizedEnvironmentKeys.has(key)) {
      throw new TypeError(`Claude CLI environment must not override adapter-owned ${key}.`);
    }
  }
  supplied.DISABLE_AUTOUPDATER = {
    value: '1',
    identity: { identityKind: 'behavior', value: true },
  };
  supplied.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = {
    value: '1',
    identity: { identityKind: 'behavior', value: true },
  };
  supplied.CLAUDE_CODE_SKIP_PROMPT_HISTORY = {
    value: '1',
    identity: { identityKind: 'behavior', value: true },
  };
  for (const key of [
    'CLAUDE_CODE_DISABLE_ATTACHMENTS',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
    'CLAUDE_CODE_DISABLE_CRON',
  ]) {
    supplied[key] = {
      value: '1',
      identity: { identityKind: 'behavior', value: true },
    };
  }
  const environment = captureClassifiedEnvironment(supplied);
  return Object.freeze({
    executablePath,
    ...(hookNodeExecutablePath === undefined ? {} : { hookNodeExecutablePath }),
    environment: environment.values,
    environmentIdentity: environment.identity,
    environmentOutputClassification: environment.outputClassification,
    maxOutputBytes: positiveSafeInteger(
      input.maxOutputBytes ?? DEFAULT_CLAUDE_CLI_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    ),
    maxInputBytes: positiveSafeInteger(
      input.maxInputBytes ?? DEFAULT_CLAUDE_CLI_MAX_INPUT_BYTES,
      'maxInputBytes',
    ),
    identityProbeTimeoutMs: positiveSafeInteger(
      input.identityProbeTimeoutMs ?? DEFAULT_CLAUDE_CLI_IDENTITY_PROBE_TIMEOUT_MS,
      'identityProbeTimeoutMs',
    ),
  });
}

function executionEnvironment(
  configuration: CapturedConfiguration,
  configDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...configuration.environment,
    CLAUDE_CONFIG_DIR: configDirectory,
  };
}

async function runProbe(
  configuration: CapturedConfiguration,
  argument: '--version' | '--help',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omk-claude-identity-'));
  const directory = join(root, 'cwd');
  const configDirectory = join(root, 'config');
  try {
    await Promise.all([mkdir(directory), mkdir(configDirectory)]);
    const { child, done } = spawnWithSigintPropagation(
      configuration.executablePath,
      [argument],
      {
        cwd: directory,
        env: executionEnvironment(configuration, configDirectory),
        maxBuffer: Math.min(configuration.maxOutputBytes, 64 * 1024),
        timeoutMs: configuration.identityProbeTimeoutMs,
      },
    );
    if (child.stdin !== null) {
      child.stdin.on('error', () => undefined);
      child.stdin.end();
    }
    let stdout: string;
    try {
      stdout = (await done).stdout.trim();
    } catch {
      throw new TypeError(`Claude CLI ${argument} identity probe failed.`);
    }
    return stdout;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertSupportedVersion(version: string): void {
  if (version.includes('-')) {
    throw new TypeError('Claude CLI Core adapter does not accept prerelease Claude Code builds.');
  }
  const numeric = version.split(/[+-]/, 1)[0]!.split('.').map(Number);
  const minimum = MINIMUM_CLAUDE_CLI_CORE_VERSION.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (numeric[index]! > minimum[index]!) return;
    if (numeric[index]! < minimum[index]!) {
      throw new TypeError(
        `Claude CLI Core adapter requires Claude Code ${MINIMUM_CLAUDE_CLI_CORE_VERSION} or newer.`,
      );
    }
  }
}

async function runVersionProbe(configuration: CapturedConfiguration): Promise<string> {
  const stdout = (await runProbe(configuration, '--version')).trim();
  const match = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s+\(Claude Code\))?$/.exec(stdout);
  if (match?.[1] === undefined || match[1].length > 128) {
    throw new TypeError('Claude CLI version probe returned an invalid version.');
  }
  assertSupportedVersion(match[1]);
  const help = await runProbe(configuration, '--help');
  const requiredFlags = [
    '--append-system-prompt-file',
    '--disable-slash-commands',
    '--disallowedTools',
    '--effort',
    '--mcp-config',
    '--model',
    '--no-chrome',
    '--no-session-persistence',
    '--output-format',
    '--permission-mode',
    '--print',
    '--setting-sources',
    '--settings',
    '--strict-mcp-config',
    '--tools',
    '--verbose',
  ];
  if (requiredFlags.some((flag) => !help.includes(flag))) {
    throw new TypeError('Claude CLI identity probe is missing required Core adapter flags.');
  }
  return match[1];
}

async function assertIdentityUnchanged(
  files: readonly CapturedIdentityFile[],
  signal?: AbortSignal,
): Promise<void> {
  await assertIdentityFilesUnchanged(files, {
    adapterLabel: 'Claude CLI',
    cancellationCode: 'OMK_CLAUDE_CLI_CANCELLED',
    identityChangedCode: 'OMK_CLAUDE_CLI_IDENTITY_CHANGED',
    ...(signal === undefined ? {} : { signal }),
  });
}

function identityManifest(
  configuration: CapturedConfiguration,
  target: CapturedClaudeCliTarget,
  files: readonly CapturedIdentityFile[],
): RuntimeIdentity['implementationManifest'] {
  const facets: RuntimeImplementationFacet[] = [{
    facetId: 'adapter.composition',
    value: {
      adapterVersion: CLAUDE_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      cancellation: 'sigterm-then-sigkill',
      hostArchitecture: process.arch,
      hostPlatform: process.platform,
      processIsolation: 'per-attempt',
      sourceProtocol: 'claude --print --output-format stream-json',
    },
  }, {
    facetId: 'adapter.environment',
    value: { entries: [...configuration.environmentIdentity] },
  }, {
    facetId: 'adapter.input-projection',
    value: {
      artifactInstructions: 'append-system-prompt-file',
      directoryEntrypoint: 'SKILL.md',
      supportingFiles: 'canonical-user-envelope',
      promptTransport: 'stdin',
      version: 'omk.claude-cli-prompt/v1',
    },
  }, {
    facetId: 'adapter.limits',
    value: {
      maxInputBytes: configuration.maxInputBytes,
      maxOutputBytes: configuration.maxOutputBytes,
      identityProbeTimeoutMs: configuration.identityProbeTimeoutMs,
    },
  }, {
    facetId: 'claude.binary-coverage',
    value: {
      coverage: 'declared-files-reverified-before-spawn',
      files: files.map(({ facetId, digest, size }) => ({ facetId, digest, size })),
    },
  }, {
    facetId: 'claude.fixed-controls',
    value: {
      configDirectory: 'private-per-attempt',
      capabilityProbe: 'audited-minimum-version-and-required-help-flags',
      implicitAttachments: 'disabled',
      managedPolicy: 'host-level-opaque-and-non-overridable',
      memory: 'claude-md-and-auto-memory-disabled',
      mcp: 'strict-config',
      minimumVersion: MINIMUM_CLAUDE_CLI_CORE_VERSION,
      nonessentialTraffic: 'disabled',
      permissionMode: 'bypassPermissions',
      persistentBackgroundWork: 'disabled',
      sessionPersistence: 'disabled',
      settingSources: [],
      updater: 'disabled',
    },
  }, {
    facetId: 'claude.launcher',
    value: {
      executablePathDigest: digestCanonicalJson(configuration.executablePath),
      ...(configuration.hookNodeExecutablePath === undefined
        ? {}
        : {
            hookNodeExecutablePathDigest: digestCanonicalJson(
              configuration.hookNodeExecutablePath,
            ),
          }),
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
  additionalIdentityFiles: readonly ContentIdentityFile[],
): Promise<{ identity: RuntimeIdentity; files: readonly CapturedIdentityFile[] }> {
  const capabilities = claudeCliExecutorCapabilities();
  const files = await captureIdentityFiles([
    { facetId: 'claude-executable', path: configuration.executablePath },
    ...(configuration.hookNodeExecutablePath === undefined
      ? []
      : [{ facetId: 'mock-hook-node', path: configuration.hookNodeExecutablePath }]),
    ...additionalIdentityFiles,
  ], 'Claude CLI');
  const version = await runVersionProbe(configuration);
  await assertIdentityUnchanged(files);
  const evidence = files.map(({ facetId, digest, size }) => ({ facetId, digest, size }));
  const identity = RuntimeIdentitySchema.parse({
    implementationId: target.binding.implementationId,
    version,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.claude-cli-content-fingerprint/v1',
      adapterVersion: CLAUDE_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION,
      version,
      capabilities,
      evidence,
    }),
    fingerprintBasis: 'content-derived',
    // Binary bytes are covered, but the remote deployment and host-managed policy are opaque.
    assuranceLevel: 'declared',
    capabilities,
    implementationManifest: identityManifest(configuration, target, files),
  });
  return { identity: deepFreezeCanonicalJson(identity), files: Object.freeze(files) };
}

export function buildClaudeCliCoreArguments(input: Readonly<{
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  systemPromptFile?: string;
  mcpConfigFiles: readonly string[];
  settingsFile?: string;
  allowedTools?: readonly string[];
  disableSkills: boolean;
}>): string[] {
  const disallowedTools = [
    ...(input.allowedTools === undefined ? [] : ['mcp__*']),
    ...(input.disableSkills ? ['Skill'] : []),
  ];
  const mcpConfigs = input.mcpConfigFiles.length === 0
    ? ['{"mcpServers":{}}']
    : [...input.mcpConfigFiles];
  return [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', input.model,
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
    '--no-chrome',
    '--setting-sources', '',
    ...(input.settingsFile === undefined ? [] : ['--settings', input.settingsFile]),
    '--mcp-config', ...mcpConfigs,
    '--strict-mcp-config',
    ...(input.systemPromptFile === undefined
      ? []
      : ['--append-system-prompt-file', input.systemPromptFile]),
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
    ...(input.allowedTools === undefined
      ? []
      : ['--tools', input.allowedTools.join(',')]),
    ...(input.disableSkills ? ['--disable-slash-commands'] : []),
    ...(disallowedTools.length === 0 ? [] : ['--disallowedTools', ...disallowedTools]),
  ];
}

function processFailure(error: unknown): never {
  const spawnError = error as SpawnHelperError;
  if (spawnError.failureKind === 'buffer-limit') {
    fail(
      'OMK_CLAUDE_CLI_OUTPUT_LIMIT_EXCEEDED',
      'infrastructure',
      'Claude CLI output exceeded the adapter byte limit.',
    );
  }
  if (spawnError.failureKind === 'abort') {
    fail('OMK_CLAUDE_CLI_CANCELLED', 'execution', 'Claude CLI execution was cancelled.');
  }
  let usage: UsageRecord | undefined;
  if (spawnError.stdout?.trim()) {
    try {
      usage = parseClaudeCliStream(spawnError.stdout).usage;
    } catch {
      // Process failure is authoritative; malformed provider details remain redacted.
    }
  }
  if (spawnError.failureKind === 'nonzero-exit') {
    fail('OMK_CLAUDE_CLI_EXIT_NONZERO', 'execution', 'Claude CLI exited unsuccessfully.', usage);
  }
  fail('OMK_CLAUDE_CLI_SPAWN_FAILED', 'infrastructure', 'Claude CLI process could not run.', usage);
}

async function executeClaude(
  configuration: CapturedConfiguration,
  target: CapturedClaudeCliTarget,
  runState: ClaudeCliRunState,
  trialState: ClaudeCliTrialState,
  attempt: Readonly<ExecutorAttemptContext>,
  configDirectory: string,
  systemPromptFile?: string,
  mockHandle?: CliMockHandle,
): Promise<ParsedClaudeCliStream> {
  if (attempt.signal.aborted) {
    fail('OMK_CLAUDE_CLI_CANCELLED', 'execution', 'Claude CLI execution was cancelled.');
  }
  const mcpConfigFiles = [
    ...(runState.mcpConfigFile === undefined ? [] : [runState.mcpConfigFile]),
    ...(mockHandle?.mcpConfigFile === undefined ? [] : [mockHandle.mcpConfigFile]),
  ];
  const args = buildClaudeCliCoreArguments({
    model: target.binding.qualification.model,
    ...(target.binding.qualification.effort === undefined
      ? {}
      : { effort: target.binding.qualification.effort }),
    ...(systemPromptFile === undefined
      ? {}
      : { systemPromptFile }),
    mcpConfigFiles,
    ...(mockHandle?.settingsFile === undefined ? {} : { settingsFile: mockHandle.settingsFile }),
    ...(trialState.allowedTools === undefined
      ? {}
      : { allowedTools: trialState.allowedTools }),
    disableSkills: target.config.behavior.allowedSkills !== undefined,
  });
  const internalAbort = new AbortController();
  const processSignal = AbortSignal.any([attempt.signal, internalAbort.signal]);
  let subprocess: ReturnType<typeof spawnWithSigintPropagation>;
  try {
    subprocess = spawnWithSigintPropagation(
      configuration.executablePath,
      args,
      {
        cwd: trialState.workingDirectory,
        env: {
          ...executionEnvironment(configuration, configDirectory),
          ...(mockHandle?.env ?? {}),
        },
        maxBuffer: configuration.maxOutputBytes,
        abortSignal: processSignal,
      },
    );
  } catch {
    fail(
      'OMK_CLAUDE_CLI_SPAWN_FAILED',
      'infrastructure',
      'Claude CLI process could not run.',
    );
  }
  const { child, done } = subprocess;
  let stdinFailed = child.stdin === null;
  let stdinWriteCompleted = false;
  if (child.stdin === null) internalAbort.abort();
  else {
    child.stdin.on('error', () => {
      // EPIPE during process teardown is not a failed prompt delivery once the
      // complete payload has already been accepted by the writable stream.
      if (!stdinWriteCompleted) {
        stdinFailed = true;
        internalAbort.abort();
      }
    });
    child.stdin.end(trialState.prompt, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        stdinFailed = true;
        internalAbort.abort();
        return;
      }
      stdinWriteCompleted = true;
    });
  }
  try {
    const stdout = (await done).stdout;
    if (stdinFailed) {
      fail(
        'OMK_CLAUDE_CLI_STDIN_UNAVAILABLE',
        'infrastructure',
        'Claude CLI stdin is unavailable.',
      );
    }
    return parseClaudeCliStream(stdout);
  } catch (error) {
    if (error instanceof ExecutionPortFailure) throw error;
    if (stdinFailed && !attempt.signal.aborted) {
      fail(
        'OMK_CLAUDE_CLI_STDIN_UNAVAILABLE',
        'infrastructure',
        'Claude CLI stdin is unavailable.',
      );
    }
    processFailure(error);
  }
}

interface ClaudeCliAttemptState {
  readonly configDirectory: string;
  readonly systemPromptFile?: string;
}

async function pathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function materializeAttemptState(
  runState: ClaudeCliRunState,
): Promise<ClaudeCliAttemptState> {
  let configDirectory: string | undefined;
  try {
    configDirectory = await mkdtemp(join(tmpdir(), 'omk-claude-attempt-'));
    if (runState.systemInstructions === undefined) {
      return Object.freeze({ configDirectory });
    }
    const systemPromptFile = join(configDirectory, 'knowledge-artifact.md');
    await writeFile(systemPromptFile, runState.systemInstructions, { mode: 0o400 });
    return Object.freeze({ configDirectory, systemPromptFile });
  } catch {
    if (configDirectory !== undefined) {
      let cleanupFailed = false;
      try {
        await rm(configDirectory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed || !(await pathAbsent(configDirectory))) {
        fail(
          'OMK_CLAUDE_CLI_ATTEMPT_DISPOSE_FAILED',
          'infrastructure',
          'Claude CLI partial attempt controls could not be disposed.',
        );
      }
    }
    fail(
      'OMK_CLAUDE_CLI_ATTEMPT_MATERIALIZATION_FAILED',
      'infrastructure',
      'Claude CLI attempt controls could not be materialized.',
    );
  }
}

async function disposeAttemptState(state: ClaudeCliAttemptState): Promise<void> {
  try {
    await rm(state.configDirectory, { recursive: true, force: true });
  } catch {
    fail(
      'OMK_CLAUDE_CLI_ATTEMPT_DISPOSE_FAILED',
      'infrastructure',
      'Claude CLI attempt controls could not be disposed.',
    );
  }
  if (!(await pathAbsent(state.configDirectory))) {
    fail(
      'OMK_CLAUDE_CLI_ATTEMPT_DISPOSE_FAILED',
      'infrastructure',
      'Claude CLI attempt controls could not be disposed.',
    );
  }
}

async function executeAttempt(
  configuration: CapturedConfiguration,
  target: CapturedClaudeCliTarget,
  runState: ClaudeCliRunState,
  trialState: ClaudeCliTrialState,
  attempt: Readonly<ExecutorAttemptContext>,
): Promise<ExecutorAttemptResult> {
  const attemptState = await materializeAttemptState(runState);
  let mockHandle: CliMockHandle | undefined;
  try {
    mockHandle = trialState.mocks === undefined
      ? undefined
      : materializeForCliConfigDir(
          [...trialState.mocks],
          undefined,
          trialState.mocksStrict,
          configuration.hookNodeExecutablePath,
        ) ?? undefined;
  } catch {
    await disposeAttemptState(attemptState);
    fail(
      'OMK_CLAUDE_CLI_MOCK_MATERIALIZATION_FAILED',
      'infrastructure',
      'Claude CLI mock controls could not be materialized.',
    );
  }
  let result: ParsedClaudeCliStream | undefined;
  let mockStats: ReturnType<CliMockHandle['readStats']> | undefined;
  let executionError: unknown;
  try {
    result = await executeClaude(
      configuration,
      target,
      runState,
      trialState,
      attempt,
      attemptState.configDirectory,
      attemptState.systemPromptFile,
      mockHandle,
    );
  } catch (error) {
    executionError = error;
  }
  if (mockHandle !== undefined) mockStats = mockHandle.readStats();
  let disposeError: unknown;
  if (mockHandle !== undefined) {
    try {
      await disposeClaudeCliMockHandle(mockHandle);
    } catch (error) {
      disposeError = error;
    }
  }
  try {
    await disposeAttemptState(attemptState);
  } catch (error) {
    disposeError ??= error;
  }
  if (disposeError !== undefined) throw disposeError;
  if (executionError !== undefined) throw executionError;
  if (result === undefined) {
    fail('OMK_CLAUDE_CLI_EXECUTION_FAILED', 'infrastructure', 'Claude CLI produced no result.');
  }
  if (result.terminalStatus === 'failed') {
    fail(
      'OMK_CLAUDE_CLI_TURN_FAILED',
      'execution',
      'Claude CLI reported a failed turn.',
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
      value: attachSourceNeutralMockStats(result.trace, mockStats),
      classification: outputClassification,
      mediaType: 'application/vnd.omk.source-neutral-trace+json',
    },
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

/**
 * Creates a binding-local Claude CLI Core Executor. Core remains the sole owner
 * of retry, timeout, budget, cache, and attempt cancellation policy.
 */
export async function createClaudeCliExecutorAdapter(
  input: Readonly<CreateClaudeCliExecutorAdapterInput>,
): Promise<ExecutionExecutor> {
  if (typeof input.sessionIsolationKey !== 'string' || input.sessionIsolationKey.trim() === '') {
    throw new TypeError('Claude CLI adapter requires a non-empty sessionIsolationKey.');
  }
  const target = captureClaudeCliTarget(input.target, input.binding);
  const configuration = await captureConfiguration(
    input.command,
    (target.config.behavior.mocks?.length ?? 0) > 0,
  );
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
        return captureClaudeCliRunState(resources, target, configuration.maxInputBytes);
      },
      async openTrial({ runState, trial }) {
        if (
          trial.protocolId !== target.binding.protocolId
          || trial.targetId !== target.binding.targetId
          || canonicalizeJson(trial.targetConfig ?? null)
            !== canonicalizeJson(target.target.config ?? null)
        ) {
          fail(
            'OMK_CLAUDE_CLI_TRIAL_MISMATCH',
            'infrastructure',
            'Claude CLI trial does not match the sealed Target binding.',
          );
        }
        runState.acquireTrial();
        try {
          return openClaudeCliTrial(
            trial,
            runState,
            configuration.maxInputBytes,
          );
        } catch (error) {
          await runState.releaseTrial();
          throw error;
        }
      },
      async execute({ runState, trialState, attempt }) {
        await assertIdentityUnchanged(files, attempt.signal);
        return executeAttempt(configuration, target, runState, trialState, attempt);
      },
      disposeTrial({ runState }) {
        return disposeClaudeCliTrial(runState);
      },
      disposeRun({ runState }) {
        return runState.requestDispose();
      },
    },
  });
}
