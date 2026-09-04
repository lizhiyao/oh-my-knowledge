import type { Lang } from '../shared/language.js';

export type EvalWorkflowMessageCode = 'doctor_gate_blocked';

interface MessageEntry {
  zh: string;
  en: string;
}

const MESSAGES: Record<EvalWorkflowMessageCode, MessageEntry> = {
  doctor_gate_blocked: {
    zh: '发布前 doctor 门禁未通过，评测已中止。\n下一步：先修复上面的阻塞项，再重跑 `omk eval`。\n原因：这段输入还不值得测，继续比较分数会是 garbage-in。\n如果依赖确实由 mock / stub 提供、doctor 误报，可用 `--skip-doctor` 绕过，但这次结果由你承担不可比风险。',
    en: 'pre-ship doctor gate failed; evaluation aborted.\nNext: fix the blocking findings above, then re-run `omk eval`.\nWhy: this input is not measurable enough yet, and comparing scores now would be garbage-in.\nIf deps are truly supplied by mocks/stubs and doctor is a false positive, use `--skip-doctor`, but you own the comparability risk.',
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
