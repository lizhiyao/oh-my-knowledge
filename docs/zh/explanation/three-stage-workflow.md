# 三阶段：doctor / eval / observe

omk 围绕三个阶段组织，对应一份 LLM 知识（prompt / RAG context / skill / agent）的生命周期。它们回答三个不同的问题，但不是三个同等入口。主干是**发布前的 doctor → eval 判断**；`observe` 是有真实 trace 之后的发布后反馈闭环。

| 阶段 | 命令 | 回答的问题 | 软件工程类比 |
|---|---|---|---|
| **doctor** | `omk doctor` | 这个 artifact 本身是否成型到能测的程度？ | lint + typecheck + 冒烟测试 |
| **eval** | `omk eval` | 这次改动是否真的更好——能被证明？ | CI 测试套件 |
| **observe** | `omk observe` | 它在真实生产 trace 上站得住吗？ | 生产监控 |

## 主干：这次改动能不能发布？

omk 的第一条有用闭环，应该像一张发布检查表：

```text
我改了一个 skill / prompt / agent artifact
→ doctor 判断结构、依赖、可测性是否过关
→ eval 判断它是否在同一批用例上打赢 baseline
→ report / Studio 指出下一步该修哪里
→ 我决定发布 / 不发布
```

在这条链路足够可信之前，围绕 `observe`、导出、badge、bot 继续加展示面都是次要的。它们以后可以放大一个判断，但不能替代受控的 doctor → eval 判断。

## doctor —— 前置健康检查，先于你信任任何数字

`doctor` 是对单个 artifact 的静态 + 单次 LLM 调用健康审计：可读性、元数据、依赖、samples 契约对齐（静态 rule），加上 LLM 打分的维度（触发边界、文档清晰度、指令精确度……）。它**不对比两个版本**——它告诉你这个 artifact 是否处于"值得测"的状态。

它同时是 **eval 的前置门禁**：`omk eval` 内部会跑静态 doctor rule，artifact 坏了就拒跑 —— 就像 CI 在跑测试前先跑 lint。doctor 绿了，意味着你接下来这次测量不会是 garbage-in；doctor 红了，就应该直接指到结构、依赖或可测性问题，先修再比比分。

→ How-to：[doctor 体检](../guides/run-doctor-checks)

## eval —— 测量核心

`eval` 是 omk 的心脏：一次**离线 A/B**，固定模型和用例，只变 artifact（及其 runtime context），问"新版本是否在噪声之外打赢了旧版本？"。它产出六维报告、统计机器（bootstrap CI、length-debias、饱和、评委间一致性），以及一行可拿来卡 CI 的 **verdict**（PROGRESS / REGRESS / CAUTIOUS / NOISE / UNDERPOWERED / SOLO）。

omk 的测量严谨性都在这里。[工作原理](./architecture)、[统计严谨性](./statistical-rigor)、[评分公式](../specs/scoring) 讲的都是怎么把这一个数字做到足以支持发布 / 不发布判断。

→ 概念：[工作原理](./architecture) · [评分公式](../specs/scoring)
→ How-to：[评测 agent](../guides/agent-eval) · [自动迭代 skill](../guides/auto-improve-skills)

## observe —— 它在生产里站得住吗？

`eval` 是固定用例集上的受控实验，`observe` 是另一端：它把**真实 Codex rollout、Claude Code / OpenClaw session 与 markdown 对话日志**统一转换为 source-neutral Trace IR，再生成 skill 健康度报告——知识使用、[gap 信号](../specs/knowledge-gap-signal-spec)、执行稳定性、token 使用和耗时。它是**观测，不是评分**：它告诉你知识库在真实使用里在哪儿撞上了未知，好让下一轮用例去覆盖这些点。

所以 `observe` 是发布后输入，不是现在最该打磨的第一入口。如果团队还没有稳定真实 trace 流，最值得投的通常不是更丰富的 production graph，而是更扎实的 doctor / eval 发布判断闭环。

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

发布闭环在 doctor → eval 就已经有价值。生产闭环稍后合上：observe 暴露真实世界的缺口 → 它们变成新的 eval 用例 → eval 证明下一个修复 → doctor 保证每次迭代都成型。`omk evolve` 把 doctor → eval → 改写这个内层循环自动化；`omk sample` 帮你生成喂给它的用例。
