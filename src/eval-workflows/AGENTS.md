# Evaluation Workflows 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/eval-workflows/`。本层负责产品输入、评分与统计声明、结果投影、持久化及评测工作流；执行能力通过注入的 Evaluation Runtime 接口接入，具体宿主装配位于 `hosts/`，由 CLI／DSH 共用。`hosts` 是独立装配边界；其它子域不得反向导入它，不能因同属本目录而自由互相依赖。

## 领域不变量

- OMK 产品工作流的评分类 prompt 位于 `instruments/prompts/`；公共 Rubric Judge prompt 的单一来源位于 `eval-runtime/judges/rubric-prompt.ts`，本层仅复用。所有 prompt 均由 `test/measurement-governance/prompt-registry.ts` 与 `prompt-registry-freeze.test.ts` 登记、冻结。
- 五层评分管道的语义固定为 assertion／llm／judge／dimension／composite。Bootstrap CI 和 Krippendorff alpha 公式不得静默变化。
- `--no-debias-length` 只关闭 rubric 评委的长度去偏 prompt 变体；排版和语气中性化始终开启。
- 工作流可以编排副作用，但必须通过显式 adapter 接入，不能把宿主状态泄漏进 Core 契约。

## Code Review Rules

- 必须拦截评分类 prompt 的非预期字节漂移，以及只为让 CI 通过而更新冻结 hash。安全路径：保持冻结文本；确需改变评分构念时，同步版本、回归证据和 `BREAKING-COMPARABILITY` 说明。
- 必须拦截五层评分、统计公式、缺失证据处理或 verdict 聚合语义的静默变化。安全路径：显式版本化并用固定 fixture 证明新旧结果边界。
- 必须拦截「固定模型、只变知识载体」实验隔离被破坏，或失败证据被当作成功分数。安全路径：在输入编译和 adapter 边界校验实验变量，缺失关键证据时 fail closed。
