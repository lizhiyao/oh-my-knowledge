/**
 * CLI 文案字典。
 *
 * 命名约定: `cli.<command>.<event>` 或 `cli.common.<event>`。
 * 占位符用 `{name}` 形式,在 tCli(params) 处替换。
 *
 * 新增 key 时**两边必须同时加**,Record 类型会强制,test/cli-i18n.test.ts
 * 还会做 runtime 校验防止 zh/en 漏写。
 */

export type CliMessageKey =
  // 通用 / 启动期
  | 'cli.common.lang_invalid_silent'
  | 'cli.common.help_hint'
  | 'cli.common.unknown_domain'
  | 'cli.common.unknown_bench_command';

export interface CliMessage {
  zh: string;
  en: string;
}

export const CLI_DICT: Record<CliMessageKey, CliMessage> = {
  'cli.common.lang_invalid_silent': {
    zh: '无效的语言: {value} (仅支持 zh|en, 已退回默认 zh)',
    en: 'Invalid language: {value} (supported: zh|en, falling back to default zh)',
  },
  'cli.common.help_hint': {
    zh: "运行 'omk --help' 查看用法",
    en: "Run 'omk --help' to see usage",
  },
  'cli.common.unknown_domain': {
    zh: "未知模块: {domain} (请用 'omk bench <command>' 或 'omk analyze <dir>')",
    en: "Unknown domain: {domain} (use 'omk bench <command>' or 'omk analyze <dir>')",
  },
  'cli.common.unknown_bench_command': {
    zh: "未知 bench 子命令: {command} (运行 'omk --help' 查看可用列表)",
    en: "Unknown bench command: {command} (run 'omk --help' to see all commands)",
  },
};
