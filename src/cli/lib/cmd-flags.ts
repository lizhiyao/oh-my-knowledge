/**
 * omk CLI 各个 oclif Command 的 typed args / flags interface 集中模块。
 *
 * 当前覆盖 13 个真正吃 typed parse 的命令 — `eval gold` topic 是只打 help 的 shim,
 * 不进入业务,所以这里没给它定义专门的 interface;加新 Command 时跟着 oclif 文件
 * 一起补对应 interface。
 *
 * 用途:
 * - oclif Command 静态 `flags = { ... }` 通过 `Flags.xxx()` 声明,但 `this.parse(X)`
 *   返回的 flags 是 oclif 推导出的 ad-hoc 类型。业务函数 `run<Cmd>(args, flags, lang)`
 *   接的是这里定义的**稳定 business-facing interface**(给跨命令业务模块跟单测复用),
 *   oclif Command 在 run() 里走 `{ ...flags, lang }` spread 把 oclif parse 结果传过去。
 *
 * - args 也走同样的 typed interface,oclif `static args = { ... }` 的 key 跟
 *   interface field 命名靠 review + 跑通的测试 case 保持对齐。
 *
 * 这里**不是**完整的 drift gate:
 * - TS 结构类型 + `{ ...flags, lang }` spread + 多数 EvalFlags 字段可选,导致
 *   ① oclif static 加新 flag 但忘记补 interface,不报错(spread 多余字段不报);
 *   ② interface 漏 optional 字段,也不报错。
 * - 真值是各 Command file 的 `static flags = { ... }`,runtime 跟 codegen 都读它。
 * - 如果未来需要硬 drift gate,可在每个 Command run() body 加
 *   `flags satisfies <XxxFlags>`(单向:catch interface required 字段缺失)
 *   + paired type-level 等价检查(双向:catch 多 / 少 字段)。当前没加是因为
 *   `{ ...flags, lang }` 的 spread 模式让 satisfies 错位率高,加之 oclif parse 错配
 *   测试运行时就挂,human review 加测试已经能抓住绝大多数 drift。
 *
 * Flag 类型映射约定:
 * - `Flags.boolean({ default: false })` → `boolean`
 * - `Flags.boolean({})`(无 default)→ `boolean | undefined`(保留三态)
 * - `Flags.string({})` → `string | undefined`
 * - `Flags.string({ default: 'x' })` → `string`(因 default 让它非 undefined)
 * - `Flags.string({ required: true })` → `string`
 * - lang 字段统一 `Lang`(`'zh' | 'en'`),业务侧不读 oclif `flags.lang`(它会被
 *   `default: 'zh'` 盖掉 `OMK_LANG=en` 环境变量),而走 `resolveLang(process.argv)`,
 *   优先级 `--lang CLI flag > OMK_LANG env > zh`。
 *
 * 三态 boolean 注意:oclif 对 `Flags.boolean({})`(没 `default`)运行时不会塞 `false`,
 * 而是字段缺失,字段读出来是 `undefined`。这点对 `eval` 跟 `parseRunConfig()` fallback
 * 关键 — `undefined`(CLI 没传)走 `eval.yaml` config / 内置 default;`false`(显式
 * `--no-xxx`)真的关。如果在 interface 里把它标成 `boolean`,后续维护者按类型读
 * `flags.bootstrap` 会静默把「没传」当成「关」,绕开 config fallback。所以未设
 * `default: false` 的 boolean 必须在 interface 里标成可选(`field?: boolean`)。
 */

export type Lang = 'zh' | 'en';

// ── init ──────────────────────────────────────────────────────────────────────

export interface InitArgs {
  targetDir?: string;
}
export interface InitFlags {
  lang: Lang;
}

// ── doctor ────────────────────────────────────────────────────────────────────

export interface DoctorArgs {
  target?: string;
}
export interface DoctorFlags {
  lang: Lang;
  json: boolean;
  gate: boolean;
  executor?: string;
  model?: string;
  samples?: string;
  timeout?: string;
  html?: string;
  'static-only': boolean;
}

// ── eval ──────────────────────────────────────────────────────────────────────

export type EvalArgs = Record<string, never>;
export interface EvalFlags {
  lang: Lang;
  control?: string;
  treatment?: string;
  config?: string;
  samples?: string;
  'skill-dir'?: string;
  model?: string;
  executor?: string;
  'judge-models'?: string;
  'output-dir'?: string;
  // 下面 17 个 boolean 都没在 Eval Command 上设 `default: false`,oclif 运行时
  // absent → undefined,业务在 parseRunConfig() / runEval() 里靠 undefined vs
  // boolean 的三态区分 CLI 没传 vs 显式开关 vs 走 eval.yaml fallback;不能简化
  // 成 `boolean`,会让维护者直接读 flags.X 时悄悄覆盖 config fallback。
  'no-judge'?: boolean;
  'no-cache'?: boolean;
  'dry-run'?: boolean;
  concurrency?: string;
  timeout?: string;
  batch?: boolean;
  'skip-connectivity'?: boolean;
  'skip-doctor'?: boolean;
  'mcp-config'?: string;
  'no-serve'?: boolean;
  verbose?: boolean;
  retry?: string;
  resume?: string;
  'layered-stats'?: boolean;
  'strict-baseline'?: boolean;
  'no-strict-baseline'?: boolean;
  effort?: string;
  'no-diagnostic'?: boolean;
  blind?: boolean;
  repeat?: string;
  'judge-repeat'?: string;
  bootstrap?: boolean;
  'bootstrap-samples'?: string;
  'gold-dir'?: string;
  'no-debias-length'?: boolean;
  'budget-usd'?: string;
  'budget-per-sample-usd'?: string;
  'budget-per-sample-ms'?: string;
  threshold?: string;
  'trivial-diff'?: string;
  'report-only'?: boolean;
  'no-gate'?: boolean;
}

// ── evolve ────────────────────────────────────────────────────────────────────

export interface EvolveArgs {
  skillPath: string;
}
export interface EvolveFlags {
  lang: Lang;
  rounds: string;
  target?: string;
  samples: string;
  model: string;
  'judge-models': string;
  'improve-model': string;
  concurrency: string;
  timeout: string;
  executor: string;
  'skip-connectivity': boolean;
  effort?: string;
  'no-diagnostic': boolean;
  'skip-doctor': boolean;
  'stop-on-assertions-pass': boolean;
  'auto-fix-samples': boolean;
  'sample-fix-max-attempts': string;
  'reuse-latest-eval': boolean;
  'improve-mode': string;
}

// ── sample ────────────────────────────────────────────────────────────────────

export interface SampleArgs {
  skillPath?: string;
}
export interface SampleFlags {
  lang: Lang;
  batch: boolean;
  count?: string;
  model: string;
  'skill-dir': string;
  focus?: string;
  'no-mock': boolean;
  fix: boolean;
  'reports-dir'?: string;
  treatment?: string;
}

// ── eval gold(3 sub-sub) ─────────────────────────────────────────────────────

export type GoldInitArgs = Record<string, never>;
export interface GoldInitFlags {
  lang: Lang;
  out: string;
  annotator?: string;
}

export interface GoldValidateArgs {
  dir: string;
}
export interface GoldValidateFlags {
  lang: Lang;
}

export interface GoldCompareArgs {
  reportId: string;
}
export interface GoldCompareFlags {
  lang: Lang;
  'gold-dir'?: string;
  variant?: string;
  'reports-dir'?: string;
  'bootstrap-samples'?: string;
  seed?: string;
}

// ── observe ───────────────────────────────────────────────────────────────────

// observe(default,健康度审计)
export interface ObserveArgs {
  sessionsDir?: string;
}
export interface ObserveFlags {
  lang: Lang;
  kb?: string;
  last?: string;
  from?: string;
  to?: string;
  skills?: string;
  'output-dir'?: string;
}

// observe ingest
export interface ObserveIngestArgs {
  traceDir: string;
}
export interface ObserveIngestFlags {
  lang: Lang;
  'output-dir'?: string;
}

// observe inbox(无 positional)
export type ObserveInboxArgs = Record<string, never>;
export interface ObserveInboxFlags {
  lang: Lang;
  'input-dir'?: string;
  skill?: string;
  limit?: string;
  explore?: string;
  'include-noise': boolean;
  'by-skill': boolean;
  'llm-enhanced-review': boolean;
  refresh: boolean;
  model?: string;
  executor?: string;
  json: boolean;
}

// observe show
export interface ObserveShowArgs {
  inboxId: string;
}
export interface ObserveShowFlags {
  lang: Lang;
  'input-dir'?: string;
}

// ── studio ────────────────────────────────────────────────────────────────────

// 无 positional。用 Record<string, never> 而不是 `interface StudioArgs {}` 是因为
// 空 interface 会被 TS-eslint 警告(空 interface 等价于 `unknown`,易撞默认推断)。
export type StudioArgs = Record<string, never>;
export interface StudioFlags {
  lang: Lang;
  port: string;
  host?: string;
  'reports-dir'?: string;
  'analyses-dir'?: string;
  'observations-dir'?: string;
  'no-open': boolean;
  dev: boolean;
}
