import type { CliMessage } from './types.js';

export type HelpMessageKey =
  | 'cli.help.observe_health'
  | 'cli.help.observe_ingest'
  | 'cli.help.observe_inbox'
  | 'cli.help.observe_show'
  | 'cli.help.evolve'
  | 'cli.help.sample'
  | 'cli.help.studio';

export const helpDict: Record<HelpMessageKey, CliMessage> = {
  'cli.help.observe_health': {
    zh: `
omk observe health——分析真实 session trace，生成 skill 健康度报告

用法：
  omk observe health <sessions-dir> [options]

选项：
  --kb <path>                         知识库根路径（默认：从 trace cwd 推断）
  --last <duration>                   时间窗口，例如 7d / 24h / 30m
  --from <iso>                        窗口起点，优先级高于 --last
  --to <iso>                          窗口终点，优先级高于 --last
  --skills <n1,n2,...>                只分析指定 skill
  --output-dir <path>                 输出目录（默认：~/.oh-my-knowledge/observe-health）

观测收件箱（observe inbox）是另一条线，见 omk observe inbox --help。
`,
    en: `
omk observe health — analyze production session traces and produce skill health reports

Usage:
  omk observe health <sessions-dir> [options]

Options:
  --kb <path>                         Knowledge base root (default: infer from trace cwd)
  --last <duration>                   Time window, e.g. 7d / 24h / 30m
  --from <iso>                        Window start, overrides --last
  --to <iso>                          Window end, overrides --last
  --skills <n1,n2,...>                Only analyze selected skills
  --output-dir <path>                 Output directory (default: ~/.oh-my-knowledge/observe-health)

The observe inbox is a separate line; see omk observe inbox --help.
`,
  },
  'cli.help.observe_ingest': {
    zh: `
omk observe ingest — 读取真实 session trace，写入 observe inbox 数据

用法：
  omk observe ingest <sessions-dir-or-file> [options]

选项：
  --output-dir <path>                输出目录（默认：.omk/observe-inbox；读取时兜底到 ~/.oh-my-knowledge/observe-inbox）

支持：
  Claude Code JSONL
  Markdown 对话日志（.log）
`,
    en: `
omk observe ingest — read real session traces and write observe inbox data

Usage:
  omk observe ingest <sessions-dir-or-file> [options]

Options:
  --output-dir <path>                Output directory (default: .omk/observe-inbox; read fallback: ~/.oh-my-knowledge/observe-inbox)

Supported:
  Claude Code JSONL
  Markdown conversation logs (.log)
`,
  },
  'cli.help.observe_inbox': {
    zh: `
omk observe inbox — 查看已写入的 observe inbox 问题列表

用法：
  omk observe inbox [options]

选项：
  --input-dir <path>                 读取目录（默认：.omk/observe-inbox；兜底到 ~/.oh-my-knowledge/observe-inbox）
  --limit <n>                        展示 top N（默认：20）
  --skill <name>                     只看指定 skill
  --explore <n>                      从最近 50 条 medium/low 问题里抽样查看长尾
  --include-noise                    --explore 时显式包含 noise 桶
  --by-skill                         按 skill 输出资产看板
  --llm-enhanced-review              显式调用模型进行链路增强复盘
  --model <name>                     LLM 增强复盘使用的模型（默认：sonnet）
  --executor <name>                  LLM 增强复盘使用的执行器
  --refresh                          强制重新生成 LLM 增强复盘
  --json                             输出 JSON
`,
    en: `
omk observe inbox — inspect previously ingested observe inbox items

Usage:
  omk observe inbox [options]

Options:
  --input-dir <path>                 Input directory (default: .omk/observe-inbox; fallback: ~/.oh-my-knowledge/observe-inbox)
  --limit <n>                        Show top N (default: 20)
  --skill <name>                     Only show one skill
  --explore <n>                      Sample long-tail issues from the latest 50 medium/low items
  --include-noise                    Explicitly include the noise bucket with --explore
  --by-skill                         Print the skill-level asset board
  --llm-enhanced-review              Explicitly run model-based enhanced chain review
  --model <name>                     Model for LLM enhanced review (default: sonnet)
  --executor <name>                  Executor for LLM enhanced review
  --refresh                          Force LLM enhanced review refresh
  --json                             Print JSON
`,
  },
  'cli.help.observe_show': {
    zh: `
omk observe show — 查看单条 observation 的原始上下文

用法：
  omk observe show <inbox_id> [options]

选项：
  --input-dir <path>                 读取目录（默认：.omk/observe-inbox；兜底到 ~/.oh-my-knowledge/observe-inbox）
`,
    en: `
omk observe show — inspect the raw context around one observation

Usage:
  omk observe show <inbox_id> [options]

Options:
  --input-dir <path>                 Input directory (default: .omk/observe-inbox; fallback: ~/.oh-my-knowledge/observe-inbox)
`,
  },
  'cli.help.evolve': {
    zh: `
omk evolve——多轮自动迭代改进 skill

用法：
  omk evolve <skill-path> [options]

选项：
  --rounds <n>                        迭代轮数（默认：5）
  --target <score>                    目标分数
  --model <name>                      任务执行模型，每轮跑 eval samples 的被测模型（默认：sonnet）
  --improve-model <name>              skill 改写模型，每轮根据反馈改写 skill 的模型（默认：sonnet）
  --judge-models <executor:model>     单评委配置（默认：claude:haiku）

示例：
  omk evolve skills/code-review/SKILL.md
  omk evolve skills/code-review/SKILL.md --rounds 10 --target 4.5
  omk evolve skills/code-review/SKILL.md --model sonnet --improve-model opus
`,
    en: `
omk evolve — auto-iterate a skill through multi-round evaluation loops

Usage:
  omk evolve <skill-path> [options]

Options:
  --rounds <n>                        Iteration rounds (default: 5)
  --target <score>                    Target score
  --model <name>                      Task executor model — runs eval samples each round (default: sonnet)
  --improve-model <name>              Skill rewriter model — rewrites the skill each round (default: sonnet)
  --judge-models <executor:model>     Single judge config (default: claude:haiku)

Examples:
  omk evolve skills/code-review/SKILL.md
  omk evolve skills/code-review/SKILL.md --rounds 10 --target 4.5
  omk evolve skills/code-review/SKILL.md --model sonnet --improve-model opus
`,
  },
  'cli.help.sample': {
    zh: `
omk sample——生成或补齐 eval-samples 评测用例

用法：
  omk sample <skill-path> [options]
  omk sample --batch [--skill-dir <dir>] [options]

输出位置（默认）：
  <skill>/SKILL.md  → <skill>/.omk/samples.json（omk 标准约定）
  其他 .md 路径    → 当前目录的 eval-samples.json（兜底）

选项：
  --count <n>                         强制生成 N 条（不指定时由 LLM 按 skill 类型自动判断：
                                       工作流型 6-8 条 / 原子型 4-6 条 / 混合型 5-7 条）
  --model <name>                      生成模型（默认：opus；lean+effort-low 已自动开,想省钱可改 sonnet/haiku）
  --focus <text>                      自然语言指定希望覆盖的场景（追加到 prompt，优先级高于自由发挥）
  --batch                             为 skill 目录下缺少 eval-samples 的 skill 批量生成
  --skill-dir <path>                  skill 目录（batch 使用，默认：skills）

示例：
  omk improve samples skills/req-tool.md
  omk improve samples skills/req-tool.md --count 8 \\
    --focus "重点覆盖 tag 查询走 PROJECT 空 → WORKSPACE 兜底的多步流程，以及 search 失败的错误路径"
`,
    en: `
omk sample — generate or fill eval-samples test cases

Usage:
  omk sample <skill-path> [options]
  omk sample --batch [--skill-dir <dir>] [options]

Output path (default):
  <skill>/SKILL.md  → <skill>/.omk/samples.json (omk standard layout)
  other .md paths   → ./eval-samples.json in current directory (fallback)

Options:
  --count <n>                         Force N samples (omit to let LLM auto-decide by skill type:
                                       workflow 6-8 / atomic 4-6 / mixed 5-7)
  --model <name>                      Generation model (default: opus; lean+effort-low applied; pass --model sonnet/haiku to save cost)
  --focus <text>                      Natural-language scenario hints appended to the prompt (overrides freeform diversity)
  --batch                             Generate for skills that are missing eval-samples
  --skill-dir <path>                  Skill directory for batch mode (default: skills)

Examples:
  omk improve samples skills/req-tool.md
  omk improve samples skills/req-tool.md --count 8 \\
    --focus "Cover PROJECT-empty → WORKSPACE-fallback multi-step tag lookup and the search-failure error path"
`,
  },
  'cli.help.studio': {
    zh: `
omk studio——打开本地知识工作台

用法：
  omk studio [options]

选项：
  --port <n>                          本地服务端口（默认：7799）
  --host <host>                       监听地址（默认：127.0.0.1；局域网访问可用 0.0.0.0）
  --reports-dir <path>                报告目录（默认：~/.oh-my-knowledge/reports）
  --analyses-dir <path>               观测分析目录
  --observations-dir <path>           observe inbox 数据目录（默认：.omk/observe-inbox）
  --no-open                           只启动服务，不自动打开浏览器
  --dev                               开发模式：文件变化时自动重启

示例：
  omk studio
  omk studio --port 7798
  omk studio --host 0.0.0.0 --observations-dir .omk/observe-inbox
  omk studio --no-open
`,
    en: `
omk studio — open the local knowledge workbench

Usage:
  omk studio [options]

Options:
  --port <n>                          Local server port (default: 7799)
  --host <host>                       Listen address (default: 127.0.0.1; use 0.0.0.0 for LAN access)
  --reports-dir <path>                Reports directory (default: ~/.oh-my-knowledge/reports)
  --analyses-dir <path>               Observation analyses directory
  --observations-dir <path>           Observe inbox data directory (default: .omk/observe-inbox)
  --no-open                           Start the server without opening a browser
  --dev                               Dev mode: restart on file changes

Examples:
  omk studio
  omk studio --port 7798
  omk studio --host 0.0.0.0 --observations-dir .omk/observe-inbox
  omk studio --no-open
`,
  },
};
