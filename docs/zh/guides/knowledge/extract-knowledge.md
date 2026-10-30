# 沉淀、维护和使用知识

从选定的对话记录、UTF-8 项目文件或固定本地 Git 文件形成候选，核对后保留到知识库，修订过时内容，再维护引用它的载体。保留、保存载体和验证效果各有自己的记录。第一次使用可以先走 Studio；命令行步骤在后面。让 Agent 依据已存知识处理新任务，见[从已有知识完成任务](#task-knowledge-reuse)。

本指南描述当前 main。先区分能力所属版本，再选择安装包或源码构建；安装后运行 `omk --version`，升级前阅读[迁移指南](../maintenance/v1-preview-migration.md)。

## 能力与版本 {#availability}

| 能力 | 可用边界 |
|---|---|
| 知识库、载体生成、持续修订与变化核对的核心流程 | 从已发布的 `1.0.0-beta.14` 开始提供；Beta.13 不包含该维护界面。 |
| Source3 项目／轨迹选区、逐请求确认的正文优先生成、独立派生关联、当前日志及显式副本迁移 | 本指南说明当前 main；已发布 Beta.14 不包含这些后续能力。使用当前源码构建，并在后续发行时核对发布说明。 |
| 读取重试、保存恢复与 CLI 操作指引的后续修复 | 同样以当前 main 为准；不把已发布 Beta.14 当作修复完成的证据。 |

当前 prompt、Schema 和容量由[当前知识提炼契约](../../reference/shared/knowledge-contract.md)从运行时代码生成。该页描述构建身份，不代替[发行记录](https://github.com/lizhiyao/oh-my-knowledge/releases)；`@next` 是发行通道，不会自动包含未发布的 main 改动。

## Studio {#studio}

```bash
omk studio
```

使用命令返回的地址，先核对当前知识保存位置。改变默认目录不会移动已有数据。已接入对话使用宿主的对话目录；项目文件、本地 Git 文件或已配置轨迹文件须由宿主先提供[有限来源 scope](#source-scope)，再用 `omk studio --source-scope ./scope.json` 启动。浏览器只选择已配置 ID 和相对路径，不能授予任意项目根目录。

1. **选择并预览来源**：从对话轮次进入提炼，或在知识页选择“选择来源并提炼知识”。可选已接入对话记录、项目文件、固定 Git 文件或已配置 Agent 原始记录。读完整选中片段，分别核对读取、保存和拟发送范围。“仅捕获选定来源”只在本地保存，不调用模型；随后选择执行器／模型，准备并核对完整请求，明确发送正文请求。正文保存后，再核对并单独确认关联请求；每次发送都可能产生费用。
2. **核对候选**：阅读完整正文段、条件、归因、例外和未知信息，点击“查看依据”回到原文。填写理由后保留、舍弃或修订；新修订需要重新核对。
3. **按需核对实体**：从候选或“知识 → 实体”检查名称、指代、层次与原文。实体纠正不改正文；核对后独立应用、审查精确段落／实体关联。
4. **持续积累**：从“知识 → 知识库”建立对象，核对不同窗口的来源实体是否谈论同一对象，填写关联理由并确认。同名不自动归并；先处理歧义与来源缺失。
5. **修订与更新**：知识变化后，载体详情提示待核对项。逐项阅读新旧修订、保留／舍弃变化和来源，再明确选择本次更新内容；旧版本仍可回看。
6. **生成与保存载体**：从匹配的已保留知识选择 skill／prompt，核对正文和精确来源，保存为版本。生成只组织现有内容，不额外调用模型；更新重建本次选定的知识区，保留区外手工内容和依赖资产。
7. **验证改动**：在载体详情选择验证入口，声明用例、对照和模型，核对预览后再启动。结束后先看运行与证据状态，再读结论；保存和使用不代表效果已验证。

候选页可切换内容与原始依据，实体与知识库列表支持窄屏切换。失败、零候选、取消或来源缺失都有明确状态；从提炼记录和知识待办找回已保存内容。

对话选择保留所选消息所在的完整原始记录；从这些记录投影出的所有可读事件均列入预览及拟发送材料。例如，Claude 的同一记录可能同时包含消息和工具事件，这些同条事件也会纳入。未选中的独立记录、项目文件和附件原件不自动加入。可读片段、本地保留原记录及完整已准备模型请求分别展示；宿主根路径不作为模型元数据发送，来源正文中已有的路径仍属于原文。这不表示完整覆盖项目，也不证明助手报告的执行结果真实。

知识库、实体与载体页显示当前知识目录；显式目录的读取不依赖模型设置。读取失败时原位重读，填写的组织草稿仍保留。关联应用冲突时正文与草稿保留，重新读取精确正文／目录／投影写头后再应用。通用服务器失败或不可读保存回执不能证明未写入；先选择“核对已保存版本”，组织按本次收据、载体按内容与精确引用确认，避免重复保存。等待期间内容保持只读且可复制，保存和核对都不额外调用模型。

### 在 Studio 按任务查找 {#studio-task-retrieval}

在“知识 → 知识库”切换到“按任务查找”，输入当前要解决的问题。默认检索已保留正文；需要检查尚未作保留决定的内容时，明确勾选“同时查找未保留候选”。已舍弃修订不纳入；阅读不要求先组织对象或生成载体。

展开“来源范围与响应预算”可以限定精确来源版本和调整 UTF-8 字节预算。结果显示本次提供的完整段落、每条知识的提供范围及预算省略；未返回内容不等于没有知识。可扩大预算重新查找，或打开完整正文与精确依据。打开的是检索返回的实际修订，之后新增修订不会悄悄替换它。

任务检索复用 CLI 的确定性字面检索，不调用生成模型；措辞不同仍可能漏召回。检索命中、引文位置匹配和保留决定均不证明内容真实或适用于当前任务。发现正文遗漏、错误关联或来源不足后，分别回到相应的修订或核对入口。

### 记录复核与任务反馈 {#review-feedback}

打开精确正文后进入“内容复核”。内容意见与保留／舍弃、关联接受及独立人工验收分别保存；新记录不会自动改正文或载体。

1. 阅读原文和必要上下文，明确记录需要修订的问题，或带限制的复核意见。问题可以指向具体段落，也可以说明整块内容未生成；来源中未被正文引用的片段同样可以作为遗漏依据。
2. 逐段核对已有实体映射，明确区分已关联、没有可靠对象、已发现缺口和未知。没有映射不等于没有对象；精确引文也不证明语境或身份正确。
3. 从任务检索结果记录使用反馈时，保留实际提供的正文修订、段落和任务问题。分别记录已提供、已读取、自述使用、观察到帮助或受控效果报告；后两项需要任务结果／对照引用或有效证据，不自动升级为系统认证。
4. 报告缺口时区分正文遗漏、关联错误和来源不可用，再进入相应修订、映射核对或来源入口。历史版本反馈不自动转到最新版本；修改正文仍明确创建新修订，重新决定保留，并核对受影响的关联和载体。
5. 先前待修意见只有被明确替代后才解除，新的正面意见不会悄悄覆盖它。保存回执不明时先核对同一 requestId 的已保存记录，不自动重发；冲突后保留草稿，重读并确认再提交新的决定。

CLI 先读取实际消费的精确修订状态；再把完整草稿写到普通 UTF-8 JSON 文件中。下列标识须替换为实际值：

```bash
omk observe knowledge review-status --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --json
omk observe knowledge review-content --workspace ./knowledge --input ./content-review.json --json
omk observe knowledge review-coverage --workspace ./knowledge --input ./coverage-review.json --json
omk observe knowledge record-use --workspace ./knowledge --input ./use-feedback.json --json
```

例如内容复核草稿：

```json
{
  "requestId": "<stable-request-uuid>",
  "bodyRef": { "knowledgeId": "<knowledge-id>", "revisionId": "<revision-id>", "bodyDigest": "sha256:<digest>" },
  "sources": [{ "snapshotId": "<snapshot-uuid>", "sourceVersion": "sha256:<source-digest>" }],
  "expectedGeneration": 0,
  "expectedHeadEventId": null,
  "supersedesEventIds": [],
  "status": "needs_revision",
  "reason": "来源中的适用条件未完整进入正文。",
  "limitations": ["本次只核对选定来源，不证明结论真值。"],
  "findings": [{ "problemKind": "omission", "description": "需要补充会改变后续判断的适用条件。", "segmentIds": [], "evidence": [] }]
}
```

`bodyRef`、generation 和 head 从精确状态读取；`sources` 只复制其中的 snapshotId／sourceVersion，不带当前可读状态字段。不可读账本的未知 generation 不能当作 0。重放同一意图保留同一 requestId 和草稿；修改内容或 CAS 后属于新的明确决定。三个 CLI 写操作需要[可信宿主归属上下文](../../specs/knowledge/knowledge-reviews.md#review-operations)，未知终端不会被记录成真人；状态读取不需要操作者上下文。

复核记录、逐段决定、使用分类及不继承规则的完整字段和边界见[复核与反馈契约](../../specs/knowledge/knowledge-reviews.md)。这些操作不调用生成模型；已保存不代表已证实或已产生收益。

### 从图谱回查和纠正关联 {#graph-review}

在“知识 → 知识库”先按标题、标签与维护状态找到知识，再切到“图谱”。可查看当前知识的邻域或当前筛选集合；没有有效实体映射的知识仍保留正文与来源入口。节点分别表示精确知识修订、来源窗口内的实体修订和来源快照，同名不会自动合并。

1. 选择知识节点阅读完整正文；选择“段落涉及对象”边，核对具体段落、提及和完整来源原文。该边表示已保存的段落映射，不代表对象之间存在已证实关系。有语义关系、歧义候选或修订父子记录时，分别按原记录呈现。
2. 从阅读面进入实体核对或“编辑实体映射”。目录选择仅列出与正文精确来源快照和版本匹配的分析；先核对来源与实体修订，再明确选择段落、对象和提及。实体纠正不会自动重绑知识，应用新映射仍需独立确认。
3. 在“实体关系”区域逐项核对、修改、删除或新增关系。当前精确正文的可读投影会保留已有关系草稿；过期或失败投影不自动带入。关系的主体／可选客体从所选段落已映射的对象中选择，依据限于这些段落已有的精确引文。保留陈述、推断等依据性质、解释与疑点；保存不证明关系真实。变更段落、目录或映射后，失效关系仍留在草稿中，需要明确修正或删除后才能保存。
4. 填写理由并保存所选映射与关系，读回新投影的精确修订与“待核对”状态。正文、正文摘要与保留决定不因关联操作改变；新投影不继承旧投影的接受状态，旧关系及其修订仍可回查。
5. 刷新或重开当前地址，核对筛选、图谱选择、正文修订及来源，并按需展开历史。保存回执不明确时先核对已保存版本；并发冲突保留草稿，重读最新状态后再作决定，不直接重发过期保存。

覆盖不完整时，图谱、实体详情和知识库对象详情仍展示已知的可读关联，同时保留数量未知、失败、过期、被拒或来源不可用提示。历史边只说明当时的精确绑定，不能套到当前正文。多来源正文可回查各来源；手工映射可保留多个精确来源目录，逐目录选择实体和提及后一起保存，没有目录的来源不会被其它来源的同名实体代替。浏览、手工纠正与重开不调用生成模型；另行发起模型重建需要单独核对发送范围。

### 对话自动提炼与项目待办 {#automatic-extraction}

自动提炼是可选入口，需要全新的 Source3 授权。先预览对话、选中原记录的事件、保存目录、执行器／模型、两阶段流程及调用总额度，再开启。授权只覆盖本条对话、24 小时及当前 Studio 服务生命周期，重启后须重新开启。旧流程的权限、预约和调用账本不能授权 Source3，迁移也不会继承它们。

初始窗口最多包含最近三个已结束轮次；后续每窗最多三个新增已结束轮次，并带前两个轮次上下文，记录稳定 30 秒后才开始。一窗最多调用模型两次：先生成正文，再生成关联，关联阶段还会接收已保存正文。每阶段各占会话总 `maxCalls` 的一次额度，界面允许设置 1～20 次。初始授权明确覆盖这些未来窗口和两个阶段；未来正文尚未产生，对应完整请求在各阶段准备时、派发前记录。这与手动逐次确认一份已准备请求不同。

派发前预约绑定精确来源集合、完整请求与调用身份，用量未知不退回额度。范围、目录、模型或上限改变须重新同意。失败、中断或未知时先停止或检查记录，不自动重发相同来源或未知 claim；到期、额度和已记录服务端冷却仍会阻止新派发。知识待办只汇集候选，不自动决定保留或改写载体。

## 选择来源并生成 {#select-sources}

CLI 与 Studio 使用同一份选定知识工作区。预览负责读取，捕获负责保存，准备请求供核对，发送需要明确确认。精确格式及容量见[来源契约](../../specs/knowledge/knowledge-sources.md)。

### 配置可信来源绑定 {#source-scope}

由宿主准备 `scope.json`，把示例路径改为实际获准访问的位置：

```json
{
  "scopeVersion": "knowledge-source-scope/v1",
  "projects": [{ "projectId": "project", "root": "/absolute/project" }],
  "traces": [{ "sourceId": "worklog", "traceKind": "codex", "path": "/absolute/session.jsonl" }]
}
```

只有这份宿主配置含文件系统根目录和轨迹路径。选区 JSON 只含逻辑 ID、相对路径及明确范围；可选材料声明按精确相对路径生效，未声明的材料保持未知。读到测试源码不表示测试已执行。二进制、非法 UTF-8 及越过配置根目录的路径会被拒绝。

例如，用 `selections.json` 选择一个项目文件的实际行：

```json
{
  "selections": [{
    "sourceKind": "project_file",
    "projectId": "project",
    "relativePath": "PRODUCT.md",
    "lineRanges": [{ "startLine": 1, "endLine": 20 }]
  }]
}
```

按实际内容调整文件和范围。文件／Git 行号从 1 开始、包含终点，`lineRanges: null` 明确选择容量内整个文件。`git_blob` 还需 `revision`，如 `HEAD`，预览会将其解析成固定本地对象。`agent_trace` 使用 `sourceId`、`traceKind` 和从 0 开始、包含终点的 `recordRanges`，选择完整原始非空记录及其中所有可读事件。不连续选区保持独立；不拉取远端 Git，也不扫描全仓。

### 预览并保存 {#source-preview}

```bash
omk observe knowledge preview-sources --workspace ./knowledge --scope ./scope.json --input ./selections.json --json > preview.json
omk observe knowledge capture --workspace ./knowledge --scope ./scope.json --input ./preview.json --json > capture.json
```

保存前先读 `preview.json`：它包含选中文字原文、原记录以及独立的实际读取、拟发送和保存清单。reader 为定位选区可能读取整个文件或扫描轨迹前缀，最终只保留选中单元。预览不保存正式快照、不调用模型；捕获会重建固定选区，核对预览摘要和宿主 scope。来源改变须重新预览，移动的 Git 分支不能悄悄替换已固定对象。容量超限时拒绝，不截断；这些导出可能包含来源隐私内容。

捕获同样不调用模型，也不授予发送权限。从 `capture.json` 的 `saveManifest.items` 中，仅复制每项的精确 `snapshotId` 和 `sourceVersion` 到 `sources.json`，不附带可用状态或序号：

```json
{
  "sources": [{ "snapshotId": "<saved-snapshot-uuid>", "sourceVersion": "sha256:<saved-source-digest>" }]
}
```

使用实际保存的值。两个字段合在一起才是 `SourceRef`，不能只用 ID 选择或删除某个捕获版本。

### 准备并逐阶段确认模型请求 {#source-generation}

```bash
omk observe knowledge prepare-generation --workspace ./knowledge --input ./sources.json --executor codex --model <model> --json > request.json
omk observe knowledge generate --workspace ./knowledge --input ./sources.json --executor codex --model <model> --confirm-request <body-request-digest> --json
```

准备请求只创建日志，不调用模型。核对执行器／模型、完整 `system` 和 `input`、producer 上下文及 `requestDigest`，再把实际已准备正文请求的摘要复制到 `--confirm-request`。来源选择或捕获同意不等于批准这次发送；执行或归档能力不支持时，会在派发前拒绝。

<details>
<summary>完整请求中要读什么</summary>

阅读 `request.json` 的 `journal.stages[0]`：`system` 是固定指令，`input` 是完整、有序的来源材料，`producer` 是已检查的执行上下文，`requestDigest` 绑定这份请求。模型材料含选定可读片段、可携带归因及限制，原始 envelope 和宿主根路径不在其中；来源文本已有的路径仍是原文。保留原始对话标题、归因与未知，不用项目显示名或推测的事实时间替换。

</details>

`generate` 只发送已确认的正文请求，归档完整返回原件，将接纳的完整正文保存为**待审且未保留**。关联基于这些已保存的精确正文另行准备，不会自动发送。用 `inspect` 读回运行，核对完整已准备关联请求，再单独确认：

```bash
omk observe knowledge inspect --workspace ./knowledge --id <run-id> --json
omk observe knowledge continue-stage --workspace ./knowledge --id <run-id> --generation <journal-generation> --executor codex --model <model> --confirm-request <association-request-digest> --json
```

关联失败或未决不删除已保存正文。每阶段默认 300 秒，并保留自己的原始结果；没有自动模型重试、校验重问或 provider 回退。默认导入对排序、去重后的同一精确来源集合复用已有日志，包含失败或未知结果；已完成集合的默认重复导入不增加模型调用或重复正文。只有明确批准独立新生成时才给新的 `--run-id`，不能用它绕过未知的旧结果。

无需工作区或模型调用即可导出当前结构 wire：

```bash
omk observe knowledge schema --stage body --json
omk observe knowledge schema --stage association --json
```

当前正文输出 v2／prompt v8、关联输出 v3／prompt v7 使用精确 quote 及可空的相邻 `contextBefore`／`contextAfter`，宿主要求唯一匹配并计算 UTF-16 位置。正文保留有来源的共享必要条件，关联提及归属各实体，每段明确映射或弃权；这些检查不证明含义完整、实体覆盖完整或真值。来源及日志使用 Schema 3／workflow v3；正文 Schema 3、实体／关联 Schema 2、复核 Schema 1 仍是独立契约。当前运行值见[生成契约](../../reference/shared/knowledge-contract.md)。

旧来源／日志不受支持时，应保全匹配构建并显式迁入副本，不通过兼容 reader 解码。独立历史研究保留冻结的来源、请求与测量身份。参数错误退出 2、业务失败退出 1、成功退出 0；`--json` 只输出机器结果。回执不明确时先检视保存状态，再决定是否重入写操作。

## 核对与处理 {#核对与处理}

```bash
omk observe knowledge show --workspace ./knowledge --id <knowledge-id> --json
omk observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation <read-generation> --reason '已核对来源与适用条件'
```

使用最新详情里的实际修订与 `history.generation`；`discard` 同样绑定精确修订，不删除历史。保留不证明真值。

修订草稿只复制 `title`、`content`、`reuseRationale`。保留各段稳定 `segmentId`、完整 `text` 与 inline `evidence`。Evidence 包含精确 `source: {snapshotId, sourceVersion}`、`selection: {evidenceRef, start, end, quote}`、`basis` 和可选 `interpretation`。位置为精确 excerpt 中的零基 UTF-16；修改前读原文，宿主也会重新读取每个 source／version 并拒绝不匹配。

```bash
omk observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation <read-generation> --input ./body.json --reason '保留变更后的适用条件'
```

Studio 从选定的精确引文计算位置；CLI 草稿提供完整 inline evidence。旧 `--citations`、`citationLocators` 及平行 grounding API 已替换。新正文修订待审、不继承保留决定，旧派生投影变为 stale。来源不可用的修订会被拒绝，已有正文仍可读；用 `show --revision <old-revision-id>` 查看历史。

## 核对实体并应用纠正 {#核对实体并应用纠正}


```bash
omk observe knowledge entities --workspace ./knowledge --analysis <run-id> --json
omk observe knowledge correct-entities --workspace ./knowledge --analysis <run-id> --entity-revision <entity-revision-id> --generation <read-generation> --input ./entities.json --reason '根据原文拆分同名对象' --json
```

`entities` 默认读取最新实体修订，可用 `--entity-revision` 查看历史。纠正草稿只包含返回的 `revision.entities` 和 `revision.mentions`。已有身份保持不变；新增实体或提及使用唯一的 `new:<local-name>`，由宿主分配 UUID。同一提及身份不能换到另一段原文。提及必须精确引用所选来源；每个对象至少有一处有效提及。未知对象使用 `identityStatus: unresolved`，保留 `uncertainties`，可填写指向明确对象的 `possibleEntityIds`，不任选一个替代。

草稿保留必填的 `referentKind`、`componentRef` 和 `collection`。实例／版本的组件关联须指向本分析中已提出的组件；集合保存明确成员及 `complete`／`partial`／`unknown` 完整性。每个关联的 `mentionIds` 至少包含所属对象的一处提及，`rationale` 记录原文判断理由。不完整或未知成员需保留不确定性，未知成员不能同时列出确定成员。移除或转移对象／提及前，明确纠正引用它的组件、集合、候选和依据，不能用自动删引用掩盖缺失。

省略 `--analysis` 时，`entities` 检索工作区内各分析的当前对象：

```bash
omk observe knowledge entities --workspace ./knowledge --query Atlas --identity-status unresolved --page-size 20 --json
```

搜索覆盖名称、原文提及、限定条件及来源；`--source-status unavailable` 查找原文不可用的结果，`--page` 翻页。同名结果保持各自分析和实体身份。JSON 包含分析／实体／修订身份、提及与关联知识数量，旧绑定数量单独列出；关联知识不可读时数量为 `null`，不能当作零。损坏分析计入 `unavailableAnalyses`，不会悄悄消失。

纠正只追加实体修订，不改写正文。要把段落连接到选定目录，先核对精确正文与目录，再单独写入派生投影：

```bash
omk observe knowledge apply-associations --workspace ./knowledge --id <knowledge-id> --revision <body-revision-id> --body-digest sha256:<digest> --generation <association-generation> --input ./associations.json --reason '已核对有来源的段落关联' --json
omk observe knowledge review-associations --workspace ./knowledge --id <knowledge-id> --revision <projection-revision-id> --generation <association-generation> --choice accept --reason '已核对该投影' --json
```

应用草稿含 `catalogRefs:[{analysisId,entityRevisionId}]`、`segmentEntityRefs`、可选 `typedRelations`、`issues`。每项段落引用为 `{segmentId,analysisId,entityRevisionId,entityId,mentionIds}`；typed 主体／客体使用相同的目录限定实体三元组。可组合正文来源匹配的多个目录，局部同名或同 ID 不自动合并。旧 `--analysis／--entity-revision` 不再用于 apply-associations。关联 generation 从 `derivedAssociations.generation` 读取，**不是**正文 `history.generation`，尚无关联时为 0。手工应用和模型重建都创建新待审投影，保留正文／修订／digest 及其维护决定；接受／拒绝只作用于该投影，不确认外部真值。被拒或过期投影不是当前知识库绑定。见[领域契约](../../specs/knowledge/knowledge-domain-model.md)。

## 组织与检索知识 {#组织与检索知识}

主题标签只组织内容，不改变正文或维护决定。面向任务消费时，默认从已保留正文检索完整段落：

```bash
omk observe knowledge retrieve --workspace ./knowledge --query '初始化需要哪些条件？' --max-bytes 65536
omk observe knowledge retrieve --workspace ./knowledge --query '还有哪些未知？' --include-candidates --snapshot <snapshot-id> --source-version sha256:<source-digest>
```

默认 JSON 视图的 **65536 UTF-8 字节计算整个单行 JSON 和换行**，不是知识存储或模型上下文限制。仍支持显式 `--max-bytes 8192`，最大保持 1 MiB；完整段落及其 inline evidence 原子装入，超大或预算排除的段落记入 `omitted`，不截条件。这一初始预算不证明任务覆盖完整或选择最优，也不升级旧小预算失败记录。下方可选 text 视图按自身完整输出计算预算。

召回与排序使用确定性的 ASCII／代码标识符和中文连续／双字片段。响应记录 `rankingPolicyId: knowledge-body-literal-topic-priority/v3`。完成来源／实体范围筛选后，以每条正文的标题、标签及范围内合格段落计算查询 ASCII／代码词的命中集合。严格子集只降低装包优先级，不证明正文冗余，也不删除候选；相等集合处于同一优先级，互不包含的集合不彼此降级，纯中文或所有 ASCII 词均未命中时保留既有排序。能装入预算的段落先按极大主题集合优先，再按字面增量覆盖／成本选择；较低优先级候选仍可利用剩余预算，所有超大或预算排除的候选均记入 `omitted`。这不使用 embedding，也不推断语义身份。`--include-candidates` 明确纳入未保留待审正文，已舍弃修订始终排除。`--snapshot` 和 `--source-version` 必须成对提供，限定精确来源引用；`--entity-id` 须同时提供 `--analysis` 和 `--entity-revision`，使用匹配当前正文的可用派生投影，拒绝／不可用／过期的关联不能提供该范围，不按名称自动归并。来源不可用时证据明确标记，已存正文仍可读。

### 从已有知识完成任务 {#task-knowledge-reuse}

官方 OMK Agent Skill 首选 `retrieve --format text` 阅读历史知识，必要时用 JSON、`show` 和 `source` 精确读回；该分支跳过评测项目与 `eval-samples` 扫描。沿用用户已选工作区或 CLI 已配置默认，不猜新目录，不自动安装、升级、迁移或改写知识。先按上方版本边界核对已安装命令的能力。

保留完整自然任务用于阅读和最终核对。每条 `--query` 去除首尾空白后最多 512 个 JavaScript 字符串单位（UTF-16）；限内原样查询，长任务按自然子问题忠实拆分并保留名称、版本和约束，不截半条件或替换成预期答案。先按工具可见容量选择较小、可调整的单次读取预算，例如：

```bash
omk observe knowledge retrieve --workspace <selected-workspace> --query '<current-task>' --format text --max-bytes 16384
```

`16384` 仅为示例，不是产品默认、知识或模型上限，也不保证任意工具都完整展示。工具若支持 `max_output_tokens` 等展示上限，也要与预计返回量匹配。默认预算仍是整个所选视图加一个换行的 65536 UTF-8 字节，最大 1 MiB。text 按每条知识原保存顺序的 `segmentIndex` 展示完整正文，保留稳定的知识／修订／摘要／状态及精确证据定位、basis 和 interpretation；quote 文本不显示，可用 JSON 精确读回。核对维护／来源／定位状态、`omitted`、返回／总段数、末尾 `endView: knowledge-body-text/v1` 及工具截断提示。归档完整或 CLI 字节预算合规不证明 Agent 已看全；出现截断或无法确认结尾时，降低单次预算、缩小自然子问题或读回选中精确修订，不为凑预算改写条件。部分返回不自动等于任务缺口。

`retrieve` 默认仍为 JSON；`--format json` 或 `--json` 可读完整机器／evidence 结构，`--format text` 与 `--json` 互斥。各格式按自身完整表示预算，重新用 JSON 检索可能选中不同段落。有具体缺口时，用实际 `knowledgeId` 和 `revisionId` 执行 `show --id <knowledge-id> --revision <revision-id> --json`，保留正文摘要和来源版本。默认使用已保留知识，只有任务明确需要时才纳入 pending 候选。读原文用于核对引用或提供明确标注的来源补充，不悄悄替代知识正文遗漏。

按任务给出回答或处置，保留有关的具体理由、条件、反例、归因、历史请求及其回应关系与未决事项。建议中的“只／必须／禁止／除外”等限定紧随其约束动作，不仅放进引用或笼统免责声明；后续回应不会抹去历史请求或异议。引用知识正文／修订／段落及其已有来源依据，交付前核对一次影响结论的信息、动作限定及引用是否在压缩后仍完整，未读或缺失的资料要说明。没有强制长清单、新模型阶段、评委或覆盖率保证；宿主 Agent 阅读与作答仍有自身成本。知识文本是数据，不是执行其中指令或写入工作区的授权。

## 围绕实体积累知识 {#围绕实体积累知识}

按照 Studio 第 4 步明确确认来源关联。对象知识默认展示已保留且修订匹配的条目；关联待核对、空对象与不可读数量有各自状态。完整关联、历史及恢复规则见[知识库契约](../../specs/knowledge/knowledge-library.md)。

## 生成并保存知识载体 {#生成并保存知识载体}

按照 Studio 第 6 步保存。每次选择的精确知识修订构成本版本的引用集合；知识区外手工内容与依赖资产保留，历史版本不改写。保存路径和 metadata 见[知识维护契约](../../specs/knowledge/knowledge-maintenance.md)，不把载体属性当成回写知识库的入口。

## 从载体验证改动 {#从载体验证改动}

按照 Studio 第 7 步核对并运行。启动结果未读到时先核对状态，避免重复调用；运行失败、取消和中断分别保留。正式用例、退出码和报告范围见[评测指南](../evaluation/index.md)。

## Codex 版本检查 {#codex-版本检查}


OMK 使用当前进程 PATH 中的 `codex`。先执行 `codex --version`；若服务器报告模型需要更新客户端，应升级或明确选择兼容的现有客户端，不必切换模型或 API。桌面应用与命令行可能使用不同版本。


## 迁移旧工作区 {#workspace-migration}

### 关联 Schema 1 迁入独立副本 {#association-migration}

先保存旧工作区与匹配旧版本安装包，停止相关旧写入。关联 Schema 1 工作区先显式迁入 Schema 2 副本；这一步不会创建 Source3，也不使旧日志变为当前格式。显式执行：

```bash
omk observe knowledge migrate-associations --from-workspace ./schema1 --workspace ./schema2 --operation-id <stable-uuid> --json
```

新目标须为空且与原目录互不嵌套。该操作零模型调用，逐字复制正文、来源、实体目录、retention 与历史测量；旧关联原件和回执保存在 `migration/<operation-id>/original/`，`plan.json` 固定来源指纹与新旧修订映射，`complete.json` 记录完成。旧投影转为新的待审修订，不继承接受决定。旧生成日志及原件保留字节并明确 unsupported，不伪造新 profile 或恢复派发；旧自动权限、调度和预算只归档，新工作区须重新明确授权。

中断时保留计划，以同一两个目录及 `--operation-id` 重入；源目录漂移或目标已修改则拒绝，不覆盖。完成后重放只验证原计划，人工新增／修改／删除不得被复活或覆盖。回退使用旧工作区和匹配旧 binary，新副本继续保留原件与映射。机械迁移、可读和保存成功均不表示知识语义通过。

### Source2 迁入独立 Source3 副本 {#source-migration}

保留原工作区及匹配的可安装构建档案，并停止旧写入。当前 Source3 迁移切片接受健康的正文 Schema 3／Source2 工作区，实体及关联须符合当前格式；所需来源缺失、已删除、数据损坏或版本不支持时明确拒绝。更早格式先按各自显式迁移流程及匹配构建处理，不原地升级原件。

```bash
omk observe knowledge migrate-sources --from-workspace ./source2 --workspace ./source3 --operation-id <stable-uuid> --matching-build ./omk-old.tgz --matching-build-id <old-build-id> --plan-only --json > migration-plan.json
omk observe knowledge migrate-sources --input ./migration-plan.json --confirm-plan <plan-digest> --json
```

第一条只读。核对实际源／目标、归档与限制后，将导出的 `planDigest` 复制给第二条命令。目标是互不嵌套的独立副本；旧原始材料、journal／outcome、复核记录、权限、知识库／载体引用和匹配构建在归档中保留字节，原目录保持不变。新来源、正文、目录和投影引用显式映射、重新待审；不继承旧保留、身份接受、复核、任务反馈或自动授权，普通组织标签单独保留。

中断后保全固定计划，用同一输入及摘要重入。未完成目标不能当普通工作区打开；目标已修改不覆盖，已完成输出被删除也不复活。首次归属记录持久保存前崩溃，可能需要核实所有者，不能自动恢复。回退使用未改动旧工作区及匹配构建；复制档案不等于实际安装或回退已验收，见[来源迁移契约](../../specs/knowledge/knowledge-sources.md#migration)。

## 中断与来源管理 {#recovery-and-data}

默认导入已复用精确来源集合的日志；若显式选择过 run UUID，同一请求须继续使用它。不同来源／模型／runtime 不能复用该身份。

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge inspect --workspace ./knowledge --id <run-id> --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

`resume` 可以归档同进程仍持有的原件、挂接已存原件或完成固定写入，不调用模型。已 claim 却无可恢复结果时保持 `outcome_unknown_do_not_redispatch`；进程退出不证明未派发或费用为零。只有从未 claim 的已准备阶段，才能在核对并明确确认精确 `requestDigest` 后发送，模型配置须与原记录相同。

对已有精确正文先准备关联重建，核对完整请求后再发送；两条命令复用同一个明确的新 run UUID：

```bash
omk observe knowledge prepare-rebuild-associations --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --run-id <new-stable-uuid> --executor codex --model <model> --json > association-request.json
omk observe knowledge rebuild-associations --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --run-id <new-stable-uuid> --executor codex --model <model> --confirm-request <prepared-request-digest> --json
```

这只生成独立的新待审投影，不重新生成正文；各精确可读来源保持独立目录。目录输出不合法时，相关投影明确失败，健康目录和已存正文保留；后续目录缺失会呈现局部缺口。

当前日志在 `generation-journals/<run-id>.json`，完整原件在 `generation-journals/outcomes/<run-id>/<invocation-id>.json`。更早 typed 正文及来源／日志格式明确不支持，不显示成健康空库；保留原工作区及匹配构建，按[正文迁移](../../specs/knowledge/knowledge-domain-model.md#body-migration)和[来源迁移](#source-migration)边界处理，不直接覆盖。

### 核对来源变化 {#source-updates}

将精确核对请求保存为 `source-check.json`：

```json
{ "source": { "snapshotId": "<saved-snapshot-uuid>", "sourceVersion": "sha256:<saved-source-digest>" } }
```

```bash
omk observe knowledge source-updates --workspace ./knowledge --scope ./scope.json --input ./source-check.json --json
```

此操作读取当前材料及已知正文／目录／投影的精确引用，不调用模型、不改知识。当前状态与影响完整性要分别阅读，部分清单不能证明零影响。完整文件可能改变而选中字节不变，形成新待审修订前仍应核对适用条件。默认 Git 核对捕获时固定对象，不是最新分支；刷新分支须显式提供 `replacementSelection`。不同路径即使字节相同，也只是待核对的可能移动；根目录失联不证明原文件已删除。

Studio 捕获 Git 来源后，可在“来源变化影响”中明确填写另一个本地提交或分支，再选择“对比版本并核对影响”。此入口保留旧来源引用及原项目、路径、固定行范围，不自动选择 `HEAD`，也不重新捕获新版本。界面保留旧固定提交，并展示填写版本、实际解析提交、来源状态、已知正文版本／实体目录版本／关联版本的精确引用数量和复核建议；检查不改变模型发送授权，建议不表示知识已更新。比较不替换本次已捕获来源或模型输入；要使用新版本，请另行预览并捕获。

已有知识可在“依据”页的引文下方展开“核对已保存来源的变化影响”，直接检查该精确来源引用，无需重新捕获。上游文件已删除时仍可核对保存的快照；历史快照本身不可读时，结果会保留不可用状态与不完整影响限制，不把它当作已确认的上游删除。只有取得该引用对应的已保存 Git 身份与选区时，才提供显式版本比较。

### 读取或删除捕获证据 {#source-data}

```bash
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --source-version sha256:<source-digest> --json
omk observe knowledge delete-source --workspace ./knowledge --snapshot <snapshot-id> --source-version sha256:<source-digest> --json
```

上游改变或删除后，历史捕获证据仍可读。显式 `delete-source` 留下无内容标记，不改上游文件、已有引文或模型归档，并非彻底清空数据。默认拒绝重新捕获该已删除版本；新选区预览中显式声明 `afterDeletion: "new_snapshot"` 可授权创建新引用，不复活旧引用。来源及工作区导出都可能包含隐私内容；保存、引文匹配与重开均不代表语义验收。

## 接纳统计

`omk observe knowledge quality --workspace ./knowledge --json` 与 Studio 读取当前 `knowledge-body-admission` 投影，逐日志给出状态、已记录正文、阶段状态、正文拒绝数量与 issues，明确 `semanticQuality: not_assessed`；旧版本 unsupported 清单单列。

这些是机械观测，不是提炼准确率、完整率、因果比较、真值、任务成功或费用验收。流程 completed 仍可能包含失败派生投影，正文依然保存；须读阶段与正文详情。CLI `inspect` 保留原生用量及 reported flags。旧 run5 质量分母和历史 typed study 评分不重算，也不混入新日志身份。

## 提取质量检查

保留[历史 typed 标注指南与离线工具](../../specs/entities/entity-extraction-evaluation.md)的测量身份。当前 CLI／Studio 的 study 核对及可携带归档重放只读；旧 typed 生成计划明确不支持，零模型调用。这些记录不验收正文优先流程；正文来源保真与真实任务价值仍需独立绑定来源／请求／版本的验证，不用新契约重算旧运行。

按[核对知识质量](review-knowledge-quality.md)对照选定来源检查完整含义、区分失败层次、修订并重开，记录实际成本与复核限制，再决定可用、继续还是停止。


## 跨窗口核对实体关联 {#review-cross-window-entity-links}

`omk observe entity-links` 核对不同来源窗口的两个实体。名称规范化只负责召回候选，不确认身份。原实体 UUID、分析和知识修订始终独立；接受关联只在库中组织引用，不合并实体记录或重写知识。

1. 运行 `candidates --workspace ./knowledge --analysis <analysis-id> --entity <entity-id> --json`，再核对选定来源和提及。
2. 冻结一次计划并保存完整 JSON。用 `preview --input` 检查**同一文件**；重新 preview 会产生新的稳定 ID 和确认摘要。

```bash
omk observe entity-links preview --workspace ./knowledge \
  --analysis <left-analysis> --entity <left-entity> \
  --right-analysis <right-analysis> --right-entity <right-entity> \
  --executor openai-api --model <model> --json > link-plan.json
omk observe entity-links preview --input link-plan.json
omk observe entity-links propose --input link-plan.json \
  --confirm-input <confirmedDigest> --json
```

`preview` 不请求模型。核对完整固定规则、选定内容、模型、endpoint 和不含凭据的 producer 上下文后，显式填写文件**顶层** `confirmedDigest`。这一 CLI 确认绑定规范化绝对工作区与完整共享 preview；内层 host 确认是独立身份。可重复传 `--mention`／`--right-mention` 限定选中的提及。计划绑定绝对工作区；工作区、请求／证明内容或可观测 producer 配置变化时，`propose` 在启动前拒绝。计划须为不超过 2 MiB 的普通 JSON 文件，不能是软链。其中包含选定来源原文，请按内容权限保存和分享。

当前支持 API producer。它冻结 API 请求、endpoint、相关环境和归档容量证明，不是完整二进制、provider 或宿主认证。Codex 的归档上界尚未证明，因此在进程启动前拒绝。额度是一次明确确认的调用，不是美元金额硬上限；未报告的用量或费用保持未知。没有 fallback 或自动重试，也不恢复 Anthropic 执行。

`propose` 先持久 prepare 再 start。重复同一计划只查看已保存的 review，不再次派发；之后配置或凭据变化也不阻止这一读取。确认响应不明时，先执行 `show --workspace ./knowledge --id <review-id> --json`。仅仍为 `prepared` 的 review 能以 `propose ... --start-prepared` 明确继续同一次尝试，继续前重新检查来源、owner 与 producer 证明。放弃未启动的预约可用 `resume --workspace ./knowledge --id <review-id> --cancel-before-start --request-id <stable-UUID> --generation <generation> --reason "取消已核对计划"`。

`list` 和 `show` 使用共享投影及不可变证据。`show --json` 包含完整原始结果、refusal、用量和事件历史。读取失败 review 仍以 0 成功退出；写操作仍处于 running、unknown、失败或应用冲突时退出 1。参数或计划无效时退出 2。输出 JSON 时，stdout 只含一个机器结果，诊断写入 stderr。

只有人核对两个原始 UUID 确实指向同一对象后才能接受；模型即使判断 `same_object` 也不是人工同意。重放决策须沿用原 request UUID，并使用 `show` 返回的 generation。

```bash
omk observe entity-links accept --workspace ./knowledge --id <review-id> \
  --request-id <stable-UUID> --generation <generation> \
  --reason "已核对两侧原文和身份" --confirm-identity --object-label "完整对象名称" --json
omk observe entity-links reject --workspace ./knowledge --id <review-id> \
  --request-id <stable-UUID> --generation <generation> --reason "身份依据不足" --json
omk observe entity-links resume --workspace ./knowledge --id <review-id> --json
```

拒绝会抑制同一对来源／实体修订，左右互换也一样。`resume` 不调用模型，只处理同一存活 host 中已保留的归档事实或稳定的待应用库意图；新 CLI 进程不能恢复归档前丢失的原始输出。running owner 崩溃后，可用 `resume --recover-unknown --request-id <stable-UUID>` 在证明本机原 owner 已退出后记录 unknown；不按 TTL 推断，不返还已消费额度。核对失败／未知证据后，才用 `--retry-of <prior-review-id>` 创建**新的** preview 并重新明确确认。取消和进程丢失不等于成功交付。存储及恢复边界见[实体关联契约](../../specs/entities/entity-links.md)。Studio 已从当前实体详情的“查找跨窗口对应”接入同一流程，详见 [Studio 复核界面](../../specs/studio/studio-entity-links.md)。真实模型质量验收与独立真人复核仍待完成。
