import { join, resolve } from 'node:path';
import type { RuntimeIdentity } from '../eval-core/contracts/index.js';
import {
  createHostedEvaluationApplication,
  createExecutorJudgeInvocationPort,
  createJudgeProviderRuntimeIdentity,
  parseCliEvaluationRequest,
  type HostedEvaluationCapabilities,
  type StoredCoreRunArtifacts,
  type OmkLlmJudgeInvocationBinding,
} from '../eval-workflows/hosts/application.js';
import { globalLayout, projectLayout } from '../evidence/storage/layout.js';
import type { CoreCliRunOutcome, CoreCliSeriesOutcome } from '../eval-workflows/projections/contracts.js';
import { managedDir } from '../knowledge-artifacts/governance/index.js';
import type { ExecutorFn } from '../executors/contracts/ports.js';
import type { EvalConfig } from '../eval-workflows/inputs/contracts/config.js';
import type { JudgeConfig } from '../eval-workflows/instruments/contracts/config.js';
import { createDshHostCoreExecutorAdapter, createDshHostCoreSchemaValidators } from './core-adapter.js';
import { createDshHostExecutor, type DshAgentLike, type DshHostContextLike } from './host-executor.js';

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

function runtimeIdentity(
  executor: ExecutorFn,
  model: string,
  deploymentRevision?: string,
): RuntimeIdentity {
  const fingerprint = executor.runtimeFingerprint?.(model);
  if (fingerprint === undefined) throw new TypeError('DSH Host 没有提供 Runtime identity。');
  return createJudgeProviderRuntimeIdentity({
    executorId: DSH_HOST_IMPLEMENTATION_ID,
    model,
    ...(deploymentRevision === undefined ? {} : { deploymentRevision }),
    executorRuntime: fingerprint,
  });
}

function judgeResolver(
  host: DshHostContextLike,
  parentAgent: DshAgentLike,
): HostedEvaluationCapabilities['resolveJudgeInvocation'] {
  const executor = createDshHostExecutor(host, { parentAgent });
  const identities = new Map<string, RuntimeIdentity>();
  return async (context): Promise<OmkLlmJudgeInvocationBinding> => {
    const qualification = context.binding.qualification;
    if (qualification === undefined
        || qualification.executorId !== DSH_HOST_IMPLEMENTATION_ID) {
      throw new TypeError('DSH Host 只能解析继承当前宿主的评委 Runtime。');
    }
    const identityKey = JSON.stringify([
      qualification.model,
      qualification.deploymentRevision ?? null,
    ]);
    const identity = identities.get(identityKey)
      ?? runtimeIdentity(
        executor,
        qualification.model,
        qualification.deploymentRevision,
      );
    identities.set(identityKey, identity);
    return Object.freeze({
      port: createExecutorJudgeInvocationPort(executor, identity),
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

function normalizedJudges(configured: readonly JudgeConfig[] | undefined, model: string): JudgeConfig[] {
  if (configured === undefined || configured.length === 0) {
    return [{ executor: DSH_HOST_IMPLEMENTATION_ID, model }];
  }
  return configured.map((judge) => ({
    ...judge,
    executor: judge.executor === 'dsh' ? DSH_HOST_IMPLEMENTATION_ID : judge.executor,
  }));
}

export async function runDshCoreEvaluation(input: Readonly<{
  host: DshHostContextLike;
  parentAgent: DshAgentLike;
  signal: AbortSignal;
  config: EvalConfig;
  projectRoot: string;
}>): Promise<DshCoreEvaluationCommandResult> {
  const projectRoot = resolve(input.projectRoot);
  const layout = projectLayout(projectRoot);
  const machineLayout = globalLayout();
  const outputDirectory = layout.evalDir;
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
        ...(judge.deploymentRevision === undefined
          ? {}
          : { deploymentRevision: judge.deploymentRevision }),
      })),
      presentation: {
        projectOutputDirectoryLocator: outputDirectory,
        globalOutputDirectoryLocator: outputDirectory,
        language: 'zh',
        languageDefaultSource: 'derived',
      },
    },
  });
  const application = createHostedEvaluationApplication({
    implementationId: DSH_HOST_IMPLEMENTATION_ID,
    environment: process.env,
    schemaValidators: createDshHostCoreSchemaValidators(),
    resolveJudgeInvocation: judgeResolver(input.host, input.parentAgent),
    idPrefix: 'dsh-',
    async executorFactory(context) {
      return {
        port: await createDshHostCoreExecutorAdapter({ target: context.target, binding: context.binding, host: input.host, dsh: { parentAgent: input.parentAgent }, sessionIsolationKey: context.sessionIsolationKey, resourceLeases: context.resourceLeases }),
        satisfiesVersionConstraint: context.binding.versionConstraint === undefined,
        preflightDeclarations: [],
      };
    },
  });
  const result = await application.run({
    request, projectRoot, materializationRoot: machineLayout.resolvedInputsDir, resourceLeaseRoot: machineLayout.resourceLeasesDir,
    signal: input.signal, managedEvidenceDirectory: managedDir(projectRoot),
    onNotice(notice) {
      if (notice.noticeKind === 'managed-evidence-failed') {
        const message = notice.error instanceof Error ? notice.error.message : String(notice.error);
        process.stderr.write(`警告：DSH Core 受管证据写入失败：${message}\n`);
      }
    },
  });
  if (result.outcomeKind !== 'run' && result.outcomeKind !== 'series') throw new Error('DSH Core 需要执行评测。');
  return result;
}
