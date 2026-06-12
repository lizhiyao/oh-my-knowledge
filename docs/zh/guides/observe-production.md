# 观测生产 trace

`omk observe` 把**真实 Claude Code session trace** 转成洞察：你的知识到底在哪儿被用上了、在哪儿撞上了缺口、执行有多稳。和 [`omk eval`](../reference/cli)（受控离线实验）不同，observe 是只读的生产观测——**它不评分**，它暴露信号。

它有两条工作流。每个 flag 见 [CLI 参考](../reference/cli)。

## A. skill 健康度报告（`omk observe health`）

指向一个 Claude Code 项目的 trace 目录：

```bash
omk observe health ~/.claude/projects/-Users-you-Documents-my-project
omk observe health ~/.claude/projects/my-project --last 7d
omk observe health ~/.claude/projects/my-project --skills audit,polish
omk observe health ~/.claude/projects/my-project --kb /path/to/project   # KB-aware 分析
```

你会拿到逐 skill 的健康度报告：知识使用、[gap 信号](../specs/knowledge-gap-signal-spec)（agent 想要某个东西却没找到）、执行稳定性、token、耗时。重点是找出**你的 eval 用例没覆盖到的真实世界缺口**——这些缺口变成下一轮 eval 用例。

用 `--last 7d` / `--from … --to …` 圈时间窗，用 `--skills` 收窄到特定 skill。

## B. inbox：reviewer 闭环

当你想逐条 triage observation（把好的回流成回归用例），用 inbox。整条链路纯本地、零 LLM。

```bash
# 1. 解析 trace，聚合 + 降噪信号，落盘到 .omk/observe-inbox/
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

支持的 trace 格式：Claude Code session JSONL、OpenClaw session JSONL、markdown 对话日志（`.log`）。

## 把 observation 变成用例

observe 确认的缺口，正是你 eval 集缺的那些失败。`omk sample --from-traces` 能从这些信号草拟回归用例——把 observe → eval 的闭环合上。

## 相关

- [三阶段](../explanation/three-stage-workflow) —— observe 在闭环里的位置
- [知识缺口信号规范](../specs/knowledge-gap-signal-spec) —— gap 信号是什么、怎么打分
- [CLI 参考：`omk observe`](../reference/cli) —— 每个 flag 和子命令
