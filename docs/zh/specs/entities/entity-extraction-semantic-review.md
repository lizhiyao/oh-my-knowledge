---
description: 对冻结的实体提取输出逐项语义复核，并形成保守的范围内裁决。
---

# 实体提取输出语义复核

本规范维护职责矩阵及**生成输出之后**的离线复核。[提取评测协议](./entity-extraction-evaluation.md) 保留既有标注、捕获、检查器和输出前参考标注复核契约。[身份规则](./entity-identity.md) 和 [提取契约](./entity-extraction.md) 继续维护领域含义与执行不变量；本页不重定义这些规则。

首轮实现只覆盖已捕获的公开合成回归，不执行模型、不修改生产 run 或历史、不改变 prompt，也不构成独立真实语义验收。原始输出、结构拒绝和旧结论完整保留。新复核是对这些证据另行标识的分析。

## 1. 规则、职责、例子与版本

下表把现有规则映射到执行和验证职责。例子说明边界，既非新参考标注，也非模型质量证据。完整正反例仍由链接指向的规则正文维护。

| 规则归属 | 确定性执行与验证 | 上下文复核职责 | 正例／反例边界 |
|---|---|---|---|
| [对象范围与粒度](./entity-identity.md) | 校验声明的实体结构与引用闭合，不用名称黑名单判定对象含义。 | 逐项检查所有接纳实体的来源依据、独立讨论的概念、属性与过度拆分；在案例层检查遗漏。 | 保留被独立讨论的 Session 概念／不为每个计数或数值建实体。 |
| [Issue/PR 收集范围](./entity-identity.md) | 显式纠正时保留来源和知识 context，不靠去编号制造概念。 | 按当前收集范围区分 Issue/PR 概念与具体编号工作记录；这不是普遍排除具体对象。 | 保留被讨论的 PR 概念，并在案例 context 留工单链接／不因命名了 PR #1282 就单独建实体。 |
| [提及边界与归属](./entity-identity.md) | 校验原文引文、出现序号、UTF-16 位置和重复分配。 | 检查所选短语是否指向目标对象，并保留必要归属和限定；精确位置本身不能证明这些。 | 限定文件短语指向文件／不把整个短语分给所属项目。 |
| [共指与歧义](./entity-identity.md) | 校验身份／引用闭合、候选层级与结构性不确定约束。 | 参照完整来源窗检查别名、代词、同名和无依据消歧；独立人工身份决定另行署明责任。 | 保留带理由的歧义指代／不无依据选择一个同名候选。 |
| [指代层级与关联](./entity-identity.md) | 校验组件／成员引用、支持层级、环和必要提及。 | 检查组件／实例／版本／集合含义，以及限定或结果是否被无依据转移。 | 实例失败保留在该实例／不把组件成功移给它。 |
| [知识端点与覆盖](./entity-extraction-evaluation.md) | 定位接纳陈述、来源锚点和预声明角色；保留必选与可选覆盖之别。 | 检查主客体、关系方向和全部必需信息；区分必需知识缺失与可选知识未选择。 | 在选中知识中保留字段值、类型和条件／不把端点命中算作知识完整。 |
| [极性、模态、条件与例外](./entity-extraction-evaluation.md) | 校验表示与绑定，不用关键词分类器给语义通过。 | 每条陈述按单一命题、统一极性／模态检查，并核对范围与例外。 | 分开表达交付已完成和质量尚未验收／不把二者合成一条正向完成陈述。 |
| [时间与证据等级](./entity-extraction-evaluation.md) | 校验时间／证据结构及 citation 闭合。 | 区分消息时间与事实时间、计划与执行、来源主张与观测或外部核实的真相。 | 无依据时保留事实时间 unknown／不把消息时间戳变成精确事件时间。 |
| [纠正、冲突与历史](./entity-extraction.md) | 保留不可变原始记录、精确 revision 绑定、显式新 revision 及拒绝／恢复路径。 | 检查后续纠正、未解决冲突和发言归属；纠正不得强化原证据。 | 用新 revision 及证据纠正归属／不复用旧身份改义或覆盖出生结果。 |
| [元数据与截断来源](./entity-extraction-evaluation.md) | 保留冻结输入及声明的限制。 | 检查指令／元数据污染、不完整上下文和无依据补全；窗口缺失的证据保持未知。 | 把环境消息标为元数据／不将其当作用户主张的事实。 |

领域规则使用指南 `omk-entity-annotation/v11` 和语料 `omk-entity-quality/v13`；确定性关键检查仍为 `omk-entity-critical-checks/v5`。生产 prompt-json `knowledge-extraction-v21`、strict `knowledge-extraction-v22`、response Schema v4、run v5 和 quality projection v3 保持各自身份。新输出复核协议拥有独立 v1 身份；加入它不会静默升级旧指南、重算历史分数或迁移存量 run。时间指引与示范字节变化显式标记 **BREAKING-COMPARABILITY**，不证明语义通过；逐项时间复核仍然必要。

## 2. 在输出前冻结复核范围

`omk-entity-semantic-plan/v1` 包含 `measurementId`、`declaredAt`、`split`、`repeats`、全部选定 `caseId`、`criteria` 及其派生 `planId`。criteria 必须显式提供四个字段：`maxConfirmedErrors`、`confirmedErrorsRationale`、`maxRequiredGaps` 和 `requiredGapsRationale`，没有默认容错额度。既有 capture v1 支持 development／validation 和一或两次重复；这是格式限制，不是统计样本量依据。measurement 对应原语料、双语指南、检查器、prompt、runtime、依赖与 Node 环境。全部计划案例与预声明义务持续可见；只挑成功输出不是有效计划。

检查器要求计划声明时间不晚于捕获开始时间。`prepare` 使用当前时间，拒绝已经含 `captures.json` 的 bundle；它无法检查所有外部副本中先前已见的输出。既有 `omk-entity-captures/v1` 不含语义计划标识，因此离线检查绑定声明时间与**捕获文件原始字节摘要**，无法证明原传输或执行曾强制遵守该计划。结果持续披露这个可审计限制。复用已有捕获属于再分析，不是新模型执行、新独立样本或追溯式预注册。

冻结来源、参考标注和捕获字节保持可用。计划变化产生不同 `planId`；复核决定变化须使用新的仓库外结果目录，保留旧 receipt 和报告。输出复核 receipt、参考 receipt 或编译后语义工具字节变化会产生不同的派生 `reportId`。语义协议变化须显式升级版本，不复用旧结论。这些变化不替换原始证据，也不让已见案例重新变成未见。本工具不授权数据传输、模型调用或重试。

| 身份 | 维护范围 |
|---|---|
| `omk-entity-semantic-plan/v1` | 声明的 measurement、案例、重复范围和显式容错标准；`planId` 由计划正文派生。 |
| `omk-entity-output-review/v1` | 绑定计划及精确捕获摘要的复核人声明与逐项裁决。 |
| `omk-entity-semantic-report/v1` | 派生的范围内裁决、复核覆盖、阻断与证据限制；`toolDigest` 记录编译后语义工具字节，`reportId` 绑定完整派生报告。 |

## 3. 逐项核对输出与义务

逐项复核覆盖所有接纳实体、提及和知识陈述、每个预声明角色、每条案例语义标准，以及案例整体。输出单元绑定精确的捕获案例／重复与条目身份。即使返回条目很少或知识为空，必需角色缺口、范围外提取和案例级遗漏也必须可复核。

每个单元均参照完整冻结窗记录决定与具体理由。正确来源引文不证明含义正确。陈述复核包括端点、关系、极性、模态、条件、例外、时间、citation，以及主张／观测／计划状态。一个条目结构拒绝可能造成依赖级联拒绝；这些保留为工程证据，不冒充多次独立成立的语义错误。

`omk-entity-output-review/v1` 绑定 `planId` 和 `capturesDigest`，记录 `reviewer: { actorKind, actorId }`、`independentHuman`、`reviewedAt` 与 `decisions`。`actorKind` 为 `agent` 或 `human`；agent 不能声明独立人工复核。每项决定绑定 `target`、`verdict`、`errorCodes` 及非空 `rationale`。target 均包含 `caseId`、`repeat` 和 `itemKind`：

| `itemKind` | 补充身份 |
|---|---|
| `entity` | `entityId` |
| `mention` | `mentionId` |
| `statement` | `proposalId` 与 `statementId` |
| `role` | 预声明 `roleKey` |
| `semantic_check` | 从零开始的 `checkIndex` |
| `case` | 无；复核整个案例／重复 |

verdict 词表为 `correct`、`incorrect`、`uncertain`、`required_missing` 和 `optional_not_selected`；决定必须适用于对应 target，不能用来跳过输出复核。协议校验覆盖和声明，不验证人的真实身份或判断正确性。复核人显式声明自己的角色。AI 复核可以发现缺陷并支持探索，不能代替独立人工通过。独立复核声明和参考标注准备度不证明来源主张的真实性。未解决分歧与缺失复核显式保留。

## 4. 保守裁决

结果使用以下四种状态。已知阻断条件优先于待复核状态。

| 状态 | 所需证据与限制 |
|---|---|
| `pending` | 尚无 receipt、缺少 target 决定或仍有 `uncertain` 决定，且没有已知阻断。 |
| `blocked` | 已知工程／参考标注／计划阻断、关键语义错误，或超过预声明错误／缺口上限。缺失复核不能遮蔽已知阻断。 |
| `exploratory_reviewed` | 逐项复核完整明确且在声明限额内，但只有 agent／作者复核或缺少独立参考标注准备度；不是独立通过。 |
| `accepted_within_scope` | 全部工程和语义门禁、原始双记录参考准备度，以及由非语料作者的独立人类声明完成的完整输出复核。 |

工程阻断包括调用／解析／捕获失败、结构拒绝、取消、未尝试记录和计划声明过晚。原关键提及／身份检查须满足冻结回归门禁，无法评估的单元不能作为通过证据。参考记录要求修改时阻断复核，不能被输出 receipt 覆盖。

`countingUnit: review-decision` 把 `incorrect` 裁决条数计为已确认错误，把 `required_missing` 条数计为必需缺口。这是复核裁决数，不是独立根因数或总体准确率。`optional_not_selected` 仅适用于 `if_selected` 角色，不增加错误或缺口。错误代码词表为 `scope`、`boundary`、`identity`、`referent_kind`、`unsupported_qualifier`、`relation`、`polarity`、`modality`、`conditions`、`time`、`coverage`、`provenance` 和 `unsupported_fact`。含 `identity`、`provenance` 或 `unsupported_fact` 的 `incorrect` 决定总是阻断验收，即使汇总限额允许它们。其他错误和必需缺口按计划显式上限及理由判定，不藏在平均分里。

`goldReady` 继续只表示旧的**输出前参考标注**准备度。本协议不重建或覆盖该标志。只有 AI 的输出复核不能产生独立通过；无阻断时最高结论为探索复核。`accepted_within_scope` 仅适用于所声明的有限合成回归范围及其已有证据，不代表真实分布总体 precision／recall／F1、发布达标、独立真实验收或已经核实的事实库。

结构成功、语义忠实、身份确认、知识保留和外部真相核实分别判断。纠正不提高原 run 的出生质量。缺少可选条目不是错误，也不是知识关联成功的证据；必需知识缺失仍是缺口。

## 5. 离线执行与证据保留

构建 runtime／scripts 后，使用已有输出前复核 bundle 和包含四个 criteria 字段的 policy JSON 声明计划：

```bash
yarn build:runtime
node dist-scripts/bench/entity-semantic-review.js prepare \
  --bundle /private/tmp/existing-entity-review-bundle \
  --policy /private/tmp/semantic-policy.json \
  --split development --repeats 1 \
  --output /private/tmp/new-semantic-plan
```

捕获后先不提供 receipt，枚举精确复核 target 并取得 pending 报告／模板：

```bash
node dist-scripts/bench/entity-semantic-review.js review \
  --bundle /private/tmp/existing-entity-review-bundle \
  --plan /private/tmp/new-semantic-plan/plan.json \
  --captures /private/tmp/captures.json \
  --output /private/tmp/new-semantic-pending
```

按实际逐项判断完成模板，保留原始模板原样。再次执行 `review`，传入 `--receipt /private/tmp/completed-output-review.json` 并使用另一个新的仓库外输出目录。空模板或复制的声明不构成复核。

命令没有 executor／model／endpoint 参数，模型调用为零。它核对原 measurement manifest、UTF-8 原始语料和双语指南、原编译检查器、runtime／prompt 字节、依赖与 Node 版本；不匹配时需要原构建，不会静默套用当前规则。它用固定生产校验器重算结构接纳，不信任已有检查结果或 ready 标志。

`prepare` 只写 `plan.json`。`review` 原样保留 `plan.json`、`captures.json` 和 `corpus.json`，写入 `review-targets.json`、`review-template.json` 和 `report.json`；传入的 receipt 原样保存为 `output-review.json`。已有作者／独立参考 receipt 分别原样保存为 `reference-self-review.json` 和 `reference-review.json`；`report.referenceReceiptDigests` 记录两者摘要，缺失时为 `null`。`outputReviewDigest` 是传入输出 receipt 原始 UTF-8 字节的 SHA-256 摘要，缺失时为 `null`。`reportId` 是完整报告对象排除 `reportId` 自身后经 `JSON.stringify` 序列化的 SHA-256 摘要，包含 receipt 摘要与 `toolDigest`。原 bundle 及其指南和参考复核记录也须保留。输出目录必须是父目录已存在的仓库外新绝对路径；拒绝指回仓库的软链和覆盖。目录权限为 `0700`，文件为 `0600`。不修改旧捕获、生产 workspace 或历史。

标准输出是一条 JSON，含 `output`、`status`、`modelCallsByThisCommand` 和 `exitCode`。计划准备成功退出码为零。复核仅在 `accepted_within_scope` 时退出零；`pending`、`blocked` 和 `exploratory_reviewed` 非零退出但保留报告。数据、身份或路径无效时非零退出，不产生伪通过。

报告区分工程失败、待复核单元、语义错误与必需缺口。成本、usage 和耗时只取原捕获记录；缺失值保持 unknown。复核劳动及后续模型评委调用需要单独证据，不得记为原生成器成本。

## 6. 真实验收仍需的证据

独立真实验收需要另行授权、未用于候选调优的真实来源，项目／会话／来源分组及重复 lineage 证据、冻结参考义务及允许等价表达、基于风险的指标与阈值，以及有依据的样本量／停止策略。公开合成案例、相邻复制／脱敏窗及对已见输出的再次复核不提供这种独立性。

真正独立的人类须复核参考标注及生成输出、裁决争议，并在报告模型评委质量结论前用这些人工决定校准语义评委。AI 初筛、另一个模型或绿色 CI 不能替代这些证据。既有 [统计方法](../../explanation/statistical-rigor.md) 仅在样本单元与指标前提成立时复用；相关提及对不是独立样本，零次观测错误也不代表零风险。

工程可以自主准备这些包、确定性检查和报告。所需独立证据未齐时，真实语义验收保持未完成，如实报告已观测范围及剩余限制。生产 CLI／Studio 展示与锁定真实 baseline／candidate 研究属于后续共验证交付边界。
