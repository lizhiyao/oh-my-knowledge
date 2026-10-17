# Knowledge 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/knowledge/`。本域是知识本体的纯契约层：知识条目、实体分析、实体跨窗组织库、标签的 Schema、校验与修订不变量。模型调用、持久化与宿主副作用由 `observability/knowledge-extraction` 及其适配器承担；本域不感知它们的存在。

## 领域不变量

- 纯契约、零宿主副作用：不读文件系统、网络、环境变量、时钟或进程状态。需要外部能力时只声明窄端口（如 `KnowledgeStore`、`EntityAnalysisStore`），由上层适配器实现。`test/architecture/import-boundaries.test.ts` 已冻结「只依赖自身与 zod」的边界，新增外部依赖会在那里判红。
- 修订不可变：知识条目、实体分析、组织库一律以 append-only 修订演进，写入携带 `expectedGeneration`／`expectedHeadRevisionId` 乐观并发与幂等 `requestId`；任何路径不得改写或丢弃历史修订。
- 身份红线：名称、路径、类型或字符串/向量相似度都不证明同一对象；跨窗口实体关联只经显式人工确认（`entities/links.ts` 的人审事件流），不做自动合并、不按时间先后裁决矛盾。
- 不确定性用显式字段表达（`identityStatus`、`uncertainties`、`context.unknowns`），观测信号不冒充已核实事实。
- 持久化身份稳定：`storeKind`、schema 版本、摘要算法不得静默改变；必要变更按 BREAKING-SCHEMA 显式版本化。
- 提及定位只认宿主计算的 UTF-16 位置（quote + occurrence），不接受模型提供的偏移或模糊匹配。

## Code Review Rules

- 必须拦截宿主能力或向上层（observability／cli／studio／eval-workflows）的反向依赖。安全路径：能力声明为窄端口注入，副作用落在上层适配器。
- 必须拦截绕过修订不变量的写路径（直写、缺并发检查、丢 receipt）。安全路径：写入统一经 `history.ts` 的应用函数，不变量在写路径上强制校验。
- 必须拦截身份红线的松动（按名称合并、按相似度归并、把未确认关联当作同一对象）。安全路径：关联一律走显式复核流，机器建议只作为候选输入。
- 新建判别字段使用 `eventKind` 等限定名；裸 `kind` 保留给 `Artifact.kind`（见 docs/specs/shared/terminology-spec.md §5.4）。
