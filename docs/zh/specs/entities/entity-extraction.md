# 选定记录中的实体提取

本规范负责窗口提取、确定性宿主准入、来源／实体／知识绑定、当前存储及调用恢复。[端到端建设设计](../knowledge/knowledge-domain-model.md)连接提取、跨窗口组织、维护与载体评测；质量版本、被测范围及就绪状态由[评测协议](./entity-extraction-evaluation.md)维护。

组件／实例、集合／未知、改名／版本与晚到纠正规则见[实体身份规则](./entity-identity.md)。§6 规定当前契约；当前只支持现行数据结构，不提供旧格式读取、恢复或迁移。人工确认的跨窗口组织已通过[实体关联日志](./entity-links.md)及[知识库](../knowledge/knowledge-library.md)提供，不替换窗口身份。自动跨 Agent 身份合并不在范围内。调研、结构校验或功能完成不证明模型效果或复用收益。

## 1. 用户结果与范围

用户从选定记录核对「谈到了哪些对象、哪些提及指向同一对象、哪些无法确定」，并让多条知识引用共同的实体分析。实体包括人、文件、系统、规则、概念和计划；主体与对象是陈述中的角色。概念定义见[OMK 如何理解知识](../../explanation/knowledge.md)。

当前范围是一份不可变来源窗口。名称相同、路径相同、类型相同或文字相似都不构成合并依据；不自动跨日志合并，不建立全局实体库或图推理。识别对象不证明关于它的陈述真实。

用户沿用「选择记录 → 提炼」入口。提炼结果与历史中可按需核对、纠正实体，零知识候选时也可查看实体。核对实体不成为每次提炼必须经过的独立步骤。

工作区实体目录是现有窗口分析的查询投影，不另建跨日志规范身份。Studio 和 CLI 可检索当前对象、提及、限定与来源，保留分析／实体／修订身份；历史可按明确修订读取。关联知识只统计当前知识修订，展示它实际绑定的实体版本与主体／对象角色。旧实体绑定、舍弃选择和来源不可用不隐藏，也不冒充已验证状态。

对象含义与语义类别的概念见知识原理；此处只规定当前窗口、身份和引用规则。

Studio 首先呈现对象含义、限定、歧义、原文提及和关联知识；身份层次与组件／集合关联在可展开详情中核对，纠正编辑时已有特殊层次或关联默认展开。

## 2. 调研与选择

| 一手来源 | 相关实践 | OMK 的选择 |
|---|---|---|
| [End-to-end Neural Coreference Resolution](https://aclanthology.org/D17-1018/)（2017） | 文本跨度与上下文支持提及及先行项判断。 | 保留提及位置和对应依据，代词不按最近名称机械归一。 |
| [GLiNER](https://aclanthology.org/2024.naacl-long.300/)（2024） | 开放类型的命名实体识别。 | 不限定实体类别；识别与身份消歧分别验收。暂不引入额外 Python 模型依赖。 |
| [实体级联合关系提取](https://aclanthology.org/2021.eacl-main.319/)（2021） | 联合利用局部提及、共指与实体级关系。 | 首选一次调用、独立结果；共享窗口实体目录，知识候选引用它。逻辑边界不强制两次调用。 |
| [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) | TextUnit 保留来源关联；实体与关系共同提取；默认按名称和类型合并。 | 保留来源关联；按名称和类型合并不适合 OMK 的同名对象边界，不照搬该策略或全图索引。 |
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/#text-quote-selector) | 原文短语及前后文帮助区分重复片段。 | 模型明确选择精确原文出现序号，宿主计算位置，不任选歧义片段的第一处。这是 OMK 的引用方式，不宣称完整协议兼容。 |
| [LLM 共指能力评测](https://aclanthology.org/2024.lrec-main.145/)（2024） | 用自动与人工分析考察不同提示词的优势和失败。 | 分开报告结构接纳与语义错误，采用输出前冻结的案例。 |
| [LEA 共指评测研究](https://aclanthology.org/P16-1060/)（2016） | 从实体链接考察共指评测口径。 | 单独检查应对应和必须分开的提及，避免只报实体数量或名称匹配。首版不声称实现完整 LEA 指标。 |

这些资料支持设计取舍，不能证明 OMK 日志上的提取效果。一次调用仍为默认；独立身份的 bounded 重试政策只允许明确授权的额外尝试，不宣称收益。比较其收益、成本及失败仍须固定模型、输入、政策和复核标准。

## 3. 契约与身份

实体分析独立于知识候选，保存实体、提及、身份歧义与来源限制。模型仅使用窗口内的临时身份；宿主为整个分析分配一次 UUID，多条知识复用它。

- 提及保存原文、引用、UTF-16 位置、显式／推断类别和对应理由。
- 实体描述帮助识别对象，限定信息用于说明项目、版本和环境。实质知识进入有上下文与证据的陈述。
- 未消解提及对应一个局部未知对象，保留可能对象与不确定性；不能任选候选对象充当已确定身份。
- 每个实体至少有一个接纳的提及；提及、可能对象与知识陈述的引用必须闭合。空实体和空知识结果均合法。
- 模型引用使用 `evidenceRef`、连续精确 `quote` 及可选的零起始 `occurrence`，重叠匹配也计数。多处匹配必须明确序号，缺失或越界拒绝；宿主计算 UTF-16 偏移，不模糊匹配、不归一化、不信任模型字符位置，拒绝旧 prefix／suffix 引用。
- 必填 `referentKind` 区分对象、组件、实例、版本、集合、计划和活动。`componentRef` 为 null，或实例／版本到已提出组件的有来源关联；`collection` 仅集合非 null，保存已知成员、完整性、提及依据及理由。引用限于本分析；未知成员与未消解身份分开，候选层次须相同，重复、悬空或循环成员拒绝。
- 关联依据须包含所属实体自己的提及；集合短语只产生一条提及，不复制跨度给成员。案例行动／结果只引用描述性陈述。结构接纳不验证身份判断或陈述真实性。
- 部分拒绝逐项记录原因。无效提及不能支撑实体，无效实体不能支撑陈述；不静默修补或删除歧义后接纳。

生成和逐项复核遵守[身份规则 §2.4](./entity-identity.md)：来源独立讨论 Issue／PR 概念时可以建实体，具体编号的 Issue／PR 则保留为工作记录证据或案例 context。不单独创建记录实体，也不通过去掉编号将记录改造成概念。此范围不排除其他有来源的具体对象或实例；结构接纳不能独自裁决这条语义边界。

生成与逐项复核还须保留引用语境：教学示例、假设和反例中引入的对象不自动等同于真实当前对象；名称相同不足以跨语境合并。来源明确仍指同一对象时，即使跨引述也保留同一身份，不能因引号或“示例”标签机械拆分；对应关系不明时保留歧义。实体 description、qualifiers、mention 归属及其理由须由同一对象语境支持，不能把示例版本、环境或结果转移到当前对象，也不补出来源未给的限定。宿主继续只做确定性结构与定位检查，不新增 NLP 语义过滤器。

来源独立审查、评价或修订整体对象时，保留指向该整体的身份与提及。局部指引、内容、示例或属性短语不会因为名称、description 或 qualifiers 含有所属对象的名称，就成为整体的别名。较长名称仍可指整体；中心所指仅是局部的短语则不能覆盖整体。只有来源支持独立对象时才分别建身份，不因所属或包含关系机械建立“整体＋局部”两份实体。

每个实体 description、qualifier 和 mention rationale 都各自承载来源断言，关系与行动者角色须独立于精确提及定位逐项核对。同轮审查或同一 PR 只支持该关联，不能自动补成来源未说明的包含、所属或构想提出关系。`basis: explicit` 记录原文有直接提及，不为其他字段背书，也不证明事实真伪。省略无据断言，或保留真正未决的关系，不补造它。

按完整短语和上下文解释：来源称谓、完整引文跨度或指向整体对象的表达，不自动声称完整组件名或规范名称。真正编造的标识／无据断言与真实措辞歧义分别判断。外部事实真伪未知，不会把已确认无据的来源断言降成输出 unknown；未决解释也不能充当通过证据。这是生成与语义复核要求，不做关键词分类或新增宿主过滤器。

### 3.1 关键来源与普通重复提及

对象身份与知识依据分别覆盖。提及选择对象名称或实际指代；已提炼知识的目的、条件、约束、例外、纠正和未验证限制，由对应陈述的证据关联及精确 `citations` 直接定位。分散的依据分别引用，保留理解判断所需的上下文；只有早期名称、同消息背景、整条消息可访问或 `rationale` 描述不足以证明关键依据可直接定位。

需要核对某一处身份时补对应提及；同一对象的普通重复出现可以省略，已有准确知识引文覆盖的重复名称无需再建提及。没有知识候选时仍保留识别对象与判断身份所需的提及。显式补提及可修复既有结果的定位，但不证明原始模型已自动覆盖，更不能用实体存在代替知识条件或来源覆盖。

这些是生成与逐项复核要求，程序继续只验证结构、引用和精确位置，不用关键词猜测关键依据或自动补写输出。定向诊断见[验收规范 §2.2](./entity-extraction-evaluation.md)。

## 4. 纠正与知识修订

实体分析拥有不可变修订、父修订、作者、时间及理由，修改采用 generation 与写入头检查，并保留幂等写入身份。用户可以改提及对应、拆分或合并局部对象、补充遗漏提及、删除误识别和保留歧义。已有提及身份不能被换到另一段原文；重新定位须另建提及。Studio 支持层次、组件关联、集合成员／完整性和依据的显式纠正；改变字段不会静默删除其他信息，不一致的草稿须先补齐。合并／删除及提及转移前，引用它的组件、成员、候选和依据须先明确纠正；界面列出依赖对象供核对，不自动删引用或推定成员完整性。合并前明确移除原对象自身的关联信息并核对目标；删除移除其自身信息，但不改写其他对象。原始修订与来源快照保留。

知识 grounding 绑定明确的实体分析及修订。生成后的纠正不覆盖旧知识。用户将新分析用于知识时，核对各陈述的主体／对象和证据，另建知识修订。一个旧对象被拆成多个对象时，应用流程不任取一个作为新主体。

普通知识修订与应用实体修订均可显式提供 `citationLocators`，以完整数组替换新知识修订的引文。每项包含 `evidenceLinkId` 和 `selection: { evidenceRef, quote, occurrence? }`；省略此输入时，沿用仍被草稿引用的旧引文。显式空数组无效。一个证据链接可对应多个精确片段，所有证据链接仍须有引文且来源一致；不得混入当前草稿之外的链接。仅允许原实体分析绑定的同一 snapshot／sourceVersion，应用层读取冻结原文，按 §2 的精确出现序号规则计算 UTF-16 位置，再校验完整 grounding 引用闭包；存储层的引用检查不能代替原文定位。结构、位置或引用无效返回有限错误码 `knowledge_citations_invalid`；来源不可用或并发冲突也不追加修订。

CLI 的 `revise`／`apply-entities` 使用 `--citations` 指向 locator JSON 文件，HTTP 的对应操作使用 `citationLocators` 字段，Studio 共用同一编辑与应用流程。修订输入的四字段草稿、grounding v2、原始生成 outcome 和历史 reader 保持原契约，无数据迁移。新引用只进入新知识修订，不改变原 run 出生统计，也不证明陈述语义正确；新修订仍需逐项复核与维护决定。

已有分析把具体 Issue／PR 记录提成实体时，先核对依赖引用，再通过新的实体分析修订显式纠正实体目录；不将记录改名成概念，也不复用其 UUID 改变含义。之后逐条修订受影响知识的陈述、主体／对象绑定及 citations，使用有来源的主体，并在 citations 或 context 中保留记录编号、链接、状态及主张者；新知识修订重新核对保留状态。没有有据改绑方案时，保留旧绑定及其限制，等待明确修订或舍弃决定。原分析、知识修订、来源和 outcome 保持不变；提取范围变化不自动迁移或重评分。

纠正仍是人或 Agent 的判断，不自动变成事实验证，也不继承旧知识修订的保留决定。来源删除或不可读取保持显式不可用，不能仅凭保存的引用声称重新核对过原文。

应用时默认保留原知识的附加身份不确定性，用户可明确核对和更新，原说明仍在旧修订中。当前实体分析中的不确定性强制带入，不能用空输入抹去未消解指代。陈述中的条件、例外和未知信息另在知识修订中核对，不根据改名或合并自动删除。

## 5. 领域与运行边界

`knowledge` 是知识建设与维护的伞形域。根目录 TypeScript 模块、`entities/` 和 `entity-library/` 保存纯契约、引用和修订不变量。`knowledge/extraction` 拥有选定窗口、模型协议和输出接纳；`knowledge/application` 拥有共用用例，`knowledge/adapters` 实现模型传输、来源读取及文件存储。Studio 与 CLI 复用同一应用流程。Observability 提供来源事实；Evaluation Core 不承担观测实体或文件系统副作用。

实体领域代码集中在 `src/knowledge/entities/`：`contracts.ts` 定义实体分析及存储端口，`identity.ts` 定义身份规则，`links.ts` 与 `link-invocation.ts` 定义跨窗复核与调用契约，`validation.ts` 校验分析中的引用和提及，`history.ts` 处理不可变修订及确定性写入规则。调用方按职责直接导入；该模块不调用模型、读写文件或依赖 Studio。`knowledge/extraction` 接纳模型输出，`knowledge/application` 编排实体／知识联合提炼，`knowledge/adapters` 实现实体文件存储。跨窗调用执行保留在 `knowledge/entity-linking`。这些执行子域保留既有的运行时和仅类型依赖关系，伞形目录不代表所有依赖只能指向内核。目录划分不增加模型调用或用户步骤。

每个 v5 run 默认使用 `knowledge-generation-single/v1`，只允许一次 OMK invocation；显式 `knowledge-generation-bounded/v1` 最多允许三次 invocation，包含最多两次校验重问，不使用 fallback。每次派发前持久化精确 system／input 摘要、来源绑定、prompt／wire／pipeline 身份与 producer 预约；bounded 政策另记录不退款的 token 预约及触发依据。API producer 证明另绑定实际完整 body 摘要与 endpoint；这不是完整请求字节归档，也不记录未观测的 Codex 全局上下文。结构解码、接纳和准备实体／知识写入意图前，将完整执行器返回 JSON 或有界异常观测归档到不可变 outcome sidecar。失败部分输出、独立 refusal 通道、usage／cache 字段与 reported 标志、内部 attemptCount 及停止／失败诊断均保留原始证据，不以展示错误代替；不据此声称已捕获原 HTTP 或 CLI 传输、确定 provider 请求数，或每个归一的零均由 provider 显式报告。作者提供的 model-port projection 保留其声明的较窄证据范围。

恢复只归档同一应用实例仍持有的 outcome、读取已持久化 sidecar，或完成已经分配身份的幂等写入意图，不重新调用模型。实体提交在知识提交前完成。进程丢失后，已开始但尚无归档字节的调用保持未知，不据此重发或退还预约；同 run 身份重放 generate 也仅恢复，不重启重试调度。

bounded 政策冻结 `maxInvocations`、`maxReasks`、`profileId`、`maxTotalTokens`、`maxOutputTokens`、retry／backoff、feedback 与 selection 规则，校验重问计入同一调用上限。仅已分类的限流／服务端／网络／超时失败，以及 parse／wire／envelope 或零接纳结果可触发下一次尝试；任一接纳 sibling 即选定部分结果。归档及提交失败不能触发新调用。每次按已验证输入／输出上界全额预约，实际报告较低或未知也不退款；规范化 input、cache-read、cache-creation 与 output 桶分别保留观测。不支持的预算依据在派发前拒绝。生产依据要求精确的官方 API endpoint 与模型快照，Codex 继续支持默认 single 政策。这引入独立政策／测量身份，不是新 prompt 或响应 Schema、模型质量证据，也不自动 fallback 到其他 provider。

提取只发送选定片段和覆盖限制；不发送原始路径，不按日志中的指令读取外部来源或调用工具。未报告成本表示未知，不能当作零。

## 6. 当前存储契约

`entities/<analysis-id>.json` 使用 `entity-analysis-history` v2，保存不可变实体修订、来源绑定及写入回执。`items/<identity-digest>.json` 使用 `knowledge-item-history` v2；本提取流程生成的知识 grounding 绑定明确的实体分析修订。

实体历史最多包含 1,024 个修订（含首次分析），单文件上限为 16 MiB。相同 `requestId` 与摘要的已提交回执先于历史／文件容量检查返回；历史已有 1,024 个修订时的新追加，或将超过文件上限的写入，均在发布前明确拒绝，CLI 与 Studio 使用已有的 `knowledge_capacity_exceeded` 诊断。文件超限可缩小本次内容后重试；历史已满不能通过缩小草稿解除，不会自动截断、删除或覆盖旧修订。未知读取／I/O 失败不因本改动成为已知未发布的容量拒绝。

实体历史 v2 的 `commandDigest` 仍为非空的不透明幂等标记；文件 adapter 对规范化的 actor 与 command 生成 SHA-256。本改动不收紧存量读取格式、不重算摘要、不升级实体历史版本，也不把摘要格式校验视为对任意历史篡改的密码学认证。目录读取的文件数／总量限制与上述单记录写入限制分别适用，不新增全局写入配额。

`extraction-runs/<run-id>.json` 使用 `knowledge-extraction-run` v5；不可变原生结果保存在 `extraction-runs/outcomes/<run-id>/<attempt-id>.json`。运行 metadata 绑定 sidecar 的身份／摘要、接纳事实与稳定的实体／知识写入意图。metadata 和 outcome 容量均须在发送前通过接纳。既有响应守卫按 JavaScript 字符串长度限制为 2 × 1024² 个 code unit；完整 outcome 先归档，再限制接纳，不截断原生证据。新 reader 校验现行格式及精确引用，不接受放入新目录的 v4 文件。

自动提炼的既有 permission 字段仍为 Schema v1；缺少 policy 明确代表既有单调用授权。新权限可记录选定政策与 `conversation-invocations/v1` ledger 身份；派发前不可变逐次回执绑定 permission／run／attempt／request 身份及完整 token 预约。可变次数／token 计数按回执核对恢复，不退款。会话 `maxCalls` 与 bounded token 总额跨窗口累计，每次重试／重问另占一次额度。新政策须重新取得用户同意，不扩大或改写旧 grant。

显式人工封存引入独立的 **BREAKING-SCHEMA** 边界：`knowledge-extraction-seal-intent` v1 与 `knowledge-extraction-seal-marker` v1 不升级或重新解释 run v5 及旧运行 Schema。先用 `omk observe knowledge sealed-runs --workspace /absolute/workspace --id <run-id> --json` 查询明确记录，取得 `expectedManifestDigest`、`expectedInventoryDigest` 及原始文件清单；`seal-run` 必须提供这两项 SHA-256 身份、稳定的 `--operation-id`、声明为人类的 `--operator` 及 `--reason`，必须显式指定工作区，不解析全局设置或构造 producer。`--storage-namespace legacy` 明确选择 `runs/`，不把它扫描为受支持的运行格式。opaque 旧 envelope 还必须提供 `--offline`，声明相关旧程序已停写／离线，但不认证进程退出。重入必须保持操作、actor、理由、命名空间及证据身份完全一致。参数错误退出 2，业务／未知 I/O 失败退出 1；封存获确认或查询成功退出 0，不代表语义通过。

现行格式候选的每个 attempt 都须使用旧 strict wire，全部已登记 attempt（包括最后一次）都须有精确归档，且不得有未登记 sidecar。拒绝 prepared／completed、entity intent、knowledge intent、committed 写入，以及已存在的 `entities/<run-id>.json`；缺失／损坏归档及未知 I/O 同样拒绝。native 输出不经现行 decoder／admission 重新接纳。对不支持的 Schema 1～4，只识别 envelope 并保留 opaque manifest 原字节及选定命名空间现有 `outcomes/<run-id>/<attempt-id>.json` 清单，不解释或认证其内部状态、reservation、退出、调用或费用。清单限制为 16 MiB manifest 及最多 64 份 sidecar，每份沿用 outcome 字节上限；不证明这些路径外的未知外部／旧文件或未来返回完整。

逐 run 事务保存在 `extraction-runs/seals/<current|legacy>/<run-id>/intent.json`，原字节副本为 `evidence/manifest.json` 与 `evidence/outcomes/<attempt-id>.json`。原 manifest 内的 reservation 字节一并保留，sidecar 不重新序列化。不可变 intent 先确立操作归属，再保存副本；全部副本及 intent 完成文件／目录耐久确认后，工作区写锁内重新核对原 manifest／清单精确身份，再原子替换原 manifest 路径为绑定 marker。原路径持续占位，原字节仍在证据中。没有 marker 的 pending intent 不算 sealed，并阻止普通执行／恢复；同一操作重入补齐或重新确认耐久性。失败保留已发布证据及原记录或 marker，不假装回滚未知发布。当前与旧 reader 都拒绝将 marker 当作可执行 manifest；不提供解封、迁移、兼容 reader、模型调用、实体／知识写入或自动新运行。该锁不能阻止未知旧进程使用内存中的 prepared 记录；offline 声明不能证明远端请求已停止，也不保证其迟到返回已归档。不支持文件／目录 fsync、排他发布或原子 rename 的文件系统明确失败；这些机制不是断电实验或多文件事务保证。

提取质量投影显式升为 `omk.extraction-quality/v4`：current 命名空间已封存记录仍进入 `runCount`，可读取的原 manifest 在原分组中计为 `sealedUnknown`，接纳分母保持未知；不支持的原格式另计无法分组的封存。legacy 封存数量在 current 分母外单列，pending intent 单列且不算 sealed。CLI／Studio 明示人工处置与执行状态未知，不表示成功、费用已知或语义通过。封存清单只读 manifest／intent／marker，并标明 `evidenceIntegrity: not_checked`，不宣称重新校验了 native 归档；显式同操作封存重入才重新核对全部保留证据字节及耐久确认。安装本功能不会封存用户历史数据或重算研究结论。

默认配置生成使用 strict `knowledge-extraction-v38`：strict 渲染包含八个经 AI 作者逐项审阅的合成完整输入／输出示例，以及单独标明的宿主部分接纳诊断。诊断复用发布门禁示例：原文 quote 不匹配的 sibling 被拒绝，合法 sibling 仍被接纳。故意错误的 sibling 是诊断材料，不是正确输出模板。这些答案已见的 demonstrations 不是评测 split，也不证明语义效果改善。v38 在同次提炼中明确要求保留会改变后续判断的原始问题与预期差、关键条件、未解决异议、试探性提议和否定支持边界；实体目录中的名字不能替代知识正文。同时要求保留不同环境、配置、代码位置和运行阶段／时点的对照条件、所报告表现及未解释反例，后续原因解释不能覆盖先前差异；具体结果只在未选内容或图片中时保留未知。提议、反驳与技术解释仍按来源说法归因，不升级为已实现、已发布或独立验证。无可复用内容时仍可返回空候选。此选择规则改变构成 BREAKING-COMPARABILITY，历史 v30／v31／v32 字节身份、运行及质量结论不改写，也不继承为 v38 的质量证明。现有仅限严格 v30 的 source-plan／coverage-review 私有研究入口继续要求原固定身份，不接收新的默认 profile。唯一 wire Schema、nullable 占位解码及其后的既有宿主接纳检查均保持不变，领域响应仍为 Schema v4。当前作者 model port 使用 prompt-json `knowledge-extraction-v29`；历史 prompt-json v14 与 strict v18 的原始字节保持不变。存储 v5、prompt 版本、wire 身份、实际请求和 pipeline 策略分别记录来源。不支持的能力在发送前拒绝，不静默 fallback 到 prompt-only。不同内容或配置不能复用同一 runId。

strict v38 还要求在整个选定窗口中核对字面提及锚点，包括标题、版本说明和配置段。规范化展示 label 不必等于原文 quote；不从连续版本写法、路径或长标识符内部裁出短 label，而应选择独立原文提及或完整限定表面，保留身份与归属未知。按原文大小写定位，并为选中的表面重新核对精确 occurrence。这是生成与自检要求：宿主仍拒绝无效锚点及其依赖，不自动改选另一处。构造回归仅证明接纳行为和正文不变，不证明模型遵从或语义身份正确。

质量验收使用[当前指南、语料与检查身份](./entity-extraction-evaluation.md)。提示词、标注或工具字节改变须使用新的测量身份；旧报告、原始输出与分数不重算。不同版本的复现只在对应冻结版本执行，不混用现行运行时。

v19／v20 在第 3 节调整提取范围，属于 **BREAKING-COMPARABILITY**：prompt 字节与标注指南／语料身份变化，wire／领域 Schema、存储格式和 pipeline 政策不变，不增加生成后的黑名单。五个示例文本与历史 v4 bundle 保持逐字节一致；v20 完整 strict system 的规则前缀已经变化，不等于该 bundle 冻结的 v18 candidate。当前请求须使用新的 run 身份和匹配执行许可；旧输出与维护决定不自动成为现行口径结果。

v21／v22 时间指引修正与第六个示范属于 **BREAKING-COMPARABILITY**。消息 `timestamp` 记录来源时间，不自动成为 `occurredDuring` 或 `validDuring`。无依据的状态与未来规范保留 unknown；原文明示的事件时刻保留其支持精度，包括恰好等于消息时间的时刻。前五个示例的序列化字节保持不变。新版避免将已发布 strict v20 的名称复用于另一份 prompt-json 字节。收录范围、公共 Schema、wire、存储和 pipeline 政策不变，宿主不增加时间相等黑名单或改写为 unknown。新指引只影响新请求：旧输出、修订、维护决定及分数不变、不重评，不与新版输出混合统计。结构／接线测试不证明模型服从或保证所有时间错误已修复；实际效果须另冻计划验证。

v23／v24 的引用语境指引与第七个完整 wire 示范属于 **BREAKING-COMPARABILITY**：新提示词与示范字节使用新的测量身份，前六个示例的序列化字节保留不变。动因是一个已见真实开发窗口的旧版输出把示例对象的版本限定移到了本轮对象；这是特定输出的错误线索，不是总体错误率。wire、公共 Schema、存储、收录范围、pipeline 政策与调用次数不变；不迁移或重评旧 run，不重算原分数。新的合成语境诊断独立于 64 例主语料；构造响应回归与提示词示范不证明真实 v24 输出已经修复或稳定提升。实际效果仍须冻结真实对照并逐项复核。

v25／v26 的核心对象指引与第八个完整 wire 示范属于 **BREAKING-COMPARABILITY**。来源独立评价或修订的内容对象，不能由包含它的文件、页面或位置替代；两者都被独立讨论时，分别保留有据身份。包含关系本身不要求把每个章节或示例拆成实体。前七个示范序列化字节不变。动因是一个已见真实开发窗口的重复运行漏掉学习正例：返回出处文件并在文件 description 提到正例，不等于覆盖正例身份。这是特定遗漏线索，不是错误率估计。既有指南／评分身份、64例语料、wire、公共 Schema、存储和 single 调用政策不变。独立合成诊断使用既有检查验证必需内容遗漏、无据拆分和明确别名；构造响应证明工程检查，不证明真实模型改善。旧计划和结果不改，新请求须有新身份及逐项真实验证。

v27／v28 进一步明确受审整体与局部内容的对应，属于 **BREAKING-COMPARABILITY**：规则与同一次调用内的输出自检字节变化，八个完整 wire 示范逐字节保留，不新增示范或调用阶段。v19 至 v26 的已登记原始摘要约束继续有效。指南 v11、检查器 v5、主语料 64 例／212 处关键提及、wire、公共 Schema、存储及 single 政策不变。动因仍是已见开发诊断的整体遗漏，不能据此宣称稳定改善；新字节须另冻测量身份、验证工程行为并逐项复核真实输出，旧运行和分数不重算。

v29／v30 的来源断言指引与同一次调用内的输出自检属于 **BREAKING-COMPARABILITY**：description、qualifiers 和 mention rationale 分别需要来源依据，不机械地把整体或完整跨度措辞当成规范名称断言。八个 wire 示范与 v19 至 v28 已登记的原始字节摘要约束保持不变。指南 v11、检查器 v5、主语料 64 例／212 处关键提及、公共 Schema、wire、存储及 single 政策不变，不增加调用阶段。已见开发问题是本轮动因，不证明真实模型已服从或稳定改善。新 prompt 与指南页面字节须重新冻结测量身份并逐项复核；历史输出、分数与冻结包不改写。

普通提取与现行 reader 保持原 `runs/` v4 文件不变，不解码、迁移、改写或删除。上述显式 opaque 封存是唯一例外：须声明旧 writer 离线，先完整保留原字节与清单，再以版本化 marker 替换原入口；不新增旧版语义 reader。旧运行详情、resume、对话／项目批次和现行质量统计仍不可用。同一工作区内现行 `sources/`、实体历史 v2 和知识历史 v2 及已有绑定仍可读取，不要求新建空工作区。实体历史 v1 仍不支持，与本次 run 升级分别说明。新提炼不会自动接管旧知识绑定。

历史记载的完整 strict v16 system 原始 UTF-8 摘要为 `sha256:a8c353c0f9c05d1249c3414eaaba7bc7d85b0d34f98142413ba6550173bde6e7`。这是历史摘要声明：当前树没有对应的完整 v16 prompt 资产，`test/measurement-governance/prompt-registry.ts` 及其冻结测试也没有 v16 条目，因此不能为该值提供可复算的字节级锚点；仅有版本号或摘要不能还原原始 system 字节。该历史 prompt 变更属于 **BREAKING-COMPARABILITY**，不改变 wire／领域 Schema、run 存储或 pipeline 政策。历史无 few-shot strict v15 保留冻结摘要 `sha256:d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d`；原 prompt-json v14 保持 `sha256:e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399`。旧冻结资产、实验臂、许可和结果继续绑定原身份，v16 不能复用旧 runId 或执行许可；存量数据不迁移、不重评分，不同身份不能合并统计或继承质量／Gold 结论。实际质量及执行证据由评测协议维护。

每次写入通过工作区的 `.knowledge-write.lock` 串行化。只有本机 PID 经 SIG0 返回 ESRCH 证明确已退出的锁可以恢复；不凭年龄或运行状态抢占。恢复者按原 owner 身份串行，避免删除后来接管的活跃锁；中断的恢复锁也遵守同一规则。

实体目录只读当前 `entities` 历史，不写第二份实体或持久索引。损坏、不支持格式或符号链接文件单独计为不可读分析；健康分析仍可检索，结果明确说明不完整。一次目录读取上限为 4,096 个 JSON 文件、64 MiB 文件总量，超限整体报错，不静默截断。查询默认每页 20 个对象、最多 100 个，按修订时间及稳定身份排序。关联知识读取失败时数量为未知，不能显示为零；来源不可用时不允许纠正。

## 7. 质量与完成证据

功能验证覆盖独立实体结果、核对纠正、知识共同身份与精确修订绑定、空结果及部分失败／中断恢复，以及不支持格式的拒绝。[评测协议](./entity-extraction-evaluation.md)单独维护冻结质量标准、checker／corpus／guide 身份、模型对比、复核闸门与当前证据。定位及引用闭合证明结构，不证明语义准确性、真值或复用收益；动线测试不能替代该协议。
