# 沉淀、维护和使用知识

从选定的工作记录形成候选，核对后保留到知识库，修订过时内容，再维护引用它的载体。保留、保存载体和验证效果各有自己的记录。第一次使用可以先走 Studio；命令行步骤在后面。

知识库、载体生成与变化核对的核心流程需要 **1.0.0-beta.14 或更新版本**。本指南描述当前 main 实现；本轮 CLI 指引、读取重试和保存恢复修复尚未包含在已发布的 Beta.14 中，需等待后续 `@next` 发版或从当前源码构建。安装后先运行 `omk --version` 核对。升级前阅读[迁移指南](../maintenance/v1-preview-migration.md)。

## Studio {#studio}

```bash
omk studio
```

使用命令返回的地址，先核对当前知识保存位置。改变默认目录不会移动已有数据。

1. **选择来源**：打开对话，在对应轮次选择“提炼这轮”，或从知识页“从对话选择”。核对消息、保存位置、执行器和模型，再确认开始；此时才调用模型，可能产生费用。
2. **核对候选**：阅读陈述、条件、例外和未知信息，点击“查看依据”回到原文。填写理由后保留、舍弃或修订；新修订需要重新核对。
3. **按需核对实体**：从候选或“知识 → 实体”检查名称、指代、层次与原文。实体纠正不会自动改写知识；确认后显式应用精确修订。
4. **持续积累**：从“知识 → 知识库”建立对象，核对不同窗口的来源实体是否谈论同一对象，填写关联理由并确认。同名不自动归并；先处理歧义与来源缺失。
5. **修订与更新**：知识变化后，载体详情提示待核对项。逐项阅读新旧修订、保留／舍弃变化和来源，再明确选择本次更新内容；旧版本仍可回看。
6. **生成与保存载体**：从匹配的已保留知识选择 skill／prompt，核对正文和精确来源，保存为版本。生成只组织现有内容，不额外调用模型；更新重建本次选定的知识区，保留区外手工内容和依赖资产。
7. **验证改动**：在载体详情选择验证入口，声明用例、对照和模型，核对预览后再启动。结束后先看运行与证据状态，再读结论；保存和使用不代表效果已验证。

候选页可切换内容与原始依据，实体与知识库列表支持窄屏切换。失败、零候选、取消或来源缺失都有明确状态；从提炼记录和知识待办找回已保存内容。

知识库、实体与载体页显示当前知识目录；显式目录的读取不依赖模型设置。读取失败时原位重读，填写的组织草稿仍保留。实体应用遇到冲突时保留角色与理由，重读知识后再明确应用。通用服务器失败或不可读保存回执不能证明未写入；先选择“核对已保存版本”，组织按本次收据、载体按内容与精确引用确认，避免重复保存。等待期间内容保持只读且可复制，保存和核对都不额外调用模型。

### 对话自动提炼与项目待办 {#对话自动提炼与项目待办}

自动提炼是可选入口。先预览选定对话的消息、目录、模型与调用次数，确认发送授权后开启；授权限当前对话、24 小时及当前服务生命周期。次数上限不是金额预算，失败或中断停止，重启不自动恢复。知识待办汇集候选供核对，不自动决定保留或改写载体。

## 选择来源并生成 {#选择来源并生成}

CLI 与 Studio 使用同一知识工作区。先明确来源范围，`capture` 只做本地归档，`generate` 才调用所选模型；以下路径、身份和模型须替换为实际值。

```bash
omk observe knowledge capture --workspace ./knowledge --source ./session.jsonl --json
```

```bash
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --json
omk observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model> --json
omk observe knowledge list --workspace ./knowledge --json
```

可用 `--start-record`／`--end-record` 限定非空行范围（零起始、含首尾）；先读取快照核对范围和限制。支持的执行器与当前格式见[实体提取契约](../../specs/entities/entity-extraction.md)。生成只发送选定片段，仍须检查其中的私有内容。

生成前会检查包含固定规则与所选片段的 system 加 input 文本，UTF-8 合计上限为 1 MiB；这不是 HTTP body、token、模型上下文或金额预算。超限时不调用模型、不创建提炼运行，也不消耗自动提炼的调用次数；原文不会被截断。请重新归档较小范围，或在 Studio 选择一轮中的较少消息。`omk agents extract` 同样支持 `--start-record`／`--end-record`，无需修改采集报告。

可导出当前构建派生的 JSON Schema，检查或冻结默认生成使用的 strict 结构线协议；`--json` 同时包含协议身份和保留在宿主的检查。该操作不读取知识工作区，也不调用模型：

```bash
omk observe knowledge schema
omk observe knowledge schema --json
```

strict 结构线协议要求全部字段必填，仅对可选的 `object`、`occurrence` 使用 nullable 占位。默认生成使用该协议，解码占位后再进入现有宿主接纳检查。默认配置生成使用无 few-shot strict prompt v15 并绑定其完整 system 摘要；领域响应 Schema v4 不变，作者 prompt-json 端口仍用原 v14。prompt、wire、完整请求与 pipeline 分别有自己的身份；本次不激活四正例候选，也不继承历史 prompt-json 质量结果，不宣称完成新的真实模型验收。不支持的执行器能力在派发前拒绝，不回退为仅靠 prompt 约束输出。逐字证据与语义检查仍由宿主负责。导出 Schema 不代表已验证具体 provider 的支持能力或模型质量。

默认文本摘要显示当前知识工作区和带同一 `--workspace` 的下一步命令；未配置模型时，`generate` 仍须显式传入 `--model`。`--json` 保持完整机器结果，提示不混入 JSON stdout。必要参数与 JSON 语法在读取设置或存储前检查；参数失败退出 `2`，业务失败退出 `1`，成功退出 `0`。修订冲突提示重读命令，工作区忙时等待当前写入结束再重试，不删除活跃锁。维护决定与效果验证分别呈现。

## 核对与处理 {#核对与处理}


```bash
omk observe knowledge show --workspace ./knowledge --id <knowledge-id> --json
omk observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --reason '后续处理本项目时参考'
```

从最新 `show` 结果读取修订身份与 `history.generation`。`discard` 使用同样参数，记录舍弃理由，不删除历史。并发修改导致版本冲突时，重新读取并核对差异，不能盲目重试旧内容。

修订输入只包含 `title`、`content`、`entities`、`evidence`，可从 `show` 的 `revision` 中取这四项保存为 JSON。修改标题、陈述、上下文或证据解释后执行；绑定实体分析的知识须通过下一节修改实体名称或对应：

```bash
omk observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 2 --input ./draft.json --reason '补充适用条件'
```

使用实际读取的 generation，不照抄示例数字。修订生成新版本，旧内容和处理理由仍保留，新版本不继承旧版本的保留选择。原文位置继续绑定；新提及或实体必须在同一分析的原文中纠正，不能凭空填入引用。新来源窗口需要新的提炼。可用 `show --revision <old-revision-id>` 查看旧版本。


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

纠正实体保存新修订，不覆盖已生成的知识。将选定实体修订应用到知识时，先核对每条陈述的主体／对象；从实体修订取所引用实体的 `entityId`、`label`、`description`，写入知识草稿的 `entities`。拆分后明确选择新主体／对象，再执行：

```bash
omk observe knowledge apply-entities --workspace ./knowledge --id <knowledge-id> --revision <knowledge-revision-id> --generation <read-knowledge-generation> --analysis <run-id> --entity-revision <chosen-entity-revision-id> --input ./draft.json --reason '明确陈述中的对象' --json
```

此操作创建知识新修订并绑定精确的实体分析修订。默认保留原附加身份不确定性；可通过 `--identity-uncertainties '["核对后仍需保留的说明"]'` 明确更新，`'[]'` 清除原说明，当前实体分析中的不确定性仍自动保留。陈述中的条件与未知信息另在知识修订中核对。原实体分析、原知识及维护决定均可回看；新知识需重新决定保留或舍弃。仅限同一来源窗口，来源快照不可用时不能纠正或应用。独立实体结果允许零对象，也不要求同时存在知识候选。详见[实体提取设计与限制](../../specs/entities/entity-extraction.md)。


## 组织与检索知识 {#组织与检索知识}

在知识详情保存主题标签，按标题或 `tag:主题` 检索。标签是用户维护的组织信息，不改写正文修订或保留决定；字段和容量见[知识维护契约](../../specs/knowledge/knowledge-maintenance.md)。

## 围绕实体积累知识 {#围绕实体积累知识}

按照 Studio 第 4 步明确确认来源关联。对象知识默认展示已保留且修订匹配的条目；关联待核对、空对象与不可读数量有各自状态。完整关联、历史及恢复规则见[知识库契约](../../specs/knowledge/knowledge-library.md)。

## 生成并保存知识载体 {#生成并保存知识载体}

按照 Studio 第 6 步保存。每次选择的精确知识修订构成本版本的引用集合；知识区外手工内容与依赖资产保留，历史版本不改写。保存路径和 metadata 见[知识维护契约](../../specs/knowledge/knowledge-maintenance.md)，不把载体属性当成回写知识库的入口。

## 从载体验证改动 {#从载体验证改动}

按照 Studio 第 7 步核对并运行。启动结果未读到时先核对状态，避免重复调用；运行失败、取消和中断分别保留。正式用例、退出码和报告范围见[评测指南](../evaluation/index.md)。

## Codex 版本检查 {#codex-版本检查}


OMK 使用当前进程 PATH 中的 `codex`。先执行 `codex --version`；若服务器报告模型需要更新客户端，应升级或明确选择兼容的现有客户端，不必切换模型或 API。桌面应用与命令行可能使用不同版本。


## 中断与来源管理 {#中断与来源管理}


`generate --run-id <UUID>` 可为一次请求指定稳定身份。重复相同请求不会再次调用模型；修改来源或运行配置时不要复用该身份。一个 v5 run 只允许一次 OMK invocation，不自动重试或 fallback；reask、瞬时失败重试与累计预算策略仍未完成。

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

`resume` 只归档同一 application 实例仍持有的原结果、读取已保存的原生 outcome，或完成稳定待写意图，不调用模型。已启动调用若在进程退出时丢失尚未保存的结果，其结果与用量保持未知。进程退出不证明请求未发送或费用为零，也不退款或授权补发；先检查记录，再显式用新的 run 身份开始新请求。失败或取消不代表完整候选已交付。

新 metadata 位于 `extraction-runs/<run-id>.json`，完整不可变原生 outcome 位于 `extraction-runs/outcomes/<run-id>/<attempt-id>.json`。原 `runs/` v4 文件保留原样，不读取或迁移：旧详情、恢复、对话／项目批次及接纳统计不可用。已有当前来源快照、实体历史 v2 与知识历史 v2 仍可在同一工作区读取，不要求空工作区。

工作区含来源快照、候选修订及生成原始输出。它们可能包含私有内容，应按本地数据管理。`delete-source --snapshot <snapshot-id>` 删除来源快照并留下不可用标记，不修改原日志，也不擦除知识修订或生成输出中的引用文字；不要将它当作工作区的彻底清除。来源缺失、损坏或删除后，候选仍保留，但不能再声称原始依据可完整核对。

首次使用请逐条记录来源忠实度、适用范围、未来复用价值，以及误提炼、遗漏和修订原因。自动测试不能替代这项判断。


## 接纳统计

`omk observe knowledge quality --workspace ./knowledge --json` 与 Studio 的**提炼记录 → 结构接纳统计**共用只读投影 `omk.extraction-quality/v2`，范围为选定工作区 `extraction-runs/` 中的当前 v5 run；不调用模型，不用当前检查器重判历史。原 `runs/` 文件不进入此投影，缺席不代表工作区从未提炼过。分组绑定 prompt 版本／摘要、执行器、请求模型、run Schema 版本、policyId、outputMode、wireId（或 null）、producerId 与 producerRevision；这些维度不证明 endpoint 或完整运行条件相同，计数也不是质量因果实验。每个 run 的已保存出生接纳只计一次，原生 outcome 证据不增加候选分母。后续实体纠正、知识修订和维护决定不改变生成计数。

实体、提及和知识提案的接纳率为汇总接纳数除以汇总接纳数与拒绝数之和，不平均各 run 的百分比。标识符碎片拒绝率以全部已记录提及项为分母。逐字定位分别显示通过、拒绝、未检查、未知：已接纳提及及定位后拒绝理由能证明执行了位置检查，结构／重复 ID 拒绝发生在定位前；未知理由不作解释。未检查项不进入定位分母；未知检查记录、历史实体拒绝列表缺失或尚无接纳记录，会使相应比例未知。空分母为 `null`，不显示 100%。

失败、取消、生成中、尚无接纳记录，以及零接纳／零知识提案接纳的运行分别显示。同一项可有多个拒绝理由；引用／依赖拒绝数不证明因果级联，位置匹配和结构接纳不证明语义准确、召回或知识价值。当前 run 目录中损坏或不支持的文件使查询失败，Studio 提供重读，不显示为健康空库；原目录保留文件不进入查询。来源、提示词、原始输出、保存的 run 和历史分数都不会改写。

## 提取质量检查

使用[现行标注指南与离线工具](../../specs/entities/entity-extraction-evaluation.md)。生成复核包不调用模型，不证明整体质量通过；历史结果仅在对应冻结版本复现，不用现行产物重算。


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
