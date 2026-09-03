# Evaluation Core 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/eval-core/`。Core 定义可版本化、可重放的评测契约与确定性状态变换，不承担宿主副作用。

## 领域不变量

- `contracts/artifacts.ts` 的 `EvaluationReportSchema` 字段语义是跨版本报告可比性的锚点，不得静默改变。
- Core 不读取文件系统、网络、环境变量或进程状态，也不依赖 CLI、Studio、具体执行器或 `eval-workflows`。需要外部能力时，只声明由宿主实现的窄接口。
- 公开 Schema identity、事件语义和状态转换必须显式版本化；内部文件路径不是公开 identity。

## Code Review Rules

- 必须拦截任何宿主副作用或向上层模块的反向依赖。安全路径：把 I/O、执行器解析和运行环境接线放到 `eval-workflows` 或对应 adapter，只向 Core 注入显式能力。
- 必须拦截未版本化的报告字段、Schema identity、事件或决策语义变化。安全路径：保持现有语义，或提供新版本并在 PR 说明迁移与可比性影响。
- 必须拦截依赖时钟、随机数、进程环境或隐式可变状态的结果。安全路径：把所有非确定性作为输入传入，并用不可变快照和状态机测试证明可重放。
