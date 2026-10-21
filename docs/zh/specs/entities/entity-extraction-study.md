---
description: 冻结真实提取研究，回放生产原生结果，并区分工程证据与独立语义验收。
---

# 真实提取研究

本规范维护仓内工具及共用研究原语，在[评测协议](./entity-extraction-evaluation.md)和[输出语义复核](./entity-extraction-semantic-review.md)之外建立独立标识的真实来源研究。它不替换生产提取流程，不新增工作区存储，也不判定发布资格。

## 1. 范围与身份

语料、计划、参考复核、输出复核、分析和原始生产运行分别标识。声明或分析变化产生新证据，不改写历史 run，也不会让已见来源重新变成未见。

| 身份 | 范围 |
|---|---|
| `omk-extraction-study-corpus/v1` | 冻结选中来源窗、分组、曝光状态、参考范围与义务；`corpusDigest` 绑定规范化语料正文。 |
| `omk-knowledge-extraction-study-configuration/v1` | 显式 actor、选中 split、重复、变化变量、抽样、门槛与两个实验臂配置。 |
| `omk-knowledge-extraction-study/v1` | 输出前执行声明、精确语料／配置字节摘要、宿主、prompt、输入、producer 证据及有序 slot；`planId` 绑定正文。 |
| `omk-knowledge-extraction-study-evidence/v1` | 计划、原始语料／配置文本、原始生产 run／outcome JSON 文本。 |
| `omk-extraction-study-reference-review/v1` | 分开的作者与独立参考复核声明。 |
| `omk-extraction-study-output-review/v1` | 绑定 `planId` 和派生 `outputDigest` 的逐项判断。 |
| `omk-extraction-study-review/v2` / `omk-extraction-study-analysis/v2` | 重算的门禁、逐臂与有限集合分析。 |
| `omk-extraction-study-judge-calibration/v2` | 已保存的 agent 判断与独立人工判断的比较。 |
| `omk-extraction-study-inspection/v2` | 安装版 CLI／Studio 对 v2 复核、分析、校准和逐 slot 完成时间证据的投影。 |

v2 派生报告的完成时间接受门槛及投影变化标记 **BREAKING-COMPARABILITY** 和 **BREAKING-SCHEMA**。参考／输出 receipt 仍为 v1；生产 run v5、plan／corpus／evidence v1 及其原始字节不迁移。现行工具只计算当前报告／投影版本，不另设并行 v1 报告 reader。旧报告及其原冻结工具保留为历史证据，新 v2 报告不能追溯认证旧研究的复核时序。新运行时字节须另冻宿主身份，不改变历史宿主或继承旧接受结论。

既有合成语料 v13、标注指南 v11、检查器 v5 保持原身份与分母。当前默认 prompt-json v29、strict v30；[时间、引用语境、核心对象及整体／局部指引修正](./entity-extraction.md)标记 **BREAKING-COMPARABILITY**，生产 run v5 不变；人工封存单独引入质量投影 v4，将封存记录保留为执行状态未知，不改变 prompt／评分语义。显式研究 prompt profile 不改变两个默认值，已发布默认版本不得标识不同 prompt 字节。以后改变收录口径或评分时，仍须另行声明可比性影响。旧冻结研究仍绑定原 prompt、宿主与输出，不能用新默认值重算或继承质量结论。

显式研究 profile 接口引入时的默认 v19／v20，以及后续 v21／v22、v23／v24、v25／v26，均保留已登记的原始字节摘要约束；默认继续升级也不能放开已有身份。新默认必须显式登记版本和摘要，不加载历史实现，也不改写旧运行。

v29／v30 的来源断言规则及同次调用自检变化标记 **BREAKING-COMPARABILITY**。此前 v27／v28 与 v19 至 v28 全部已登记摘要约束继续受保护，八个 wire 示范逐字节保留。指南 v11、检查器 v5、64 例／212 处关键提及分母、公共 Schema、存储、wire 及 single 政策不变，不增加调用阶段。新 prompt 与当前指南页面字节须另冻测量身份，旧证据不重评分。已见诊断只是改动动因，不证明模型服从、稳定改善或独立验收。

准备阶段用同一请求核对两臂归档器的固定条件，避免把提示词变化引起的请求摘要与归档容量差异误判为环境漂移。每个实际 slot 仍保存各自完整请求与归档证明，并在运行和派发前逐臂重新核对；共同请求的检查不替代实际请求证据。

## 2. 来源分组与参考范围

`freezeExtractionStudyCorpus(input)` 生成语料身份；`parseExtractionStudyCorpus(input)` 要求并重算它。每个案例包含 `caseId`、`split`、`exposure`、`projectGroup`、`conversationGroup`、`lineageGroup`、`ancestorLineageIds`、`stratumId`、`originDigest`、`transformation`、`sourceRecords`、完整捕获 `window` 和 `reference`。原始记录声明稳定 `recordId`、`recordIndex` 和 `originalDigest`。window 是已有生产证据快照，包含选中的原始记录、excerpts 和 limitations。

项目、会话、lineage／祖先、origin 和原始记录身份不得跨越开发集与验证集。即使标签不同，重复来源文本也会拒绝。验证案例须声明 `exposure: unseen`；开发来源的改名、相邻窗、复制或脱敏版本不因此成为独立验证证据。来源、曝光和 lineage 是待审计声明，摘要不能认证其真实性。

| `annotationScope` | 允许的结论 |
|---|---|
| `full` | 完整有限参考集合经过完整独立参考及输出复核后，可以定义实体／提及匹配分母。 |
| `critical_only` | 复核预声明关键义务和全部生成输出；总体匹配 precision／recall／F1 保持 `null`。 |
| `unannotated` | 仅工程捕获与探索复核；没有参考答案分母，也不能形成范围内语义通过。 |

参考实体与提及包含描述、允许等价表达和精确 quote locator。提及绑定参考实体，并可通过 `locators` 声明多种合法精确边界。知识义务区分 `required` 与 `if_selected`，语义标准显式保留。每个参考实体须有参考提及。来源引文使用生产 locator 与宿主 UTF-16 约定，文字命中不负责判断语义等价。

参考映射按对象身份而非名称包含判断：返回整体的局部指引或属性内容，不能因其 mention／qualifiers 含有整体名称就覆盖整体。只有来源和输出确实指同一对象，才能记录有据的等价表达；精确命中声明 locator 与其他有意义定位的逻辑覆盖分别报告。整体遗漏与局部独立资格未知分别保留，不在看到输出后补 locator 或改参考追认。已见来源的重复观测仍是开发诊断，不构成独立样本、稳定改善或真人验收。

所有生成 description、qualifiers 和 mention rationale 都须各自复核来源依据，不能用核心对象覆盖或精确位置代替。同轮／同 PR 关联或 `basis: explicit` 不补足未说明的关系与行动者角色。已确认来源无据与外部真伪未知分别保留，真实措辞歧义也与编造规范标识分别处理：完整来源短语可以指向整体，而不声称完整组件名称。未决输出语义不能计为通过。不看输出放宽参考，不用关键词分类；更正解释时保留复核修订及此前证据。

从独立准备的草稿生成语料时，使用构建后的原语；草稿须提供上文描述的真实分组、来源窗和参考范围：

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { freezeExtractionStudyCorpus } from './dist/knowledge/extraction/study-corpus.js';

const draft = JSON.parse(readFileSync('/private/tmp/study-corpus-draft.json', 'utf8'));
const corpus = freezeExtractionStudyCorpus(draft);
writeFileSync('/private/tmp/study-corpus.json', JSON.stringify(corpus, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
```

草稿正文含 `corpusVersion`、`sourceKind`（`private-real` 或 `public-redacted-real`）、`authors` 与 `cases`。工程探索可将未标注案例写为 `reference: { annotationScope: 'unannotated', entities: [], mentions: [], knowledge: [], semanticChecks: [] }`；成功捕获后仍是未标注。对应快照必须已在显式选中的工作区原样存在；prepare 不捕获新会话或导入来源。

## 3. 计划与生产执行

配置要求依次提供 `baseline` 和 `candidate`。二者共享模型、执行器、来源、输出模式、wire、timeout 和 producer 条件。`changedVariable` 仅允许一个维度：`prompt` 要求原始 system 字节与版本标签均不同；`policy` 允许改变生产生成政策及其输出上限；`replication` 要求其他配置相同，不声称候选改进。

抽样冻结 `selectionFrame`、`inclusionExclusion`、`unit: lineage-group`、含 `coverageRationale` 的选中 `strata`、`sampleSizeRationale`、`stoppingRule`、`budgetRationale` 和 `interruptionPolicy`。这些说明不证明抽样具有代表性或独立性。门槛显式要求 `maxConfirmedErrors`、`maxRequiredGaps` 及各自理由，实际阈值须在输出前由任务损失与风险论证。

以下最小开发配置验证同版本重复。一次重复和零容错只是示例声明，不是推荐样本量或业务验收阈值。准备实际研究前，应将模型占位符替换为实际配置快照，并如实替换其抽样框、场景分层、依据和 actor：

```json
{
  "configurationVersion": "omk-knowledge-extraction-study-configuration/v1",
  "actor": { "actorKind": "agent", "actorId": "study-author", "executionRef": "study:development-example" },
  "changedVariable": "replication",
  "split": "development",
  "repeats": 1,
  "criteria": {
    "maxConfirmedErrors": 0,
    "confirmedErrorsRationale": "开发示例；声明范围内不允许语义错误。",
    "maxRequiredGaps": 0,
    "requiredGapsRationale": "开发示例；预声明必需义务必须保留可见。"
  },
  "sampling": {
    "selectionFrame": "明确授权的已有开发快照。",
    "inclusionExclusion": "选择冻结语料的开发split，排除新的私人来源。",
    "unit": "lineage-group",
    "strata": [{ "stratumId": "work-record", "coverageRationale": "验证声明的开发场景。" }],
    "sampleSizeRationale": "仅工程演示，不作总体估计。",
    "stoppingRule": "使用预声明slot，未知预约阻止后续派发。",
    "budgetRationale": "每个slot一次生产调用，无重试或fallback。",
    "interruptionPolicy": "恢复同一run，未知调用不重发。"
  },
  "variants": [
    {
      "variantId": "baseline", "executor": "openai-api", "model": "<configured-model-snapshot>",
      "policy": { "policyId": "knowledge-generation-single/v1", "maxInvocations": 1, "retry": "none", "fallback": "none" }
    },
    {
      "variantId": "candidate", "executor": "openai-api", "model": "<configured-model-snapshot>",
      "policy": { "policyId": "knowledge-generation-single/v1", "maxInvocations": 1, "retry": "none", "fallback": "none" }
    }
  ]
}
```

每个实验臂可选提供 `timeoutMs`、`maxOutputTokens` 和 `promptProfile: { profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion, system }`。`system` 是精确原始 prompt 文本，不是文件名；省略时使用现有配置生产默认值。有界重试复用既有显式生产政策，包括已验证的 endpoint／model 预算 profile、重试／重问次数、反馈版本及不退款的 token 预约。研究不另建重试调度器，也不新增任意固定的总调用额度。

内部 `timeoutMs` 选项默认 `300000`，接受 1 至 `2147483647` 毫秒的整数，与归档／子进程上限一致。两个实验臂须使用相同 timeout。实际值冻结在既有 plan 和 slot request 中；执行时同时核对冻结的 producer 证明，并原样传递 timeout；调整必须另立新计划，不能给旧调用加时或重发。它不新增公开 CLI flag，不改变普通 CLI／Studio 默认值，也不授权重试。已保存超时仍是失败观测，未知用量不退款、不填零。

prepare 冻结选中 split 的全部案例，并为每个案例 × 重复 × 实验臂预分配 slot 和生产 `runId`。每个案例／重复配对交替首个实验臂。紧凑序列化计划有 16 MiB 的技术证据容量，在展开 slot 前检查；它不是模型调用或消费预算。实际授权调用上限来自预声明 slot 和生产政策。

所有效果均调用 `KnowledgeApplication.generate`，传入显式冻结 profile 和政策。派发前重验来源、宿主、请求、producer 与已保存 attempt 声明。已有 run 身份只允许 `resume`。未知或未完成的前置 slot 阻止后续派发，已记录失败输出保留在配对分母。遗留外部锁须先检查，不自动删除锁或改用新 run 身份。

仓内 `prepare`／`run`／`report` 在固定 delivery worker 中执行完整应用流程，由 worker 构造具体 producer，knowledge application 继续只消费其端口。主线程异步等待；同步 CPU 内核留在 worker 内。每次既有 `ports.identity()` 及每次 `beforeDispatch` 仍重新读取、计算实际宿主字节身份，派发前仍重新读取冻结计划，不以请求开始时的成功结果代替后续核验，也不永久缓存 hash。运行期间代码或依赖字节变化、缺失或读取失败，必须在下次相应核验时观察并拒绝准入。取消传给既有执行器；最终 producer gate 前后还同步检查共享取消标志，使同步重哈希期间到达的取消不必等普通 worker 消息处理后才阻止派发，主线程不使用 `Atomics.wait`。生成 worker 协作等待执行器取消、归档及临时资源清理，不直接终止线程；取消不回滚已完成发布，也不授予新调用或自动重发权限。

## 4. 仓内命令与复核交接

先构建当前 runtime。仓内入口加载固定的编译后生产装配入口，不执行证据指定的源码：

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-study.js prepare \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --corpus /private/tmp/study-corpus.json \
  --config /private/tmp/study-configuration.json
```

`prepare` 只检查配置的 producer，不派发模型。API 检查要求实际配置环境及凭据，但不将秘密保存为配置。执行时 endpoint 和依赖凭据的 producer 容量仍须一致。新的仓库外目录保存 `plan.json`、原始 `corpus.json`、原始 `configuration.json`，以及精确 `baseline-prompt.txt`／`candidate-prompt.txt`。

输出前可用 `report` 在新结果目录生成未签名参考模板：

```bash
node dist-scripts/bench/knowledge-study.js report \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --output /private/tmp/new-reference-handoff
```

模板以 `referenceAuthorTemplate`、`independentReferenceTemplate` 和 `outputReviewTemplate` 嵌在 `report.json` 中，空身份、时间和判断故意保持无效。作者与另行安排的独立真人须在输出前完成各自参考 receipt。AI 辅助不能填写真人身份或独立批准。程序核对声明和时间先后，不认证真人身份或判断正确性。

只有 `run` 发送选中输入，且一次只推进一个明确授权的计划 slot。将下列占位符替换为 `plan.json` 中的精确值：

```bash
node dist-scripts/bench/knowledge-study.js run \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --slot '<slot-id>' --authorize-plan 'sha256:<plan-id>'
```

同一 slot 仅在冻结生产政策允许时包含多个 attempt。对已有 `runId` 重复执行仅恢复、不生成。捕获后另建报告，取得绑定实际输出的复核模板；输出前模板不构成输出复核。实际 receipt 完成后可提供：

```bash
node dist-scripts/bench/knowledge-study.js report \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --output /private/tmp/new-reviewed-study \
  --author-review /private/tmp/reference-author.json \
  --reference-review /private/tmp/reference-independent.json \
  --output-review /private/tmp/output-review.json
```

receipt 参数均可省略，缺失状态持续可见。`report` 模型调用为零，在新目录写入 `evidence.json` 和 `report.json`。成功的 `prepare`／`report` 退出零仅表示命令完成，不表示语义通过；`run` 仅在选中生产 run completed 时退出零。参数错误退出 2，证据／执行错误退出 1，诊断固定且有界。顶层工程字段 `goldReady: false`／`qualityConclusion: not_evaluated` 不被退出码覆盖，应查看重算的嵌套分析及其独立证据支持的范围。

## 5. 原生回放、分析与校准

可携带证据回放不信任外部 status 或 `nativeVerified`。它核对计划、原始文本摘要、run／attempt 身份、每个 native sidecar 引用、accounting 和选中投影；复用冻结的生产 decoder／checker，重建宿主分配的身份映射，逐项比较实体／提及出生结果和知识 intents／grounding 与原始接纳输出。它不覆盖历史分数或后续修订。

expected host 来自固定安装适配器 `extractionStudyHostIdentity()`：实际编译 runtime／runner 字节、解析到的依赖字节、Node 版本及 Node 二进制。宿主证据不同则拒绝，未独立提供当前宿主的回放保持 `outputVerified: false`。调用者提供的报告不能给自己签发信任。此身份冻结 OMK 及受检查的运行依赖，不认证外部供应商、Codex 二进制或用户配置；原 Codex producer 明确不证明二进制／配置／provider 调用。请求模型名和相同 OMK 字节不能证明外部模型行为未变。native outcome 是执行器观测，不是原始 HTTP／CLI 传输捕获，也不证明供应商内部请求次数。

`runtimeDigest` 继续覆盖既有扫描范围内的全部实际编译 runtime 文件字节，包含固定 worker、bridge 和 processor；仍排除 `studio/web` 子树。`runnerDigest` 保留原 9 条路径的子集：`cli/runtime/knowledge-study.js`，`knowledge/application/study-runner.js`、`knowledge/application/study-local.js`，`knowledge/extraction/study-plan.js`、`knowledge/extraction/study-corpus.js`、`knowledge/extraction/study-review.js`、`knowledge/extraction/study-analysis.js`，以及 `knowledge/adapters/study-files.js`、`knowledge/adapters/study-host.js`。它不扩展为新的 worker 闭包；新增 worker 的实际字节由 `runtimeDigest` 绑定。两者的字节摘要、规范化及扫描范围规则不变；依赖身份仍从 `zod`、`ajv`、`js-yaml`、`smol-toml` 四种子展开实际依赖代码与资产，不改成版本清单。两个固定 worker 入口均登记为可达性根；源码 import 守护将其实际校验依赖闭包与上述已解析依赖 manifest 对照，拒绝不透明或未覆盖的加载，只对两处精确的具体执行器构造 import 截断，不据此证明外部执行器或供应商身份。代码字节变化会产生新的冻结 host，不代表摘要范围算法升级，也不使新旧宿主可混用。此调度改造不新增 host／plan／evidence Schema 版本，不重算历史研究；不同 host 的旧研究只在原冻结构建中核对，不能省略核验或继承旧研究结论来宣称可比。

报告保留每个预声明 slot，包括失败、取消、generating、prepared、未知和未尝试，并保留所有已记录 attempt。token／cache／USD 和耗时取自所有 attempt 的原生观测；缺失或显式未报告时，总额保持 `null`。执行器归一零值不证明供应商显式报告零。attempt 耗时相加不是实测用户任务端到端耗时。OMK attempt、执行器报告 attempt 与额外复核调用属于不同记账范围。

`evaluateExtractionStudyReview` 枚举全部输出实体、提及、陈述、预声明参考／知识义务、语义标准和案例目标。`identity`、`provenance` 或 `unsupported_fact` 关键错误始终阻断。缺失／不确定复核、结构／捕获失败持续可见。逐臂结果不会因为 baseline 失败而删除 candidate。状态为 `pending`、`blocked`、`exploratory_reviewed` 和 `accepted_within_scope`；最后一种要求独立参考及输出复核、完整证据及适用的预声明门禁，仅限冻结声明范围。

`analyzeExtractionStudy` 输出整体和逐场景有限集合结果。完整独立复核的实体／提及参考可产生范围内匹配 precision／recall／F1，参考匹配须一一对应，部分或缺失参考不能产生这些指标。重复和相关目标不是独立样本。配对结果使用 lineage group，显示不完整配对、已知转移和符合条件的 candidate-minus-baseline 差异；指标差异对符合条件的 lineage group 等权。场景分层可重叠，不能相加当作独立样本。尚未建立有代表性、可交换的抽样，因此总体 precision／recall／F1 和置信区间保持 `null`。

review v2 要求每个 completed run 有实际 `finishedAt`，该 slot 才能取得完成后复核、范围内实体／提及匹配指标及校准就绪资格。已完成但缺失该字段时，全局与受影响版本的 blockers 增加 `completion_time_unverified`，该 slot 的 `completionTimeStatus` 和耗时状态同步显式标记。`completionTime` 保留 `completedSlots`、`verifiedCompletedSlots` 及 `unverifiedSlotIds` 中的每个未核实 slot 身份。参考标注的 `goldReady` 继续单独表达参考准备度，参考复核齐全不能补足运行完成证据。另一完整版本仍可展示，依赖缺失版本的 lineage 资格和成对差异不可用。校准保留已观察的原始裁决对与关键漏检，但 `ready: false`、比率为 null，并明确时间原因。

提供完成时间时，回执须满足 `finishedAt <= reviewedAt <= now`，边界相等允许；run 的未来时间和早于开始的完成时间均拒绝。缺完成时间时仍可检查已有开始时间及受检时刻上界，但不能取得范围内接受或依赖完成时序的指标资格。不以当前时间、文件 mtime、推测值或之后的复核者声明填补缺失完成时间。旧 [bench capture／review v1](./entity-extraction-semantic-review.md) 没有完成时间戳，仍只检查开始下界；本改动不升级其原协议、冻结字节或历史结论。时间／独立性声明不证明真人实际阅读、判断正确或来源主张真实。

`calibrateExtractionStudyJudge` 是共享编程原语，下文的安装版 CLI 与 Studio 核对入口也使用它。它比较绑定同一证据的实际 agent 与独立人工 receipt，重算两份复核报告，提供逐错误类别检测计数、缺失／不确定目标和关键漏检。缺少真人证据时，校准保持 pending，指标不可用。完整校准覆盖不要求候选通过质量门禁，`ready` 也不认证评委：没有预声明校准验收标准时，`judgeAcceptance` 仍为 `not_assessed`。不会合成模型或真人复核。

agent 输出 receipt 必须提供 `judgeIdentity`，human receipt 禁止此字段。其 `identityVersion` 为 `omk-extraction-study-judge-identity/v1`，`evidenceScope: reviewer-declared;not-native-verified/v1`；声明 `executor`、`executorRevision`、`model`、`modelRevision`、`promptVersion`、精确 `promptDigest` 和 `configurationDigest`、`selectedAttemptId` 及全部声明 `attempts`。每个 attempt 含唯一 `attemptId`、`attemptStatus`（`completed`、`failed` 或 `unknown`）、`runEvidence: { reference, digest }`、可空 `outputEvidence: { reference, digest }`，以及各值明确可空的 `usage: { durationMs, inputTokens, outputTokens, costUSD }`。completed attempt 要求输出证据，选中 attempt 必须 completed。这些是单独范围的评委声明，不并入提取生成器成本。评估器不读取引用，不认证声明的版本、用量或原生执行，缺失金额不补零。

## 6. 持久化与当前交付边界

研究目录和报告目录须是显式绝对新路径，位于仓库与选中工作区之外，父目录已存在。拒绝软链和覆盖，目录权限 `0700`、文件 `0600`。生产工作区继续使用既有来源、实体、知识和 run 契约；证据导出复制原始 run／outcome 文本，再分析另建输出目录。来源隐私及实际向评委／模型传输的授权，与本地 prepare 分开处理。

从本次构建安装的 CLI 提供与 Studio 共用的零模型调用核对入口：

```bash
omk observe knowledge study --evidence /absolute/evidence.json --json
omk observe knowledge study --evidence /absolute/evidence.json \
  --author-review /absolute/reference-author.json \
  --reference-review /absolute/reference-independent.json \
  --output-review /absolute/output-review.json \
  --judge-review /absolute/agent-judge-review.json
```

回执均可省略；缺失项保持待完成。该操作在全局设置和工作区解析之前处理，不需要 `--workspace` 或模型凭据，不读取证据中的路径，也不派发、恢复或修订运行。`--json` 输出共享只读投影；命令成功退出不代表语义通过。输入参数错误退出 2，宿主或证据校验失败退出 1。

Studio 候选核对页的更多菜单提供“核对研究证据”，无工作区时也可打开。用户显式选择 `evidence.json`，按需添加作者、独立参考、输出和 AI 评委回执后执行核对。结果只留在本次抽屉中，关闭清空；换文件立即撤下旧结论，迟到响应不能覆盖新选择。逐例展示原文 excerpts、出生实体／提及／陈述、引用、判断理由及缺项，不把便携 ID 当作当前工作区可维护的身份。

CLI 和 `/api/knowledge/study` 共用固定宿主、原始证据回放与分析。产品只返回明确选择的来源／出生输出和安全统计，不返回原始 transport、完整 run、sourcePath 或 producer proof。HTTP 保留同源保护，数据不落工作区。所有输入和回执合成后的 UTF-8 JSON 总容量为 128 MiB；转义后的请求超限也拒绝，不静默裁剪，其他 API 的既有限额保持不变。

研究执行与 inspection 的两个固定 worker 服务各自在进程内最多持有一个活动任务，不设等待队列；这不是跨进程全局锁或新的模型预算。HTTP 在接收研究请求体前预留 inspection 槽位，随后只接收有界原始字节，由 worker 完成 JSON 解析、实际宿主重哈希、完整回放及分析；CLI 显式选择的普通 UTF-8 文件也在同一 inspection worker 中安全读取，证据里的路径不能选择文件或可执行代码。同步 inspection processor 只供 worker 和单元测试使用，真实 CLI／Studio 路径统一异步等待 worker。主线程仍处理字节接收、传输复制和结果序列化，不能据此宣称零 CPU／I/O 或减少完整身份核验次数。

HTTP 断连或 Studio 停止会取消本次只读 inspection 并终止其 worker，CLI inspection 接入既有信号取消。worker 构造失败、异常或无结果退出均作为有限服务失败处理；已启动 worker 的槽位与监听器只在确认退出后释放。生成 worker 保留前述协作清理边界。inspection 繁忙返回 HTTP 503、`knowledge_study_busy`；工作进程不可用或已取消返回 HTTP 503、`knowledge_study_unavailable`，已断开的连接不再写响应。界面保留已选文件，提示等待当前核对结束或重试；CLI 将这两类服务失败报告为退出 1。有限错误码不暴露原始异常、私有路径或输入，也不被客户端当作写入已确定拒绝的回执。既有输入／容量与证据错误边界继续保留，成功响应仍使用现行 inspection 投影。

宿主严格绑定实际构建、验证器依赖与 Node 字节。不同宿主的旧研究需要在其冻结环境中核对；不能省略宿主核验来显示通过，也不能将重新分析称为新的独立模型验证。正式参考交接应冻结最终运行环境，避免在真人复核期间继续改动其身份。逐 run 的起止时间差是本地墙钟耗时，包含生成、归档、写入与等待；未知保持空值，不推断人工主动核对／纠正负担。

生产质量投影 v4 表达已保存的工程接纳及执行状态未知的显式人工封存，不代表此独立语义裁决。合成／作者编写的执行器 fixture 验证工程行为，不能提供真实来源质量证据、人工批准、总体结论、发布资格或父质量议题完成证据。在另行安排的真人复核及所需真实证据齐备前，正式语义验收持续未完成。

## 7. 独立多人输出复核组

独立仓内 panel 工具比较已保存的研究输出复核，不生成模型输出、不代签真人回执、不修改 run／参考、不改变 `goldReady`，也不替代现有单人复核接受门槛。其 `qualityAcceptance` 始终为 `not_assessed`。一致性只描述明确声明的有限目标集；多人也可能同意一个错误主张。

| 身份 | 绑定内容 |
|---|---|
| `omk-extraction-study-panel/v1` | `panelId`、声明时间／模式、精确 `planId`、`corpusDigest`、原始便携证据 `evidenceDigest`、`outputDigest`、有序完整 targets／`targetSetDigest`、全体名单、另一位裁决者及固定指标／缺失／不确定规则。 |
| `omk-extraction-study-panel-submission/v1` | `panelId` 与完整提交回执清单：`reviewerId`、`receiptFile`、原始 UTF-8 `receiptDigest`；名单中未提交者仍记缺失。 |
| `omk-extraction-study-panel-report/v1` | 完整初始集身份、逐人覆盖、实际人际一致性、两两结果、初始分歧、可选裁决及明确限制；`reportId` 摘要绑定完整报告正文。 |
| `omk-extraction-study-panel-adjudication/v1` | `panelId`、完整 `initialSetDigest`、`disputedTargetsDigest`、第三位真人的 `reviewReceiptFile` 与原始 `reviewReceiptDigest`。 |
| `omk-extraction-study-panel-package/v1` | 输出文件名／角色、原始回执与复核者映射、字节数及精确 UTF-8 摘要；这是本地审计清单，不是新增工作区存储。 |

名单包含 `raters` 和 `adjudicator`，每人声明 `reviewer: { actorKind, actorId }`、`independentHuman`、`authorRelationship: author|non_author` 及 `independenceRationale`。所有身份（含裁决者）按不区分大小写保持不同。作者关系依据冻结语料的 authors 核对。agent 或作者不得声称独立真人；裁决者必须是另一位独立、非作者的 human。这些是声明，不是真实身份认证或实际独立阅读的证明。工具不补填任何人或声明。

准备时绑定已冻结输出集；前瞻模式要求在判断前声明。`prospective` 要求 `declaredAt` 严格早于每份初始回执的 `reviewedAt`；任何判断已经存在后才声明的组必须使用 `retrospective`。准备入口记录当前核对时间，没有回填过去时间的参数。程序只能比较声明时间，不能证明真人何时开始形成判断。回顾性报告保留实际比较，完整 `fullIAA` 明确不可用。当前宿主回放核对原始 corpus／configuration／run／native 字节及固定安装运行时；旧冻结宿主不能重新绑定今天的代码。历史证据使用其原工具，或在当前宿主下另行冻结新研究，不改写旧研究。

有序目标集精确复用 `extractionStudyReviewTargets`：每个 slot 的全部已接纳输出实体／提及／陈述、参考实体／提及、知识义务、语义检查和 case 判断。参考遗漏（`required_missing`）及整体 case 分歧进入主分母，不能因两人对输出匹配都同意就被丢弃。不改变现有单人回执格式。全部回执复用当前 v2 研究复核规则核对，包括目标唯一性、参考匹配、证据身份以及已有完成／时间边界。

固定规则为 `metric: exact-verdict-error-categories-reference/v1`、`missing: retain-in-planned-denominator;no-agreement`、`uncertain: retain-separately;exclude-observed-definite-agreement`、`targetScope: all-output-reference-obligation-check-case`。精确一致比较 verdict、错误类别集合及匹配 `referenceId`；理由文字原样保留，不参与一致性评分。逐类错误结果在相同共同明确目标上比较各类别出现／未出现。类别统计使用 incorrect 判断所声明的错误类别，并将 `required_missing` 计入 `coverage`，与既有研究分析一致；原始回执中的空错误类别数组保持不变。另列仅 verdict 一致性。参考匹配结果分别统计 entity、mention、statement，包含每个 slot／reference 的匹配出现一致性和逐人匹配数；null 是明确未匹配，另列全部正向匹配覆盖。非输出目标不计作参考匹配。这些都是一致性统计，不是准确率、错误检出效果、kappa、置信区间或总体估计。

只有已提交、独立、非作者的 human 进入 IAA。报告保留计划／实际提交人数、human／agent／非独立真人数、逐人缺失／不确定／required_missing 目标、实际已提交合格真人的共同明确覆盖、逐目标类别结果、两两覆盖及逐错误类别／参考一致性。AI 和非独立真人判断保留在原始清单与初始分歧记录中。`observed`、`pairwise` 保留实际可比较的明确子集；缺失和 uncertain 不计同意，没有可比较目标时比率为 null。仅当至少两名合格真人、所有已声明 rater 均提交完整明确覆盖、native／完成证据核实且声明为前瞻性时，`fullIAA` 才是精确全体一致率；否则为 `null` 并列 `fullIAAUnavailableReasons`，即便已观测子集完全一致。该保守完整清单条件也保留 agent 的缺失／不确定；添加 agent 不会增加真人数。有完整数值的 IAA 仍不构成语义质量验收。

提交清单列全已提交的原始回执，没有选择复核者或挑最佳回执的参数。未知／重复 rater、同一物理回执的重复别名、未知／重复目标、错误版本和字节／证据替换均拒绝。`initialSetDigest` 绑定 panel、精确原始提交清单字节，以及名单顺序中每位成员的原始回执摘要或缺失值。改理由、换回执或改提交清单都会产生新集合身份。程序不能证明未声明的外部回执没有被隐瞒；作者和复核者须核查完整声明清单。

裁决可选，前提是名单所有回执均已提交。预声明的第三位真人提供普通的原始单人输出回执，签署时间不早于 `panel.declaredAt`、严格晚于所有初始回执且不晚于核对时钟。回顾性模式仅放宽初始判断与声明的时间关系，不能把更早的第三人判断追认为预先任命的裁决。其 envelope 绑定完整初始集与精确争议清单。仅争议目标计作裁决；该普通回执中的非争议条目仅供既有规则核对上下文，绝不替换初始判断。缺失／不确定的争议裁决仍未解决。每个已裁决目标保留规范化解析 decision 摘要和原始整份回执摘要；不将规范化摘要描述为原始 JSON 子串摘要。原始 envelope 和第三人回执均保留。初始分歧、覆盖和 IAA 不随裁决改写。

按贡献流程构建当前仓库运行时／脚本后，使用以下零模型命令。路径和真实复核者身份必须明确提供；示例是模板，不是已签署复核：

```sh
node dist-scripts/bench/knowledge-study-panel.js prepare \
  --evidence /ABS/STUDY-REPORT/evidence.json --roster /ABS/roster.json \
  --mode prospective --output /ABS/NEW-PANEL
node dist-scripts/bench/knowledge-study-panel.js report \
  --evidence /ABS/STUDY-REPORT/evidence.json --panel /ABS/NEW-PANEL/panel.json \
  --submission /ABS/submission.json --output /ABS/NEW-PANEL-REPORT
# 预声明的第三位真人提供原始回执及 envelope 后：
node dist-scripts/bench/knowledge-study-panel.js report \
  --evidence /ABS/STUDY-REPORT/evidence.json --panel /ABS/NEW-PANEL/panel.json \
  --submission /ABS/submission.json --adjudication /ABS/adjudication.json \
  --output /ABS/NEW-ADJUDICATED-REPORT
```

提交正文形状为 `{ "submissionVersion": "omk-extraction-study-panel-submission/v1", "panelId": "sha256:…", "receipts": [{ "reviewerId": "REAL_DECLARED_REVIEWER_ID", "receiptFile": "original-review.json", "receiptDigest": "sha256:…" }] }`。回执路径相对明确选择的 submission 文件解析；裁决者路径相对明确选择的 adjudication 文件解析。可从 `dist/knowledge/extraction/study-panel.js` 使用 `extractionStudyPanelBytesDigest(readFileSync(path, 'utf8'))` 取得原始 UTF-8 精确摘要，不能先重新序列化原文。将初始 panel 报告的 `initialSetDigest`、`disputedTargetsDigest` 复制到裁决 envelope；初始集变化必须重新复核并绑定。

`prepare` 写原始 evidence／roster、`panel.json`、`targets.json` 和 `package-manifest.json`；`report` 写原始 evidence／panel／submission、按提交顺序命名为 `initial-NNN.json` 的全部原始回执、完整 targets／report 和清单；带裁决时另保留 `adjudication.json`、`adjudication-review.json`。清单将每份复制的初始回执映射到声明复核者；原始 manifest 保留原路径字符串供审计，移动输出包不静默改写路径或集合身份。所有读取输入必须为有界普通 UTF-8 文件。输出为检出外独占新目录（`0700`，文件 `0600`），不覆写已有目录；发布中断／失败可能留下部分目录，须明确检查。仅写明确选择的新输出目录，不扫描便携证据中的来源路径，不改写原始来源／run／用户配置记录，也不调用模型服务。

参数错误退出 2；数据／身份／I/O 错误退出 1，有限诊断不暴露私人来源／回执原文。成功 prepare／report 退出 0，stdout JSON 含 `modelCallsByThisCommand: 0` 和 `qualityAcceptance: not_assessed`，包括 IAA 为 null 的不完整报告。退出 0 只证明所请求的离线核算已保存，绝非真人批准或质量验收。原始清单、声明或报告变化取得新派生身份。既有 prompt、指南／检查器、run v5 和单人回执保留字节与版本；独立 panel 协议不重评历史测量，也不将 development 夹具追认为真实独立验证集。
