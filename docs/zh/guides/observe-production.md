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

当你想逐条 triage observation，用 inbox。下面步骤 1-3 纯本地、零 LLM；生成评测用例草稿是单独的可选 authoring 步骤，会调用生成模型。

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

## 查看一次任务

直接启动 `omk studio` 即可，不需要先运行 `observe ingest`。Studio 会读取本机 Codex 会话索引，在首页按「对话(Thread) → 任务(Turn)」组织 Codex rollout：

```bash
omk studio
```

先从对话总览选择一段对话，再选择其中一次任务进入「任务轨迹」。对话总览支持按标题或工作目录搜索，并区分进行中、未归档与已归档对话。当前首页直接索引本机 Codex 会话；Claude Code、OpenClaw 和 markdown trace 仍通过 `omk observe` 进入观测报告。

任务边界优先使用来源明确提供的 `turnId`，其次使用 `turn_started` / `turn_completed` 等生命周期事件；只有来源没有原生 Turn 边界时，才退化为按用户消息切分。Skill 归因只解释选定任务与哪些知识载体有关，不参与划定任务范围。

任务轨迹基于 source-neutral Trace IR 分为四条可观察泳道：

- **对话**：用户要求、AI 回答与用户后续纠正；
- **执行**：AI 发起的工具调用；
- **结果**：工具返回及调用状态；
- **知识**：进入任务的运行时上下文和知识证据。

### 实时跟随进行中的任务

Studio 会把近期仍有活动、且没有终态证据的最后一次任务标记为「进行中」，并优先展示。进入这类任务后，页面通过本地事件流增量刷新轨迹：

- **跟随中**：新事件到达后保持详情面板状态，并把可视区域平滑推进到最新位置；
- **查看更新**：你手动滚动到历史位置后，Studio 不抢回视口；有新事件时提供显式入口；
- **任务已结束**：观察到完成、中断或终止事件后停止实时跟随；
- **未记录结束状态**：旧日志没有终态证据且已超过活动窗口时，状态退化为未知，不再显示为进行中。

实时刷新只重读本地日志并更新当前视图，不会向模型发送请求。`omk studio` 默认固定使用端口 `7799`；需要其他端口时显式传 `--port`。

页面提供三层互相可追溯、但职责不同的信息：

- **语义轨迹**：把 Trace IR 投影为四条泳道，帮助人理解任务经过。长任务超过展示上限时，投影会保持工具调用与结果成对，优先保留请求、最终回答、任务边界与失败，再按时间分布选择其余节点，避免简单截掉任务中段；
- **规范化事件**：按来源顺序查看 source-neutral Trace IR，核对适配器实际提取了什么；
- **原始日志**：查看随报告有界归档的 JSONL 日志原文，核对规范化前的输入。旧报告、来源已丢失或超过归档上限时会明确提示不可用或不完整；`encrypted_content` 等不透明加密载荷只标记存在，不尝试解密，也不展示为模型思考。

语义节点详情中的「查看原始日志」会优先定位到对应原始记录；原始日志不可用时退回对应规范化事件。这个跳转只依赖 Trace IR 保存的来源位置，不要求 renderer 理解 Codex 私有日志格式。

Codex 的会话元数据会规范化为 `session_context`，其中包括可观测的运行时版本、Memory / History 模式、上下文窗口标识、动态工具名称和基础指令；每轮工作目录、模型、审批与沙箱设置则记录为 `execution_context` 或 `settings`。这些字段属于任务输入条件，不代表模型已经使用或遵循了它们。

必要时，页面还会提示 trace 截断、损坏记录、未识别事件和工具结果失配等完整性问题。未知协议记录会留在规范化事件和原始日志中供排查，而不是静默丢弃。

任务轨迹只陈述 trace 中可核验的事实。Knowledge 进入上下文、被读取或由工具返回，不代表模型实际采用了它，也不能单独证明任务结果的原因。

## 把 observation 变成用例

observe 确认的缺口，正是你 eval 集缺的那些失败。`omk sample --from-traces` 能从这些信号草拟评测用例——把 observe → eval 的闭环合上。

这个命令会通过你配置的 executor 和 model 调用 sample 生成器，因此 trace 派生证据会发送给该模型，也可能产生生成成本：

```bash
omk sample --from-traces
```

它会写 `.omk/observe-inbox/sample-drafts.json`。把这个文件当 review 队列：先看草稿，只保留可复现的用例，再合入正式 `eval-samples` 文件。

## 相关

- [复现 Codex 父子任务观测](./codex-observe-case)——可执行的 Trace IR 与紧凑报告案例
- [三阶段](../explanation/three-stage-workflow) —— observe 在闭环里的位置
- [知识缺口信号规范](../specs/knowledge-gap-signal-spec) —— gap 信号是什么、怎么打分
- [CLI 参考：`omk observe`](../reference/cli) —— 每个 flag 和子命令
