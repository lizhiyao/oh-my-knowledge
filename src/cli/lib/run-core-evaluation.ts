import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvalConfig } from '../../inputs/contracts/config.js';
import type { EvaluationContentResolver } from '../../evaluation-core/evaluation/index.js';
import {
  compileCliEvaluationInput,
  parseCliEvaluationRequest,
  type CliEvaluationRequest,
} from '../../eval-workflows/input-compilation/index.js';
import {
  createNodeCoreBatchArtifactStore,
  createNodeCoreContentStore,
  createNodeCoreRunArtifactStore,
  createOverlayCoreRunArtifactStore,
  type CoreRunArtifactStore,
  type StoredCoreRunArtifacts,
} from '../../eval-workflows/artifact-store/index.js';
import {
  createNodeCliProductionComposition,
  createProductionEvaluationHost,
  executeProductionEvaluationSeries,
  persistCoreArtifactGraph,
  resolveNodeCliEvaluationRequest,
} from '../../eval-workflows/production-host/index.js';
import {
  projectCoreCliDryRun,
  projectCoreCliBatchOutcome,
  projectCoreCliRunOutcome,
  projectCoreCliSeriesOutcome,
  projectCoreManagedEvidence,
} from '../../eval-workflows/downstream-projections/index.js';
import { discoverBatchSkills } from '../../inputs/skill-loader.js';
import { withLocalizedSampleDiscovery } from './localized-sample-discovery.js';
import { projectReportsDir, globalReportsDir } from '../../measurement-artifacts/directories.js';
import { generateRunId } from '../../measurement-artifacts/run-id.js';
import { globalLayout, projectLayout } from '../../omk-layout/index.js';
import type { RunConfig } from './parse-run-config.js';
import type { CliLang } from './i18n.js';

export interface RunCoreEvaluationCommandInput {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Pick<RunConfig,
    'samplesPath' | 'skillDir' | 'executorName' | 'model' | 'effort' | 'judgeModels'
  >>;
  readonly evalConfig: Readonly<EvalConfig> | null;
  readonly lang: CliLang;
  readonly environment?: NodeJS.ProcessEnv;
  readonly projectRoot?: string;
  readonly store?: CoreRunArtifactStore;
}

export interface RunCoreEvaluationCommandResult {
  readonly exitCode: 0 | 1;
  readonly output: unknown;
  readonly stored?: StoredCoreRunArtifacts;
  readonly outputDirectory: string;
}

function runStoreForOutput(
  outputDirectory: string,
  primaryContentResolver: EvaluationContentResolver | undefined,
): CoreRunArtifactStore {
  const primary = createNodeCoreRunArtifactStore(outputDirectory, {
    contentResolver: primaryContentResolver,
  });
  const resolved = resolve(outputDirectory);
  const project = projectLayout();
  const global = globalLayout();
  const fallbackDirs = resolved === resolve(project.evalDir)
    ? [global.evalDir]
    : [];
  const unique = [...new Set(fallbackDirs.map((dir) => resolve(dir)))]
    .filter((dir) => dir !== resolved);
  if (unique.length === 0) return primary;
  return createOverlayCoreRunArtifactStore(primary, unique.map((dir) => (
    createNodeCoreRunArtifactStore(dir, {
      contentResolver: createNodeCoreContentStore(join(dir, 'content')),
    })
  )));
}

function requestFor(input: RunCoreEvaluationCommandInput, projectRoot: string): CliEvaluationRequest {
  const projectMcpConfig = join(projectRoot, '.mcp.json');
  return parseCliEvaluationRequest({
    explicitCliFlags: input.flags,
    ...(input.evalConfig === null ? {} : { evalConfig: input.evalConfig }),
    defaults: {
      samplesLocator: input.config.samplesPath,
      skillDirectoryLocator: input.config.skillDir,
      ...(existsSync(projectMcpConfig) ? { mcpConfigLocator: projectMcpConfig } : {}),
      targetRuntime: {
        executorId: input.config.executorName,
        model: input.config.model,
        effort: input.config.effort ?? 'low',
      },
      judgeMembers: input.config.judgeModels.map((judge) => ({
        executorId: judge.executor,
        model: judge.model,
      })),
      presentation: {
        projectOutputDirectoryLocator: projectReportsDir(),
        globalOutputDirectoryLocator: globalReportsDir(),
        language: input.lang,
        languageDefaultSource: 'environment-selection',
      },
    },
  });
}

function emitProgress(lang: CliLang) {
  let last = '';
  return Object.freeze({
    render(update: Readonly<{
      progressStage: string;
      progressStatus: string;
      subject: Readonly<{ subjectId: string }>;
    }>): void {
      const identity = `${update.progressStage}\0${update.progressStatus}\0${update.subject.subjectId}`;
      if (identity === last) return;
      last = identity;
      const text = lang === 'zh'
        ? `[Core] ${update.progressStage}：${update.progressStatus}（${update.subject.subjectId}）`
        : `[Core] ${update.progressStage}: ${update.progressStatus} (${update.subject.subjectId})`;
      process.stderr.write(`${text}\n`);
    },
  });
}

async function announceCoreReport(
  artifacts: StoredCoreRunArtifacts,
  store: CoreRunArtifactStore,
  outputDirectory: string,
  serve: boolean,
  lang: CliLang,
): Promise<void> {
  process.stderr.write(lang === 'zh'
    ? `Core 评测产物已保存：${artifacts.manifest.runId}\n`
    : `Core evaluation artifacts saved: ${artifacts.manifest.runId}\n`);
  if (!serve) return;
  if (!process.stdout.isTTY) {
    process.stderr.write(lang === 'zh'
      ? `非交互终端不自动启动 Studio。运行 omk studio --reports-dir ${outputDirectory} 查看。\n`
      : `Studio was not started in a non-interactive terminal. Run omk studio --reports-dir ${outputDirectory}.\n`);
    return;
  }
  const { createCoreStudioCatalog } = await import('../../studio/core-runs/index.js');
  const { createReportServer } = await import('../../studio/http/report-server.js');
  const server = createReportServer({
    coreStudioCatalog: createCoreStudioCatalog(store),
  });
  const serverUrl = await server.start();
  const reportUrl = `${serverUrl}/reports/${encodeURIComponent(artifacts.manifest.runId)}`;
  process.stderr.write(lang === 'zh'
    ? `报告服务：${serverUrl}\n查看本次评测：${reportUrl}\n按 Ctrl+C 停止。\n`
    : `Report server: ${serverUrl}\nView this run: ${reportUrl}\nPress Ctrl+C to stop.\n`);
  const { openWorkbench } = await import('./open-workbench.js');
  await openWorkbench(reportUrl, lang);
}

async function appendManagedEvidenceSafely(
  stored: Readonly<StoredCoreRunArtifacts>,
  enabled: boolean,
  lang: CliLang,
): Promise<void> {
  if (!enabled) return;
  try {
    const { recordCoreEvalEvidence } = await import('../../managed/evidence.js');
    const written = recordCoreEvalEvidence(projectCoreManagedEvidence(stored));
    if (written.length > 0) process.stderr.write(lang === 'zh'
      ? `已写入 ${written.length} 条 Core 受管证据。\n`
      : `Recorded ${written.length} Core managed evidence reference(s).\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(lang === 'zh'
      ? `警告：Core 受管证据写入失败：${message}\n`
      : `Warning: failed to record Core managed evidence: ${message}\n`);
  }
}

async function persistArtifactGraph(
  stored: Readonly<StoredCoreRunArtifacts>,
  outputDirectory: string,
  cwd: string,
): Promise<void> {
  await persistCoreArtifactGraph({ source: stored, outputDirectory, cwd });
}

function resumeRunId(request: CliEvaluationRequest): string | undefined {
  const locator = request.values.orchestration.resumeSourceLocator?.trim();
  if (locator === undefined || locator === '') return undefined;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(locator)) {
    throw new TypeError('--resume 只接受 Core runId，不接受旧报告路径。');
  }
  return locator;
}

/** Executes the single authoritative Node CLI → Evaluation Core production path. */
export async function runCoreEvaluationCommand(
  input: Readonly<RunCoreEvaluationCommandInput>,
): Promise<RunCoreEvaluationCommandResult> {
  const projectRoot = resolve(input.projectRoot ?? process.cwd());
  const request = requestFor(input, projectRoot);
  if (request.values.orchestration.preflight.doctor === 'skip') {
    process.stderr.write(input.lang === 'zh'
      ? '警告：--skip-doctor 已开启，Core 静态健康检查已跳过；依赖正确性由用户负责。\n'
      : 'Warning: --skip-doctor is enabled; Core static health checks were skipped and dependency correctness is user-owned.\n');
  }
  if (request.values.orchestration.batch) {
    const entries = withLocalizedSampleDiscovery(
      () => discoverBatchSkills(resolve(projectRoot, request.values.locators.skillDirectory)),
      input.lang,
    );
    if (entries.length === 0) {
      throw new TypeError(input.lang === 'zh'
        ? `没有找到带 canonical 私有用例的目录 skill：${request.values.locators.skillDirectory}。每个 skill 应使用 <skill>/.omk/eval-samples.json 或 eval-samples.yaml。`
        : `No directory skill with canonical private samples found in ${request.values.locators.skillDirectory}. Use <skill>/.omk/eval-samples.json or eval-samples.yaml for each skill.`);
    }
    if (request.values.orchestration.resumeSourceLocator !== undefined) {
      throw new TypeError('Batch resume 必须按 child runId 显式执行，不能复用旧聚合报告。');
    }
    const children = [] as Awaited<ReturnType<typeof runCoreEvaluationCommand>>[];
    for (const entry of entries) {
      process.stderr.write(input.lang === 'zh'
        ? `\nCore Batch：${entry.name}\n`
        : `\nCore Batch: ${entry.name}\n`);
      children.push(await runCoreEvaluationCommand({
        ...input,
        flags: {
          ...input.flags,
          batch: undefined,
          control: 'baseline',
          treatment: entry.skillPath,
          samples: entry.samplesPath,
          'no-serve': true,
        },
      }));
    }
    const outputDirectory = children[0]!.outputDirectory;
    if (request.values.orchestration.dryRun) {
      return {
        exitCode: 0,
        output: Object.freeze({
          projectionKind: 'core-cli-batch-dry-run',
          children: Object.freeze(entries.map((entry, index) => Object.freeze({
            itemId: entry.name,
            plan: children[index]!.output,
          }))),
        }),
        outputDirectory,
      };
    }
    const storedChildren = children.map((child) => {
      if (child.stored === undefined) throw new Error('Core Batch child 缺少持久化产物。');
      return child.stored;
    });
    const contentResolver = createNodeCoreContentStore(join(outputDirectory, 'content'));
    const runStore = input.store ?? runStoreForOutput(outputDirectory, contentResolver);
    const batchId = generateRunId(['batch']);
    const batch = await createNodeCoreBatchArtifactStore(outputDirectory, runStore).save({
      batchId,
      createdAt: new Date().toISOString(),
      children: storedChildren.map((child, index) => ({
        itemId: entries[index]!.name,
        runId: child.manifest.runId,
      })),
    });
    const output = projectCoreCliBatchOutcome({
      batch,
      children: storedChildren,
      exitMode: request.values.presentation.exitMode,
      diagnosticMode: request.values.orchestration.diagnostic === 'enabled-outside-core'
        ? 'enabled'
        : 'disabled',
    });
    return {
      exitCode: output.gate.exitCode,
      output,
      outputDirectory,
    };
  }
  const outputDirectory = resolve(projectRoot, request.values.presentation.outputDirectoryLocator);
  const resolved = await resolveNodeCliEvaluationRequest(request, {
    projectRoot,
    materializationRoot: join(outputDirectory, 'resolved-inputs'),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(request.values.orchestration.repeatCount > 1
      ? { seriesInstanceId: generateRunId(['series']) }
      : {}),
  });
  const compiled = compileCliEvaluationInput(resolved);
  const composition = await createNodeCliProductionComposition({
    compiled,
    projectRoot,
    outputDirectory,
    environment: input.environment,
  });
  const store = input.store ?? runStoreForOutput(
    outputDirectory,
    composition.support.contentResolver,
  );
  const host = {
    compiled,
    ...composition,
    artifactStore: store,
  };
  if (compiled.orchestration.dryRun) {
    const prepared = await createProductionEvaluationHost(host).prepare();
    const output = projectCoreCliDryRun({ plan: prepared.plan, preflight: prepared.preflight });
    return { exitCode: 0, output, outputDirectory };
  }

  const sourceRunId = resumeRunId(request);
  const independentSeries = compiled.orchestration.independentSeries;
  if (independentSeries !== undefined) {
    if (sourceRunId !== undefined) {
      throw new TypeError('Independent Series resume 必须按 member runId 单独执行。');
    }
    const createdAt = new Date().toISOString();
    const series = await executeProductionEvaluationSeries({
      host,
      members: independentSeries.memberships.map((membership) => ({
        runId: generateRunId([membership.memberId]),
        createdAt,
        progressSink: emitProgress(input.lang),
      })),
      bundleId: generateRunId(['series-analysis']),
      reportId: generateRunId(['series-report']),
    });
    await series.result;
    const evolution = await series.evolution;
    if (evolution === undefined) throw new Error('Core Series 未完成，无法生成 evolution evidence。');
    const memberArtifacts = await Promise.all(series.members.map(async (member) => {
      if (member.executionStatus !== 'started') throw member.error;
      await member.run.result;
      const persistence = await member.run.persistence;
      if (persistence.persistenceStatus !== 'stored') {
        if (persistence.persistenceStatus === 'failed') throw persistence.error;
        throw new Error(`Core Series member 产物未保存：${persistence.reasonCode}`);
      }
      return persistence.artifacts;
    }));
    const output = projectCoreCliSeriesOutcome({
      evolution,
      members: memberArtifacts,
      exitMode: request.values.presentation.exitMode,
      diagnosticMode: request.values.orchestration.diagnostic === 'enabled-outside-core'
        ? 'enabled'
        : 'disabled',
    });
    for (const artifacts of memberArtifacts) {
      await persistArtifactGraph(artifacts, outputDirectory, projectRoot);
    }
    if (compiled.orchestration.managedEvidence === 'append') {
      process.stderr.write(input.lang === 'zh'
        ? 'Core Series 不写入单次 member 受管证据；需由预注册的 Series 总体决定投影后再纳入生命周期。\n'
        : 'Core Series does not write single-member managed evidence; lifecycle admission requires a preregistered Series-level decision projection.\n');
    }
    process.stderr.write(input.lang === 'zh'
      ? `Core Series 已完成：${output.seriesId}（${output.members.length} 个独立 run）\n`
      : `Core Series completed: ${output.seriesId} (${output.members.length} independent runs)\n`);
    return { exitCode: output.gate.exitCode, output, outputDirectory };
  }
  const prepared = await createProductionEvaluationHost(host).prepare();
  let stored: StoredCoreRunArtifacts;
  if (sourceRunId !== undefined) {
    const admission = await prepared.admitResume({
      locator: { locatorKind: 'core-run', runId: sourceRunId },
      policy: {
        rejectionMode: 'fail-closed',
        minimumSourceTrust: 'unknown',
        cacheReceiptMode: 'allow-indeterminate',
        budgetVerificationMode: 'allow-indeterminate',
      },
    });
    if (admission.disposition !== 'reuse') {
      throw new Error(`Core resume 被拒绝：${admission.reasonCode}`);
    }
    stored = admission.artifacts;
  } else {
    const targetIds = prepared.plan.execution.targets.map((target) => target.targetId);
    const runId = generateRunId(targetIds);
    const run = await prepared.execute({
      runId,
      createdAt: new Date().toISOString(),
      progressSink: emitProgress(input.lang),
    });
    await run.result;
    const persistence = await run.persistence;
    if (persistence.persistenceStatus !== 'stored') {
      if (persistence.persistenceStatus === 'failed') throw persistence.error;
      throw new Error(`Core 产物未保存：${persistence.reasonCode}`);
    }
    stored = persistence.artifacts;
  }

  const output = projectCoreCliRunOutcome(stored, {
    exitMode: request.values.presentation.exitMode,
    diagnosticMode: request.values.orchestration.diagnostic === 'enabled-outside-core'
      ? 'enabled'
      : 'disabled',
  });
  await persistArtifactGraph(stored, outputDirectory, projectRoot);
  await appendManagedEvidenceSafely(
    stored,
    compiled.orchestration.managedEvidence === 'append',
    input.lang,
  );
  await announceCoreReport(
    stored,
    store,
    outputDirectory,
    request.values.presentation.serve,
    input.lang,
  );
  return {
    exitCode: output.gate.exitCode,
    output,
    stored,
    outputDirectory,
  };
}
