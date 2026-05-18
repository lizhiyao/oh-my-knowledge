/**
 * omk CLI 14 个 oclif Command 的 typed args / flags interface 集中模块。
 *
 * 用途:
 * - oclif Command 静态 `flags = { ... }` 通过 `Flags.xxx()` 声明,但 `this.parse(X)`
 *   返回的 flags 是 oclif 推导出的 ad-hoc 类型。业务函数 `run<Cmd>(args, flags, lang)`
 *   接的是这里定义的稳定 interface,oclif Command 在 run() 里把 oclif parse 结果 cast
 *   到对应 interface(TypeScript 编译期校验 shape 一致)。
 *
 * - oclif Command 静态 flags 跟这里的 interface **shape 必须一致**(命名 / 类型)。
 *   不一致就编译挂(parse 结果不能 narrow 到 interface),靠 tsc 做 drift gate。
 *
 * - args 也走同样的 typed interface,oclif `static args = { ... }` 的 key 跟
 *   interface field 命名严格对齐。
 *
 * Flag 类型映射约定:
 * - `Flags.boolean({ default: false })` → `boolean`
 * - `Flags.string({})` → `string | undefined`
 * - `Flags.string({ default: 'x' })` → `string`(因 default 让它非 undefined)
 * - `Flags.string({ required: true })` → `string`
 * - lang 字段统一 `Lang`(`'zh' | 'en'`),业务侧不读 oclif `flags.lang`(它会被
 *   `default: 'zh'` 盖掉 `OMK_LANG=en` 环境变量),而走 `resolveLang(process.argv)`,
 *   优先级 `--lang CLI flag > OMK_LANG env > zh`。
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
  'no-judge': boolean;
  'no-cache': boolean;
  'dry-run': boolean;
  concurrency?: string;
  timeout?: string;
  batch: boolean;
  'skip-connectivity': boolean;
  'skip-doctor': boolean;
  'mcp-config'?: string;
  'no-serve': boolean;
  verbose: boolean;
  retry?: string;
  resume?: string;
  'layered-stats': boolean;
  'strict-baseline': boolean;
  'no-strict-baseline': boolean;
  effort?: string;
  'no-diagnostic': boolean;
  blind: boolean;
  repeat?: string;
  'judge-repeat'?: string;
  bootstrap: boolean;
  'bootstrap-samples'?: string;
  'gold-dir'?: string;
  'no-debias-length': boolean;
  'budget-usd'?: string;
  'budget-per-sample-usd'?: string;
  'budget-per-sample-ms'?: string;
  threshold?: string;
  'trivial-diff'?: string;
  'report-only': boolean;
  'no-gate': boolean;
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
