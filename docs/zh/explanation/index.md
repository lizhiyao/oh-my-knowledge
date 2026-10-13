# 原理与概念

`explanation/` 回答“是什么、为什么、如何理解”。它提供概念与理由，不单独规定接口、Schema 或验收。

## 阅读顺序

1. [OMK 如何理解知识](knowledge.md)：知识、实体、上下文与载体的概念基础。
2. [为谁、解决什么](who-omk-is-for.md)：目标用户、任务及产品边界。
3. [三阶段工作流](three-stage-workflow.md)：doctor、eval 与 observe 怎样协作。
4. [架构](architecture.md)：各领域的职责与依赖理由。
5. [统计严谨性](statistical-rigor.md)：如何理解证据、差异与结论限制。

## 文档职责

| 要回答的问题 | 入口 |
|---|---|
| 是什么、为何这样设计 | 本目录；概念只定义一次 |
| 实现必须满足什么行为、边界和验收 | [领域规范](../specs/index.md)；注明现行、部分交付或草案 |
| 用户怎样完成任务 | [使用指南](../README.md)与 guides/ |
| 某字段、flag 或 API 怎么查 | reference/，如[样本格式](../reference/eval-sample-format.md) |
| 某次试验或旧提案说明了什么 | 对应 specs 领域的 history/；原始证据不冒充当前能力 |

同一篇文档可以引用其他职责的权威来源，但不复制一份会独立漂移的契约。维护规则见[贡献指南](../guides/contributing.md)。
