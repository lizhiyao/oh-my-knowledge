import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../evaluation-core/contracts/index.js';
import { checkDependencies } from '../../preflight/dependencies.js';
import { createExecutor } from '../../executors/index.js';
import type { ExecutorFn } from '../../executors/contracts/ports.js';
import type { Artifact } from '../../artifacts/contracts.js';
import type { CliEvaluationCompileResult } from '../input-compilation/index.js';
import type {
  OmkLlmJudgeInvocationBinding,
  OmkLlmJudgeInvocationRequest,
  OmkRuntimePreflightDeclaration,
} from '../runtime-adapter/index.js';
import { OmkUserFacingPreflightFailure } from '../runtime-adapter/preflight.js';
import {
  createAnthropicApiCoreSchemaValidators,
  createClaudeCliCoreSchemaValidators,
  createClaudeSdkCoreSchemaValidators,
  createCodexCliCoreSchemaValidators,
  createCodexSdkCoreSchemaValidators,
  createCustomCommandCoreSchemaValidators,
  createOpenAIApiCoreSchemaValidators,
  customCommandExecutorCapabilities,
} from '../runtime-adapter/adapters/index.js';
import type { ClassifiedEnvironmentEntry } from '../runtime-adapter/adapters/shared/classified-environment.js';
import {
  createNodeEvaluationRuntimeSupportPorts,
  createProductionRuntimeFactoryRegistry,
  type ProductionExecutorAdapterConfiguration,
} from './runtime-registry.js';

const CREDENTIAL_ENVIRONMENT = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
]);

const EFFECT_LOCATOR_ENVIRONMENT = new Set([
  'CODEX_HOME',
  'HOME',
  'PATH',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

const BEHAVIOR_ENVIRONMENT = new Set([
  'LANG',
  'LC_ALL',
  'NO_COLOR',
]);

export interface NodeCliProductionComposition {
  readonly factories: ReturnType<typeof createProductionRuntimeFactoryRegistry>;
  readonly support: ReturnType<typeof createNodeEvaluationRuntimeSupportPorts>;
  readonly resources: { readonly leaseRoot: string };
}

export interface CreateNodeCliProductionCompositionInput {
  readonly compiled: CliEvaluationCompileResult;
  readonly projectRoot: string;
  readonly outputDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export class NodeCliProductionCompositionError extends Error {
  readonly code:
    | 'NODE_CLI_EXECUTOR_UNSUPPORTED'
    | 'NODE_CLI_EXECUTABLE_UNAVAILABLE'
    | 'NODE_CLI_CREDENTIAL_MISSING';

  constructor(
    code: NodeCliProductionCompositionError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'NodeCliProductionCompositionError';
    this.code = code;
  }
}

function classifiedEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, ClassifiedEnvironmentEntry>> {
  const keys = new Set([
    ...CREDENTIAL_ENVIRONMENT,
    ...EFFECT_LOCATOR_ENVIRONMENT,
    ...BEHAVIOR_ENVIRONMENT,
  ]);
  return Object.freeze(Object.fromEntries([...keys].sort().flatMap((key) => {
    const value = environment[key];
    if (value === undefined) return [];
    const identity: ClassifiedEnvironmentEntry['identity'] = CREDENTIAL_ENVIRONMENT.has(key)
      ? { identityKind: 'credential' }
      : EFFECT_LOCATOR_ENVIRONMENT.has(key)
        ? { identityKind: 'effect-locator' }
        : { identityKind: 'behavior', value };
    return [[key, Object.freeze({ value, identity })]];
  })));
}

async function resolveExecutable(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => (
      join(directory, command)
    ));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the explicit PATH snapshot.
    }
  }
  throw new NodeCliProductionCompositionError(
    'NODE_CLI_EXECUTABLE_UNAVAILABLE',
    `执行器「${command}」在当前 PATH 中不可用。`,
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

async function doctorArtifacts(compiled: CliEvaluationCompileResult): Promise<Artifact[]> {
  const targetsById = new Map(compiled.definition.targets.map((target) => [target.targetId, target]));
  return Promise.all(compiled.hostResources.resources.flatMap((resource) => {
    if (resource.resourceKind !== 'artifact') return [];
    const lineage = record(resource.lineage);
    const targetId = typeof lineage?.targetId === 'string' ? lineage.targetId : undefined;
    const target = targetId === undefined ? undefined : targetsById.get(targetId);
    const artifactKind = lineage?.artifactKind;
    if (target === undefined || artifactKind === 'baseline'
        || !['skill', 'prompt', 'agent', 'workflow'].includes(String(artifactKind))) return [];
    return [(async (): Promise<Artifact> => {
      const sourceLocator = typeof lineage?.sourceLocator === 'string'
        ? lineage.sourceLocator
        : resource.locator;
      const isDirectorySkill = typeof lineage?.skillRootLocator === 'string';
      const skillRoot = isDirectorySkill ? resource.locator : undefined;
      const contentPath = skillRoot === undefined
        ? resource.locator
        : join(resource.locator, 'SKILL.md');
      const content = await readFile(contentPath, 'utf8');
      const sourceKind = lineage?.sourceKind;
      return {
        name: target.targetId,
        kind: artifactKind as Artifact['kind'],
        source: ['variant-name', 'file-path', 'git', 'inline', 'custom'].includes(String(sourceKind))
          ? sourceKind as Artifact['source']
          : 'custom',
        content,
        locator: sourceLocator,
        ...(skillRoot === undefined ? {} : { skillRoot }),
        ...(typeof lineage?.workingDirectoryLocator === 'string'
          ? { cwd: lineage.workingDirectoryLocator }
          : {}),
      };
    })()];
  }));
}

function dependencyDoctor(
  compiled: CliEvaluationCompileResult,
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): OmkRuntimePreflightDeclaration {
  let result: Promise<void> | undefined;
  return Object.freeze({
    preflightKind: 'doctor' as const,
    checkId: 'host-dependencies',
    preflightDisposition: 'check' as const,
    async run(): Promise<void> {
      result ??= (async () => {
        const requirements = compiled.orchestration.dependencyRequirements;
        if (requirements !== undefined) {
          const { baseDirectoryLocator, ...dependencies } = requirements;
          const checked = await checkDependencies({
            ...(dependencies.tools === undefined ? {} : { tools: [...dependencies.tools] }),
            ...(dependencies.files === undefined ? {} : { files: [...dependencies.files] }),
            ...(dependencies.env === undefined ? {} : { env: [...dependencies.env] }),
            ...(dependencies.preflight === undefined ? {} : {
              preflight: [...dependencies.preflight],
            }),
          }, baseDirectoryLocator, environment);
          if (!checked.ok) throw new Error('Evaluation dependency doctor failed.');
        }
        const artifacts = await doctorArtifacts(compiled);
        if (artifacts.length === 0) return;
        const { runDoctor } = await import('../../doctor/index.js');
        const { renderDoctorReportText } = await import('../../doctor/renderer.js');
        const { tEvalWorkflowMessage } = await import('../messages.js');
        const language = compiled.presentation.language;
        const report = await runDoctor({
          artifacts,
          cwd: projectRoot,
          dependencyCwd: requirements?.baseDirectoryLocator ?? projectRoot,
          executorName: compiled.definition.targets[0]?.executorId ?? 'unknown',
          model: 'core-runtime',
          timeoutMs: compiled.policy.execution.timeoutMs ?? 8_000,
          lang: language,
        });
        if (report.outcome === 'failed') {
          renderDoctorReportText(report, language);
          throw new OmkUserFacingPreflightFailure(
            `doctor failed:\n${tEvalWorkflowMessage('doctor_gate_blocked', language)}`,
          );
        }
      })();
      return result;
    },
  });
}

export function createNodeHostPreflightDeclarations(
  compiled: CliEvaluationCompileResult,
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): readonly OmkRuntimePreflightDeclaration[] {
  const hasMcpResource = compiled.hostResources.resources.some(
    (resource) => resource.resourceKind === 'mcp-config',
  );
  const hasMockResource = compiled.hostResources.resources.some(
    (resource) => resource.resourceKind === 'mock-rule'
      || resource.resourceKind === 'mock-payload',
  );
  const mcpPreflight: OmkRuntimePreflightDeclaration = hasMcpResource
    ? {
        preflightKind: 'mcp-readiness',
        checkId: 'sealed-mcp-resource',
        preflightDisposition: 'check',
        async run(): Promise<void> {
          await Promise.all(compiled.hostResources.resources
            .filter((resource) => resource.resourceKind === 'mcp-config')
            .map((resource) => access(resource.locator, constants.R_OK)));
        },
      }
    : {
        preflightKind: 'mcp-readiness',
        checkId: 'sealed-mcp-resource',
        preflightDisposition: 'not-required',
        reasonCode: 'no-mcp-resource',
      };
  const mockPreflight: OmkRuntimePreflightDeclaration = hasMockResource
    ? {
        preflightKind: 'mock-readiness',
        checkId: 'sealed-mock-resources',
        preflightDisposition: 'check',
        async run(): Promise<void> {
          await Promise.all(compiled.hostResources.resources
            .filter((resource) => resource.resourceKind === 'mock-rule'
              || resource.resourceKind === 'mock-payload')
            .map((resource) => access(resource.locator, constants.R_OK)));
        },
      }
    : {
        preflightKind: 'mock-readiness',
        checkId: 'sealed-mock-resources',
        preflightDisposition: 'not-required',
        reasonCode: 'no-mock-resource',
      };
  return Object.freeze([
    dependencyDoctor(compiled, environment, projectRoot),
    Object.freeze({
      preflightKind: 'filesystem' as const,
      checkId: 'sealed-resource-locators',
      preflightDisposition: 'check' as const,
      async run(): Promise<void> {
        await Promise.all(compiled.hostResources.resources.map((resource) => (
          access(resource.locator, constants.R_OK)
        )));
      },
    }),
    Object.freeze(mcpPreflight),
    Object.freeze(mockPreflight),
    Object.freeze({
      preflightKind: 'credential' as const,
      checkId: 'host-credential',
      preflightDisposition: 'not-required' as const,
      reasonCode: 'adapter-validates-credential',
    }),
    Object.freeze({
      preflightKind: 'connectivity' as const,
      checkId: 'provider-connectivity',
      preflightDisposition: 'not-required' as const,
      reasonCode: 'core-execution-is-authoritative',
    }),
  ]);
}

function requiredCredential(
  environment: NodeJS.ProcessEnv,
  key: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY',
): string {
  const value = environment[key]?.trim();
  if (value !== undefined && value !== '') return value;
  throw new NodeCliProductionCompositionError(
    'NODE_CLI_CREDENTIAL_MISSING',
    `执行器需要环境变量 ${key}。`,
  );
}

async function executorConfiguration(
  implementationId: string,
  compiled: CliEvaluationCompileResult,
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): Promise<ProductionExecutorAdapterConfiguration> {
  const preflightDeclarations = createNodeHostPreflightDeclarations(
    compiled,
    environment,
    projectRoot,
  );
  const capturedEnvironment = classifiedEnvironment(environment);
  switch (implementationId) {
    case 'codex':
      return Object.freeze({
        adapterKind: 'codex-cli',
        command: {
          executablePath: await resolveExecutable('codex', environment),
          environment: capturedEnvironment,
        },
        preflightDeclarations,
      });
    case 'codex-sdk':
      return Object.freeze({
        adapterKind: 'codex-sdk',
        sdk: { environment: capturedEnvironment },
        preflightDeclarations,
      });
    case 'claude':
      return Object.freeze({
        adapterKind: 'claude-cli',
        command: {
          executablePath: await resolveExecutable('claude', environment),
          environment: capturedEnvironment,
        },
        preflightDeclarations,
      });
    case 'claude-sdk':
      return Object.freeze({
        adapterKind: 'claude-sdk',
        sdk: { environment: capturedEnvironment },
        preflightDeclarations,
      });
    case 'openai-api':
      return Object.freeze({
        adapterKind: 'openai-api',
        api: { apiKey: requiredCredential(environment, 'OPENAI_API_KEY') },
        preflightDeclarations,
      });
    case 'anthropic-api':
      return Object.freeze({
        adapterKind: 'anthropic-api',
        api: { apiKey: requiredCredential(environment, 'ANTHROPIC_API_KEY') },
        preflightDeclarations,
      });
    default: {
      const runtimeResource = compiled.hostResources.resources.find((resource) => (
        resource.resourceKind === 'runtime-implementation'
        && typeof resource.lineage === 'object'
        && resource.lineage !== null
        && !Array.isArray(resource.lineage)
        && resource.lineage.lineageKind === 'custom-command-runtime'
        && implementationId === `custom-command-${resource.descriptor.digest.slice('sha256:'.length)}`
      ));
      if (runtimeResource === undefined) {
        throw new NodeCliProductionCompositionError(
          'NODE_CLI_EXECUTOR_UNSUPPORTED',
          `Evaluation Core 找不到执行器「${implementationId}」的可信 Runtime 声明。`,
        );
      }
      return Object.freeze({
        adapterKind: 'custom-command',
        runtime: {
          implementationId,
          version: '1.0.0',
          capabilities: customCommandExecutorCapabilities(),
          contentIdentityFiles: [{ facetId: 'runtime-executable', path: runtimeResource.locator }],
        },
        command: {
          executablePath: runtimeResource.locator,
          environment: capturedEnvironment,
        },
        preflightDeclarations,
      });
    }
  }
}

function productionSchemaValidators(): ReadonlyMap<string, CoreSchemaValidator> {
  const validators = [
    ...createCodexCliCoreSchemaValidators(),
    ...createCodexSdkCoreSchemaValidators(),
    ...createClaudeCliCoreSchemaValidators(),
    ...createClaudeSdkCoreSchemaValidators(),
    ...createOpenAIApiCoreSchemaValidators(),
    ...createAnthropicApiCoreSchemaValidators(),
    ...createCustomCommandCoreSchemaValidators(),
  ];
  return new Map(validators.map((validator) => [schemaIdentityKey(validator.schema), validator]));
}

function judgeIdentity(
  executorId: string,
  model: string,
): RuntimeIdentity {
  const capabilities = { providerInvocation: 'single', model };
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: executorId,
    fingerprint: digestCanonicalJson({
      derivation: 'omk.node-cli-judge-provider/v1',
      executorId,
      model,
    }),
    fingerprintBasis: 'opaque',
    assuranceLevel: 'unknown',
    capabilities,
    implementationManifest: {
      coverageKind: 'fingerprint-plus-facets',
      facets: [{
        facetId: 'provider.binding',
        value: { executorId, model },
      }],
    },
  })) as RuntimeIdentity;
}

function usage(result: Awaited<ReturnType<ExecutorFn>>): UsageRecord | undefined {
  const value: UsageRecord = {
    ...(result.tokenUsageReportedByExecutor === false ? {} : {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
    }),
    ...(result.costReportedByExecutor === false ? {} : {
      providerCost: {
        amount: result.costUSD,
        currency: 'USD',
        reportedByProvider: true,
      },
    }),
  };
  return Object.keys(value).length === 0 ? undefined : value;
}

function judgeResolver(): (
  context: Parameters<NonNullable<Parameters<typeof createProductionRuntimeFactoryRegistry>[0]['resolveJudgeInvocation']>>[0],
) => Promise<OmkLlmJudgeInvocationBinding> {
  const executors = new Map<string, ExecutorFn>();
  return async (context) => {
    const qualification = context.binding.qualification;
    if (qualification === undefined) {
      throw new NodeCliProductionCompositionError(
        'NODE_CLI_EXECUTOR_UNSUPPORTED',
        'LLM 评委 binding 缺少 provider qualification。',
      );
    }
    const executorId = qualification.executorId;
    let executor = executors.get(executorId);
    if (executor === undefined) {
      executor = createExecutor(executorId);
      executors.set(executorId, executor);
    }
    const provider = executor;
    return Object.freeze({
      port: Object.freeze({
        identity: judgeIdentity(executorId, qualification.model),
        providerCost: { reporting: 'optional' as const },
        async invoke(request: Readonly<OmkLlmJudgeInvocationRequest>) {
          try {
            const result = await provider({
              model: request.model,
              system: request.system,
              prompt: request.prompt,
              effort: request.effort,
              abortSignal: request.signal,
            });
            const measuredUsage = usage(result);
            return result.ok && result.output !== null
              ? {
                  invocationStatus: 'completed' as const,
                  output: result.output,
                  ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
                }
              : {
                  invocationStatus: 'failed' as const,
                  reasonCode: request.signal.aborted
                    ? 'provider-invocation-cancelled'
                    : 'provider-invocation-failed',
                  ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
                };
          } catch {
            return {
              invocationStatus: 'failed' as const,
              reasonCode: request.signal.aborted
                ? 'provider-invocation-cancelled'
                : 'provider-invocation-failed',
            };
          }
        },
      }),
      preflightDeclarations: Object.freeze([Object.freeze({
        preflightKind: 'connectivity' as const,
        checkId: 'provider-connectivity',
        preflightDisposition: 'not-required' as const,
        reasonCode: 'core-evaluation-is-authoritative',
      }), Object.freeze({
        preflightKind: 'credential' as const,
        checkId: 'host-credential',
        preflightDisposition: 'not-required' as const,
        reasonCode: 'provider-validates-credential',
      })]),
    });
  };
}

/** Builds the Node CLI's only production Runtime composition from sealed input. */
export async function createNodeCliProductionComposition(
  input: Readonly<CreateNodeCliProductionCompositionInput>,
): Promise<NodeCliProductionComposition> {
  if (!isAbsolute(input.outputDirectory)) {
    throw new TypeError('outputDirectory 必须是绝对路径。');
  }
  const environment = Object.freeze({ ...(input.environment ?? process.env) });
  const implementationIds = [...new Set(input.compiled.runtimeBinding.bindings.flatMap((binding) => (
    binding.runtimeKind === 'executor' ? [binding.implementationId] : []
  )))].sort();
  const configurations = await Promise.all(implementationIds.map(async (implementationId) => (
    [implementationId, await executorConfiguration(
      implementationId,
      input.compiled,
      environment,
      input.projectRoot,
    )] as const
  )));
  const baseSupport = createNodeEvaluationRuntimeSupportPorts({
    contentStoreRoot: join(input.outputDirectory, 'content'),
  });
  const support = Object.freeze({
    ...baseSupport,
    schemaValidators: productionSchemaValidators(),
  });
  return Object.freeze({
    factories: createProductionRuntimeFactoryRegistry({
      executorsByImplementationId: new Map(configurations),
      resolveJudgeInvocation: judgeResolver(),
    }),
    support,
    resources: Object.freeze({
      leaseRoot: join(input.outputDirectory, 'runtime-leases'),
    }),
  });
}
