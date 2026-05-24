import type { Lang } from '../types/shared.js';

export type EvalWorkflowMessageCode =
  | 'power_warning_tiny_n'
  | 'power_warning_small_n'
  | 'power_warning_repeat_one'
  | 'doctor_gate_blocked';

interface MessageEntry {
  zh: string;
  en: string;
}

const MESSAGES: Record<EvalWorkflowMessageCode, MessageEntry> = {
  power_warning_tiny_n: {
    zh: '⚠ N={n} < 5：仅适合探索，任何结论都不可靠，CI 会很宽。需要决策时建议 ≥20 条评测用例。',
    en: '⚠ N={n} < 5 (exploration-only): any conclusion is unreliable, CI will be uselessly wide. Decisions need ≥20 cases.',
  },
  power_warning_small_n: {
    zh: '⚠ N={n} < 20：只能识别很大的效果（Cohen\'s d > 0.8），中等效果（d ≈ 0.5）很难检出。要做可靠决策建议 ≥20 条评测用例。',
    en: '⚠ N={n} < 20 (large-effect-only, Cohen\'s d > 0.8): medium effects (d ≈ 0.5) hard to detect. For confident decisions consider ≥20 cases.',
  },
  power_warning_repeat_one: {
    zh: '⚠ --repeat=1：单轮评测无法测稳定性（CV 会标记为未测量）。用 --repeat 3+ 检测同一 variant 内部方差。',
    en: '⚠ --repeat=1: single-run cannot measure stability (CV will be marked "not measured"). Use --repeat 3+ to detect within-variant variance.',
  },
  doctor_gate_blocked: {
    zh: 'skill 健康检查未通过，评测已中止。doctor 是评测必经环节，无 skip 选项——请修复上述问题后重跑。',
    en: 'skill health check failed; evaluation aborted. doctor is mandatory and not skippable — fix the issues above and re-run.',
  },
};

const DEFAULT_LANG: Lang = 'zh';

export function tEvalWorkflowMessage(
  code: EvalWorkflowMessageCode,
  lang: Lang = DEFAULT_LANG,
  params?: Record<string, string | number>,
): string {
  const entry = MESSAGES[code];
  let text = entry[lang] ?? entry[DEFAULT_LANG];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
