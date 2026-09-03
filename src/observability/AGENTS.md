# Observability 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/observability/`。本层把真实运行轨迹投影为 source-neutral evidence，不把观测信号冒充因果结论。

## 领域不变量

- `prompts/llm-enhanced-review.prompt.md` 的 observe LLM 增强复盘 prompt 属于测量学不变量，由 `test/measurement-governance/prompt-registry-freeze.test.ts` 冻结。
- trace、experience 和 inbox 必须保留来源、时间与关联身份；投影可以派生视图，但不能覆盖原始证据。

## Code Review Rules

- 必须拦截增强复盘 prompt 的非预期字节漂移。安全路径：保持冻结文本；确需改变 `runtimeAssessment` 可比性时，同步版本、冻结登记和 `BREAKING-COMPARABILITY` 说明。
- 必须拦截丢失 provenance、合并不同来源身份或把启发式信号表述为已证实事实。安全路径：保留 source-neutral 原始证据，以显式派生字段表达分析结果和不确定性。
- 必须拦截轮询、子进程、缓存或订阅在成功、失败和中断路径上的资源泄漏。安全路径：集中管理生命周期，并覆盖取消、终止与 cleanup 测试。
