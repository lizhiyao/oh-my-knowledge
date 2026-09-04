<!--
title: 统计严谨性——不确定性、校准、去偏与证据门禁
description: Evaluation Core 的结论为何可审计：预注册 Bootstrap family、显式 Gold 对比、冻结评委 prompt，以及失败关闭的 evidence coverage。
-->

# 统计严谨性

omk 评估一次知识改动时，会固定模型和用例设计，只改变 artifact，并让证据沿 sealed Evaluation Core plan 流动。更高的展示分数不是发布授权；已注册的 Core Decision 必须能把结论追溯到完整、可比的观测与预注册分析。

五道防线分别覆盖不同的失败模式。

## 一、Bootstrap comparison family

`omk eval` 根据实际观测到的 sampling unit，通过 percentile Bootstrap 估计不确定性，不假设分数服从某种参数分布。

- Target 均值与 treatment-minus-control 区间由 `omk.bootstrap-family-table/v2` 生成；
- paired design 必须声明显式 pairing key，绝不会自动降级为 independent estimator；
- 多个 treatment 共享一组封存的 comparison family；`K` 取计划比较数，包含后来证据缺失的比较，有效显著性水平为 `alpha / K`，缺失结果不能静默放大家族假阳性率；
- 重采样次数、名义 alpha、design、Target／Sample 顺序与确定性 Mulberry32 随机流都进入 Analysis identity；CLI 默认重采样 1000 次；
- 四位小数的 percentile 区间只用于描述，不作为显著性判定边界；显著性直接使用未舍入的 draw stream，以及它在 0 一侧的相关尾部；
- 有限 draw 数量拥有独立的精确 Clopper-Pearson 尾概率区间；其置信度按计划 comparison family 做 Bonferroni 分配，保证全家族 99% 置信度。区间跨越 `alpha / (2K)` 时，显著性为 `indeterminate`，发布判定失败关闭；
- comparison interval 缺失时保持 inconclusive，release policy 不会拿点估计兜底。

这把总体抽样不确定性与 Monte Carlo 近似误差明确分开，符合 [Koehler、Brown 与 Haneuse](https://pmc.ncbi.nlm.nih.gov/articles/PMC3337209/) 强调的区分；精确二项区间采用 [Clopper 与 Pearson](https://doi.org/10.1093/biomet/26.4.404) 的方法。

实现：`src/eval-workflows/runtime-adapter/analysis/bootstrap-family-table-v2.ts` 与 `bootstrap-family-parameters.ts`。

## 二、Gold agreement 是显式校准

Bootstrap uncertainty 回答的是观测差异能否与重采样噪声区分，不能证明 LLM 评委与人工标准一致。

因此，Gold comparison 是独立的、经过认证的 Core projection。调用方必须选择精确的 run、Target、Evaluator、数值 Metric，以及可选的 trial coordinate。Gold 与 Metric 的量尺必须完全一致；观测存在歧义时显式失败，不会跨 trial 或 ensemble member 暗自平均。

投影会报告：

- 以 interval distance 计算的 Krippendorff alpha，作为主要一致性统计量；
- 加权 kappa 与 Pearson correlation，作为辅助诊断；
- paired-unit Bootstrap uncertainty 与结构化 missing 状态；
- annotator 与评委身份可能让一致性过于乐观时的污染警告。

当前 `omk.agreement-table/v3` 契约遵循 [Krippendorff 推荐的可靠性 bootstrap](https://www.asc.upenn.edu/sites/default/files/2021-03/Algorithm%20for%20Bootstrapping%20a%20Distribution%20of%20Alpha.pdf)：每个 draw 重采样配对观测分歧，期望分歧则固定为原始评分的值。它消费加权 Dimension v2 契约；v1 与 v2 只为精确重放继续绑定 Dimension v1。观测结果完全一致是文献明确的不适用情形，不会编造区间；draw coverage 与所有缺失状态仍显式报告。事后调用方可以显式提供最低 alpha，assessment 会比较置信区间下界；未提供阈值时则明确保持未配置。

事后 Gold comparison 属于 exploratory calibration，不会反向改写预注册的 release Decision。

实现：显式 projection 位于 `src/eval-workflows/projections/gold.ts`；预注册 Core Analysis node 位于 `src/eval-workflows/runtime-adapter/analysis/agreement-table.ts`。

## 三、评委去偏与 prompt identity

LLM 评委可能在正确性之外奖励冗长、精致排版或自信语气。omk 的 rubric prompt 会显式中性化这些信号。

- 排版与语气中性化始终开启；
- 长度去偏默认开启；`--no-debias-length` 只关闭长度指令，用于受控研究或复现；
- 每条评分类 prompt 都有 registry identity 与 hash；evaluator identity 或 prompt variant 不同时，报告不会被当作可盲比事实；
- model 名称本身不能唯一标识远端评委部署。`eval.yaml` 未提供 `judgeModels[].deploymentRevision` 时，omk 会把 provider Runtime 记录为 `opaque/unknown`；跨 run 可比性会明确标为 conditional，要求完全 compatible evidence 的 policy 会失败关闭。正式发布研究应使用 provider 的固定 model identifier，并声明 gateway 或 deployment revision：

  ```yaml
  judgeModels:
    - executor: openai-api
      model: gpt-5-2025-08-07
      deploymentRevision: production-gateway-2026-09-04
  ```

  该 revision 是宿主声明，不是 provider attestation，因此 assurance 只会是 `declared`，不会成为 `verified`。routing、system middleware 或实际部署模型改变时，必须同步修改 revision。omk 不根据 model 名称格式猜测它是否不可变：OpenAI 记录了 pinned snapshot，Anthropic 区分 snapshot ID 与移动 alias，并说明 serving infrastructure 仍可能变化；Vertex AI alias 也可以重新指向其它版本。参见 [OpenAI model stability 说明](https://platform.openai.com/docs/api-reference/backward-compatibility)、[Anthropic model ID 与 alias](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)及 [Vertex AI model alias](https://docs.cloud.google.com/vertex-ai/docs/model-registry/model-alias)；
- hash 由 `test/measurement-governance/prompt-registry.ts` 统一编目，并由同目录 `prompt-registry-freeze.test.ts` 冻结。这份治理清单仅用于维护与 CI，不进入发布运行时。

Prompt 指令只能降低已知偏差风险，不能证明评委无偏；Gold calibration 才是外部校验。

## 四、Evidence 与 coverage 失败关闭

缺失证据既不是零分，也不会在 Decision 边界被静默丢弃。

- Assertion、judge、dimension 与 composite table 会保留 observed、missing、invalid、failed、unavailable 和 not-started 状态；
- 结构性不适用与计划观测但未取得结果是两回事；
- coverage 沿 Analysis lineage 守恒，读取传输后的 Bundle 时会再次校验；
- release Decision 必须先确认 evidence 完整且 source binding 精确，才能给出方向性结论。

这能防止困难 coordinate 因为没产出分数，反而让 run 看起来更好。

## 五、重复运行必须先固定停止规则

`--repeat N` 会在执行前把 `N` 个独立 Run 封存进同一个 Evaluation Series。它是 test-retest 证据，不是「重试到成功」开关。应当在查看结果前确定 repeat 数与停止规则，然后完整报告这个 Series。不要在 verdict 不理想后反复重跑，再只发布第一次有利结果：这种未校正、由结果决定的重复属于 optional stopping，会使宣称的假阳性控制失效。

`--retry` 的用途不同：它只在已封存的 retry policy 下重试运行失败的 sample attempt。两个选项都不允许选择性删除、替换或报告已完成的观测。如果确实需要自适应停止设计，必须使用显式控制错误率的 sequential method；当前的固定设计 release Decision 不提供这种保证。参见 García-Pérez：[Statistical Conclusion Validity: Some Common Threats and Simple Remedies](https://pmc.ncbi.nlm.nih.gov/articles/PMC3429930/)。

## Release Decision

`omk.release-decision/v6` 消费经过认证的 Composite table、Bootstrap family，以及可选的 Judge Ensemble table。它会给出六种结论：

| Verdict | 含义 |
|---|---|
| `PROGRESS` | 比较显著向好，且所有已注册 release gate 通过 |
| `CAUTIOUS` | 有正向信号，但 practical-effect、layer、judge-dissent、未测量的 judge uncertainty 或 holdout gate 要求复核 |
| `REGRESSION` | 比较显著向坏 |
| `NOISE` | comparison 不显著，且实际观测的比较单元数达到已注册下限 |
| `UNDERPOWERED` | comparison 不显著，且实际观测的比较单元数低于已注册下限 |
| `SOLO` | 只有一个 Target，不存在 comparison |

运行状态、证据状态、结论状态与 verdict 始终正交。只有同时携带 `release-gates-passed` 的 `PROGRESS` 才能进入常规发布路由。跨 run 稳定性属于 Evaluation Series，绝不能从单次 run 推断。

对于配对设计，v6 使用完整 pair 数执行样本量 gate；对于独立设计，使用两侧实际观测单元数中的较小值，因为较大一侧不能补偿另一侧缺失的证据。已编写但未观测的用例不能把 `UNDERPOWERED` 变成 `NOISE`。Monte Carlo 误差下仍为 `indeterminate` 的显著性不会进入该 gate，而是保持 not-decided。对于显著向好的比较，v6 把 `triviallySmallDifference` 应用于持久化的四位小数 percentile 区间下界，而不是点估计。下界等于阈值时通过；下界低于阈值时，即使点估计很大也返回 `CAUTIOUS`。

默认的 `minimum-count` 要求是 20 个比较单元。它是可配置的启发式证据下限，不代表统计功效已经得到证明。正式发布研究如果已有可靠先验信息，可以在 `eval.yaml` 中声明配对比较的先验规划：

```yaml
decision:
  power:
    minimumDetectableDifference: 0.5
    expectedDifferenceStandardDeviation: 1.0
    targetPower: 0.8
    assumptionSource: pilot-2026-q3
```

omk 会在执行前封存最小有意义的 treatment-minus-control 差异、来自外部先导数据的配对差值标准差、目标功效、假设来源、家族 alpha、计划比较数量、方法 identity，以及据此计算的完整 pair 数要求。当前方法采用双侧正态近似，并按计划 comparison family 做 Bonferroni 分配；它是规划近似，不保证 percentile Bootstrap 的实际运行特性。复杂、强离散或偏态设计应在 omk 外通过 simulation 确定样本量，再用 `decision.minimumComparisonUnits` 登记结果。omk 明确不报告事后「观测功效」：用本次 run 的观测 effect 或 variance 为本次样本量辩护属于循环论证。

对于已配置的 Judge Ensemble，v6 会分别估计 control 与 treatment 的跨评委一致性。如果任一侧不足两个完整的评委成员序列，或者不足两个共同 sample，一致性就不可估计；正向结果会返回 `CAUTIOUS` 与 `judge-uncertainty-unmeasured`，而不是把一次 LLM 读数当成精确真值。未配置 Judge Ensemble 时此 gate 不适用。历史 release policy v1～v5 与 Bootstrap family v1 仍作为历史语义实现存在；新运行使用 v6 与 Bootstrap family v2。assignment-aware schema 切换会升级受影响的 Runtime identity，并且不保留切换前的 Plan reader。

规划依据：[NIST 的双侧样本量公式](https://www.itl.nist.gov/div898/handbook/prc/section2/prc222.htm)、[CONSORT 2025 对目标差异、假设、alpha 与功效预先声明的要求](https://www.bmj.com/content/389/bmj-2024-081124)，以及 [Hoenig 与 Heisey 对事后功效滥用的论证](https://doi.org/10.1198/000313001300339897)。

实现：`src/eval-workflows/runtime-adapter/analysis/release-decision.ts`。

## Construct validity 与审计链

统计方法无法挽救被污染的实验。严格 baseline 隔离会阻止 control 通过本机 skill、workspace 文件或 agent 工具发现 treatment。Artifact、Dataset、Runtime、evaluator、prompt、policy 与各阶段 identity 都会在第一次 Target 调用前封存。

每个持久化 run 都包含精确的 Run Plan、Execution Bundle、Evaluation Bundle、Analysis Bundle 和 Evaluation Report，并由 digest 串成 lineage。Studio 只是这些产物上的可重建 projection，不是第二份测量真相。冻结 prompt、五层评分语义、Bootstrap 公式、Krippendorff alpha、缺失证据处理或 length-debias 语义发生变化时，必须经过显式 `BREAKING-COMPARABILITY` 评审。

另见：[综合分](../specs/scoring.md)、[用例设计](../specs/sample-design-spec.md)与 [Evaluation Core 生产切换](../guides/eval-core-cutover.md)。
