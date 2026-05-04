import { CliExit } from '../cli-exit.js';
import { tCli, langFromArgv } from '../i18n.js';
import { parseRunConfig } from '../parse-run-config.js';
import { makeOnProgress } from '../progress.js';
import type { ProgressCallback, ReportDocument } from '../../types/index.js';
import { requireEvaluationReport, type EvalResult } from './_shared.js';

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values, config } = parseRunConfig(argv, {
    threshold: { type: 'string', default: '3.5' },
    'trivial-diff': { type: 'string' },
  });

  const { runEvaluation } = await import('../../eval-workflows/run-evaluation.js');

  config.onProgress = makeOnProgress(lang) as unknown as ProgressCallback;

  // 注入 lang + skip-connectivity warning(若 flag set);doctor 由 evaluation 强制调, 无 skip 选项。
  config.lang = lang;
  if (values['skip-connectivity'] as boolean) {
    process.stderr.write(tCli('cli.run.skip_connectivity_warning', lang) + '\n');
  }

  try {
    const { report: document } = (await runEvaluation(config)) as EvalResult;

    if ((document as ReportDocument & { dryRun?: boolean }).dryRun) {
      console.log('Gate dry-run: no scores to check');
      throw new CliExit(0);
    }
    const report = requireEvaluationReport(document, 'current run', lang);

    // gate 内核 = run + verdict, 自动覆盖 omk 全部决策维度(三层 layer-gate /
    // bootstrap diff CI / saturation / Krippendorff α)。computeVerdict 是单一
    // 决策源, exit code 跟 verdict.level 走 — 数据 underpowered 直接 FAIL,
    // 堵住"过 PASS 就 deploy"的漏洞。
    const { computeVerdict, formatVerdictText } = await import('../../eval-core/verdict.js');
    const result = computeVerdict(report, {
      gateThreshold: Number(values.threshold),
      triviallySmallDiff: values['trivial-diff'] != null ? Number(values['trivial-diff']) : undefined,
    });
    console.log(formatVerdictText(result, { verbose: true }));

    // exit code 与 handleVerdict 对齐:只有 PROGRESS / SOLO-pass 才 0,
    // NOISE / UNDERPOWERED / CAUTIOUS / REGRESS 全 1。pipeline `omk bench gate
    // && deploy` 数据不显著就不会误 deploy。
    if (result.level === 'PROGRESS') {
      throw new CliExit(0);
    }
    if (result.level === 'SOLO' && result.headline.includes('PASS')) {
      throw new CliExit(0);
    }
    throw new CliExit(1);
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    throw new CliExit(1);
  }
}
