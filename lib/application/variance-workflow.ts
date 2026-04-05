import { confidenceInterval, tTest } from '../statistics.js';
import type { Report, VarianceData } from '../types.js';
import type { RunEvaluationOptions } from './run-evaluation.js';

export interface RunMultipleOptions extends RunEvaluationOptions {
  repeat?: number;
  onRepeatProgress?: ((info: { run: number; total: number }) => void) | null;
}

export function buildVarianceData(runs: Report[]): VarianceData | null {
  if (runs.length <= 1) {
    return null;
  }

  const variants = runs[0].meta.variants || [];
  const perVariant: Record<string, { scores: number[]; mean: number; lower: number; upper: number; stddev: number }> = {};
  for (const variant of variants) {
    const scores = runs
      .map((run) => run.summary?.[variant]?.avgCompositeScore)
      .filter((score): score is number => typeof score === 'number');
    perVariant[variant] = { scores, ...confidenceInterval(scores) };
  }

  const comparisons: Array<{ a: string; b: string; tStatistic: number; df: number; significant: boolean }> = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      comparisons.push({
        a: variants[i],
        b: variants[j],
        ...tTest(perVariant[variants[i]].scores, perVariant[variants[j]].scores),
      });
    }
  }

  return { runs: runs.length, perVariant, comparisons };
}

export async function executeVarianceWorkflow({
  repeat = 1,
  onRepeatProgress,
  config,
  runEvaluation,
}: {
  repeat?: number;
  onRepeatProgress?: ((info: { run: number; total: number }) => void) | null;
  config: RunEvaluationOptions;
  runEvaluation: (options: RunEvaluationOptions) => Promise<{ report: Report; filePath: string | null }>;
}): Promise<{ report: Report; aggregated: VarianceData | null; filePath: string | null }> {
  const runs: Report[] = [];
  const savedOutputDir = config.outputDir;

  for (let i = 0; i < repeat; i++) {
    onRepeatProgress?.({ run: i + 1, total: repeat });
    const isLast = i === repeat - 1;
    const { report } = await runEvaluation({
      ...config,
      outputDir: isLast ? savedOutputDir : null,
      persistJob: isLast,
    });
    runs.push(report);
  }

  const report = runs[runs.length - 1];
  const aggregated = buildVarianceData(runs);
  if (aggregated) {
    report.variance = aggregated;
  }

  return { report, aggregated, filePath: null };
}
