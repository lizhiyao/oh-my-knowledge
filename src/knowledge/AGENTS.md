# Knowledge 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/knowledge/`。本域是知识建设与维护的伞形域：根目录 TypeScript 模块、`entities/` 和 `entity-library/` 构成纯核心；`extraction/` 负责选定窗口、模型协议和输出接纳，`entity-linking/` 负责跨窗关联执行，`application/` 负责共用用例与本地装配，`adapters/` 实现模型传输、来源读取与持久化，`artifacts/` 拥有知识载体生命周期。纯核心约束不扩展到这些执行子域；载体规则由最近的 `artifacts/AGENTS.md` 补充。

## 领域不变量

- 纯核心零宿主副作用：根目录 TypeScript 模块、`entities/` 和 `entity-library/` 不读文件系统、网络、环境变量、时钟或进程状态，只依赖核心自身与 `zod`，不得反向依赖伞内执行子域。需要外部能力时只声明窄端口（如 `KnowledgeStore`、`EntityAnalysisStore`），由适配器实现。`test/architecture/import-boundaries.test.ts` 冻结这条边界。
- 执行子域保留职责边界：应用流程消费提炼、关联和适配器，关联还消费知识库应用行为与执行适配器；适配器与提炼、关联之间的既有关系继续显式登记。运行时与仅类型依赖分别审计，不将伞形目录视为所有子域只能向核心单向依赖，也不通过新增聚合入口绕过依赖守卫。领域实现不得反向依赖 CLI 或 Studio。
- 修订不可变：知识条目、实体分析、组织库一律以 append-only 修订演进，写入携带 `expectedGeneration`／`expectedHeadRevisionId` 乐观并发与幂等 `requestId`；任何路径不得改写或丢弃历史修订。
- 身份红线：名称、路径、类型或字符串／向量相似度都不证明同一对象；跨窗口实体关联只经显式人工确认（`entities/links.ts` 的人审事件流），不做自动合并、不按时间先后裁决矛盾。
- 不确定性用显式字段表达（`identityStatus`、`uncertainties`、`context.unknowns`），观测信号不冒充已核实事实。
- 持久化身份稳定：`storeKind`、schema 版本、摘要算法不得静默改变；必要变更按 BREAKING-SCHEMA 显式版本化。源码目录调整不改变用户工作区路径、prompt 字节或公开 Schema 身份；运行时源码指纹如实反映当前字节。
- 提及定位只认宿主计算的 UTF-16 位置（quote + occurrence），不接受模型提供的偏移或模糊匹配。

## Code Review Rules

- 必须拦截纯核心引入宿主能力或对执行子域、observability、CLI、Studio、eval-workflows 的反向依赖。安全路径：能力声明为窄端口，副作用落在执行子域及适配器；伞形域不构成放宽核心边界的理由。
- 必须拦截绕过修订不变量的写路径（直写、缺并发检查、丢 receipt）。安全路径：写入统一经对应 `history.ts` 的应用函数，不变量在写路径上强制校验。
- 必须拦截身份红线的松动（按名称合并、按相似度归并、把未确认关联当作同一对象）。安全路径：关联一律走显式复核流，机器建议只作为候选输入。
- 新建判别字段使用 `eventKind` 等限定名；裸 `kind` 保留给 `Artifact.kind`（见 docs/specs/shared/terminology-spec.md §5.4）。
