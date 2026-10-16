---
description: 跨窗口实体提案的冻结参考、分层检查与独立复核契约。
---

# 实体关联提案质量验收

本协议维护 `entity-link-proposal-v1`／`entity-link-suggestion/v1` 的质量标准、测量身份及复核就绪状态。[实体关联日志](entity-links.md)负责生产调用、人工组织决定与恢复；[建设设计](../knowledge/knowledge-domain-model.md)负责阶段交接。合法建议、人工接受知识库组织、独立复核的语义质量是不同结果。

## 1. 版本与语料范围 {#link-evaluation-scope}

初始指南为 `omk-entity-link-annotation/v1`，语料为 `omk-entity-link-quality/v1`，检查器为 `omk-entity-link-checks/v1`，测量为 `omk-entity-link-measurement/v1`，捕获格式为 `omk-entity-link-captures/v1`。它们是 benchmark 契约，不改变生产实体、知识、知识库或调用存储。

`test/fixtures/entity-link-review-v1.json` 包含 12 对公开合成案例：开发与验证各六例，每个 split 的三种判别各有两个参考。语料覆盖明确改名／别名、属性变化、不同部署／版本对象、带作用域标识、组件与实例、仅路径／版本标签相同、助手猜测及来源中夹带指令，不含真实用户对话。

项目及会话不能跨 split。语料 parser 还拒绝跨 split 的相同已选来源内容、重复案例身份及无效实体／提及绑定。这些检查防止已规定的泄漏机制，不证明不存在语义重合。公开、作者编写的验证案例不是隐藏或盲测，也不是总体抽样。输出被查看后须报告该暴露情况，后续提示词调优不能称为未见验证结果。

只有每例的 `input` 进入请求 payload。`expectedAssessment`、`referenceRationale`、`semanticChecks`、split／分组标签及 benchmark 限制留在复核材料中。输入本身包含生产 `left`／`right` 绑定、实体描述、所选提及及来源限制；来源指令始终是数据，不授权读文件或调用工具。

## 2. 三判别参考决定 {#link-evaluation-decisions}

输出捕获前冻结每例参考判别、理由及语义标准。对所选证据应用[身份规则](entity-identity.md)，不把名称或 UUID 字符串当作答案。

| 判别 | 必须具备的证据 | 不足以支持的依据 |
|---|---|---|
| `same_object` | 来源支持两个窗口之间的身份连续性，例如明确改名／别名，以及已知命名空间及有效范围内的稳定标识；解释对应与剩余限制。 | 同名、同路径、版本字符串相同、相关描述、共享组件名或助手猜测。 |
| `different_objects` | 证据明确区分所指，例如不同部署、独立指称的版本对象、带作用域的不同标识，或明确不同的指代层次。 | 未能证明相同。作用域或层次未知不证明不同。 |
| `insufficient_evidence` | 所选证据不能确定身份对应、标识作用域、层次或歧义；说明缺失内容，不猜测。 | 任取一个对象，将来源指令视为权威身份依据，或补造外部语境。 |

属性、管理员、环境或版本条件变化不自动产生新对象；反之，明确实例／版本对象也不因名称重合就成为同一组件。组件与已明确的实例是不同所指；来源连层次本身都未确定时保留未知。未知是否相同与已知不同必须区分。

逐输出核对理由与实际所选提及：左右对应、来源范围、指代层次、身份依据、未知及是否编造事实。判别正确但理由无依据仍是语义问题。不能看见不一致输出后修改作者参考；保留分歧，在冻结新版本前另行裁决。

## 3. 分层检查与分母 {#link-evaluation-checks}

| 层次 | 程序观测 | 解释边界 |
|---|---|---|
| 计划捕获 | `planned`、`recorded`、`unattempted`、`callFailures`、`cancelled`；拒绝未知、重复、输入变化或超计划记录。 | 缺失尝试不是成功空输出，检查器内部错误不是模型失败。 |
| JSON 解析 | `parse_failure`；`parseFailureRate = parseFailures / outputCount`，无输出时为 `null`。 | 未捕获输出的调用不进入该分母。 |
| 响应 Schema | `schema_rejection`；`structureRejectionRate = schemaRejections / (outputCount - parseFailures)`，无解析成功输出时为 `null`。 | 此比率不含绑定拒绝及语义错误，后两者分别报告数量。 |
| 所选证据绑定 | `binding_rejection` 或 `admitted`；核对精确左右实体 ID、提及 ID 唯一且属于对应侧已选集合。 | 引用闭合不证明身份正确或理由得到支持。 |
| 作者参考一致性 | 只对已接纳输出记录 `authorReferenceCompared`、`authorReferenceMatches` 及逐项分歧。 | 这是与作者标签的一致性，不是独立准确率，也不评分理由。 |
| 语义复核 | 每条保持 `rationaleReview: pending`，汇总保持 `semanticReview: pending`、`qualityConclusion: not_evaluated`。 | 人工须核对理由与冻结标准，checker 不把一致性升级为语义通过。 |

保留原始输出、原始用量观测及全部失败记录。捕获记录可携带实际非负 `durationMs` 及已报告 `costUSD`，缺费用时省略。`reportedCostUSD` 只覆盖已报告记录；仅当完整计划均已记录且每条都报告费用时，`totalCostUSD` 才非 `null`。规范化零值或部分费用覆盖均不证明完整运行零成本；计划但未尝试的工作与已记录尝试费用分开。

离线命令对未尝试或任何未接纳记录非零退出；判别不一致本身不触发失败退出。成功退出只表示结构检查完成，不代表语义或独立验收。生产[工作区质量观测](entity-links.md)使用自身的核对／调用／接纳／决定分母，不是本语料的质量分数。

## 4. 作者与独立复核 {#link-evaluation-review}

复用提取标注记录格式，绑定本测量身份与完整案例集：

| 记录 | 必需字段与含义 |
|---|---|
| 作者 | `selfReviewVersion: omk-entity-author-review/v1`、`measurementId`、语料作者 `reviewer`、`reviewedAt`、`reviewedBeforeOutputs: true`，以及每例一条含 `caseId`、`approved`／`changes_requested` 及理由的 `decisions`。 |
| 独立真人 | `reviewVersion: omk-entity-annotation-review/v1`，相同身份／时间／案例覆盖，`reviewKind: independent-human`、`reviewedBeforeOutputs: true`、`independenceAttestation: true`，以及含案例、问题、结论与独立裁决人的 `disputes`。复核人不能是列出的语料作者。 |

两份记录都须精确覆盖每例一次，且早于输出捕获；未来时间、错误身份、缺项及作者自称独立均被拒绝。争议须在输出前裁决，否则保持 `changes_requested`。这些检查验证记录闭合与声明，不验证复核人的真实身份或语义判断正确。另一个 AI Agent 不等于独立真人复核人。

只有作者完成时可以 `exploratoryReady: true`，缺少独立复核仍为 `pending`，`goldReady: false`。`goldReady` 同时要求作者完成与 `attested_independent_human`；任一已提供的 `changes_requested` 阻断两种 ready。标注就绪仍不核对后续输出理由，也不完成质量验收。输出判断分别记录，不能从模型建议或知识库决定制造真人记录。

## 5. 测量身份与零调用准备 {#link-evaluation-identity}

测量身份绑定 corpus／guide／check 版本、原始语料字节、双语指南字节、已编译 checker 组件、已构建生产 runtime 树、包清单／锁文件、实际 Zod validator 版本／目录树、Node 版本／二进制，以及精确受治理 prompt 版本／原始 UTF-8 摘要与响应 Schema 摘要。runtime 与 validator 树摘要覆盖 `.js`／`.json` 路径及字节，checker 包含共享标注组件。包／锁文件摘要记录依赖声明，不代表全部已安装传递依赖字节。任一绑定字节变化都需要新冻结包及复核记录，重建不自动保证身份不变。这是已声明产物闭包，不代表捕获全部操作系统、账号、凭据或 provider 状态。

先更新 runtime 构建，再创建新的仓库外复核包：

```bash
yarn build:runtime
node dist-scripts/bench/entity-link-review.js \
  --corpus test/fixtures/entity-link-review-v1.json \
  --output /private/tmp/omk-link-review-unique
```

输出必须是绝对路径，即使经过软链也须在仓库外，父目录已存在、目标未存在。包保存 manifest、原始语料、双语指南、精确 system 与响应 Schema、无参考答案的逐例输入及未签署的作者／独立模板。本命令不导入执行器，模型调用为零；准备及标注复核均不授权执行。

实际核对全部案例后，通过 `--self-review /absolute/self-review.json` 提供记录；可选 `--review /absolute/independent-review.json`，使用另一个新的 `--output` 目录。`--captures /absolute/captures.json` 只检查既有输出，不调用模型。捕获绑定该 `measurementId`、单一 split、一或两次声明重复、开始时间、执行器／模型及案例／重复序号／输入摘要；未知、重复与额外 slot 不能静默加入。

## 6. 显式真实捕获与恢复 {#link-evaluation-live}

`entity-link-live` 是单独确认的 benchmark runner，使用生产请求 adapter 与 Codex 执行器。它不证明 Codex 满足生产持久日志的容量契约，该 host 仍负责自身支持的 producer 边界。live plan 绑定测量包、作者记录、精确逐例请求、实际 runtime／checker／依赖／validator／Node 身份、runner 与 Codex 二进制、模型、split 及所选 slot。

从作者批准的包创建计划。以下只选择六个开发案例各一次，不执行：

```bash
node dist-scripts/bench/entity-link-live.js prepare \
  --repository /absolute/path/to/oh-my-knowledge \
  --bundle /private/tmp/omk-link-reviewed-unique \
  --out /private/tmp/omk-link-live-development-unique \
  --executor codex --model gpt-6.1-sol --max-calls 6 \
  --split development \
  --cases dev-component-rename,dev-component-properties,dev-separate-deployments,dev-version-objects,dev-path-only,dev-assistant-guess
```

验证分区使用另一个 plan 及输出目录，提供冻结语料中的六个 `val-*` ID。每例要求一个唯一 slot，`maxCalls` 必须等于所选案例数。私有工作目录排除项目指令，runtime 默认的全局技能与推理力度仍属于已声明 Codex 上下文。受治理 system 由请求 adapter 前置，不声称是 CLI 唯一的全局 system 上下文。

核对 `plan.json` 及其精确输入／模型／限制后，明确确认实际 `planId`：

```bash
node dist-scripts/bench/entity-link-live.js execute \
  --repository /absolute/path/to/oh-my-knowledge \
  --out /private/tmp/omk-link-live-development-unique \
  --confirm-plan 'sha256:<actual-plan-digest>'
node dist-scripts/bench/entity-link-live.js check \
  --repository /absolute/path/to/oh-my-knowledge \
  --out /private/tmp/omk-link-live-development-unique
```

每次调用前 runner 独占发布 reservation，派生接纳、用量及捕获记录前归档完整执行器返回 JSON。已预约但无 native 证据的 slot 保持 unknown，绝不重发；已有 native 可重建派生记录，已完成 slot 不重复调用。失败、非法输出／绑定、观测到工具、明确未报告用量或未知预约 slot 均停止执行，不自动重试。只读 `check` 不调用模型，报告 `complete` 与 `stopped`，须读取这些值，不能把退出零当作验收完成。

`maxCalls` 只限制 OMK invocation，不限制内部 provider 请求、token 或美元。Codex 费用在执行器明确报告前为未知，取消及进程丢失不能撤销已消费请求或费用。不能把规范化 `costUSD: 0` 当作已报告账单。native 输出、预约、派生记录及 `captures.json` 是仓库外私有证据，随后在新复核包中运行离线 checker 报告分层结果。本协议规定运行方法，不预先声明任何模型结果。

## 7. 比较与完成边界 {#link-evaluation-completion}

比较前冻结 split、抽样、重复、模型、实际请求、runtime、预算及复核标准，逐例失败与不一致连同分母报告，不筛选成功结果。提取 prompt-json 与 strict 请求遵循[提取评测协议](entity-extraction-evaluation.md)，各自保留 wire／prompt 身份及 parse／structure 数量。同时改变 prompt 示例与输出模式的比较，测量的是完整请求差异，不是 Schema 约束的独立因果效果。

本语料的严格语义验收要求：所有计划记录齐全；无调用／解析／Schema／绑定失败；符合输出前已裁决的参考；全部输出理由及语义标准经独立逐项复核，无未解决问题。输出后出现的标注争议仍是本轮限制；修改参考须新冻结版本，不重判旧结果。缺失独立证据须保持显式；作者复核的探索性结果可支持开发，但不能称为 Gold 或完整质量验收。小规模合成结果不证明整体准确率、稳定性、真实对话覆盖、自动跨 Agent 身份或任务收益。
