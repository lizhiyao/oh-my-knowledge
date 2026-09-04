# 评测评分等价 RFC

> 状态：[#480](https://github.com/lizhiyao/oh-my-knowledge/issues/480) 的迁移契约已实现。下文的阶段性表述保留迁移依据；生产环境的 `omk eval` 现已执行这张 Core 评分图，并在原子化 `BREAKING-SCHEMA` 切换后仅持久化 Core 产物。

## 1. 决策

现有评分与发布语义将被重新表达为一条具有四个显式边界的 Evaluation Core 流水线：

```text
密封的样本评测上下文
  -> 宿主 Evaluator：准则观测与原始评委读数
  -> AnalysisGraph：重复测量、集成、层级、维度与综合派生
  -> 统计 Analysis 节点：区间、一致性与校正
  -> DecisionPolicy：发布结论
```

迁移通过固定执行输出和固定提供方响应进行离线验证。生产双跑、双写、回退选择和旧产物迁移不在范围内。

旧流水线仅在 #480 实施期间作为有边界的等价性基准。生产切换现已完成，重复路径已经移除，当前代码不得重新引入旧 grader 作为实现层或兼容层。

## 2. 构念模型

历史术语「五层评分」描述的是五种身份，而不是五次连续求平均：

| 身份 | 当前含义 | Core 角色 |
|---|---|---|
| assertion | 加权的通过／失败准则，随后归类为事实或行为 | Evaluator 观测及证据 |
| llm | 一次评委调用产生的一个 1～5 原始读数 | 数值型 Evaluator 观测 |
| judge | 成功重复测量的均值，再对成功的集成成员求均值 | 每测量单元的 Analysis 结果 |
| dimension | 具名 rubric 结果；各维度求均值得到样本评委分 | 每测量单元的 Analysis 结果 |
| composite | 现有事实、行为和评委分数的等权均值 | 每测量单元的 Analysis 结果 |

`dimension` 当前不会作为第四个分数额外进入 `composite`。它是获得评委层分数的一条路径。如果迁移按 assertion → llm → judge → dimension → composite 依次求平均，就会测量不同的构念，因此必须拒绝。

## 3. 密封输入与适用性

旧评分准则随样本变化，而 Core Evaluator 定义覆盖整个运行计划。因此，编译器在每个样本的 `evaluationContext` 中物化评分投影，并为数据集生成稳定 Metric 定义的并集。

Evaluator 家族覆盖整个运行计划，并且只声明自身需要的输入。对于某条已声明指标不适用的样本，Evaluator 发出原因是 `criterion-not-applicable` 的 `missing`；不得发出零，也不得伪造通过。在首次调用 Target 前，EvaluationPlan 身份必须覆盖样本评测上下文、prompt 哈希、Evaluator 配置和 Metric 并集。

该设计规避三种无效方案：

- 在运行时创建 Evaluator，从而绕过密封计划；
- 把样本、重试或重复测量状态编码进 `evaluatorId` 命名约定；
- 只包含旧最终分数的单个不透明 grader 观测。

## 4. 运行时家族

宿主负责提供方调用、prompt 注册表访问、自定义模块加载和内容解析。Evaluation Core 负责调度、重试、超时、预算、缓存、输入绑定、证据策略、取消和生命周期。

| 运行时家族 | 输入绑定 | 观测 | 身份要求 |
|---|---|---|---|
| 确定性 assertion | 输出和评测上下文；感知执行的叶节点还需要 Core 拥有的执行事实 | 布尔准则结果；assertion 详情作为证据 | assertion 算法版本和受支持类型注册表 |
| 自定义 assertion | 输出、评测上下文和已验证的资源租约 | 布尔准则结果或结构化 Evaluator 失败 | 模块内容身份和沙箱／资源策略 |
| 语义相似度 | 输出、预期结果／评测上下文 | 布尔阈值结果；固定响应解析证据 | 语义 prompt 哈希、模型 Runtime 身份、阈值、取反规则 |
| RAG 指标 | 输出和评测上下文 | 布尔阈值结果；固定响应解析证据 | 指标专属 prompt 哈希、模型 Runtime 身份、阈值、取反规则 |
| rubric 评委 | 输出、可选 trace、评测上下文 | 1～5 标度上的原始数值读数 | rubric prompt 哈希、去偏变体、集成成员、重复测量索引、模型 Runtime 身份 |

Core 永不导入 `PROMPT_REGISTRY`。组合根解析冻结的 prompt，并把它的哈希放进宿主 Runtime 身份。`lengthDebias=false` 仅选择现有的 rubric 关闭长度去偏工具；表达和语气中性仍然启用。RAG 和语义 prompt 没有长度去偏开关。

语义和 RAG assertion 使用 `omk.llm-assertions/v2`。一个 Evaluator 坐标只拥有一条准则和一个布尔 Metric，因此一次提供方失败不能压制或伪造无关准则。规范化的 `applicableSampleIds` 在评测和分析前移除不适用坐标，而不把多条准则合并进共享的提供方调用。密封工具保留 assertion 类型、注册表 prompt ID 和冻结 prompt 哈希；下游聚合所需的阈值、正权重、显式取反规则和事实层身份也会保留。仅在有效原始分数完成阈值比较后执行取反；证据同时保留 `rawPassed` 和 `negated`，提供方失败、无效响应、超时、取消或预算截尾均不得成为已观测的通过。Runtime 指纹还绑定所选模型配置和宿主调用 Runtime 身份。宿主调用端口只执行一次支持协作取消的调用，自身没有重试、超时、预算或缓存策略。

`[1, 5]` 内的严格整数读数和非空解释会生成已观测的布尔阈值结果。非 JSON、畸形 JSON、畸形分数、越界分数和缺失解释分别生成不同的无效观测。提供方失败生成带脱敏稳定代码的失败 Evaluation 记录。Core 超时和取消仍是尝试状态，准入失败仍是预算截尾。未知用量或提供方成本保持缺失。这是 [#481](https://github.com/lizhiyao/oh-my-knowledge/issues/481) 负责的有意 `BREAKING-COMPARABILITY` 修正；不提供兼容模式或旧读取器。

Rubric 评委使用 `omk.rubric-judge/v1` 和同一个宿主拥有的单次调用提供方端口。每个测量坐标只发出一个数值型原始读数；重复测量和集成聚合仍属于 AnalysisGraph。工具把现有的启用或关闭去偏注册表身份，与显式的 `none` 或 `source-neutral` trace 策略一起密封。启用 trace 的评测只绑定 `omk.source-neutral-trace/v2`，其摘要塑形算法和 schema 进入 Runtime 指纹。有效响应是一个包含 `[1, 5]` 范围内整数分数和非空理由的 JSON 对象；推理过程是可选证据。协议失败使用与 LLM assertion 相同的不同无效状态，提供方失败仍为失败记录。Core 有意拒绝旧 rubric 解析器对畸形 JSON 的挽救、数字字符串和小数强制转换、越界读数、空理由及分数零失败哨兵。这项由 [#492](https://github.com/lizhiyao/oh-my-knowledge/issues/492) 负责的 `BREAKING-COMPARABILITY` 修正没有兼容模式，也不改变冻结的 rubric prompt 字节或哈希。

确定性 assertion 被拆成两个独立标识的家族。仅输出家族只绑定输出和评测上下文。感知执行家族递归计算每棵 assertion 树的最小权限来源并集，然后只绑定所需的输出、Core 拥有的 `execution-facts`、来源中立 trace 和评测上下文。依赖签名不同的准则属于不同 Evaluator 组，因此 trace 不可用时不能压制只依赖事实的指标。

成本只采用 `ExecutionFacts.usage.providerCost` 中完整的、由提供方报告的美元聚合值；未报告、不完整或混合币种成本是缺失观测，绝不是零。延迟采用 `ExecutionFacts.timing.wallClockDurationMs` 的试验墙钟时长。轮次 assertion 使用 `omk.source-neutral-trace/v2` 独立于提供方／运行时的 `numTurns` 字段，绝不使用对话记录宽度(`fullNumTurns`)、尝试次数或重试次数。工具 assertion 使用来源中立的 `toolCalls`；mock 命中 assertion 要求由已配置拦截边界捕获的来源中立 `mockStats`。缺失遥测保持缺失，而不会变成失败的质量 assertion。v2 切换是有意行为，并且没有 v1 兼容读取器：用不同的必需字段集合复用 v1 身份会让持久化证据产生歧义。

每条 Core `json_schema` 准则都在隔离的验证器会话中编译。旧模块级全局 Ajv 注册表可能在原本独立的准则之间保留 `$id` 状态，使结果依赖进程历史；复现这种污染会违反运行和绑定隔离。这是 [#484](https://github.com/lizhiyao/oh-my-knowledge/issues/484) 负责的显式 `BREAKING-COMPARABILITY` 例外：后续 schema 复用较早的 `$id` 时，可能仅因编译状态泄漏而在旧进程中失败，而 Core 会独立评测两个 schema。正式切换直接接受 Core 结果；它不会模拟旧缓存、增加兼容标志，也不会在准则、记录、绑定或运行之间共享注册表。

## 5. 身份与统计单元

| 旧概念 | Core 身份 |
|---|---|
| 执行 `--repeat` | Target `trialIndex` 和 `trialId` |
| `--judge-repeat` | Evaluator `replicateGroupId` 和 `replicateIndex` |
| 集成中的评委模型 | `ensembleMemberId` 加解析后的 Runtime 身份 |
| 提供方重试 | 同一个 `evaluationId` 内的 `attemptNumber` |
| 样本 | `sampleId` 和抽样单元身份 |
| 配对的对照／处理观测 | `pairingBlockId` |
| 批处理子评测 | 独立 Run 身份 |

重试永远不会创建新的测量重复。失败的评委重复测量保持失败，不会静默地由额外成功调用替代。聚合器只消费显式规划的重复测量坐标，并保留失败计数。

## 6. AnalysisGraph

每测量单元的派生使用版本化表信封。每一行绑定目标、样本、试验、指标或维度身份、输入观测 ID、数值或结构化缺失原因，以及准确的舍入阶段。下游节点把这些表作为 Analysis 结果消费；Evaluation 完成后不再创建新的 MetricObservation。

规划节点如下：

1. `judge-replicate-mean`：对成功的原始读数求均值和样本标准差；成功读数为零时结果缺失。
2. `judge-ensemble-mean`：对成功的成员均值等权求平均；成员行和失败仍保留在输入血缘中。
3. `dimension-weighted-mean`：对全部计划维度按密封权重求平均，四舍五入到两位小数；任一维度缺失都会让聚合结果缺失。
4. `assertion-layer-score`：分别计算事实和行为的加权通过比例，以 `1 + ratio * 4` 映射，并四舍五入到两位小数。
5. `composite-score`：对现有的事实、行为和评委行等权求平均，四舍五入到两位小数；不存在任何层时，只允许旧投影产生历史零哨兵，权威 Core 结果为不确定／缺失。

前两个派生由宿主拥有的 Analysis 节点 `omk.judge-replicate-table/v2` 和 `omk.judge-ensemble-table/v2` 实现。重复测量表按完整的目标／样本／试验／指标／工具／集成成员／重复测量组坐标分组，按显式规划的重复测量索引排序而不要求索引连续，并保留每个已观测或未观测行。成员均值四舍五入到两位小数，样本标准差(`n - 1`) 四舍五入到三位小数。集成表消费经过 schema 验证的结果，赋予每个已观测成员均值相同权重，把共识值四舍五入到两位小数，并仅在已观测成员间计算两两平均绝对差，四舍五入到三位小数。已观测成员少于两个时，一致性缺失。两个输出 schema 都会在实时执行和传输 Bundle 验证期间强制执行规范顺序、覆盖守恒、内容派生的血缘身份和可重算统计量；其 Runtime 指纹绑定估计量、标度、缺失策略、舍入规则，以及由 Core 派生的配对／聚类／分层抽样单元身份。v2 身份替换切换前的 v1 契约，而不是改变其 schema 摘要；该修正由 [#497](https://github.com/lizhiyao/oh-my-knowledge/issues/497) 负责，不注册 v1，也不提供兼容读取器。

第三个派生由宿主持有的 `omk.dimension-table/v2` 节点实现。密封参数把每个维度绑定到一个 Metric、一个上游评委集成 Analysis 结果，以及显式的逐 sample 适用范围和权重；每条 sample 的计划权重和必须为 1。只有全部计划维度都有观测值时，节点才计算保留两位小数的加权平均；缺少上游组、读数缺失或权重和非法都会失败关闭为缺失聚合。表验证器会重算覆盖与聚合，强制执行规范顺序和稳定绑定，并把权重认证进内容派生的血缘身份。每条 criterion 都由一次独立评委调用测量，因此多准则 prompt 内的排列顺序不再进入测量构造。Runtime 指纹绑定这些语义及全部上游、参数和输出 schema 身份。

第四个派生由 [#496](https://github.com/lizhiyao/oh-my-knowledge/issues/496) 引入的宿主 Analysis 节点 `omk.assertion-layer-table/v1` 实现。其密封参数把每个唯一准则和布尔 Metric 显式映射到 `fact`、`behavior` 或 `excluded-mixed-layer`，并附带有限正权重；节点绝不从 assertion 名称、Evaluator ID 或证据推断分类。每个目标／样本／试验行保留完整准则状态和 Core 派生的抽样单元血缘。`criterion-not-applicable` 是结构性的，不计入 assertion 评分覆盖；Analysis Bundle v2 仍在 `planned` 中保留这个矩形坐标，将其放入独立的 `notApplicable` 桶，并通过 `notApplicableRows` 认证行身份和原因。因此它不会降低证据完整度；其它所有未观测状态仍会降低覆盖，但不会变成 `false` 或分数零。表验证器会重算加权分数和覆盖，并强制执行规范顺序、全局唯一来源血缘、内容派生的组身份，以及在所有测量单元间保持一致的准则设计。Runtime 指纹绑定这些语义和两个 schema 身份。生产 CLI 通过已注册的 Core AnalysisGraph 消费该节点。

第五个派生由 [#512](https://github.com/lizhiyao/oh-my-knowledge/issues/512) 引入的宿主 Analysis 节点 `omk.composite-table/v2` 实现。密封参数把事实层和行为层绑定到 assertion-layer 结果，并把评委层绑定到集成共识或维度聚合；不会从图位置或标签推断来源。对于每个目标／样本／试验单元，节点对现有的已观测层等权求平均并四舍五入到两位小数。缺少来源组是结构性不适用，不会创建层条目；已有但缺失的组仍是显式证据；已观测层为零时，权威结果是缺失而不是数值零。验证器会重算聚合值和覆盖，并强制执行规范的单元／层顺序、稳定绑定、全局唯一来源结果／来源组血缘，以及内容派生的组身份。由于所有溯源均跟随上游 Analysis 组，直接 Metric 行覆盖为空。真实 Core DAG 一致性测试覆盖仅 assertion 和由维度支撑的仅评委计划，包括传输 Bundle 验证、父节点失败阻塞、取消和仅一次释放。生产 CLI 通过已注册的 Core AnalysisGraph 消费该节点。

本次迁移有意打破旧约定：失败成员的分数零哨兵以前会污染一致性，却不参与共识。现在，失败、无效、不可用和未开始的坐标保持不同的缺失证据，绝不变成数值零。该修正由 [#494](https://github.com/lizhiyao/oh-my-knowledge/issues/494) 负责，没有兼容模式，也不会把 Evaluator 用量聚合到 Analysis 产物中。

混合层 `assert-set` 准则仍是可见的 assertion 观测，但同时排除在事实层和行为层之外。总权重为零会生成缺失层。失败的 rubric 评委是缺失，不是分数零。

旧 RAG 和语义路径会把提供方／解析失败转换成失败的布尔 assertion。该行为只作为历史差分证据冻结。Core 有意不复现它：无效读数和失败尝试排除在 assertion-layer 通过率之外，并降低覆盖。低于阈值的有效读数仍是已观测的 `false`，所以负向内容证据仍会被计入。

旧异步路径现在仅对有效的语义、RAG 或自定义通过／失败读数应用公开的 `Assertion.not` 契约。提供方失败、畸形或不完整的评委输出、缺失 RAG 输入、自定义异常和无效自定义结果在取反后仍为失败。Core 把相同的布尔准则规则密封进 v2 Definition 和证据契约。这项由 [#489](https://github.com/lizhiyao/oh-my-knowledge/issues/489) 负责的独立 `BREAKING-COMPARABILITY` 修正，不会削弱 #481 的规则，即 Core 基础设施和协议失败仍是结构化缺失证据，而不是已观测的布尔 `false`。

## 7. 统计标准

当随机流或结论契约不同时，精确迁移标准与同名的通用 Core 内置项是不同标准。

| 旧标准 | 可直接复用 Core 内置项？ | 原因 |
|---|---|---|
| 算术均值／比例 | 可以，不需要每测量单元派生表时 | 估计目标和缺失排除方式相同 |
| 均值／独立／配对百分位 bootstrap | 精确黄金等价时不可以 | 旧实现使用整数种子 `20260616` 的 Mulberry32，并把端点四舍五入到四位小数；Core `bootstrap.* /v1` 对 SHA 派生的抽样做域分离 |
| Bonferroni alpha/K | 精确旧等价时不可以 | 旧实现以 `alpha/K` 计算每个区间且没有 p 值表；Core `bonferroni/v1` 消费 p 值 |
| Krippendorff alpha | 新的区间距离 Analysis 标准 | 现有公式不是 Core 内置项，未定义情形必须成为不确定 |
| 发布结论 | 新的 OMK 发布 DecisionPolicy | Core `progress/v1` 是单效应三向策略，不是旧六级契约 |

旧版等价 bootstrap 标准重采样已声明的实验单元、保持配对、使用冻结随机流，并公开点估计、舍入后的边界、重采样次数、alpha，以及从舍入边界派生的显著性。它绝不能回退到非配对估计量。该行为冻结在 `omk.bootstrap-family-table/v1` 中用于重放，但不再作为生产判定标准。

退化输入属于标准的一部分，而不是实现偶然。仅一个观测的旧均值区间是 `samples=0` 的点区间；仅一个完整配对的配对差仍执行请求数量的重采样，并返回恒定差值。空输入映射为权威 Core 的不确定结果，历史全零对象只允许出现在旧投影中。统计实现落地前，这些情形分别拥有黄金向量。

生产环境使用宿主 Analysis 节点 `omk.bootstrap-family-table/v2`。它保留相同的实验单元、配对规则、确定性 Mulberry32 随机流与描述性 percentile 区间，但用显式新 identity 改变判定证据。即使后来有观测缺失，`K` 仍取已封存的计划比较数。显著性直接使用未舍入 draw 在 0 相关一侧的尾部计数，不依赖舍入后的区间端点。有限重采样的 Monte Carlo 误差用精确 Clopper-Pearson 区间量化，并经 Bonferroni 分配在计划家族上提供 99% 同时置信度；区间跨越 `alpha/(2K)` 时返回 `indeterminate`。完整重采样支持严格同号时构成精确证明，不需要 Monte Carlo 近似。传输 Bundle 校验会重算每项观测、区间、尾部计数、不确定性边界、覆盖值、顺序规则与血缘链接。

Krippendorff alpha 使用区间距离 `delta^2=(c-k)^2`；名义或顺序变体并不等价。空输入、总计只有一个评分对，或期望分歧为零时，结果是不确定而不是数值零。alpha bootstrap 重采样配对评分单元。

该标准由宿主 Analysis 节点 `omk.agreement-table/v3` 实现，它从 [#522](https://github.com/lizhiyao/oh-my-knowledge/issues/522) 引入的 v1 节点演化而来。它消费 schema 密封的加权 Dimension v2 表，以及仅存在于 Analysis 样本上下文中的 Gold 评分；Execution 和 Evaluation 的计划与 Bundle 永远不会接收该上下文。节点密封一个目标、标注者身份、标注版本、数值标度、JSON 指针、样本顺序、bootstrap 配置，以及区间距离 alpha 定义。重复的 Dimension 试验在每个样本内求平均，同时保留每样本组覆盖和血缘。输出以 Krippendorff alpha 为主统计量，以加权 kappa 和 Pearson 为辅助诊断，并报告完整 bootstrap draw coverage；样本对不足、期望分歧为零、统计量未定义、完全一致导致 bootstrap 不适用，或意外抽样无效时，输出结构化缺失结果。v3 保留 v2 遵循 Krippendorff 推荐的 bootstrap——重采样配对观测分歧，同时固定原始评分的期望分歧——并把认证过的上游契约切到加权 Dimension v2。v1 与 v2 继续绑定 Dimension v1，作为历史语义实现存在；assignment-aware capability identity 不承诺重放切换前的 Plan。表会在传输 Bundle 验证期间按统计公式重算。生产 Gold 比较通过显式选择器消费这个经过认证的 Core 投影。

## 8. DecisionPolicy 边界

发布 DecisionPolicy 消费具名且绑定到计划的 Analysis 结果和显式证据门禁。它必须复现旧六种结论及理由优先级，而不读取旧 Report 对象。

在给出方向性结论前，它检查覆盖、必需结果、假设、来源可信度和比较家族。随后，策略应用配对置信区间、层级门禁、样本量／功效状态、评委分歧、稳定性和留出集差距规则。展示字符串和 CLI 后续步骤文本位于策略之外；稳定理由代码才具有权威性。

`SOLO`、`UNDERPOWERED`、`NOISE`、`PROGRESS`、`CAUTIOUS` 和 `REGRESSION` 是结论，而不是运行状态。基础设施失败仍产生失败或未决决策。

该契约由宿主拥有的 `omk.release-decision/v7` 策略实现，它从 [#525](https://github.com/lizhiyao/oh-my-knowledge/issues/525) 引入的 v1 策略演化而来。参数显式绑定 Composite 表、Bootstrap Family v2 表、每个适用 Judge Ensemble 选择器及其 sample 范围、密封的目标和样本顺序、所有门禁阈值、预注册样本量要求，以及可选且互斥的训练／留出分区。在应用六级优先级前，策略会验证估计量拥有的 `comparisonFamilyResultId`、精确的结果／schema 全集、Composite 到 Bootstrap 的观测血缘、比较绑定，以及每个已配置 Judge Ensemble 的覆盖。任一适用维度出现分歧或跨评委一致性不可测时，正向比较都会成为 `CAUTIOUS`；没有 Judge Ensemble 的确定性设计不受影响。不显著的比较根据完整配对数或较小的独立组已观测样本数应用样本量门禁，绝不使用已编写但未观测的样本。显著向好的比较只有在持久化的 percentile 区间下界达到已封存阈值时，才能通过实际效应 gate；点估计本身不充分。缺失区间或 Monte Carlo 误差下仍未决的显著性保持 not-decided；Core 路径绝不回退到点估计。跨运行稳定性属于 Series DecisionPolicy，不会从单个 Run 推断。历史 release policy v1～v6 与 Bootstrap family v1 仍作为历史语义实现存在；assignment-aware schema 切换有意拒绝切换前的 Plan，而不再承诺精确重放。

## 9. 字段映射与拒绝规则

| 旧字段／事实 | Core 产物 | 拒绝规则 |
|---|---|---|
| `AssertionDetail.type/value/weight/passed/layer` | 布尔观测和分类证据 | 不受支持或畸形的类型在编译／准备期间失败 |
| `llmScoreSamples` | 原始重复测量观测 | 不得从完成顺序推断样本顺序 |
| `llmScoreFailures` | 失败重复测量覆盖 | 失败不能变成额外的零读数 |
| `llmEnsemble` | 成员作用域观测和每成员 Analysis 行 | 成员身份／模型不匹配即不兼容 |
| `dimensions[name]` | 具名指标和维度表行 | 空 rubric 或未声明维度会被拒绝 |
| `layeredScores` | 事实／行为／评委 Analysis 行 | 混合 assertion 集不能归入单层 |
| `compositeScore` | composite Analysis 行和覆盖 | 缺失层不能在未记录所含集合时被静默重加权 |
| `bootstrapCI`／成对 CI | 区间 Analysis 记录 | 单元、种子标准、alpha 或配对错误即不兼容 |
| `humanAgreement.alpha` | 一致性 Analysis 记录 | 非区间距离标准即不兼容 |
| 结论及理由 | DecisionResult 理由代码 | 证据不完整时不能产生方向性结论 |
| 成本值和已报告标志 | Usage 溯源 | 未报告成本保持缺失／未知，绝不是数值零 |

不影响 Metric 或决策的宿主诊断仍属于后处理。任何会改变结论的诊断都必须成为密封的 Analysis 输入或 DecisionPolicy 参数。

## 10. 一致性证据

第一个基线是锚定到提交 `38648427` 的 `test/fixtures/eval-core/scoring-equivalence-v1.json`。它冻结：

- 全部六个评分 prompt 哈希；
- 确定性 assertion、嵌套同层和混合层 `assert-set` 行为、权重、层映射及舍入；
- 固定响应的语义与 RAG 结果及用量；
- 评委重复测量失败、样本标准差、集成成员证据及共识；
- 旧随机流下的独立和配对 bootstrap 向量；
- 区间 Krippendorff alpha、加权 kappa、Pearson 及 alpha bootstrap。

后续迁移测试通过新 Core 路径消费相同 fixture，并比较观测、覆盖、证据、每测量单元表、区间结果、用量溯源和理由代码。精确身份和状态比较绝不使用数值容差。浮点容差只允许用于不比较产物相等性的公式性质测试。

语义／RAG 一致性向量还冻结有意的失败语义变更：有效通过、有效阈值失败、有效取反、提供方失败、非 JSON、畸形 JSON、畸形分数、越界分数、缺失解释、超时、取消、预算截尾、未知用量／成本，以及增加基础设施失败不能降低已观测内容通过率这一不变量。旧自定义 assertion 向量覆盖有效通过／失败、取反、模块抛错与超时，以及无效结果对象。

最终离线差分工具由 [#528](https://github.com/lizhiyao/oh-my-knowledge/issues/528) 交付，并在切换后随旧基准一起移除。它的不可变输入 fixture 仍位于 `test/fixtures/eval-core/scoring-equivalence-v1.json`。当前 Core 与生产边界覆盖位于 `test/eval-core/conformance/` 和 `test/eval-workflows/production-host/`。差分工具准备并执行了一份真实密封计划，覆盖两个 Target 和四个配对样本，然后通过公开引擎 facade 遍历 `Execution -> Evaluation -> Analysis -> Decision`。计划包含仅输出和感知执行的确定性 assertion、全部四种语义／RAG 工具、两个各含两次测量重复的 rubric 集成成员，以及 assertion-layer、replicate、ensemble、dimension、composite、Bootstrap-family、Agreement 和 release-decision 节点。旧投影独立地从相同输出、固定提供方读数、Gold 评分、阈值和种子生成。

该工具精确比较准则读数、结构化失败状态、覆盖、用量和提供方成本溯源、prompt ID 和冻结哈希、样本／试验／成员／重复测量／配对身份、层与 composite 行、Bootstrap 来源血缘、Gold 血缘、一致性统计量、发布结论和稳定理由代码。运行时生成的 schema 验证器和产物摘要检查保持启用；测试不会通过调用纯函数构造最终表。生产 CLI、Report 读取器／写入器、Studio、resume、batch、evolve 和持久化路径都不参与该运行。

### 10.1 历史类型化差异例外清单

差分工具只接受下列由 issue 负责的差异。每项都是带有显式 `accepted` 或 `blocking` 状态的类型化值；任何未列出的不一致都会使精确比较失败。

| 负责 issue | 状态 | 有意差异 |
|---|---|---|
| [#481](https://github.com/lizhiyao/oh-my-knowledge/issues/481) | accepted | 提供方或解析失败保持为失败／无效／缺失证据，而不是布尔内容失败。全链路失败探针会检查两个投影及下游覆盖。 |
| [#484](https://github.com/lizhiyao/oh-my-knowledge/issues/484) | accepted | `json_schema` 验证器会话彼此隔离，而不是共享旧进程全局状态。 |
| [#492](https://github.com/lizhiyao/oh-my-knowledge/issues/492) | accepted | 畸形、强制转换、越界、空理由和零哨兵 rubric 响应不是有效读数。 |
| [#489](https://github.com/lizhiyao/oh-my-knowledge/issues/489) | accepted | 异步 assertion 取反已密封，并且只在有效原始通过／失败读数后应用；无效和基础设施失败不能变成成功。 |

该清单不是兼容模式。`accepted` 条目描述权威 Core 语义，一致性工具不再有阻碍正式切换的差分例外。生产依赖方向仍是 Core 契约／运行时向内，宿主 adapter 向外：Evaluation Core 不会导入旧 Report、CLI、提供方 SDK、环境、文件系统或 prompt 注册表文本。提供方调用和 prompt 构造仍是注入的宿主端口；只有密封身份和已捕获产物跨越边界。

## 11. 交付切片

1. 基线 RFC 与不可变旧 fixture。
2. 仅输出的确定性 assertion Evaluator，在 #483 后跟进感知执行的 assertion 和自定义 assertion Evaluator。
3. 使用固定响应重放的语义、RAG 和 rubric Evaluator。
4. 重复测量、集成、维度、assertion-layer 和 composite Analysis 节点。
5. 精确 bootstrap 与一致性 Analysis 标准。
6. 六级发布 DecisionPolicy。
7. 完整离线新旧差分一致性验证和依赖审计。

每个实现切片都运行一份已准备的 Core 计划和真实 Runtime 生命周期，包括取消和仅一次释放。测试实现使用 `test.*` 命名空间。后续切换阶段把生产 `omk eval`、Studio、resume、batch、evolve、Gold 比较和产物图连接到这些契约，并删除旧 Report 读取器与写入器。
