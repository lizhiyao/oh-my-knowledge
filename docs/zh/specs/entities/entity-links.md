# 跨窗口实体复核日志

local application 能召回候选、预览精确有限输入、持久准备一次明确确认的调用、执行当前生产 API adapter、归档完整返回结果、记录独立人工决定，以及恢复知识库发布。受治理 prompt 与请求字节均被固定。CLI 与 [Studio 核对界面](../studio/studio-entity-links.md)已接入这一闭环。质量标准、冻结测量及复核就绪状态由独立的[实体关联评测协议](entity-link-evaluation.md)维护；动线完成不证明语义质量。

## 1. 身份与候选边界

`entity-link-retrieval/v1` 对当前实体标签和来源提及文本执行 NFKC、小写化和移除空白。完全相等只召回其它分析窗口的实体，不据此确认身份、改变实体 UUID 或重写知识。超过 100 个匹配明确失败；不可读分析单独计数。知识库归属或复核文件不可读时查询失败，不显示为健康空库。

预览固定两个不同分析窗口及其实体 UUID、实体修订 ID 与 generation、来源 snapshot/version、选中 mention ID，以及各自当前知识库 owner 的 generation/head。两侧可以都未归属，也可以一侧已归属一个知识库对象。两侧都已归属时需要单独维护组织；预览拒绝同 owner 和竞争 owner。

`entity-link-model-input/v1` 包含上述绑定、两侧选中实体、选中已保存提及证据及分析限制，不包含原生路径、原始轨迹 envelope 或无关完整来源正文。实际 system 加规范化 prompt 的 UTF-8 输入总上限为 256 KiB；调用方须减少选中提及，不能静默截断证据。预览要求来源当前可读且定位匹配。预览不预约或执行模型。独立 prepare 命令要求明确的内容／模型确认，绑定精确请求与调用预算，并在工作区锁内重核来源／实体／owner head。

## 2. 独立 v1 存储

`entity-links/<review-id>.json` 使用 `storeKind: entity-link-invocation-history`、`schemaVersion: 1`，替换尚未发布的离线 `record(capture)` 协议，不保留兼容别名或第二个 reader。实体历史 v2、知识历史 v2 与 library v1 不变。独立的 extraction-run v5 升级及旧 run 读取边界由[实体提取规范](./entity-extraction.md)规定，不改变本 v1 日志。不支持的存储关闭式失败。

独立的人工命令 `execution_terminated` 携带 `terminationVersion: omk.entity-link-termination/v1`。外层日志保持 schema 1，旧事件字节和 facts 原样保留，不迁移，也不新增历史 reader。新增该命令对事件协议属于 **BREAKING-SCHEMA**：旧程序遇到包含它的日志会拒读。下文的调用及工作区质量投影显式升级为 v2；实体、知识、library 和模型建议 Schema 不变。

Preparation 保存两侧精确绑定、受治理的完整 system／prompt 和 JSON Schema、prompt／schema hash、model／executor／输出／超时设置、确认摘要、重试前驱及可信具体 producer 容量证明。request digest 证明精确请求完整性，不宣称完整 runtime 或凭据身份。实际 API builder 和执行器使用同一冻结环境；beforeDispatch 将真实 endpoint／body 与已准备的证明比对。证明不保存凭据。零 I/O inspect 在预览中返回非敏感 producerContext，producerContextDigest 共同进入内容／模型确认摘要；预览到 prepare 之间 endpoint 或证明上下文变化会明确拒绝，不能静默切换配置。共享 PreviewSchema 核对展示输入与计划一致，返回稳定 reviewId、prepare requestId 和 startRequestId。

无序 pair key 绑定 analysis／entity／revision 与 snapshot／source-version 身份。名称规范化只用于召回；owner 变化、mention 子集和左右交换不能绕过人工拒绝。一个 workspace 同时只允许一个 prepared／running 调用。失败、未知或人工终止的调用要求显式 retryOf 和重新确认，活跃前驱不能重试。一次确认只授权一次 OMK invocation，执行器内部 attemptCount 单独保存。

只追加生命周期为 prepare → start → execution_recorded → reviewed → application_applied／application_conflict，记录结果前可插入已证明 owner 退出的 execution_unknown；未启动时可 cancel_before_start。最多六个事件。只有成功 CAS start 发布 dispatch_once；start 确认重放、list／read／resume 和普通重载都不派发。崩溃前已写入的 start 可能已经发送，因此无结果仍消耗调用额度。只有证明本机 PID 已退出才可将 running 标记 unknown；经过时间、远端主机或锁消失均不足。unknown 和启动后取消都不退款或自动补发。独立人工终止可以在不宣称 owner 已退出的情况下结束 running 调用，不等同于 `execution_unknown` 转移。

完整 JSON ExecResult 先落盘，再做结构接纳，包含失败部分 output、refusal、执行器标准化 token／cache 计数、用量 reported 标志、stop reason、失败元数据及额外返回 JSON 字段。这些是执行器观测，不宣称 provider 显式报告过每个被归一的零。任意 JS 异常不经 JSON.stringify，也不读取 getter／proxy；只保存有界 exception-diagnostic/v1 观测，结果和用量保持 unknown。单次归档 outcome 不可变；尚未归档的 unknown 可以补回找回的原结果，已归档 exception 不能静默替换为第二个 outcome。

v1 建议仍为 entity-link-suggestion/v1，包含 same_object、different_objects 或 insufficient_evidence、精确实体／已选 mention 引用和理由。执行失败、观测到工具、无效 JSON／引用、token 聚合溢出或预约超限均不能接受；原返回计数、output 和 refusal 保持完整；系统时钟回拨造成的有限负 durationMs 也按原值归档，不为归档修正计时。结构接纳不衡量语义准确率，也不确认身份。

API 容量来自可执行 producer 代码，不来自调用方填报数字：HTTP 原字节 4 MiB 上限、非 fatal UTF-8 替换最多 ×3、保留的 output／refusal／stopReason 三个字符串通道、JSON UTF-8 转义最多 ×6、内部 diagnostic 上限，以及外层 redactor 按实际冻结凭据计算的替换增长；包含 refusal fallback 的重复。固定字段上界模板覆盖 API 结果／envelope 其余字段。Codex 尚无完整 trace 派生上界，因此 preparation 前明确拒绝且零派发；已证明的 API 路径可以正常使用。

产品配额为 4096 文件及单文件／命名空间 512 MiB，不把配额当作 producer 输出上界。Preparation 预约完整结果证明及五个未来事件槽；每槽由明确的最大 command／facts 模板证明，包含 256 个 library 成员、64 个 mention ID、JSON 转义及人工决定字段。记录结果后释放未用结果容量，继续保留人工决定／终态空间。人工终止释放工作区全局的逻辑调用预约，但仍保留尚未归档结果的 producer 容量证明，不能保证原进程或 provider 请求已经停止；迟到归档后释放未用结果容量。终止分支为 prepare → start → execution_terminated → 可选 execution_recorded，仍在六事件上限内。intent 容量在持久人工决定前检查。紧凑规范化 JSON 以独占创建或 CAS 替换原子发布；相同既有确认先于配额检查返回。损坏、重定向、不支持或不可读存储不显示为健康空库。

## 3. 人工决定与组织

只有明确 human actor 可以授权 preparation、终止 running 调用或决定身份；执行与归档事件记录 host actor。`accept` 要求显式 `identityConfirmed: true` 和非空理由。人工可以覆盖任何已通过结构接纳的模型建议，包括 `different_objects` 或 `insufficient_evidence`；原建议继续可见。这表示人工组织决定，不是新的模型质量分数，也不证明知识主张为真。`reject` 追加人工理由，原实体 UUID、分析、知识和 library 均保持不变。

新知识库对象的 `accept` 可以提供最长 256 字符的 `objectLabel`。未提供时，仅在长度符合知识库限制的情况下使用完整左侧实体标签。长名称要求人工显式命名，绝不截断。已有对象标签通过既有知识库流程维护。选定标签和理由绑定决定摘要与稳定应用 intent。

接受通过既有知识库关联两个原始实体。两侧均未归属时创建新知识库对象；仅一侧归属时追加到固定 owner。无关既有成员保持不变。不合并来源 UUID、不在竞争 owner 间转移成员、不复制知识正文，也不以时间先后判断真假。两侧必须是相同所指层级的 proposed 身份，且与固定既有 owner 的不可变层级一致；未消歧或层级不兼容时，须先纠正来源，再建立新复核。

## 4. 发布、冲突与恢复

人工接受先持久化一个稳定 library 命令：request ID、object/revision ID、作者/时间/理由、完整 draft 及预期 library head/generation，然后尝试发布。entity-link 转移和 library 发布使用同一 `.knowledge-write.lock`；两侧来源/实体 head、精确提及位置和 owner generation/head 均在锁内复核，包含 owner 中原已存在且未改变的成员。外部预检后再调用普通 library save 不满足该边界。

已知的来源/实体、未消歧身份、owner、过期 library 和重复 pair 冲突在人工决定后形成明确的 accepted_conflict 终态事实。既有 owner 的所指层级固定，来源实体后续被纠正也不改变它；不兼容的 intent 或恢复以 `identity_unresolved` 结束。明确尚未发布的 library 写入容量拒绝（256 修订历史、文件或命名空间）以 `library_capacity` 结束；既有匹配回执先于历史上限检查返回。复核 intent 容量在持久化决定前检查，并预留终态空间。library 列表/读取容量错误、损坏数据或未知 I/O 不能证明发布被拒绝，继续保留可重试状态，不能转成容量终态。不发布部分组织，也不撤销历史。解决原因后，须基于当前绑定建立新复核。两个不同既有 owner 对象绝不自动合并。

复核文件与 library 文件不是多文件文件系统事务。未知 I/O 失败保留已持久化的 accepted intent，允许重试。如果 library 已提交但确认或复核追加失败，`resume()` 复用精确同一命令；既有匹配 library 回执先于当前来源复核返回。这会记录已经提交的事实，不额外添加 library 修订，也不调用模型。尚未发布时，过期绑定仍然冲突。归档 I/O 失败保留稳定 execution 身份及进程内原始 outcome，供 resume 重试；进程退出且没有已保存字节时仍为 running／unknown，不创建新请求。文件系统原子发布不承诺断电持久性或远端 exactly-once。终态结果幂等；已拒绝复核不能通过 resume 逆转或应用。

### 4.1 明确人工终止 {#human-termination}

原 owner 仍存活或无法证明退出时，人工可以先核对已保存 review，再明确终止这次逻辑调用。该操作不杀进程、不取消 provider 请求、不证明未发送，也不证明后续费用为零；它记录停止将该调用用于接纳与组织的决定，不伪造进程退出事实。

`omk observe entity-links terminate` 要求明确工作区、review `--id`、稳定 `--request-id`、当前 `--generation`、冻结的 `--execution-id`、冻结的 `--owner-id` 及非空 `--reason`。先读取已保存 review，再复制其 execution 与 owner 身份。应用从冻结 start 解析完整 owner，不允许调用方另填主机或 PID。工作区锁内同时核对 human actor、running 状态、CAS generation、execution 和完整 owner；完全相同的请求重放返回已有事实，同 request ID 改内容则冲突。过期 generation 或不同 owner 不能终止另一调用。

命令追加 `execution_terminated`，review 成为终态，已消耗调用仍为一次且不退款。该操作不重读来源、当前 producer 配置或凭据，也不调用 owner 退出证明；不产生身份决定，不发布知识库组织。确认失败或未知时，下一步先读回同一 review 和原 request。

原结果迟到时，可以沿既有 execution 身份归档一次。review 保持 `execution_terminated`，归档 facts 使用 `archiveDisposition: terminated`，不接纳；即使建议结构合法，也不能再做人工身份决定或知识库应用。原始结果／失败／拒绝、执行器尝试数及已报告用量仍作为观测可读；归档不存在时这些值保持未知。读取、重载和 resume 均不再派发。同 pair 的新尝试要求新 review 和 invocation、显式 `retryOf`、重新预览及内容／模型确认。

日志在来源删除后仍将选中提及文本和原始输出作为用户数据保留，不恢复已删除来源，也不允许基于不可用证据进行新应用。删除来源不等于删除独立保留的实体或复核历史。这些文件须与所选知识 workspace 一同管理隐私和备份，不属于仓库源码资产。

## 5. 版本化投影与工作区观测

共享调用视图使用 `projectionKind: entity-link-invocation`、`projectionVersion: omk.entity-link-invocation-projection/v2`，返回冻结的 `execution` 身份及完整 `termination` 命令，缺失时为 null；`canTerminateExecution` 仅在 running 时为 true。人工终止的 review 保持 `admission` 和 `decision` 为 null，`canStart` 和 `canResumeOrganization` 为 false，已消耗调用预算仍为一次。迟到结果可以提供真实执行器尝试数及用量，不重新开启接纳或组织。

工作区投影为 `omk.entity-link-quality/v2`。`humanTerminations` 单列 `total`、`outcomeUnrecorded` 和 `lateOutcomeRecorded`，接纳计数另列 `terminatedDispatched`。人工终止调用不进入机器接纳的 recorded／admitted／rejected／unrecorded-dispatched 分母，也不进入人工身份决定计数；终止不等于人工拒绝、模型失败或质量标签。原生 result／exception 与实际用量观测可以包含迟到归档，缺失用量不补零。这些投影仍是运行观测，不是 benchmark 质量分数，也不证明语义正确。
