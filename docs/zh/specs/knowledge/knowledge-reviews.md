# 内容复核、关联覆盖与任务反馈

本规范描述当前 main 的独立复核记录。它不修改知识正文、保留决定、关联接受、身份确认或历史测量，也不代表已发布 Beta.14 包含这些能力。操作步骤见[知识提炼与复用指南](../../guides/knowledge/extract-knowledge.md#review-feedback)。

## 精确对象与存储 {#review-identity}

`reviews/<identity-digest>.json` 使用 `knowledge-review-history` Schema 1。摘要为 `sha256(canonicalJson([namespace, knowledgeId]))` 的十六进制部分，与正文按工作区／知识身份组织；同一账本保留不同正文修订的事件。

每个事件固定 `bodyRef: {knowledgeId, revisionId, bodyDigest}`、正文引用的精确 `sources: [{snapshotId, sourceVersion}]`、实际 `actor`、时间、事件身份及显式替代集合。来源集合由宿主从指定正文推导并与提交值核对；不会跟随最新正文或按名称推断来源。事件中的证据仍使用原始 UTF-16 引文位置。

账本含 `generation`、`writeHeadEventId`、追加的 `events` 和 `receipts`。事件上限 4096，单文件上限 16 MiB；超过限制明确拒绝，不截断历史。现有正文3、关联2、实体2、生成日志2及原件不迁移、不回写，读取正文也不依赖此账本存在。

## 三类事件 {#review-events}

| eventKind | 内容与边界 |
| --- | --- |
| `content_review` | `needs_revision` 或 `reviewed_with_limits`，附理由、限制和 `findings`。问题包含类型、描述、相关 `segmentIds` 及可选精确证据；空段落集合可表示整块内容未生成。待修状态必须有问题，有限复核必须保留限制。 |
| `association_coverage` | 固定 `projectionRevisionId`，无适配投影时为 `null`；每个正文段恰一项决定和理由。`linked` 必须引用该投影实际存在的目录、实体与提及；`no_reliable_object` 是明确判断，`gap` 是已发现缺口，`unknown` 表示未决。空映射不会自动变成“没有可靠对象”。 |
| `task_use` | 固定实际消费的正文、段落、`taskRef` 和 `query`；`signal` 分别记录 `provided`、`read`、`reported_use`、`observed_help`、`controlled_effect`。可选 `issueKind` 区分 `content_missing`、`association_wrong`、`source_unavailable` 和 `other`。后两类效果报告需要非空任务／对照引用或有效精确证据，但不由系统认证因果效果。 |

内容问题可引用同一来源中尚未进入正文的片段，不能要求遗漏依据只能来自已有正文引文。任务反馈也可引用后续任务的注册来源；新增 inline evidence 必须通过精确来源及引文核验。仅报告来源不可用或实际消费旧版本时，不要求重新获得已删除的原文。

## 意见、覆盖与修订 {#review-selection}

无记录才是 `not_reviewed`；损坏、格式不支持、软链或不可读账本为 `unavailable`，generation／head 保持未知，不能当作零。来源可读性另行呈现，来源删除不抹去历史复核或正文。

同一正文可有多份意见。`supersedesEventIds` 只显式替代相同正文、同类事件；覆盖还需相同投影，使用记录还需相同任务和信号。未解除的 `needs_revision` 优先呈现，不按最后时间或操作者类型裁决真值。逐段覆盖保留所有活跃意见：缺口优先，未决或相互冲突的决定显示未知。

新正文不继承内容复核、保留或旧覆盖决定。新关联投影只使旧覆盖不再适配当前投影，同一正文的内容意见仍保留。历史版本反馈始终绑定实际消费版本，不静默指向最新修订。记录反馈不会自动改写正文、合并身份、接受关联或更新载体。

## 操作与可信宿主 {#review-operations}

共用应用操作为 `review-status`、`review-content`、`review-coverage`、`record-use`。状态使用独立投影，不往 `retrieve` Schema 2 的预算响应增加字段，也不改变排序。读取明确的 bodyRef，按需指定覆盖投影；写入另含稳定 `requestId`、预期来源集合、`expectedGeneration`、`expectedHeadEventId` 及具体决定。

纯核心定义 Schema、引用闭合、历史与选择规则；应用层在工作区锁内核对精确正文、投影和新证据；文件适配器执行原子持久化。完整操作者参与 command digest，事件 ID 使用稳定 requestId，宿主时钟不进入可重试命令身份。相同请求确认已保存原件后返回原收据；payload 或操作者改变产生幂等冲突。未知回执先查同一 requestId，不自动重发。

可信应用构造注入实际 `KnowledgeActor`；缺少 actor 的实例只读，浏览器与草稿中的 actor 字段被拒绝。Studio 使用本地 UI 宿主声明，隔离 Agent 自动化可由服务端明确注入实际 Agent，不从启动进程的 Codex 环境推断浏览器操作者。

三个新 CLI 写操作仅识别继承的 Codex Desktop 启动上下文：`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop` 与有效 `CODEX_THREAD_ID`。记录 `agent/codex:<thread-id>`、`executionRef=codex-thread:<thread-id>`；这是启动器的归属声明，不是身份认证。未知终端／其它宿主不能回落成真人，应使用 Studio 或显式注入实际 actor 的应用入口。旧命令及旧 actor 不重标。

## 验证范围 {#review-evidence}

结构接纳、保留、关联接受、内容复核、使用报告及独立人工验收分别记录。引文精确、复核保存成功或有限复核均不证明知识真实、覆盖完整或任务收益。新写入不调用生成模型或评委；宿主 Agent 阅读、核对和修订仍有自身成本。真实质量及长期价值由对应的来源与任务证据验证，不重跑旧冻结调用或改判旧失败。
