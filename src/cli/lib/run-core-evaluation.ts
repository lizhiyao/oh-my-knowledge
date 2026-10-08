import {
  createNodeEvaluationApplication,
  parseCliEvaluationRequest,
  type CoreRunArtifactStore,
  type StoredCoreRunArtifacts,
  type EvaluationNotice,
} from '../../eval-workflows/hosts/application.js';
import { withLocalizedSampleDiscovery } from './localized-sample-discovery.js';
import { globalLayout } from '../../evidence/storage/layout.js';
import type { PreparedCliEvaluation } from './prepare-evaluation.js';
import type { CliLang } from './i18n.js';
import { announceCoreReport } from './core-report-service.js';

export interface RunCoreEvaluationCommandInput {
  readonly prepared: PreparedCliEvaluation;
  readonly store?: CoreRunArtifactStore;
  readonly signal?: AbortSignal;
}

export interface RunCoreEvaluationCommandResult {
  readonly exitCode: 0 | 1;
  readonly output: unknown;
  readonly stored?: StoredCoreRunArtifacts;
  readonly outputDirectory: string;
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
  }
}

export async function runCoreEvaluationCommand(input: Readonly<RunCoreEvaluationCommandInput>): Promise<RunCoreEvaluationCommandResult> {
  const { request, parseInput, projectRoot, environment } = input.prepared;
  const lang = request.values.presentation.language;
  const machineLayout = globalLayout(environment.environment.OMK_HOME);
  const application = createNodeEvaluationApplication(environment);
  try {
    const result = await application.run({
      request, projectRoot,
      materializationRoot: machineLayout.resolvedInputsDir, resourceLeaseRoot: machineLayout.resourceLeasesDir,
      store: input.store, signal: input.signal,
      createProgressSink: () => emitProgress(lang),
      onNotice: (notice) => renderNotice(notice, lang),
      requestForBatchItem: (entry) => parseCliEvaluationRequest({
        ...parseInput,
        explicitCliFlags: { ...parseInput.explicitCliFlags, batch: undefined, control: 'baseline', treatment: entry.skillPath, samples: entry.samplesPath, 'no-serve': true },
      }),
      async onCompleted(completed, request) {
        if (completed.outcomeKind === 'run') await announceCoreReport(completed.artifacts, completed.store, completed.outputDirectory, request.values.presentation.serve && !input.signal?.aborted, lang, completed.outcome.gate.exitCode, input.signal);
        if (completed.outcomeKind === 'series') process.stderr.write(lang === 'zh'
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
    return withLocalizedSampleDiscovery(() => { throw error; }, lang);
  }
}
