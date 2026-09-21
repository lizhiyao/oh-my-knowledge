# 三阶段：doctor / eval / observe

OMK 用 doctor、eval 和 observe 回答知识载体生命周期中的不同问题。已有改动时，从 **doctor → eval** 开始；已有工作日志时，从 **Studio → 观测与复核** 开始。真实任务可以发生在开发、试用或发布后，观测不要求先完成一次评测。

| 阶段 | 命令 | 回答的问题 | 软件工程类比 |
|---|---|---|---|
| **doctor** | `omk doctor` | 这个 artifact 本身是否成型到能测的程度？ | lint + typecheck + 冒烟测试 |
| **eval** | `omk eval` | 当前证据是否支持这次改动？ | CI 测试套件 |
| **observe** | `omk observe` | 它在真实生产 trace 上站得住吗？ | 日志分析 |

<a id="knowledge-entities-and-carriers"></a>

知识、实体与载体的概念基础见[OMK 如何理解知识](./knowledge.md)。本文聚焦三阶段如何协作。

## 主干：这次改动能不能发布？

omk 的第一条有用闭环，应该像一张发布检查表：

```text
我改了一个 skill / prompt / agent artifact
→ doctor 判断结构、依赖、可测性是否过关
→ eval 判断它是否在同一批用例上打赢 baseline
→ report / Studio 指出下一步该修哪里
→ 我决定发布 / 不发布
```

也可以先在 Studio 查看真实任务，从选定的日志片段提炼知识内容，或将确认的问题整理为评测用例。知识复核帮助确定要改什么；受控比较帮助判断载体改动是否有效。这两类证据不能互相替代。

## doctor —— 前置健康检查，先于你信任任何数字

`doctor` 对单个 artifact 做静态检查与 LLM 健康审计（默认重复采样后归并）：可读性、元数据、依赖、samples 契约对齐（静态 rule），加上 LLM 打分的维度（触发边界、文档清晰度、指令精确度……）。它**不对比两个版本**——它告诉你这个 artifact 是否处于"值得测"的状态。

它同时是 **eval 的前置门禁**：`omk eval` 内部会跑静态 doctor rule，artifact 坏了就拒跑 —— 就像 CI 在跑测试前先跑 lint。检查通过不保证用例代表性或结论有效；检查失败时，先修复指出的结构、依赖或可测性问题。

→ How-to：[doctor 体检](../guides/run-doctor-checks)

## eval —— 测量核心

`eval` 是 omk 的心脏：一次**离线 A/B**，固定模型和用例，只改变 artifact 与封存的 runtime context，回答「新版本是否在噪声之外打赢了旧版本？」。它产出经过认证的 Execution／Evaluation／Analysis 证据、Bootstrap uncertainty、coverage 与 agreement 诊断，以及可用于 CI 路由的已注册 **Decision**（`PROGRESS` / `REGRESSION` / `CAUTIOUS` / `NOISE` / `UNDERPOWERED` / `SOLO`）。

omk 的测量严谨性都在这里。[工作原理](./architecture)、[统计严谨性](./statistical-rigor)、[评分公式](../specs/scoring) 说明如何组合判定、覆盖、不确定性与原始证据，支持发布判断。

→ 概念：[工作原理](./architecture) · [评分公式](../specs/scoring)
→ How-to：[评测 agent](../guides/agent-eval) · [自动迭代 skill](../guides/auto-improve-skills)

## observe —— 它在生产里站得住吗？

`eval` 是固定用例集上的受控实验，`observe` 是另一端：它把**真实 Codex rollout、Claude Code / OpenClaw session 与 markdown 对话日志**统一转换为 source-neutral Trace IR，再生成 skill 健康度报告——知识使用、[gap 信号](../specs/knowledge-gap-signal-spec)、执行稳定性、token 使用和耗时。它是**观测，不是评分**：它告诉你知识库在真实使用里在哪儿撞上了未知，好让下一轮用例去覆盖这些点。

`omk studio` 可直接浏览本机 Codex 对话与四泳道任务轨迹，无需先 ingest；进行中的任务支持实时跟随。查看日志不调用模型，也不把知识访问解释为结果原因。

[知识提炼](../guides/extract-knowledge.md)从选定 Codex 日志片段生成待复核内容，保留来源、适用条件、修订与处理理由。生成会调用模型；保留内容不等于证实，也不会自动写入载体。[MCP 主动反馈](../guides/mcp-integration.md)则在用户确认后记录 observation，复核为真实问题后才能草拟用例。

→ How-to：[观测生产 trace](../guides/observe-production)

## 它们怎么串起来

```
写 / 改一个 artifact
        │
        ▼
   omk doctor      → 是否成型？  （门禁）
        │ 绿
        ▼
   omk eval        → 改动是不是真的进步？  （verdict → CI 门禁）
        │ 发布
        ▼
   omk observe     → 生产里站得住吗？  → 把新发现的缺口喂回 eval
```

发布闭环在 doctor → eval 就已经有价值。生产闭环稍后合上：observe 暴露真实世界的缺口 → 它们变成新的 eval 用例 → eval 测量下一个修复 → doctor 保证每次迭代都成型。`omk evolve` 把 doctor → eval → 改写这个内层循环自动化；`omk sample` 帮你生成喂给它的用例。
