# Evaluation Core 产物持久化

> 状态：[#531](https://github.com/lizhiyao/oh-my-knowledge/issues/531) 第一个切片的宿主持久化契约。本阶段不切换 `omk eval`、不读取旧报告，也不会把传输来的 JSON 伪装成可信 Core capability。

## 一、边界

Evaluation Core 继续保持纯内存。宿主为每个 run 持久化一组不可变产物：

1. 版本化 `RunPlan` wire document；
2. `ExecutionBundle`；
3. `EvaluationBundle`；
4. `AnalysisBundle`；
5. `EvaluationReport`。

必须保存 Plan，因为 Bundle digest 只能标识已封存的测量契约，不能重建契约本身。若只保存结果，resume 将被迫信任摘要或依赖环境重新编译。宿主 manifest 只是定位和完整性投影，不是第六类测量事实。

## 二、权威性与校验

发布和完整读取时，store 校验：

- 每份 wire schema 与原生产物 digest；
- 根据 Plan 重新计算的 Dataset、stage、randomization 与 run-contract digest；
- Execution → Evaluation → Analysis → Report 父 digest 链；
- Report 的 Bundle 引用、状态、预算摘要、Decision 绑定与 provenance parent；
- manifest 的文档 digest 与最高 captured-content classification；
- 通过注入 resolver 解析并校验每个 content descriptor。

这些校验证明传输完整性与精确 lineage，不证明 provenance 真实性。持久化 `RunPlan` 读取后仍是 wire document，绝不重新授予 `SealedRunPlan` brand。resume 必须用当前 Definition 与 MeasurementPolicy 重新 prepare，获得新的 sealed Plan capability，再调用 Core 的 plan-aware Bundle verifier 决定是否复用。digest 相等不能凭空生成 source trust、cache receipt 或 Runtime attestation。

## 三、原子发布

每个 run 使用由 `runId` 的 SHA-256 派生出的 opaque 目录，用户 ID 不直接成为路径片段。宿主先把五份文档和 manifest 写入私有 staging 目录，manifest 最后写入，再通过同文件系统的一次 rename 发布整个目录。读取方只枚举已发布的 `run-<digest>` 目录；进程中断留下的隐藏 staging 目录不可见，可独立清理。

`runId` 不可变。完全相同的文档集合重复发布是幂等操作；同一 ID 对应不同集合时失败。进程内写入按 run 串行化，目录发布同时把跨进程竞态收敛为一个完整 winner。已发布 run 损坏时显式失败，不从列表里静默消失。

完整 Plan 可能包含 expected 或 evaluator-only 输入，因此目录只允许 owner 访问，文件只允许 owner 读写。路径属于宿主 effect，不进入 Core 文档或测量 digest。

## 四、Manifest 与索引

`omk.core-run-artifact-manifest/v1` 使用限定判别字段 `manifestKind` 与 `documentKind`。五个文档引用具有固定相对文件名、schema identity、原生 identity digest 和完整文档 canonical digest；manifest 另行记录 run／report identity、run-contract digest、Report 三轴状态、Execution／Evaluation replayability、创建时间与 captured content 的最高分级。

索引卡片只是已校验 manifest 的纯 projection。列表重建卡片时可以不解析大 content，因为列表不声称 evidence 可用；完整读取 run 时必须闭合 descriptor，缺 resolver 或 content 损坏都会失败，不能投影为空证据。

## 五、宿主 ContentStore

Node content store 实现现有 Execution／Evaluation content port。写入前校验调用方提供的 value digest，并持久化私有的内容寻址 envelope。identity 同时绑定 value digest、media type 与 classification，因此相同 bytes 的 `public` 与 `gold` 内容不会 alias 或互相降级。descriptor 使用 opaque `omk-content:` URI，不泄漏文件系统路径。

解析时重新校验 envelope digest、descriptor、canonical value digest、media type、byte size 与 classification。失败只返回稳定且脱敏的错误码；原始文件路径和内容不会进入 Core error。

## 六、非目标

- 旧 `EvaluationReport` reader、迁移或双写；
- resume admission 或 cache 复用；
- batch、evolve、gold compare、artifact graph 或 Studio projection；
- 正式 CLI 切换与旧 pipeline 删除；
- artifact 签名或 provenance attestation。

这些 consumer 在 #531 的后续切片中建立于本传输边界之上。最终 CLI 切换仍是 #450 下独立的 `BREAKING-SCHEMA` 变更。
