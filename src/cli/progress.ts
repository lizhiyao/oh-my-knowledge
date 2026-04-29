import { tCli, type CliLang } from './i18n.js';

// CLI progress info — superset of all possible fields from ProgressInfo union members
export interface ProgressInfo {
  phase: string;
  completed?: number;
  total?: number;
  sample_id?: string;
  variant?: string;
  strategy?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  score?: number;
  outputPreview?: string | null;
  jobId?: string;
  judgePhase?: string;
  judgeDim?: string;
  skipped?: boolean;
  attempt?: number;
  maxAttempts?: number;
  error?: string;
}

export function makeOnProgress(lang: CliLang): (info: ProgressInfo) => void {
  return ({
    phase,
    completed,
    total,
    sample_id,
    variant,
    durationMs,
    inputTokens,
    outputTokens,
    costUSD,
    score,
    outputPreview,
    judgePhase: _judgePhase,
    judgeDim,
    skipped,
    attempt,
    maxAttempts,
    error,
  }: ProgressInfo): void => {
    const ctx = { i: completed ?? '', n: total ?? '', sample: sample_id ?? '', variant: variant ?? '' };
    if (phase === 'preflight') {
      process.stderr.write(tCli('cli.progress.preflight_starting', lang));
      return;
    }
    if (phase === 'retry') {
      process.stderr.write(tCli('cli.progress.sample_retry', lang, {
        ...ctx, attempt: attempt ?? '', max: maxAttempts ?? '',
      }));
      return;
    }
    if (phase === 'error') {
      process.stderr.write(tCli('cli.progress.sample_error', lang, { ...ctx, error: error ?? '' }));
      return;
    }
    if (phase === 'start') {
      process.stderr.write(tCli('cli.progress.sample_executing', lang, ctx));
    } else if (phase === 'exec_done') {
      const cost: string = costUSD != null && costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      process.stderr.write(tCli('cli.progress.sample_exec_done', lang, {
        ...ctx, ms: durationMs ?? '', input: inputTokens ?? '', output: outputTokens ?? '', cost,
      }));
      if (outputPreview) {
        process.stderr.write(tCli('cli.progress.output_preview', lang, {
          preview: outputPreview.slice(0, 150).replace(/\n/g, ' '),
        }));
      }
    } else if (phase === 'grading') {
      const dim: string = judgeDim ? ` [${judgeDim}]` : '';
      process.stderr.write(tCli('cli.progress.judging', lang, { ...ctx, dim }));
    } else if (phase === 'judge_done') {
      const dim: string = judgeDim ? ` [${judgeDim}]` : '';
      process.stderr.write(tCli('cli.progress.judged', lang, { ...ctx, dim, score: score ?? '' }));
    } else if (phase === 'done' && skipped) {
      if (sample_id) process.stderr.write(tCli('cli.progress.skipped', lang, ctx));
    } else {
      const cost: string = costUSD != null && costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      const scoreInfo: string = typeof score === 'number' ? ` score=${score}` : '';
      process.stderr.write(tCli('cli.progress.sample_done', lang, {
        ...ctx, ms: durationMs ?? '', input: inputTokens ?? '', output: outputTokens ?? '',
        cost, score: scoreInfo,
      }));
    }
  };
}
