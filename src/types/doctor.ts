import type { Artifact, Sample } from './eval.js';

export type DoctorSeverity = 'fatal' | 'warn' | 'info';
export type DoctorRuleStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type DoctorSkillStatus = 'pass' | 'warn' | 'fail';

export interface DoctorRuleResult {
  ruleId: string;
  severity: DoctorSeverity;
  status: DoctorRuleStatus;
  /** 已 i18n 翻译后的 user-facing message。CI 消费 JSON 时直接读。 */
  message: string;
  /** 可选可操作修复建议(已 i18n 翻译)。terminal 渲染器在 message 之后单独一行展示。 */
  hint?: string;
  /** 结构化数据,留给 renderer 或上游系统消费(不渲染到终端)。 */
  detail?: Record<string, unknown>;
  durationMs: number;
}

export type DoctorRuleCheckOutcome = Omit<DoctorRuleResult, 'ruleId' | 'severity' | 'durationMs'>;

export interface DoctorContext {
  artifact: Artifact;
  /** 仅 samples_contract_aligned rule 用。其他 rule 可忽略。 */
  samples?: Sample[];
  executorName: string;
  model: string;
  cwd: string;
  lang: 'zh' | 'en';
  timeoutMs: number;
}

export interface DoctorRule {
  id: string;
  severity: DoctorSeverity;
  /** i18n key,terminal 渲染时用作 rule 标题。 */
  labelKey: string;
  check(ctx: DoctorContext): Promise<DoctorRuleCheckOutcome>;
}

export interface DoctorSkillReport {
  skillName: string;
  skillPath: string;
  results: DoctorRuleResult[];
  status: DoctorSkillStatus;
}

export interface DoctorReport {
  kind: 'doctor';
  id: string;
  timestamp: string;
  cliVersion: string;
  cwd: string;
  executorName: string;
  model: string;
  skills: DoctorSkillReport[];
  /** 至少一个 skill 有 fatal-fail。CLI exit 1 / bench run abort 的判断依据。 */
  failed: boolean;
  /** 至少一个 skill 有 warn(无 fail)。不阻断,仅提示。 */
  warned: boolean;
  totals: { pass: number; warn: number; fail: number };
}

export interface DoctorRunOptions {
  /** 单 skill 文件 / 目录 / null(=cwd 当前目录批量) */
  target?: string | null;
  cwd: string;
  executorName: string;
  model: string;
  timeoutMs: number;
  lang: 'zh' | 'en';
  /** 跳过 executor smoke(测试 / 离线场景用,CLI 不暴露此 flag) */
  skipSmoke?: boolean;
  /** 可选 samples,仅 samples_contract_aligned rule 会用 */
  samples?: Sample[];
  /** 覆盖内置 rules(test 注入用)。生产路径走 BUILTIN_RULES。 */
  rules?: DoctorRule[];
}
