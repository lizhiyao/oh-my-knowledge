# Evaluation Core Studio 投影

> 状态：[#535](https://github.com/lizhiyao/oh-my-knowledge/issues/535) 的只读 catalog 与 view model 边界。本阶段不切换 Studio route／renderer，也不读取旧报告。

## 一、权威边界

Studio 只是 Evaluation Core 事实的 consumer，不是第二套报告模型。`CoreRunArtifactStore` 继续负责 schema、digest、content closure 与 lineage 校验。`createCoreStudioCatalog()` 只接收该 store port，不引入文件系统、server 或 renderer 依赖。

catalog 提供三种操作：

- `list()` 只投影已校验的 manifest index card，不加载完整 artifacts；
- `inspect(runId)` 执行同语义的点查询，不声称 content 可用；
- `get(runId)` 必须先加载并校验完整 artifact set，再构建 detail view。

project／global 行为复用 `createOverlayCoreRunArtifactStore()`。同一 `runId` 的相同 artifact set 去重，不同 artifact set 使用现有稳定 overlay conflict code 显式失败。Studio 不另造更宽松的冲突策略。

## 二、版本化视图

`omk.studio-core-run-card/v1` 只包含 manifest 事实：run／report identity、artifact-set digest、创建时间、正交的 run／evidence／conclusion status、replayability 与最高 captured classification。

`omk.studio-core-run-detail/v1` 进一步投影：

- Dataset identity 与 sample count，不包含 Sample input；
- Target、Evaluator、measurement 与 Metric definition，不包含 config；
- stage Bundle identity、直接 parent lineage、显式状态、coverage、replayability、budget aggregate 与脱敏 provenance；
- Execution／Evaluation coordinate identity、状态、duration、安全 usage、cache status 与 error／reason code；
- 只投影数值 Metric observation；boolean、categorical、text 与 ranking value 继续隐藏；
- Analysis identity、output schema version／digest、coverage、exclusion count、assumption status，以及有限 scalar 数值；
- 已注册 Decision 的状态、verdict、reason code 与精确 Analysis result reference；
- manifest 中五份文档的 identity 与完整 document digest，不包含 filename 或 path。

两种 projection 都是 canonical、JSON-safe 且深冻结的值。未定义数值不折算为零，而是直接省略。

## 三、隐私与 construct validity

detail view 明确省略原始 input、execution context、expected、evaluation context、output、trace、evaluator evidence／metadata、Gold、任意 Analysis table、Runtime capability／facet、provenance facet／source identifier、usage details、extension 与 error message。

这是语义 allow-list。后续 renderer 无法把未捕获 evidence 当作空值，也无法泄漏受保护内容，因为这些字段不会跨过 projection 边界。新增 result type 必须建立显式的 schema-specific projection，禁止遍历任意对象直接展示。

视图状态不从分数阈值推导。run status、evidence status 与 conclusion status 保持正交；stage failure、cancel、budget exhaustion、missing observation、inconclusive Analysis 与 not-decided Decision 都保留 Core 原始状态和 reason code。

## 四、迁移边界

Core Studio 模块不导入旧 `ReportStore`、`EvaluationReport`、`VariantResult` 或结果行。本切片不修改现有 server、skill index、route 与 renderer；后续 PR 会把 consumer 单向切到版本化 view，不引入 legacy reader、adapter、shadow read 或双视图。

最终 `omk eval` 与报告 wire 切换仍是 [#450](https://github.com/lizhiyao/oh-my-knowledge/issues/450) 下独立的 `BREAKING-SCHEMA` 步骤。本 projection 不改变 evaluator、analysis formula、prompt、missing-data policy 或 verdict 语义，因此不属于 `BREAKING-COMPARABILITY`。
