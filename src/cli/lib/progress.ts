import { tCli, type CliLang } from './i18n.js';
import type { DoctorProgressInfo } from '../../doctor/contracts.js';

// CLI 展示层的进度事件投影。
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
  ok?: boolean;
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
    ok,
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
    } else if (ok === false) {
      const cost: string = costUSD != null && costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      process.stderr.write(tCli('cli.progress.sample_failed_done', lang, {
        ...ctx, ms: durationMs ?? '', input: inputTokens ?? '', output: outputTokens ?? '',
        cost, error: error ?? '',
      }));
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

// 图标 + 状态枚举(pass/warn/fail 是技术枚举,与图标一样语言无关,不进 i18n 模板)。
const DOCTOR_STATUS_LABEL: Record<string, string> = {
  pass: '✓ pass',
  warn: '⚠ warn',
  fail: '✗ fail',
};

/** doctor 批量体检进度打印(per-skill,写 stderr),对齐 eval 的 makeOnProgress。 */
export function makeDoctorProgress(lang: CliLang): (info: DoctorProgressInfo) => void {
  return (info: DoctorProgressInfo): void => {
    // 单 skill 时省略 [i/n] 前缀(冗余);批量才显示计数。
    const prefix = info.total > 1 ? `[${info.index}/${info.total}] ` : '';
    if (info.phase === 'skill_start') {
      process.stderr.write(tCli('cli.doctor.progress_skill_start', lang, { prefix, skill: info.skillName }));
    } else {
      const result = DOCTOR_STATUS_LABEL[info.status ?? 'pass'] ?? DOCTOR_STATUS_LABEL.pass;
      process.stderr.write(tCli('cli.doctor.progress_skill_done', lang, {
        prefix, skill: info.skillName, result, ms: info.durationMs ?? 0,
      }));
    }
  };
}
