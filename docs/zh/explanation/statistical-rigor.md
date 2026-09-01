<!--
title: 统计严谨性——不确定性、校准、去偏与证据门禁
description: Evaluation Core 的结论为何可审计：预注册 Bootstrap family、显式 Gold 对比、冻结评委 prompt，以及失败关闭的 evidence coverage。
-->

# 统计严谨性

omk 评估一次知识改动时，会固定模型和用例设计，只改变 artifact，并让证据沿 sealed Evaluation Core plan 流动。更高的展示分数不是发布授权；已注册的 Core Decision 必须能把结论追溯到完整、可比的观测与预注册分析。

四道防线分别覆盖不同的失败模式。

## 一、Bootstrap comparison family

`omk eval` 根据实际观测到的 sampling unit，通过 percentile Bootstrap 估计不确定性，不假设分数服从某种参数分布。

- Target 均值与 treatment-minus-control 区间由 `omk.bootstrap-family-table/v1` 生成；
- paired design 必须声明显式 pairing key，绝不会自动降级为 independent estimator；
- 多个 treatment 共享一组封存的 comparison family，有效显著性水平为 `alpha / K`，增加比较数量不会静默放大家族假阳性率；
- 重采样次数、名义 alpha、design、Target／Sample 顺序与确定性 Mulberry32 随机流都进入 Analysis identity；CLI 默认重采样 1000 次；
- comparison interval 缺失时保持 inconclusive，release policy 不会拿点估计兜底。

实现：`src/eval-workflows/runtime-adapter/analysis/bootstrap-family-table.ts` 与 `bootstrap-family-parameters.ts`。

## 二、Gold agreement 是显式校准

Bootstrap uncertainty 回答的是观测差异能否与重采样噪声区分，不能证明 LLM 评委与人工标准一致。

因此，Gold comparison 是独立的、经过认证的 Core projection。调用方必须选择精确的 run、Target、Evaluator、数值 Metric，以及可选的 trial coordinate。Gold 与 Metric 的量尺必须完全一致；观测存在歧义时显式失败，不会跨 trial 或 ensemble member 暗自平均。

投影会报告：

- 以 interval distance 计算的 Krippendorff alpha，作为主要一致性统计量；
- 加权 kappa 与 Pearson correlation，作为辅助诊断；
- paired-unit Bootstrap uncertainty 与结构化 missing 状态；
- annotator 与评委身份可能让一致性过于乐观时的污染警告。

事后 Gold comparison 属于 exploratory calibration，不会反向改写预注册的 release Decision。

实现：显式 projection 位于 `src/eval-workflows/downstream-projections/gold.ts`；预注册 Core Analysis node 位于 `src/eval-workflows/runtime-adapter/analysis/agreement-table.ts`。

## 三、评委去偏与 prompt identity

LLM 评委可能在正确性之外奖励冗长、精致排版或自信语气。omk 的 rubric prompt 会显式中性化这些信号。

- 排版与语气中性化始终开启；
- 长度去偏默认开启；`--no-debias-length` 只关闭长度指令，用于受控研究或复现；
- 每条评分类 prompt 都有 registry identity 与 hash；evaluator identity 或 prompt variant 不同时，报告不会被当作可盲比事实；
- hash 由 `src/shared/llm-prompts/registry.ts` 驱动，并由 `test/shared/prompt-registry-freeze.test.ts` 冻结。

Prompt 指令只能降低已知偏差风险，不能证明评委无偏；Gold calibration 才是外部校验。

## 四、Evidence 与 coverage 失败关闭

缺失证据既不是零分，也不会在 Decision 边界被静默丢弃。

- Assertion、judge、dimension 与 composite table 会保留 observed、missing、invalid、failed、unavailable 和 not-started 状态；
- 结构性不适用与计划观测但未取得结果是两回事；
- coverage 沿 Analysis lineage 守恒，读取传输后的 Bundle 时会再次校验；
- release Decision 必须先确认 evidence 完整且 source binding 精确，才能给出方向性结论。

这能防止困难 coordinate 因为没产出分数，反而让 run 看起来更好。

## Release Decision

`omk.release-decision/v1` 消费经过认证的 Composite table、Bootstrap family，以及可选的 Judge Ensemble table。它会给出六种结论：

| Verdict | 含义 |
|---|---|
| `PROGRESS` | 比较显著向好，且所有已注册 release gate 通过 |
| `CAUTIOUS` | 有正向信号，但 practical-effect、layer、judge-dissent 或 holdout gate 要求复核 |
| `REGRESSION` | 比较显著向坏 |
| `NOISE` | comparison interval 跨 0，且计划用例数达到已注册下限 |
| `UNDERPOWERED` | comparison interval 跨 0，且计划用例数低于已注册下限 |
| `SOLO` | 只有一个 Target，不存在 comparison |

运行状态、证据状态、结论状态与 verdict 始终正交。只有同时携带 `release-gates-passed` 的 `PROGRESS` 才能进入常规发布路由。跨 run 稳定性属于 Evaluation Series，绝不能从单次 run 推断。

实现：`src/eval-workflows/runtime-adapter/analysis/release-decision.ts`。

## Construct validity 与审计链

统计方法无法挽救被污染的实验。严格 baseline 隔离会阻止 control 通过本机 skill、workspace 文件或 agent 工具发现 treatment。Artifact、Dataset、Runtime、evaluator、prompt、policy 与各阶段 identity 都会在第一次 Target 调用前封存。

每个持久化 run 都包含精确的 Run Plan、Execution Bundle、Evaluation Bundle、Analysis Bundle 和 Evaluation Report，并由 digest 串成 lineage。Studio 只是这些产物上的可重建 projection，不是第二份测量真相。冻结 prompt、五层评分语义、Bootstrap 公式、Krippendorff alpha、缺失证据处理或 length-debias 语义发生变化时，必须经过显式 `BREAKING-COMPARABILITY` 评审。

另见：[综合分](../specs/scoring.md)、[用例设计](../specs/sample-design-spec.md)与 [Evaluation Core 生产切换](../guides/evaluation-core-cutover.md)。
