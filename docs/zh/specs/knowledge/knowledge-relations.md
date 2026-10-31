# 跨知识关系意见

本契约新增同一显式工作区内、两篇精确正文之间的补充／冲突意见。不生成关系、不合并身份、不改正文，也不裁决哪条主张为真。这是当前 main 的能力，不属于已发布 Beta.14。

## 语义与范围 {#relation-meaning}

| relationType | 含义 |
| --- | --- |
| `supplements` | `from` 针对明示问题及条件，为 `to` 增加内容或复用限制，不表示另一篇错误或被替代。 |
| `conflicts_with` | 在主体、语气、时间／版本及适用条件可比时，两端主张不能同时成立。语义对称，不裁决哪端为真。不同条件不形成冲突；可比性未知可保留待审，不能接受为已核对冲突。 |

两端必须是同一显式工作区内不同 knowledgeId，各固定 `bodyRef: {knowledgeId, revisionId, bodyDigest}` 及可选非空 `segmentIds`。名称、日期、路径和相似度都不确立身份或裁决分歧。

已有 `derived_from`、`split_from`、`merged_from`、`replaces` 和修订父子继续只读呈现来源／演变，不是新增采用决定或独立冲突复核。派生引用原本没有摘要时，只有精确目标可解析才派生摘要，否则保留原 ID 与缺口。`recordedIn` 标明收录该信息的正文修订，不补造原意见的独立作者／时间。

## 依据与存储 {#relation-storage}

`knowledge-relations/<relation-id>.json` 使用 `knowledge-relation-history` Schema 1。账本固定工作区 namespace、关系 ID 和有序的两端知识身份。新提案修订可显式重绑正文版本，保留父提案修订；新提案始终待审。

提案保存问题、条件、声明的比较范围（`same`、`different`、`unknown` 及主体／语气／时间／版本细节）、依据类型（`source_assertion` 或 `inference`）、理由与限制。每端都需要正文段落、精确 UTF-16 正文选区，以及精确来源引用和原文选区。该来源必须属于对应端所选正文段落的已有来源。位置核对不证明语义真值。

提出或接受关系时，两端精确正文及支持任一完整正文的全部来源都须可读，依据须匹配，不能只核对表单中选中的引文。拒绝与作者撤回可在历史来源不可用时保留限制。任何操作都不自动追随最新正文或捕获新来源。

账本追加 `relation_proposed`、`relation_reviewed`、`relation_withdrawn` 事件及 generation/head、实际 actor／时间与收据。单文件最多 4096 事件、16 MiB；目录清单最多 4096 文件、64 MiB，不可读、不支持或被重定向的记录形成 partial 清单，不能伪装为空结果。不为满足上限截断历史。

## 意见与版本 {#relation-state}

没有活跃复核时为 `pending`；只有接受为 `accepted`，只有拒绝为 `rejected`，相反活跃意见为 `disputed`。显式 supersession 只可替换该稳定 actor 对同一提案修订的活跃意见，不按 actor 类型或时间排序真值。

只有当前提案修订的实际作者可以撤回，按稳定 `actorKind`、`actorId` 匹配；新的 executionRef 不改变作者身份。其他操作者可以拒绝或替换自己的意见。撤回保留完整历史，重新提出须显式新修订。接受须核对全部提案依据索引，比较范围未知的冲突不能接受。

意见状态、是否当前提案修订、正文 current/stale 及来源可用性分轴保存。正文改变后，旧关系仍绑定旧版本；显式新提案修订重新待审，不继承旧意见。历史精确读取仍可用；账本不可用不代表没有关系。

## 操作与可信操作者 {#relation-operations}

共用应用工厂为 `createLocalKnowledgeRelations(workspace, actor?)`，缺少实际 actor 时只读。CLI 和 Studio 调用同一应用流程，浏览器输入不能自报 actor。

| 操作 | 输入 |
| --- | --- |
| `relations` | 精确 `bodyRef`，返回匹配的关系修订、清单缺口与完整性。 |
| `relation` | `relationId` 及可选 `relationRevisionId`，返回精确投影及完整账本／收据。 |
| `propose-relation` | 稳定关系／请求 ID、预期 generation/head 及完整提案。 |
| `review-relation` | 相同写入身份、精确关系修订、接受／拒绝、理由／限制、已核依据索引及显式本人意见替换。 |
| `withdraw-relation` | 相同写入身份、精确当前关系修订及理由／限制。 |

```bash
omk observe knowledge graph --workspace ./knowledge --input ./graph-scope.json --json
omk observe knowledge relations --workspace ./knowledge --id <knowledge-id> --revision <body-revision-id> --body-digest sha256:<digest> --json
omk observe knowledge relation --workspace ./knowledge --id <relation-id> --revision <relation-revision-id> --json
omk observe knowledge propose-relation --workspace ./knowledge --input ./proposal.json --json
omk observe knowledge review-relation --workspace ./knowledge --input ./review.json --json
omk observe knowledge withdraw-relation --workspace ./knowledge --input ./withdrawal.json --json
```

写入 JSON 是完整领域输入，不加 `operation` wrapper 或 `actor`。新账本使用 `expectedGeneration: 0`、`expectedHeadEventId: null`、`parentRelationRevisionId: null`，后续写入使用实际读到的头。CLI 只将可信 Codex Desktop 启动上下文识别为 Agent，未知写入者不回落为真人。Studio 注入声明的本地界面操作者；隔离 Agent 验收时在服务端显式注入实际 Agent。

Studio 通过 `POST /api/knowledge/relations` 传输操作，携带显式 `workspace` 和 `operation`。已知非法／无权／不可用请求返回受控错误，未确认写入保留原请求身份。先读 `relation` 及收据判断是否提交，不自动重发结果不明的写入。

相同请求的收据检查先于 CAS；完整命令及实际 actor 进入摘要，宿主时间不进入重试身份。内容或操作者变化产生冲突。持共享工作区写锁重新核对精确端点及来源依据后才持久发布。关系写入不调用生成模型或评委。

只读 `graph` 命令的范围 JSON 为 `{knowledgeIds?, includeHistory?}`。不提供 `--input` 时读取当前工作区图谱；`knowledgeIds: []` 为空，历史默认不展开。图谱响应不携带完整关系账本；只有两端精确节点均可见时才返回端点引文，隐藏依据保留数量，不伪装为不存在。

## Graph3 与启用 {#relation-activation}

**BREAKING-SCHEMA(graph)：**CLI／HTTP／Studio 的 `knowledge-graph` DTO 从 Schema 2 统一升级为 Schema 3，不保留永久双 reader。`knowledge_relation` 呈现显式关系意见，`knowledge_derivation` 只读呈现已有派生，既有 `revision_parent` 不变。显式知识选择不自动读取或添加另一篇正文／来源，历史也须明确展开。端点缺失和关系数据不可读形成局部缺口，健康节点与边仍保留。

固定原清单及匹配旧／新构建后，只在完整独立副本启用。既有正文／来源／目录／关联／复核／载体引用和字节不变，关系操作只新增关系账本。原工作区与匹配 Graph2/v7 构建保留回退，新副本与匹配 Graph3 构建另行保全。回退是重开原配对，不降级新账本、不让旧构建写新副本。本功能不改变生成 profile、wire、workflow 或历史测量；发版仍需单独授权。

## 验收限制 {#relation-limits}

保存提案、接受意见、图边和引文匹配都不等于真值、完整召回、独立佐证、真人 Gold 或任务收益；同源补充保留这一限制。合成冲突／生命周期测试是工程证据，真实冲突正例、独立真人使用及长期价值需要各自证据。旧失败及原测量身份继续保留。
