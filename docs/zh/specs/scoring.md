<!--
title: 综合分——推导、coverage 与 Decision 边界
description: Evaluation Core 如何推导 fact、behavior、judge、dimension 与 composite 证据，同时避免把缺失观测变成零分或把展示分数当作发布授权。
-->

# 综合分

Evaluation Core 把评分表达成经过认证的 evidence graph，而不是一行可变 report 数据。历史五层契约保持稳定：`assertion`、`llm`、`judge`、`dimension` 与 `composite`；这些名称表示职责，不是五次连续求平均。

```text
criterion observation          raw rubric reading
          │                              │
          ▼                              ▼
 assertion-layer table      replicate → ensemble table
     fact / behavior                    │
          │                       dimension table
          └──────────────┬───────────────┘
                         ▼
                  composite table
                         │
             Bootstrap comparison family
                         │
                 Release Decision
```

## Assertion layer

每条 Boolean criterion 都会通过封存的 Analysis parameter 显式绑定为 `fact`、`behavior` 或 `excluded-mixed-layer`，并携带有限正权重。实现不会根据 assertion 名称或 evaluator ID 猜测分类。

对一个 Target／Sample／Trial coordinate，观测到的 assertion layer 按下式计算：

```text
layerScore = 1 + passedObservedWeight / observedWeight × 4
```

结果在 1–5 量尺上保留两位小数。结构性不适用不进入 assertion 计分的 planned coverage；Analysis Bundle v2 仍保留矩形输入坐标，将其单列到 `notApplicable`，并通过 `notApplicableRows` 认证行身份与原因，因此不会把它误判为不完整证据。missing、invalid、failed、unavailable 与 not-started observation 会保持为显式 coverage 状态，绝不变成 `false`。没有任何权重被观测到时，该层为 missing，不是零分。

实现：`src/eval-workflows/runtime-adapter/analysis/assertion-layer.ts` 中的 `omk.assertion-layer-table/v1`。

## Judge 与 dimension 推导

原始 rubric reading 会保留 evaluator、metric、instrument、ensemble member、replicate group、replicate index、Sample、Trial 与 sampling-unit identity。

- replicate table 对同一计划 member 的 observed reading 求平均，并保留未观测行；
- ensemble table 对每个 observed member mean 等权聚合，只有证据满足要求时才报告 agreement；
- dimension table 把每个 dimension 绑定到一个 Metric 和一个上游 ensemble result。上游证据缺失时继续保持 missing；零个 observed dimension 不会变成零分。

这能避免把 retry attempt、judge repeat、ensemble member、Trial 与独立 Run 压成同一个统计单位。

## Composite 推导

封存参数最多绑定三个 present layer：`fact`、`behavior` 与 `judge`。judge source 可以是 ensemble consensus，也可以是 dimension aggregate。

```text
composite = mean(observed present layers)
```

聚合值保留两位小数。不存在的 layer 属于结构性不适用；存在但缺失的 layer 仍是显式 missing evidence。所有计划 layer 都未观测到时，composite 为 missing，而不是数值零。每个 source group 与 binding 都会保留在 lineage 中，传输后的 table 也会在校验时重新计算。

实现：`src/eval-workflows/runtime-adapter/analysis/composite-table.ts` 中的 `omk.composite-table/v1`。

## Composite 能回答什么

composite 是同一 sealed design 内的比较信号。Dataset、Target 条件、evaluator identity、policy 与 layer binding 保持不变时，它适合进入预注册的 treatment-minus-control Bootstrap 比较。

它不是绝对 psychometric level。等权聚合属于务实选择，assertion 通过率与 rubric score 具有不同测量性质，不同 present layer 的设计也在测量不同 construct。不要用 raw composite 给互不相关的 artifact、dataset 或 run 排名。

## Decision 边界

composite score 或正向点估计本身不能授权发布。`omk.release-decision/v6` 消费精确绑定的 Composite 与 Bootstrap-family v2 result，以及可选的 Judge Ensemble result，并先校验证据完整性与 source lineage。统计显著性使用未舍入的尾部证据；有限重采样的 Monte Carlo 不确定性跨越显著性阈值时失败关闭。正向比较只有在持久化的四位小数 percentile 区间下界大于或等于 `triviallySmallDifference` 时，才能通过实际效应 gate；点估计很大但下界不确定时仍为 `CAUTIOUS`。

它的六种结论是 `PROGRESS`、`CAUTIOUS`、`REGRESSION`、`NOISE`、`UNDERPOWERED` 与 `SOLO`。常规发布路由要求 Decision 已决定为 `PROGRESS`，且携带 `release-gates-passed`。如果已绑定 Judge Ensemble，但 control 或 treatment 无法估计跨评委一致性，正向比较会变为 `CAUTIOUS`，并携带 `judge-uncertainty-unmeasured`；未绑定 Judge Ensemble 的确定性评测不受影响。非显著配对比较使用完整 pair 数执行样本量 gate，独立比较使用两侧实际观测单元数中的较小值。封存要求可以是显式下限，也可以是可重算的配对比较先验规划；规划绝不读取本次 run 的观测 variance。区间缺失或 Monte Carlo 误差下仍未决的显著性保持 not-decided；多 treatment 使用已注册的最差结论；跨 run 稳定性属于 Evaluation Series，不能从单次 run 分数推断。历史 release policy v1～v5 与 Bootstrap family v1 仍保留注册以精确重放。

不确定性、一致性、去偏与 coverage gate 详见[统计严谨性](../explanation/statistical-rigor.md)。

## 可比性不变量

五层语义、冻结的评分类 prompt、Bootstrap 公式、缺失证据语义与 length-debias toggle 是跨版本比较的锚点。改变这些语义时，必须显式经过 `BREAKING-COMPARABILITY` 评审。纯展示性质的 Studio projection 绝不能重新定义 score 或 Decision。
