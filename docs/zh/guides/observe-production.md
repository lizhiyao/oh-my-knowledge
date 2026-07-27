# 观测生产 trace

`omk observe` 把**真实 Codex rollout、Claude Code / OpenClaw session 与 markdown 对话日志**统一转换为 source-neutral Trace IR，再呈现知识在哪儿被使用、在哪儿撞上缺口、执行有多稳定。和 [`omk eval`](../reference/cli)（受控离线实验）不同，observe 是只读的生产观测——**它不评分**，只暴露信号。

它有两条工作流。每个 flag 见 [CLI 参考](../reference/cli)。

## A. skill 健康度报告（默认）

将它指向受支持的 trace 目录或日志文件：

```bash
# ChatGPT desktop / Codex CLI
omk observe ~/.codex/sessions --last 7d

# Claude Code
omk observe ~/.claude/projects/-Users-you-Documents-my-project
omk observe ~/.claude/projects/my-project --last 7d
omk observe ~/.claude/projects/my-project --skills audit,polish
omk observe ~/.claude/projects/my-project --kb /path/to/project   # KB-aware 分析
```

你会拿到逐 skill 的健康度报告：知识使用、[gap 信号](../specs/knowledge-gap-signal-spec)（agent 想要某个东西却没找到）、执行稳定性、token、耗时。重点是找出**你的 eval 用例没覆盖到的真实世界缺口**——这些缺口变成下一轮 eval 用例。

用 `--last 7d` / `--from … --to …` 圈时间窗，用 `--skills` 收窄到特定 skill。

## B. inbox：reviewer 闭环

当你想逐条 triage observation，用 inbox。下面步骤 1-3 纯本地、零 LLM；生成回归用例草稿是单独的可选 authoring 步骤，会调用生成模型。

```bash
# 1. 解析 trace，聚合 + 降噪信号，落盘到 .omk/observe-inbox/
omk observe ingest ~/.codex/sessions
omk observe ingest ~/.claude/projects/my-project

# 2. 看 inbox（默认 top 20，按 severity / confidence / lastSeen 排序）
omk observe inbox
omk observe inbox --skill audit          # 按 skill 过滤
omk observe inbox --by-skill             # 每个 skill 一行（rollup）
omk observe inbox --explore 10           # 从 medium/low 抽长尾条目
omk observe inbox --json                 # JSON 给自动化

# 3. 看单条 observation 及其上下文消息
omk observe show <inbox_id>
```

每条 observation 带它的可信度（`confidence` + `attributionConfidence`，并排显示，让你区分"强信号"和"摇摆的 skill 归因"）、一个稳定的 `severityReasonCode`、以及一个 `messageWindow`（触发前 3 条 / 触发 / 后 3 条，外加 agent 是否恢复），都锚回原始 JSONL。

支持的 trace 格式：Codex rollout JSONL、Claude Code session JSONL、OpenClaw session JSONL、markdown 对话日志（`.log`）。Codex 记录会保留模型、父子任务分组、tool call、token 使用和 `sourceKind=codex`；skill 归因依据实际读取的 `skills/<name>/SKILL.md`。

两条工作流都会持久化摄取摘要。源数据包含格式损坏记录、不是对象的合法 JSON 值，或当前 adapter 无法识别的事件时，CLI 与 Studio 会显示完整性提示。把「没有发现信号」解释成「没有问题」之前，应先复核这项提示。运行时守护会话属于有意过滤，会单独计数。

## 把 observation 变成用例

observe 确认的缺口，正是你 eval 集缺的那些失败。`omk sample --from-traces` 能从这些信号草拟回归用例——把 observe → eval 的闭环合上。

这个命令会通过你配置的 executor 和 model 调用 sample 生成器，因此 trace 派生证据会发送给该模型，也可能产生生成成本：

```bash
omk sample --from-traces
```

它会写 `.omk/observe-inbox/sample-drafts.json`。把这个文件当 review 队列：先看草稿，只保留可复现的用例，再合入正式 `eval-samples` 文件。

## 相关

- [三阶段](../explanation/three-stage-workflow) —— observe 在闭环里的位置
- [知识缺口信号规范](../specs/knowledge-gap-signal-spec) —— gap 信号是什么、怎么打分
- [CLI 参考：`omk observe`](../reference/cli) —— 每个 flag 和子命令
