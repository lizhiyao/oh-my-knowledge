# 选定记录中的实体提取

本规范负责窗口提取、确定性宿主准入、来源／实体／知识绑定、当前存储及调用恢复。[端到端建设设计](../knowledge/knowledge-domain-model.md)连接提取、跨窗口组织、维护与载体评测；质量版本、被测范围及就绪状态由[评测协议](./entity-extraction-evaluation.md)维护。

组件／实例、集合／未知、改名／版本与晚到纠正规则见[实体身份规则](./entity-identity.md)。§6 规定当前契约；当前只支持现行数据结构，不保留旧生产 reader；显式新工作区迁移另有契约。人工确认的跨窗口组织已通过[实体关联日志](./entity-links.md)及[知识库](../knowledge/knowledge-library.md)提供，不替换窗口身份。自动跨 Agent 身份合并不在范围内。调研、结构校验或功能完成不证明模型效果或复用收益。

## 1. 用户结果与范围

主要结果是从选定来源窗口提炼完整自然语言知识，保存为待审正文。实体及可选 typed 关联是后继独立投影，不是前置条件或正文主数据。概念见[知识原理](../../explanation/knowledge.md)。

生成先保存接纳正文，再独立调用关联模型。关联缺失、失败或未决时，用户仍可读取、保留／舍弃、修订正文；实体核对／纠正、精确正文／目录投影的应用和审查独立完成。识别对象不要求编造知识，实体提取也不替代来源保真或任务验证。

窗口对象含义、提及、限定、指代层次和不确定性仍可核对；名称、路径、类型或相似度不证明同一对象。不引入自动跨窗归并、embedding 搜索或全局图库；跨窗知识库组织仍需既有明确人工确认。

## 2. 调研与选择

| 一手来源 | 相关实践 | OMK 的选择 |
|---|---|---|
| [End-to-end Neural Coreference Resolution](https://aclanthology.org/D17-1018/)（2017） | 文本跨度与上下文支持提及及先行项判断。 | 保留提及位置和对应依据，代词不按最近名称机械归一。 |
| [GLiNER](https://aclanthology.org/2024.naacl-long.300/)（2024） | 开放类型的命名实体识别。 | 不限定实体类别；识别与身份消歧分别验收。暂不引入额外 Python 模型依赖。 |
| [实体级联合关系提取](https://aclanthology.org/2021.eacl-main.319/)（2021） | 联合利用局部提及、共指与实体级关系。 | 保留窗口证据与独立身份；当前生产先保存正文，再单独生成关联，替换历史联合 typed 流程。 |
| [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) | TextUnit 保留来源关联；实体与关系共同提取；默认按名称和类型合并。 | 保留来源关联；按名称和类型合并不适合 OMK 的同名对象边界，不照搬该策略或全图索引。 |
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/#text-quote-selector) | 原文短语及前后文帮助区分重复片段。 | 用精确 quote 及相邻原文上下文唯一选中片段，宿主计算位置并拒绝歧义匹配。这是 OMK 的引用方式，不宣称完整协议兼容。 |
| [LLM 共指能力评测](https://aclanthology.org/2024.lrec-main.145/)（2024） | 用自动与人工分析考察不同提示词的优势和失败。 | 分开报告结构接纳与语义错误，采用输出前冻结的案例。 |
| [LEA 共指评测研究](https://aclanthology.org/P16-1060/)（2016） | 从实体链接考察共指评测口径。 | 单独检查应对应和必须分开的提及，避免只报实体数量或名称匹配。首版不声称实现完整 LEA 指标。 |

这些资料支持取舍，不证明 OMK 表现。旧 single／bounded typed 流程保留冻结测量身份，当前正文优先流程不能继承其质量、成本或因果结论；来源保真与真实任务收益需要独立受控证据。

## 3. 契约与身份

当前生产使用 `knowledge-body-first/v2`，替换旧联合 typed 响应。[生成契约](../../reference/shared/knowledge-contract.md)分别标识正文／关联 prompt、结构 wire 和当前存储。

当前正文输出／wire v2 使用 prompt v7，关联输出／wire v3 使用 prompt v6。这是模型响应及生成 profile 的 **BREAKING-API/COMPARABILITY**，不改变第 6 节的存储契约，不重评分历史输出。其它独立版本化的提取／测量协议继续保留冻结的 occurrence 定位及身份。

正文 prompt 先确定具体案例的范围，再组织可独立阅读的段落，拆到另一 proposal 的案例同样适用。有据的升级背景版本与报告中问题涉及的未知版本分别表达；一般方法不继承无关案例限定。关联 prompt 先选对象提及再做映射，跨段复用合法提及，分别复查来源独立指认的工件／代码状态及必要的组件、版本映射。属性或问题陈述不是所属对象的提及，组件链接也不自动传播检索映射。这些是模型指令，不是确定性语义保证；原始质量仍须对照来源复核并实际检验限定检索。

- Canonical 正文草稿：`{title,content:{segments:[{segmentId,text,evidence}],organization?},reuseRationale}`。每段完整保留必要条件、归因、否定、时间、例外、参与者立场和未知；标题、复用提示、引文和未来目录不能补正文遗漏。
- Inline evidence：`{source:{snapshotId,sourceVersion},selection:{evidenceRef,start,end,quote},basis,interpretation?}`，依据区分来源说法、直接观测和推断；匹配不证明真值。
- 模型定位使用 `{evidenceRef,quote,contextBefore,contextAfter}`，quote 与可空 context 均为同一片段内相邻的逐字原文。宿主要求连续 `contextBefore + quote + contextAfter` 唯一匹配，再计算 quote 的 UTF-16 位置，不规范化或模糊匹配；不匹配或有歧义即拒绝。模型不提供 occurrence 或偏移；结构／领域／引用检查前保全原生原件。
- 每个正文 proposal 用 `requiredContexts:[{literal,evidence}]` 声明所有段落共享且有来源的必要语境。literal 必须逐字出现于其 evidence quote 及每段 text；宿主将相应证据追加到每段，按完整 evidence 值去重，不补写正文。允许空声明；已声明语境不证明必要语境或可复用内容已找全。编译后接纳草稿的 UTF-8 JSON 合计最多 16 MiB；超过容量或合并证据限制时整条 proposal 拒收，不截断。
- 派生关联绑定 `{knowledgeId,revisionId,bodyDigest}`、完整 `catalogRefs:[{analysisId,entityRevisionId}]`、带目录限定的 `segmentEntityRefs`、可选 `typedRelations` 与 issues。形成 typed 投影时仍保留角色／modality／polarity，不强迫全部正文变成 triples；失败或重建不修订正文。
- 窗口实体保留有来源的 `description`、`qualifiers`、`referentKind`、`identityStatus`、uncertainties 及闭合的组件／集合／候选引用。每个接纳实体需有效提及；标识符碎片、引用缺失和提及归属错误拒绝接纳。确定性检查不证明语义身份。
- 关联输出将 `mentions` 放在各实体内，`mentionKey` 只在所属实体内唯一；宿主分配持久 ID，按目录／实体／key 编译引用，不同实体的相同 key 互不混用。组件／集合关联只能引用声明实体自身的提及，仍须通过原有指代层级与引用闭合检查。每个正文段恰有一项 `segmentDecisions`：`mapped` 的实体引用非空，`abstained` 无实体引用，两者均须给理由。这些 AI 决定是诊断，不是内容或覆盖复核；弃权不证明不存在相关对象。
- 新正文和派生修订均待审；正文保留／舍弃与派生接受／拒绝是独立决定，新修订不继承任一决定。

### 3.1 关键来源与普通重复提及

每个完整正文段直接引用支持重要条件、纠正、例外和未知的来源位置；归属依赖较早原文上下文时，将该锚点与主张证据一起保留。metadata 限定仍明确为 metadata，不伪造成原文 quote，也不将来源时间当事实时间。可读全文、目录描述或 rationale 不是该主张的直接依据。正文还必须表达内容本身，不能只存引文。

对于会变化的实现、生产默认、版本或完成状态，生成 prompt 要求每个受影响段落保留承载该说法的 `excerpt.timestamp` 所示报告日期及说话者归因。正文明确日期来自消息 metadata，并保留其 UTC／时区性质；它不是事实发生、生效或本轮核验时间。evidence 仍逐字引用实际说法，在 `interpretation` 中标明日期来自同一 excerpt 的 `timestamp` 及其原值，不将 metadata 日期伪造成 quote 或放进要求原文字面的 `requiredContexts`。没有 timestamp 时明确报告日期未知；不依赖历史状态的稳定方法不必增加日期。这项 prompt 要求不等于宿主已确定性校验日期归属的语义。

对象提及是独立的身份导航义务。可选范围是该段已绑定的完整精确来源窗口，不仅限其引用的 excerpt 或 quote；同一 sourceKey 的其它片段中已有且支持该段指代的提及也可用于导航。这不补救主张证据缺失，也不允许借用其它 sourceKey 或仅靠标题确认身份。普通重复名称不必全部变成 mention，必要的身份出现位置仍需可核对。可选 typed 派生证据只能复用其引用正文段已有来源范围。精确位置匹配与来源保真判断分别检查。

## 4. 纠正与知识修订

实体纠正按精确 generation／head 和幂等 request 身份追加不可变分析修订，不改正文。已有 mention 身份不能换到另一来源位置；有来源的新 `new:` 身份由宿主分配 UUID，组件／集合／候选引用需闭合。

正文修订接收完整新 `KnowledgeDraft` 及 inline evidence；宿主重新读取每个 snapshot／version，核对精确 UTF-16 引文后才追加。旧 `citationLocators`／`--citations` 和平行 grounding 已替换。新正文有新 digest、待审且不继承 retain，旧投影变为 stale。

`apply-associations` 固定正文修订／digest、目录修订及关联 generation，创建新待审投影；`review-associations` 只为该投影记录接受／拒绝。`rebuild-associations` 用新日志及关联调用，不再调用正文模型、不产生正文修订。正文生成仍从一个选定窗口开始；关联重建读取正文的全部精确来源，以宿主 `sourceKey` 分隔目录和局部实体／提及 ID。端点均绑定目录、目录修订和实体，跨目录关系不确认同一身份。来源不可用或写头过期时明确拒绝；纠正身份时仍在正文保留条件／否定／未知，目录编辑不静默转移主张。

## 5. 领域与运行边界

知识契约／历史仍是纯核心，extraction 拥有阶段 wire 和结构接纳，application 编排用例，文件系统／执行器 adapter 承担副作用。CLI 与 Studio 共用正文优先流程；跨窗口 entity-link 执行保持独立。

每阶段派发前记录精确来源、prompt／profile／wire、system／input、producer 证明和请求摘要，并先检查执行能力与可归档容量。正文和关联各有原生身份及完整执行器 JSON（或有界异常观测），先归档后解码／接纳。Refusal、失败部分输出、未知字段、工具／失败诊断、用量／cache 值及 reported flags 均保留；宿主发布不冒充 single run5 原生响应。

正文先保存待审，再准备关联。不支持的 wire、引文或目录引用失败保留原证据；关联失败尽可能发布独立 failed 投影，不删除正文。各阶段默认 300 秒，无自动重试／重问／回退；阶段身份不证明 provider 请求次数、费用预算或质量。

只发送选定 excerpts、limitations 和明确来源归因，不将宿主 sourcePath／cwd 当语义 metadata。来源里的指令是数据，无权扩展读取或调用工具；模型工具／refusal／failure 结果不接纳为正常文本生成，用量或金额未报告时保持未知。

## 6. 当前存储契约

当前物理路径与身份由[显式工作区契约](../shared/storage-layout-spec.md#explicit-knowledge-workspace)定义：正文历史 Schema 3、独立关联历史 Schema 2、实体历史 Schema 2、独立复核 Schema 1、生成日志 Schema 2。正文修订包含 `bodyDigest`；inline evidence 是来源绑定，不再依赖旧平行 grounding／extractionRunId reader。

`generation-journals/<run-id>.json` 保存阶段及固定发布意图，`generation-journals/outcomes/<run-id>/<invocation-id>.json` 保存分别绑定请求和完整字节摘要的原件。生成 profile 匹配时，`resume` 挂接仍持有／孤立原件，零模型重放精确命令／收据。部分发布保留固定 ID 与已确认前缀。已 claim 无原件时保持未知，禁止自动重发；从未 claim 的关联只能明确继续，完全相同的 completed 身份重放零调用。

含旧生成 profile 的 active 日志明确 `unsupported`：当前构建不解码其归档输出、不挂接孤立输出，也不在混合身份下派发后续阶段；恢复须使用保全的匹配旧构建。已记录的 `prepared_writes` 仍可重放固定发布意图，不解码模型输出、不调用模型；若仍有旧 profile 工作未完成，随后回到 `unsupported`。completed／failed 终态日志及原始字节仍可检视，不将历史记录改写为新 profile。

实体历史继续保持每文件 1024 修订／16 MiB 限制及幂等收据重放，不截断旧修订。目录扫描仍限制 4096 文件／64 MiB，单列不可读分析。结构校验、精确位置和成功重开不证明语义质量。

当前 reader 拒绝旧 typed 知识 v2，新日志恢复拒绝 run5，旧清单明确 unsupported。[迁移](../knowledge/knowledge-domain-model.md#body-migration)要求独立新工作区与原件保全，创建不继承 retain 的新待审正文，不改指向 library／carrier。保全旧来源／工作区／binary 可回退，不保双 canonical reader。

独立 `study` 核对／可携带归档重放、`seal-run`／`sealed-runs` 档案处置保持历史身份，不恢复旧默认生成，也不授予语义通过；当前构建零调用拒绝旧 typed 生成计划。显式封存先保存 raw inventory 再写其独立处置标记，不是迁移或当前日志 resume。

写入共用 `.knowledge-write.lock`，只恢复证实本机退出的 owner。派生关联或来源不可用时正文仍可读，给出明确诊断，不显示健康空结果。

历史记载的完整 strict v16 system 原始 UTF-8 摘要为 `sha256:a8c353c0f9c05d1249c3414eaaba7bc7d85b0d34f98142413ba6550173bde6e7`。这是历史摘要声明：当前树没有对应的完整 v16 prompt 资产，`test/measurement-governance/prompt-registry.ts` 及其冻结测试也没有 v16 条目，因此不能为该值提供可复算的字节级锚点；仅有版本号或摘要不能还原原始 system 字节。该历史 prompt 变更属于 **BREAKING-COMPARABILITY**，不改变 wire／领域 Schema、run 存储或 pipeline 政策。历史无 few-shot strict v15 保留冻结摘要 `sha256:d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d`；原 prompt-json v14 保持 `sha256:e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399`。旧冻结资产、实验臂、许可和结果继续绑定原身份，v16 不能复用旧 runId 或执行许可；存量数据不迁移、不重评分，不同身份不能合并统计或继承质量／Gold 结论。实际质量及执行证据由评测协议维护。

## 7. 质量与完成证据

功能验证覆盖独立实体结果、核对纠正、知识共同身份与精确修订绑定、空结果及部分失败／中断恢复，以及不支持格式的拒绝。[评测协议](./entity-extraction-evaluation.md)单独维护冻结质量标准、checker／corpus／guide 身份、模型对比、复核闸门与当前证据。定位及引用闭合证明结构，不证明语义准确性、真值或复用收益；动线测试不能替代该协议。
