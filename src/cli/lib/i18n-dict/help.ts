import type { CliMessage } from './types.js';

export type HelpMessageKey =
  | 'cli.help.observe';

export const helpDict: Record<HelpMessageKey, CliMessage> = {
  'cli.help.observe': {
    zh: `
omk observe——分析真实 session trace，生成 skill 健康度报告

用法：
  omk observe <sessions-dir> [options]

选项：
  --kb <path>                         知识库根路径（默认：从 trace cwd 推断）
  --last <duration>                   时间窗口，例如 7d / 24h / 30m
  --from <iso>                        窗口起点，优先级高于 --last
  --to <iso>                          窗口终点，优先级高于 --last
  --skills <n1,n2,...>                只分析指定 skill
  --output-dir <path>                 输出目录（默认：项目级 .omk/observe/health）
  --global                            写全局 ~/.oh-my-knowledge/observe/health，而非项目 .omk/observe/health

观测收件箱（observe inbox）是另一条线，见 omk observe inbox --help。
`,
    en: `
omk observe — analyze production session traces and produce skill health reports

Usage:
  omk observe <sessions-dir> [options]

Options:
  --kb <path>                         Knowledge base root (default: infer from trace cwd)
  --last <duration>                   Time window, e.g. 7d / 24h / 30m
  --from <iso>                        Window start, overrides --last
  --to <iso>                          Window end, overrides --last
  --skills <n1,n2,...>                Only analyze selected skills
  --output-dir <path>                 Output directory (default: project-level .omk/observe/health)
  --global                            Write to global ~/.oh-my-knowledge/observe/health instead of project .omk/observe/health

The observe inbox is a separate line; see omk observe inbox --help.
`,
  },
};
