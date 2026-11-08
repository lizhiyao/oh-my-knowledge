# 来源复核记录

## 范围 {#scope}

来源复核将可复用含义的候选清单、对已存正文的独立比较、实际操作者的决定分别记录。两份历史均采用 Schema 1，不替换 `reviews/` 中的内容复核、段落／实体覆盖或任务使用反馈。

**BREAKING-SCHEMA/API/COMPARABILITY**　当前日志为 Schema 11。普通正文绑定同次精确草稿及完整 Source3。超出阈值的 Codex 来源在派发前准备所有原文窗口，全部成功后由宿主统一发布。来源复核及待审关联仍可独立执行。旧日志由匹配旧构建读取，`knowledge-workflow-to11` 只迁入独立副本，旧日志、分析、原件及自动许可原样归档。历史测量保留其原有身份。

覆盖 prompt6 还要求：同一完整来源单位或正文段落内重复的引文，必须扩为唯一连续原文或给出真实紧邻的消歧上下文。宿主继续拒收模糊位置；prompt5 的失败原件仍失败，不修补历史结果。

## 身份与证据 {#identity}

宿主从显式选定的 Source3 快照生成完整 manifest，绑定精确 SourceSet、完整 portable 输入摘要、快照摘要及每个已发送单元。每份来源包含一个 metadata 单元，保存可发送的来源身份、归因、选区、限制及 excerpt 描述；每个 excerpt 正文另为一个单元。不会额外发送原始 envelope、捕获时间或宿主绑定。完整快照的 custody 摘要仍能检测已存快照字节变化。

单元种类、key、UTF-16 长度、文本摘要及字段路径保持显式。清单 input1 将每个完整单元交付为有序 `{passageId,text}` 块，宿主策略及索引摘要绑定完整 SourceSet、单元和精确位置。模型只选择同单元 `{startPassageId,endPassageId}` 范围并回显 passageIndexDigest，宿主恢复逐字引文及 UTF-16 位置；空来源不补造片段。覆盖 input2 仍用逐字 quote 与紧邻 context，歧义匹配拒收。metadata 引文属于可携带元数据 JSON，不冒充 excerpt 原话。缺失、重复、替换单元和非法范围均拒绝，超容量不截断。

## 分析记录 {#analyses}

### 来源清单 {#ledger}

`source-ledgers/<identity-digest>.json` 保存 `knowledge-source-ledger-history` Schema 1。不可变修订保留 manifest、每个单元处置、候选含义／facet、精确来源锚点、限制及模型原件引用；它们是意见，不是 Gold 或删除来源的权限。清单 wire3／prompt4 返回片段范围，宿主按 item 顺序派生每个单元的 itemIds，全部闭合检查保持。过长范围仅沿既有片段边界拆成每条最多 32768 个 UTF-16 单位的相邻引文，顺序拼回恰等于原选区；展开后每组证据仍最多 256 条，编译清单 JSON 最多 16 MiB，超出即拒绝，不丢内容。Schema1 不变，旧 wire1／2 原件不兼容解码或重解释。

### 来源覆盖 {#coverage}

`source-coverage/<identity-digest>.json` 保存 `knowledge-source-coverage-history` Schema 1。分析绑定精确清单修订／摘要与正文引用，逐项覆盖来源单元、候选、要点和正文段落，并保留对清单错误、遗漏或正文无据主张的独立发现。

当前覆盖输出为 wire3／prompt6。宿主从本次精确输入枚举完整单元／item／facet／正文段落目标目录，模型检查只返回 targetKey，宿主恢复完整目标身份。未知键和目标覆盖不全仍拒收，同一目标仍可分别检查不同覆盖对象。阶段请求绑定派生目录，来源 manifest 保持不变。

覆盖对象区分知识含义、已保留的来源声明未知、已保留的输入范围限制，以及事实值。正文写清“数值未知”不等于数值已知；事实值为 `unknown` 的检查不能 covered。对于输入范围限制，模型返回的 `boundedInput` 须含 `inspectionKind: "complete_manifest_units"`、将 manifest 每个精确 unitKey 各列一次的 `inspectedUnitKeys`，以及仅限本次交付输入的 scope。未知、遗漏或重复单元键均拒收。模型不能声明完整检查时，`boundedInput` 为 null，该限制不能 covered。

宿主从已验证的完整 manifest 派生 `sourceInputDigest`、按 manifest 顺序排列的 `unitKeys` 及各单元精确 `fieldPaths` 的去重排序并集，按不变的持久化 Schema 1 保存为 `boundedInput.inspectedFields`。模型不填写字段路径，宿主不将说明文字清洗或猜测成有效路径。该声明记录模型自报的完整检查范围，不证明实际读过每个单元、不将本次输入缺失推广为全局不存在，也不证明事实真值。精确来源／正文 quote、完整目标检查与语义复核仍不可省略。零正文也能保存查漏结果，不造占位知识、不自动批准。

## 实际决定 {#decisions}

明确决定绑定精确覆盖修订／摘要、SourceSet、清单引用和正文引用，记录可信宿主注入的实际 human 或 Agent、限制、理由，以及每个未解决项、排除／待定意见和发现的处置。决定为 `proceed_with_limits`、`needs_revision` 或 `stop`，模型分析不自动创建该事件。

明确替换意见与撤销均保留旧事件；不同活跃意见为 disputed，不按时间或模型共识裁定真值。意见只针对绑定的精确正文和分析，不自动继承到新修订，也不是待审关联生成的准入凭据。

完整 `record_decision` 的 decision 含 coverageRef、sourceSetId、ledgerRef、bodyRefs、decisionKind、reason、limitations、dispositions 和 supersedesEventIds。每项 disposition 为 accepted_limit／resolved／blocks；未决 ID 按实际清单派生：排除／待定单元为 `unit:<unitKey>`，排除／待定 item 为 `item:<itemId>`，非 covered 检查为 `check:<checkId>`，每个 finding 为 `finding:<findingId>`。必须逐项覆盖，不以字符串拼出“已通过”。`sourceCoverageDecisionRef` 只含 coverageRef、sourceSetId、ledgerRef、bodyRefs 及已提交 receipt 的 eventId，不夹带 decisionKind、reason 或 actor。

## 发布与原件闭合 {#custody}

写入采用追加历史、共享工作区锁、CAS 及绑定实际 actor 的幂等收据。不可信客户端载荷不能自报实际 actor；缺少可信 actor 时可读、不可写。

应用层在发布锁内重验原生输出、精确模型准备输入、完整来源、正文与清单引用。可信原件读取端必须先验证 archive／request custody，再返回原始输出；quote 匹配或提供摘要本身不够。改写后的模型数据不能冒充原分析保存，读取视图将原件核验状态与决定意见分开。完全相同的已提交命令可读回原收据，派发资格仍须重新核对。

原件证据不可用时仍可撤销既有意见。关联 claim 独立在共享工作区锁内重验完整选定来源、正文和准备请求，不消费或伪造来源复核批准。

## 集成边界 {#integration}

`prepare-generation` 为普通流程准备写作稿，为 Codex 长来源准备全部原文窗口。用单个请求摘要或精确分窗批量摘要确认派发，发布正文后结束。`prepare-rebuild-associations`／`rebuild-associations` 独立接收 `{sources, bodyRefs}`，正文和关联都保持待审，不以来源清单、覆盖分析或实际决定作为强制前置。零正文不虚构占位或自动生成关联。

`prepare-source-review` 接收完整原始 `sources`、精确 `bodyRefs` 和可选 `ledgerRef`。没有清单引用时先盘点再覆盖；匹配引用只做覆盖，不生成正文或自动关联。需要复核新正文时按新 bodyRefs 分别准备分析和实际意见。关联输入中的 sources 明确定义本次完整选区，不由正文引文推断或自动缩减。

`source-ledger` 和 `source-coverage-status` 支持精确修订读取。`review-source-coverage` 接收完整 `record_decision` 或 `revoke_decision` command，携带 coverageId、稳定 requestId、expectedGeneration、expectedHeadEventId；记录决定还带完整 decision，撤销带 targetEventId 和理由，不自报 actor。模型分析、意见保存、关联生成和手工维护互不冒充批准。

Source3、正文、实体、关联、reviews 和 tags 保持既有身份；`migrate-workflow` 只将支持的六类格式复制到独立目标，journal10 及更早、来源清单／覆盖分析和自动许可仅归档。分窗批次须显式确认当前请求，旧工作区的自动许可保持归档。回退使用未改动旧目录及匹配构建。

### 覆盖 profile 边界 {#coverage-profile}

旧 wire2／prompt3 及 wire3／prompt4—5 覆盖记录仅保留被动读取语义，显示 `originalVerification=not_verified`，不继承当前来源复核的原件核验资格。当前覆盖原件核对仍使用 wire3／prompt6，不提供旧 wire 的兼容 decoder，不改写旧输出。需要旧流程执行或回退时使用保留的旧目录和匹配构建；关联生成独立绑定显式 sources 与 bodyRefs，不以旧覆盖或其决定作为准入凭据。

继续旧 profile 执行或回退时，保留原工作区及匹配的可安装构建。要使用当前覆盖，须明确创建完整、独立的工作区副本，以完整原来源、匹配清单和精确已存正文引用准备新的 wire3／prompt6 分析；不为替换覆盖而重跑已完成的匹配清单或正文。原件／请求 custody 仍须能重验，否则停止。原来源、正文、ID、失败结果、测量身份和分数均保留。新分析须有自己的实际决定，复制或被动可读不代替决定。该边界描述源码构建，不表示已经发版。

只替换覆盖时，复用的清单必须能通过当前 journal11 原件核验。journal10 及更早的清单／覆盖在迁入 workflow11 的副本中仅归档，不能继承当前执行资格；新流程须独立准备来源盘点，不改写或重发旧 run。
