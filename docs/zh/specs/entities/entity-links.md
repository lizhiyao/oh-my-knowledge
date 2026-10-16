# 跨窗口实体复核日志

这是跨窗口关联的新增领域基础。local application 能召回候选、预览有限输入、归档已捕获的模型响应、记录显式人工决定，以及恢复组织发布。本批尚未接入 CLI、Studio 人审、模型执行器、受治理的关联 prompt 或真实模型质量验收，不能据此宣称跨窗口动线已全部完成。

## 1. 身份与候选边界

`entity-link-retrieval/v1` 对当前实体标签和来源提及文本执行 NFKC、小写化和移除空白。完全相等只召回其它分析窗口的实体，不据此确认身份、改变实体 UUID 或重写知识。超过 100 个匹配明确失败；不可读分析单独计数。知识库归属或复核文件不可读时查询失败，不显示为健康空库。

预览固定两个不同分析窗口及其实体 UUID、实体修订 ID 与 generation、来源 snapshot/version、选中 mention ID，以及各自当前知识库 owner 的 generation/head。两侧可以都未归属，也可以一侧已归属一个知识库对象。两侧都已归属时需要单独维护组织；预览拒绝同 owner 和竞争 owner。

`entity-link-model-input/v1` 包含上述绑定、两侧选中实体、选中已保存提及证据及分析限制，不包含原生路径、原始轨迹 envelope 或无关完整来源正文。规范化 UTF-8 输入上限为 256 KiB；调用方须减少选中提及，不能静默截断证据。预览要求来源当前可读且定位匹配。预览不预约模型执行，也不在调用前归档输入；后续执行器仍须实现持久 preparation 和 usage 生命周期。

## 2. 独立 v1 存储

`entity-links/<review-id>.json` 使用 `storeKind: entity-link-review-history`、`schemaVersion: 1`。这是新增命名空间，不迁移或改变实体历史 v2、提炼 run v4、知识历史 v2 或 library v1。不支持的版本没有兼容 reader。既有提炼 prompt 身份与字节保持不变。

不可变 capture 保留两侧绑定、输入摘要、请求身份、完整原始输出、声明的 executor/model 与 prompt version/hash、耗时及可选 token/cost 观测。`record()` 根据保留的精确分析修订核对输入摘要，包括纠正或来源 tombstone 后的旧修订。当前 head/owner 变化不会丢弃已经返回的响应。响应 UTF-8 上限为 512 KiB；超限在创建复核之前失败。声明的模型与 prompt 元数据是调用方提供的归档 provenance，不证明本批基础执行过该模型或验证过 prompt 字节。

v1 模型响应包含 `responseKind: entity-link-suggestion`、`schemaVersion: 1`、两侧实体 ID、`assessment`（`same_object`、`different_objects` 或 `insufficient_evidence`）、分侧支持 mention ID 和理由。接纳只检查结构及精确选中实体/提及引用。无效输出以 `invalid_response` 原样保留，可以拒绝，不能接受。结构接纳不证明语义身份或准确率。

无序 pair key 绑定两侧 analysis/entity/revision 与 snapshot/source-version 身份。owner 状态和 mention 子集不重置拒绝。同一精确修订 pair 被拒绝后不再进入预览/召回；新的实体修订可以重新复核。已在途的 capture 仍可归档：被拒绝或待处理 pair 的后到响应保存 `duplicateOf`，指向先前复核，不能发布组织变更。此类仅证据的重复记录不会在主复核发生冲突后阻止新预览。同 review/request/content 的录入幂等；复用身份却改变内容明确失败。

每份复核最多三个只追加事件：`recorded`、`reviewed`，及可选的 `applied` 或 `conflict`。SHA-256 由宿主实现；纯 pair-key/history 函数显式接收 hash port，原始响应上限通过纯编码器计算 UTF-8 字节。generation 等于事件数；读取时核对 head、request/event 唯一性、命令摘要、已接纳响应、精确 intent 端点与回执身份。单文件上限 4 MiB，命名空间上限 4096 文件及 64 MiB，不静默清理。待应用 intent 在文件与命名空间上限内为有界终态事件预留 4 KiB。JSON 原子发布；损坏、重定向或不支持的存储关闭式失败，保留原有字节。

## 3. 人工决定与组织

只有 human actor 可以录入或决定复核。`accept` 要求显式 `identityConfirmed: true` 和非空理由。人工可以覆盖任何已通过结构接纳的模型建议，包括 `different_objects` 或 `insufficient_evidence`；原建议继续可见。这表示人工组织决定，不是新的模型质量分数，也不证明知识主张为真。`reject` 追加人工理由，原实体 UUID、分析、知识和 library 均保持不变。

新知识库对象的 `accept` 可以提供最长 256 字符的 `objectLabel`。未提供时，仅在长度符合知识库限制的情况下使用完整左侧实体标签。长名称要求人工显式命名，绝不截断。已有对象标签通过既有知识库流程维护。选定标签和理由绑定决定摘要与稳定应用 intent。

接受通过既有知识库关联两个原始实体。两侧均未归属时创建新知识库对象；仅一侧归属时追加到固定 owner。无关既有成员保持不变。不合并来源 UUID、不在竞争 owner 间转移成员、不复制知识正文，也不以时间先后判断真假。两侧必须是相同所指层级的 proposed 身份，且与固定既有 owner 的不可变层级一致；未消歧或层级不兼容时，须先纠正来源，再建立新复核。

## 4. 发布、冲突与恢复

人工接受先持久化一个稳定 library 命令：request ID、object/revision ID、作者/时间/理由、完整 draft 及预期 library head/generation，然后尝试发布。entity-link 转移和 library 发布使用同一 `.knowledge-write.lock`；两侧来源/实体 head、精确提及位置和 owner generation/head 均在锁内复核，包含 owner 中原已存在且未改变的成员。外部预检后再调用普通 library save 不满足该边界。

已知的来源/实体、未消歧身份、owner、过期 library 和重复 pair 冲突会追加明确的终态 conflict。既有 owner 的所指层级固定，来源实体后续被纠正也不改变它；不兼容的 intent 或恢复以 `identity_unresolved` 结束。明确尚未发布的 library 写入容量拒绝（256 修订历史、文件或命名空间）以 `library_capacity` 结束；既有匹配回执先于历史上限检查返回。复核 intent 容量在持久化决定前检查，并预留终态空间。library 列表/读取容量错误、损坏数据或未知 I/O 不能证明发布被拒绝，继续保留可重试状态，不能转成容量终态。不发布部分组织，也不撤销历史。解决原因后，须基于当前绑定建立新复核。两个不同既有 owner 对象绝不自动合并。

复核文件与 library 文件不是多文件文件系统事务。未知 I/O 失败保留已持久化的 accepted intent，允许重试。如果 library 已提交但确认或复核追加失败，`resume()` 复用精确同一命令；既有匹配 library 回执先于当前来源复核返回。这会记录已经提交的事实，不额外添加 library 修订，也不调用模型。尚未发布时，过期绑定仍然冲突。终态结果幂等；已拒绝复核不能通过 resume 逆转或应用。

日志在来源删除后仍将选中提及文本和原始输出作为用户数据保留，不恢复已删除来源，也不允许基于不可用证据进行新应用。删除来源不等于删除独立保留的实体或复核历史。这些文件须与所选知识 workspace 一同管理隐私和备份，不属于仓库源码资产。
