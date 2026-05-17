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
 * - lang 字段统一 `Lang`(`'zh' | 'en'`),init hook 已在 Command.run() 前 inject。
 */

export type Lang = 'zh' | 'en';

// ── init ──────────────────────────────────────────────────────────────────────

export interface InitArgs {
  targetDir?: string;
}
export interface InitFlags {
  lang: Lang;
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
