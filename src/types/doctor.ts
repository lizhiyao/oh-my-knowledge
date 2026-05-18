import type { Artifact, Sample } from './eval.js';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';

export type DoctorSeverity = 'fatal' | 'warn' | 'info';
export type DoctorRuleStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type DoctorSkillStatus = 'pass' | 'warn' | 'fail';

/** Single-enum CI verdict. Switch on this directly:
 *    'failed'        — at least one skill has fatal-fail (CLI exits 1, eval aborts)
 *    'warnings_only' — no fatal-fail but at least one skill has warn (informational)
 *    'passed'        — all skills pass cleanly */
export type DoctorOutcome = 'passed' | 'warnings_only' | 'failed';

/** Bumped whenever DoctorReport schema changes in a way CI consumers should
 *  be able to detect. CI can pin/check this when parsing the JSON. */
export const DOCTOR_REPORT_SCHEMA_VERSION = '1.0.0';

export interface DoctorRuleResult {
  ruleId: string;
  severity: DoctorSeverity;
  /** rule 的 i18n key, 引擎执行时由 rule.labelKey 注入。renderer 用它显示 rule 标题 —
   *  自定义规则不再 fallback 到硬编码 ruleId 映射。 */
  labelKey: string;
  status: DoctorRuleStatus;
  /** 已 i18n 翻译后的 user-facing message。CI 消费 JSON 时直接读。 */
  message: string;
  /** 可选可操作修复建议(已 i18n 翻译)。terminal 渲染器在 message 之后单独一行展示。 */
  hint?: string;
  /** 结构化数据,留给 renderer 或上游系统消费(不渲染到终端)。 */
  detail?: Record<string, unknown>;
  durationMs: number;
  /** 由 ComposerRule 产出的子结果共享同一个 groupId(= composer.id)。renderer
   *  按 groupId 把多条 result 渲染为同一组(header + 缩进的子项)。普通 rule 不设。 */
  groupId?: string;
}

export type DoctorRuleCheckOutcome = Omit<DoctorRuleResult, 'ruleId' | 'severity' | 'labelKey' | 'durationMs' | 'groupId'>;

/** ComposerRule 的子结果。一次 checkAll() 返回多条,每条会被 engine 映射成
 *  独立的 DoctorRuleResult。subId 是子 rule 的稳定 id(eg. dimension id),
 *  最终 ruleId = `${composer.id}:${subId}`。 */
export interface ComposerOutcome extends DoctorRuleCheckOutcome {
  subId: string;
  /** 覆盖 composer 的默认 labelKey(每个子项有自己的标签)。 */
  labelKey?: string;
  /** 覆盖 composer 的默认 severity(子项可独立声明 fatal/warn/info)。 */
  severity?: DoctorSeverity;
}

/** 复合 rule:一次 checkAll() 产出多条 result,适合"单次 LLM 调用 → N 个维度结果"
 *  这类场景。doctor engine 检测 kind === 'composer' 时把数组结果展开,每条共享
 *  同一个 groupId(= composer.id)以便 renderer 分组。 */
export interface ComposerRule {
  id: string;
  kind: 'composer';
  /** 默认 severity(子 outcome 未指定时用)。 */
  severity: DoctorSeverity;
  /** 默认 labelKey(子 outcome 未指定时用,通常是 composer 整体的标签)。 */
  labelKey: string;
  checkAll(ctx: DoctorContext): Promise<ComposerOutcome[]>;
}

/** doctor engine 接受的 rule 类型: 普通 DoctorRule 或 ComposerRule。 */
export type DoctorRuleLike = DoctorRule | ComposerRule;

export function isComposerRule(r: DoctorRuleLike): r is ComposerRule {
  return (r as ComposerRule).kind === 'composer';
}

export interface DoctorContext {
  artifact: Artifact;
  /** 仅 samples_contract_aligned rule 用。其他 rule 可忽略。 */
  samples?: Sample[];
  /** samples wrapper 里的显式 requires (tools/files/env/preflight)。
   *  传给 dependencies_present rule, 让 doctor 与 evaluation preflight
   *  对依赖完整性的判断完全一致。 */
  requires?: DependencyRequirements;
  executorName: string;
  model: string;
  /** doctor 的运行工作目录(默认 process.cwd())。 */
  cwd: string;
  /** 解析 requires.files / requires.preflight 路径时用的基准目录。
   *  规则与 evaluation preflight 一致: artifact.cwd > dependencyCwd > cwd。
   *  缺位时 rule 退回 ctx.cwd(行为不变, 测试 fixture 不强制传)。 */
  dependencyCwd?: string;
  lang: 'zh' | 'en';
  timeoutMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 深度健康检查(LLM-judge,多维度)开关。CLI doctor 默认 true,`--static-only`
   *  会过滤 composer rule;programmatic API 默认 false,只跑静态 rule。true 时
   *  skill_health composer 才真正调 LLM。composer 不在 BUILTIN_RULES,必须先
   *  import './doctor/health/register.js' 让 registerRule 副作用生效。 */
  runHealthCheck?: boolean;
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
  /** Schema version the JSON consumer can pin/check. Bumped on any
   *  user-visible change to this report's shape. See DOCTOR_REPORT_SCHEMA_VERSION. */
  schemaVersion: string;
  id: string;
  timestamp: string;
  cliVersion: string;
  cwd: string;
  executorName: string;
  model: string;
  skills: DoctorSkillReport[];
  /** Single-enum CI verdict. CLI exits 1 iff `outcome === 'failed'`. */
  outcome: DoctorOutcome;
  /** Per-skill outcome counts (each skill contributes exactly once based on its worst rule).
   *  `skills.length === totals.pass + totals.warn + totals.fail`. */
  totals: { pass: number; warn: number; fail: number };
  /** Per-rule outcome counts across all skills. Different granularity from `totals` —
   *  CI uses this to know how much of the doctor surface actually ran (e.g. how many
   *  rules ended up `skipped` because samples were not provided). `total` equals
   *  pass+warn+fail+skipped. */
  ruleStats: { pass: number; warn: number; fail: number; skipped: number; total: number };
}

export interface DoctorRunOptions {
  /** 单 skill 文件 / 目录 / null(=cwd 当前目录批量)。当 artifacts 显式提供时, target 被忽略。 */
  target?: string | null;
  /** 直接提供 artifacts，跳过 target 解析。CLI 嵌入 eval 时用，
   *  避免 doctor 检查 skillDir 里与本次评测无关的草稿 skill。 */
  artifacts?: Artifact[];
  cwd: string;
  executorName: string;
  model: string;
  timeoutMs: number;
  lang: 'zh' | 'en';
  /** 可选 samples,仅 samples_contract_aligned rule 会用 */
  samples?: Sample[];
  /** 可选 requires (samples wrapper 里的显式声明), 透传给 dependencies_present rule */
  requires?: DependencyRequirements;
  /** 解析 requires.files / requires.preflight 路径时的基准目录(优先级低于
   *  artifact.cwd，高于 cwd）。CLI 嵌入 eval 时传 skillDir，与 evaluation
   *  preflight 的 cwd 选择规则保持一致(参见 evaluation-pipeline.ts dependency check)。 */
  dependencyCwd?: string;
  /** 覆盖默认 rules(test 注入用)。生产路径走 getRegisteredRules() = BUILTIN + custom。
   *  既可以是普通 DoctorRule,也可以是 ComposerRule(健康度体检走这条)。 */
  rules?: DoctorRuleLike[];
  /** 深度健康检查(7 维 LLM-judge)。透传给 DoctorContext.runHealthCheck。
   *  CLI doctor 默认开启;`--static-only` 通过过滤 composer rule 切到离线静态模式。
   *  programmatic API 默认 false。 */
  runHealthCheck?: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
