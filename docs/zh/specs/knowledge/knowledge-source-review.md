# 来源复核记录

## 范围 {#scope}

来源复核将可复用含义的候选清单、对已存正文的独立比较、实际操作者的决定分别记录。两份历史均采用 Schema 1，不替换 `reviews/` 中的内容复核、段落／实体覆盖或任务使用反馈。

默认 `knowledge-body-first/v4` 按来源盘点、正文、来源覆盖、关联四阶段执行；journal 为 Schema 4，默认输入为 `knowledge-source-generation-input/v2`。每阶段独立准备、核对完整请求、确认摘要并 claim，完整原件先归档再解码；不会自动串行发送或批准。正文仍为 wire2／prompt9，关联沿用原字节的 prompt7／profile／wire3 及阶段 v1 envelope。该流程不证明原始生成质量或任务效果已通过。

## 身份与证据 {#identity}

宿主从显式选定的 Source3 快照生成完整 manifest，绑定精确 SourceSet、完整 portable 输入摘要、快照摘要及每个已发送单元。每份来源包含一个 metadata 单元，保存可发送的来源身份、归因、选区、限制及 excerpt 描述；每个 excerpt 正文另为一个单元。不会额外发送原始 envelope、捕获时间或宿主绑定。完整快照的 custody 摘要仍能检测已存快照字节变化。

单元类型、键、UTF-16 长度、文本摘要与字段路径显式保留。metadata 引文指向序列化的 portable metadata，不是原 excerpt 引文。模型只返回逐字 quote 及紧邻上下文，宿主唯一定位并计算位置；重复、缺失、替换单元或歧义 quote 均拒收。请求容量显式校验，不静默截断。

## 分析记录 {#analyses}

### 来源清单 {#ledger}

`source-ledgers/<identity-digest>.json` 保存 `knowledge-source-ledger-history` Schema 1。不可变分析修订包括 manifest、完整单元处置、候选含义／要点、来源锚点、限制及模型原件引用。每个发送单元都有 retain、exclude 或 pending 意见和理由，单元与候选引用必须闭合。这些是模型意见，不是 Gold，也不授权删除原材料。 当前模型输出为清单 wire2／prompt3：模型提供单元处置和理由，宿主从严格定位的全部 item／facet 证据按 item 顺序去重派生每个单元的 itemIds，不要求模型重复填写反向索引。领域／历史 Schema 1 及全部闭合检查保持，旧 wire1 原件不按新口径解释。覆盖使用 wire2／prompt3。宿主从本次精确输入枚举完整单元／item／facet／正文段落目标目录，模型检查只返回 targetKey，宿主恢复完整目标身份。未知键和覆盖不全仍拒收，同一目标仍可分别检查不同覆盖对象。阶段请求绑定派生目录，来源 manifest 与两份存储领域 Schema 保持。

### 来源覆盖 {#coverage}

`source-coverage/<identity-digest>.json` 保存 `knowledge-source-coverage-history` Schema 1。分析绑定精确清单修订／摘要与正文引用，逐项覆盖来源单元、候选、要点和正文段落，并保留对清单错误、遗漏或正文无据主张的独立发现。

覆盖对象区分知识含义、已保留的来源声明未知、已保留的输入范围限制，以及事实值。正文写清“数值未知”不等于数值已知。输入范围限制绑定已发送输入摘要、完整单元清单与实际核对字段，语义是否充分仍需复核。零正文也能保存查漏结果，不造占位知识、不自动批准。

## 实际决定 {#decisions}

明确决定绑定精确覆盖修订／摘要、SourceSet、清单引用和正文引用，记录可信宿主注入的实际 human 或 Agent、限制、理由，以及每个未解决项、排除／待定意见和发现的处置。决定为 `proceed_with_limits`、`needs_revision` 或 `stop`，模型分析不自动创建该事件。

明确替换意见与撤销均保留旧事件；不同活跃意见为 disputed，不按时间或模型共识裁定真值。关联请求须固定一个活跃、无冲突的允许继续决定，新正文或分析不继承旧决定。

完整 `record_decision` 的 decision 含 coverageRef、sourceSetId、ledgerRef、bodyRefs、decisionKind、reason、limitations、dispositions 和 supersedesEventIds。每项 disposition 为 accepted_limit／resolved／blocks；未决 ID 按实际清单派生：排除／待定单元为 `unit:<unitKey>`，排除／待定 item 为 `item:<itemId>`，非 covered 检查为 `check:<checkId>`，每个 finding 为 `finding:<findingId>`。必须逐项覆盖，不以字符串拼出“已通过”。`sourceCoverageDecisionRef` 只含 coverageRef、sourceSetId、ledgerRef、bodyRefs 及已提交 receipt 的 eventId，不夹带 decisionKind、reason 或 actor。

## 发布与原件闭合 {#custody}

写入采用追加历史、共享工作区锁、CAS 及绑定实际 actor 的幂等收据。不可信客户端载荷不能自报实际 actor；缺少可信 actor 时可读、不可写。

应用层在发布锁内重验原生输出、精确模型准备输入、完整来源、正文与清单引用。可信原件读取端必须先验证 archive／request custody，再返回原始输出；quote 匹配或提供摘要本身不够。改写后的模型数据不能冒充原分析保存，读取视图将原件核验状态与决定意见分开。完全相同的已提交命令可读回原收据，派发资格仍须重新核对。

原件证据不可用时仍可撤销既有意见。关联 claim 必须在同一共享工作区锁内重验所选决定及上游身份，不能只依赖准备阶段的检查。

## 集成边界 {#integration}

`prepare-generation` 从完整来源准备来源清单；后续阶段分别通过 `continue-stage` 核对并发送。关联准备还须在同一 run 的输入中提供精确 `sourceCoverageDecisionRef`；覆盖分析完成、全部 covered 或无 finding 都不代替该决定。正文为零条也继续盘点和查漏，不虚构占位正文。

`prepare-source-review` 接收完整原始 `sources`、精确 `bodyRefs` 和可选 `ledgerRef`。没有清单引用时先盘点再覆盖；匹配引用只做覆盖，不生成正文或自动关联。正文修订后须按新 bodyRefs 重新覆盖并记录决定。`prepare-rebuild-associations`／`rebuild-associations` 同样绑定精确决定，来源取自该覆盖记录的完整 SourceSet，不能缩成正文已有引文。

`source-ledger` 和 `source-coverage-status` 支持精确修订读取。`review-source-coverage` 接收完整 `record_decision` 或 `revoke_decision` command：共同携带 coverageId、稳定 requestId、expectedGeneration、expectedHeadEventId；记录决定还带完整 decision，撤销带 targetEventId 和理由，不在 payload 自报 actor。关联在准备时及共享锁内 claim 前重验决定和所有上游绑定。claim 后的撤销保留已发送请求及原件，投影仍 pending，并显示失效的复核语境。手工实体／关联维护不自动产生来源覆盖批准。

Source3、正文、实体、关联、reviews 和 tags 保持既有身份；`migrate-workflow` 只将支持的六类格式复制到独立目标，旧 journal3 和自动许可仅归档。当前构建不提供 workflow4 自动调度或重新授权入口；回退使用未改动旧目录及匹配构建。
