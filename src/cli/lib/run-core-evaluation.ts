import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvalConfig } from '../../eval-workflows/inputs/contracts/config.js';
import {
  createNodeEvaluationApplication,
  parseCliEvaluationRequest,
  type CliEvaluationRequest,
  type CoreRunArtifactStore,
  type StoredCoreRunArtifacts,
  type EvaluationNotice,
} from '../../eval-workflows/hosts/application.js';
import { captureNodeCliEvaluationEnvironment } from './evaluation-composition.js';
import { withLocalizedSampleDiscovery } from './localized-sample-discovery.js';
import { projectReportsDir } from '../../evidence/storage/directories.js';
import { globalLayout } from '../../evidence/storage/layout.js';
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

function requestFor(input: RunCoreEvaluationCommandInput, projectRoot: string, globalOutputDirectory: string): CliEvaluationRequest {
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
        ...(judge.deploymentRevision === undefined
          ? {}
          : { deploymentRevision: judge.deploymentRevision }),
      })),
      presentation: {
        projectOutputDirectoryLocator: projectReportsDir(projectRoot),
        globalOutputDirectoryLocator: globalOutputDirectory,
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

function renderNotice(notice: EvaluationNotice, lang: CliLang): void {
  switch (notice.noticeKind) {
    case 'doctor-skipped':
      process.stderr.write(lang === 'zh'
        ? '警告：--skip-doctor 已开启，Core 静态健康检查已跳过；依赖正确性由用户负责。\n'
        : 'Warning: --skip-doctor is enabled; Core static health checks were skipped and dependency correctness is user-owned.\n');
      break;
    case 'batch-item':
      process.stderr.write(lang === 'zh' ? `\nCore Batch：${notice.name}\n` : `\nCore Batch: ${notice.name}\n`);
      break;
    case 'managed-evidence-recorded':
      process.stderr.write(lang === 'zh' ? `已写入 ${notice.count} 条 Core 受管证据。\n` : `Recorded ${notice.count} Core managed evidence reference(s).\n`);
      break;
    case 'managed-evidence-failed': {
      const message = notice.error instanceof Error ? notice.error.message : String(notice.error);
      process.stderr.write(lang === 'zh' ? `警告：Core 受管证据写入失败：${message}\n` : `Warning: failed to record Core managed evidence: ${message}\n`);
      break;
    }
    case 'series-managed-evidence-skipped':
      process.stderr.write(lang === 'zh'
        ? 'Core Series 不写入单次 member 受管证据；需由预注册的 Series 总体决定投影后再纳入生命周期。\n'
        : 'Core Series does not write single-member managed evidence; lifecycle admission requires a preregistered Series-level decision projection.\n');
  }
}

export async function runCoreEvaluationCommand(input: Readonly<RunCoreEvaluationCommandInput>): Promise<RunCoreEvaluationCommandResult> {
  const projectRoot = resolve(input.projectRoot ?? process.cwd());
  const environment = captureNodeCliEvaluationEnvironment(input.environment);
  const machineLayout = globalLayout(environment.environment.OMK_HOME);
  const application = createNodeEvaluationApplication(environment);
  try {
    const result = await application.run({
      request: requestFor(input, projectRoot, machineLayout.evalDir), projectRoot,
      materializationRoot: machineLayout.resolvedInputsDir, resourceLeaseRoot: machineLayout.resourceLeasesDir,
      store: input.store,
      createProgressSink: () => emitProgress(input.lang),
      onNotice: (notice) => renderNotice(notice, input.lang),
      requestForBatchItem: (entry) => requestFor({ ...input, flags: { ...input.flags, batch: undefined, control: 'baseline', treatment: entry.skillPath, samples: entry.samplesPath, 'no-serve': true } }, projectRoot, machineLayout.evalDir),
      async onCompleted(completed, request) {
        if (completed.outcomeKind === 'run') await announceCoreReport(completed.artifacts, completed.store, completed.outputDirectory, request.values.presentation.serve, input.lang);
        if (completed.outcomeKind === 'series') process.stderr.write(input.lang === 'zh'
          ? `Core Series 已完成：${completed.outcome.seriesId}（${completed.outcome.members.length} 个独立 run）\n`
          : `Core Series completed: ${completed.outcome.seriesId} (${completed.outcome.members.length} independent runs)\n`);
      },
    });
    return {
      exitCode: result.outcomeKind === 'dry-run' || result.outcomeKind === 'batch-dry-run' ? 0 : result.outcome.gate.exitCode,
      output: result.outcome, outputDirectory: result.outputDirectory,
      ...(result.outcomeKind === 'run' ? { stored: result.artifacts } : {}),
    };
  } catch (error) {
    return withLocalizedSampleDiscovery(() => { throw error; }, input.lang);
  }
}
