import { join, resolve } from 'node:path';
import {
  RuntimeIdentitySchema,
  deepFreezeCanonicalJson,
  schemaIdentityKey,
  type JsonValue,
  type RuntimeIdentity,
  type UsageRecord,
} from '../evaluation-core/contracts/index.js';
import {
  compileCliEvaluationInput,
  parseCliEvaluationRequest,
} from '../eval-workflows/input-compilation/index.js';
import {
  createNodeCoreContentStore,
  createNodeCoreRunArtifactStore,
  type StoredCoreRunArtifacts,
} from '../eval-workflows/artifact-store/index.js';
import {
  createNodeEvaluationRuntimeSupportPorts,
  createNodeHostPreflightDeclarations,
  createProductionEvaluationHost,
  createProductionRuntimeFactoryRegistry,
  executeProductionEvaluationSeries,
  resolveNodeCliEvaluationRequest,
} from '../eval-workflows/production-host/index.js';
import {
  projectCoreCliRunOutcome,
  projectCoreCliSeriesOutcome,
  projectCoreManagedEvidence,
  type CoreCliRunOutcome,
  type CoreCliSeriesOutcome,
} from '../eval-workflows/downstream-projections/index.js';
import { persistCoreArtifactGraph } from '../artifact-graph/core.js';
import { managedDir, recordCoreEvalEvidence } from '../managed/index.js';
import type { ExecResult } from '../executors/contracts/result.js';
import type { ExecutorFn } from '../executors/contracts/ports.js';
import type {
  OmkExecutorBindingContext,
  OmkLlmJudgeInvocationBinding,
  OmkLlmJudgeInvocationRequest,
  OmkRuntimeBindingFactories,
} from '../eval-workflows/runtime-adapter/index.js';
import type { EvalConfig } from '../inputs/contracts/config.js';
import type { JudgeConfig } from '../types/index.js';
import { generateRunId } from '../shared/run-id.js';
import {
  createDshHostCoreExecutorAdapter,
  createDshHostCoreSchemaValidators,
} from './core-adapter.js';
import {
  createDshHostExecutor,
  type DshAgentLike,
  type DshHostContextLike,
} from './host-executor.js';

const DSH_HOST_IMPLEMENTATION_ID = 'dsh-host';

export type DshCoreEvaluationCommandResult =
  | {
      readonly outcomeKind: 'run';
      readonly outcome: CoreCliRunOutcome;
      readonly artifacts: StoredCoreRunArtifacts;
      readonly outputDirectory: string;
    }
  | {
      readonly outcomeKind: 'series';
      readonly outcome: CoreCliSeriesOutcome;
      readonly artifacts: readonly StoredCoreRunArtifacts[];
      readonly outputDirectory: string;
    };

function withoutExecutor(config: Readonly<EvalConfig>): EvalConfig {
  const result = { ...config };
  delete result.executor;
  return result;
}

function usage(result: Readonly<ExecResult>): UsageRecord | undefined {
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

function runtimeIdentity(executor: ExecutorFn, model: string): RuntimeIdentity {
  const fingerprint = executor.runtimeFingerprint?.(model);
  if (fingerprint === undefined) throw new TypeError('DSH Host 没有提供 Runtime identity。');
  const manifest = JSON.parse(JSON.stringify(fingerprint)) as JsonValue;
  return deepFreezeCanonicalJson(RuntimeIdentitySchema.parse({
    implementationId: DSH_HOST_IMPLEMENTATION_ID,
    ...(fingerprint.binary?.version === undefined ? {} : { version: fingerprint.binary.version }),
    fingerprint: fingerprint.fingerprint,
    fingerprintBasis: 'environment-derived',
    assuranceLevel: 'unknown',
    capabilities: fingerprint.capabilities as unknown as JsonValue,
    implementationManifest: {
      coverageKind: 'fingerprint-plus-facets',
      facets: [{ facetId: 'dsh.host-invocation', value: manifest }],
    },
  })) as RuntimeIdentity;
}

function judgeResolver(
  host: DshHostContextLike,
  parentAgent: DshAgentLike,
): Parameters<typeof createProductionRuntimeFactoryRegistry>[0]['resolveJudgeInvocation'] {
  const executor = createDshHostExecutor(host, { parentAgent });
  const identities = new Map<string, RuntimeIdentity>();
  return async (context): Promise<OmkLlmJudgeInvocationBinding> => {
    const qualification = context.binding.qualification;
    if (qualification === undefined
        || qualification.executorId !== DSH_HOST_IMPLEMENTATION_ID) {
      throw new TypeError('DSH Host 只能解析继承当前宿主的评委 Runtime。');
    }
    const identity = identities.get(qualification.model)
      ?? runtimeIdentity(executor, qualification.model);
    identities.set(qualification.model, identity);
    return Object.freeze({
      port: Object.freeze({
        identity,
        providerCost: { reporting: 'optional' as const },
        async invoke(request: Readonly<OmkLlmJudgeInvocationRequest>) {
          try {
            const result = await executor({
              model: request.model,
              system: request.system,
              prompt: request.prompt,
              effort: request.effort,
              abortSignal: request.signal,
            });
            const measured = usage(result);
            return result.ok && result.output !== null
              ? {
                  invocationStatus: 'completed' as const,
                  output: result.output,
                  ...(measured === undefined ? {} : { usage: measured }),
                }
              : {
                  invocationStatus: 'failed' as const,
                  reasonCode: request.signal.aborted
                    ? 'provider-invocation-cancelled'
                    : 'provider-invocation-failed',
                  ...(measured === undefined ? {} : { usage: measured }),
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
      preflightDeclarations: Object.freeze([
        Object.freeze({
          preflightKind: 'credential' as const,
          checkId: 'host-credential',
          preflightDisposition: 'not-required' as const,
          reasonCode: 'host-session-owns-credential',
        }),
        Object.freeze({
          preflightKind: 'connectivity' as const,
          checkId: 'provider-connectivity',
          preflightDisposition: 'not-required' as const,
          reasonCode: 'host-session-proves-connectivity',
        }),
      ]),
    });
  };
}

function factories(input: Readonly<{
  compiled: ReturnType<typeof compileCliEvaluationInput>;
  host: DshHostContextLike;
  parentAgent: DshAgentLike;
  projectRoot: string;
}>): OmkRuntimeBindingFactories {
  const base = createProductionRuntimeFactoryRegistry({
    executorsByImplementationId: new Map(),
    resolveJudgeInvocation: judgeResolver(input.host, input.parentAgent),
  });
  const preflightDeclarations = createNodeHostPreflightDeclarations(
    input.compiled,
    process.env,
    input.projectRoot,
  );
  return Object.freeze({
    ...base,
    executorsByImplementationId: new Map([
      [DSH_HOST_IMPLEMENTATION_ID, async (context: Readonly<OmkExecutorBindingContext>) => ({
        port: await createDshHostCoreExecutorAdapter({
          target: context.target,
          binding: context.binding,
          host: input.host,
          dsh: { parentAgent: input.parentAgent },
          sessionIsolationKey: context.sessionIsolationKey,
          resourceLeases: context.resourceLeases,
        }),
        satisfiesVersionConstraint: context.binding.versionConstraint === undefined,
        preflightDeclarations,
      })],
    ]),
  });
}

function normalizedJudges(configured: readonly JudgeConfig[] | undefined, model: string): JudgeConfig[] {
  if (configured === undefined || configured.length === 0) {
    return [{ executor: DSH_HOST_IMPLEMENTATION_ID, model }];
  }
  return configured.map((judge) => ({
    ...judge,
    executor: judge.executor === 'dsh' ? DSH_HOST_IMPLEMENTATION_ID : judge.executor,
  }));
}

async function persistDshCoreConsumers(
  artifacts: Readonly<StoredCoreRunArtifacts>,
  outputDirectory: string,
  projectRoot: string,
  appendEvidence: boolean,
): Promise<void> {
  await persistCoreArtifactGraph({ source: artifacts, outputDirectory, cwd: projectRoot });
  if (!appendEvidence) return;
  try {
    recordCoreEvalEvidence(projectCoreManagedEvidence(artifacts), {
      dir: managedDir(projectRoot),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`警告：DSH Core 受管证据写入失败：${message}\n`);
  }
}

export async function runDshCoreEvaluation(input: Readonly<{
  host: DshHostContextLike;
  parentAgent: DshAgentLike;
  signal: AbortSignal;
  config: EvalConfig;
  projectRoot: string;
}>): Promise<DshCoreEvaluationCommandResult> {
  const projectRoot = resolve(input.projectRoot);
  const outputDirectory = join(projectRoot, '.omk', 'reports');
  const model = input.config.model?.trim() || input.parentAgent.options.model?.trim();
  if (!model) throw new TypeError('当前 DSH session 没有可继承的模型，且 eval.yaml 未配置 model。');
  if (input.config.judgeModels?.some((judge) => judge.executor === DSH_HOST_IMPLEMENTATION_ID)) {
    throw new TypeError('dsh-host 是 OMK 内部执行器标识；请在 eval.yaml 中使用 executor: dsh。');
  }
  const judgeModels = normalizedJudges(input.config.judgeModels, model);
  if (judgeModels.some((judge) => judge.executor !== DSH_HOST_IMPLEMENTATION_ID)) {
    throw new TypeError('DSH Core 评委必须使用 executor: dsh 或继承当前 DSH。');
  }
  const config = { ...withoutExecutor(input.config), judgeModels };
  const request = parseCliEvaluationRequest({
    explicitCliFlags: {},
    evalConfig: config,
    defaults: {
      samplesLocator: config.samples,
      skillDirectoryLocator: join(projectRoot, 'skills'),
      targetRuntime: {
        executorId: DSH_HOST_IMPLEMENTATION_ID,
        model,
        effort: 'low',
      },
      judgeMembers: judgeModels.map((judge) => ({
        executorId: judge.executor,
        model: judge.model,
      })),
      presentation: {
        projectOutputDirectoryLocator: outputDirectory,
        globalOutputDirectoryLocator: outputDirectory,
        language: 'zh',
        languageDefaultSource: 'derived',
      },
    },
  });
  const resolved = await resolveNodeCliEvaluationRequest(request, {
    projectRoot,
    materializationRoot: join(outputDirectory, 'resolved-inputs'),
    ...(request.values.orchestration.repeatCount > 1
      ? { seriesInstanceId: generateRunId(['dsh-series']) }
      : {}),
    hostExecutorImplementationIds: [DSH_HOST_IMPLEMENTATION_ID],
    hostOwnedEffortImplementationIds: [DSH_HOST_IMPLEMENTATION_ID],
  });
  const compiled = compileCliEvaluationInput(resolved);
  const contentStore = createNodeCoreContentStore(join(outputDirectory, 'content'));
  const support = {
    ...createNodeEvaluationRuntimeSupportPorts({
      contentStoreRoot: join(outputDirectory, 'content'),
    }),
    schemaValidators: new Map(createDshHostCoreSchemaValidators().map((validator) => [
      schemaIdentityKey(validator.schema),
      validator,
    ])),
  };
  const artifactStore = createNodeCoreRunArtifactStore(outputDirectory, {
    contentResolver: contentStore,
  });
  const host = {
    compiled,
    factories: factories({ compiled, host: input.host, parentAgent: input.parentAgent, projectRoot }),
    support,
    resources: { leaseRoot: join(outputDirectory, 'runtime-leases') },
    artifactStore,
  };
  const independentSeries = compiled.orchestration.independentSeries;
  if (independentSeries !== undefined) {
    const createdAt = new Date().toISOString();
    const series = await executeProductionEvaluationSeries({
      host,
      members: independentSeries.memberships.map((membership) => ({
        runId: generateRunId([membership.memberId]),
        createdAt,
        signal: input.signal,
      })),
      bundleId: generateRunId(['dsh-series-analysis']),
      reportId: generateRunId(['dsh-series-report']),
    });
    await series.result;
    const evolution = await series.evolution;
    const artifacts = await Promise.all(series.members.map(async (member) => {
      if (member.executionStatus !== 'started') throw member.error;
      await member.run.result;
      const persisted = await member.run.persistence;
      if (persisted.persistenceStatus !== 'stored') {
        throw persisted.persistenceStatus === 'failed'
          ? persisted.error
          : new Error(`DSH Core member 未持久化：${persisted.reasonCode}`);
      }
      return persisted.artifacts;
    }));
    for (const memberArtifacts of artifacts) {
      // Series 的 member 只写可追溯图，不冒充预注册的 Series 总体证据。
      await persistDshCoreConsumers(memberArtifacts, outputDirectory, projectRoot, false);
    }
    return {
      outcomeKind: 'series',
      outcome: projectCoreCliSeriesOutcome({
        evolution,
        members: artifacts,
        exitMode: 'gate',
        diagnosticMode: config.noDiagnostic === true ? 'disabled' : 'enabled',
      }),
      artifacts,
      outputDirectory,
    };
  }
  const prepared = await createProductionEvaluationHost(host).prepare({ signal: input.signal });
  const run = await prepared.execute({
    runId: generateRunId(compiled.definition.targets.map((target) => target.targetId)),
    createdAt: new Date().toISOString(),
    signal: input.signal,
  });
  await run.result;
  const persisted = await run.persistence;
  if (persisted.persistenceStatus !== 'stored') {
    throw persisted.persistenceStatus === 'failed'
      ? persisted.error
      : new Error(`DSH Core 产物未持久化：${persisted.reasonCode}`);
  }
  await persistDshCoreConsumers(
    persisted.artifacts,
    outputDirectory,
    projectRoot,
    compiled.orchestration.managedEvidence === 'append',
  );
  return {
    outcomeKind: 'run',
    outcome: projectCoreCliRunOutcome(persisted.artifacts, {
      exitMode: 'gate',
      diagnosticMode: config.noDiagnostic === true ? 'disabled' : 'enabled',
    }),
    artifacts: persisted.artifacts,
    outputDirectory,
  };
}
