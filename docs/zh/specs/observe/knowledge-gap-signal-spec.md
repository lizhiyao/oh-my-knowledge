# 知识缺口信号契约

本文规定生产观测已使用的启发式信号和聚合边界。用户入口见[观测指南](../../guides/observe/observe-production.md)。

## 1. 输入与意义 {#current-scope}

`omk observe` 将来源 trace 的实际工具与文本记录转换为分析输入。`computeGapReport` 只纳入目标 variant 存在且 `ok !== false` 的条目；上游负责建立来源与任务／skill 分段。必须同时读 `sampleCount` 和来源完整性，不从零率推导没有问题。

信号表示可复核的失败搜索或不确定性线索。它不能证明知识不存在、知识库完整或某个载体导致了结果。知识文件访问 coverage 与 Core evidence coverage 分属不同用途，不混读。

## 2. 四类信号 {#current-signals}

| 信号 | 当前来源 | 权重 |
|---|---|---|
| failed_search | 搜索或文件读取失败／未命中 | 1.0 |
| repeated_failure | 同类搜索至少三次连续失败 | 1.0 |
| explicit_marker | 输出中的显式推断／未知／缺口标记 | 0.5 |
| hedging | 输出中的不确定措辞模式 | 0.5 |

规则细节由 `observability/analysis/gap-analyzer.ts` 和 `trace/tool-search.ts` 拥有。探索性搜索、引用规则本身、业务假设等可能造成误报；阅读原上下文后再决定是否形成知识或用例。

## 3. 聚合 {#current-aggregation}

`gapRate = samplesWithGap / sampleCount`。分子按有信号的 sampleId 去重，分母计纳入的有效条目；上游分段使用唯一 sampleId，同一身份不因信号多而重复进入分子。`weightedGapRate` 对每条目取最高信号权重后平均；类型计数仍记录各信号事件。

两率保留四位小数，分母为零时返回零，同时保留零 sampleCount。它只是受当前来源和规则条件限制的统计，不能跨不同来源范围、规则或任务分布直接解读改善。

## 4. 可显式调用的分类器 {#current-classifier}

`applyHedgingClassifier` 是代码层可调用能力，生产观测没有自动接入。调用方须提供 `model`；默认最多分类 50 个 candidate、每批 10 个。超限尾部与调用／解析失败保守保留，结果返回 `truncated`；数量上限不保证金额预算。

缓存位于进程内，以句子摘要前 16 位为键；它不是持久测量证据。confidence 是模型自报，不进入权重，也不是校准后的可靠性。当前没有自动开启、默认模型或 `eval.yaml.hedgingClassifier` 配置。

## 5. 展示与后续动作 {#current-display}

报告保留信号上下文、分母、来源范围与限制；人核对原始记录后，才决定修订知识或草拟正式评测用例。有效复核优先级及注释应用由[观测复核规范](effective-observation-review.md)负责，不回写原始证据。

当前 `omk eval` 不提供 `--max-gap-rate` 或 `--gap-rate-regression`。自动扩用例 nudge、知识完备性判断、主动 competency questions 与跨评测 gap 门禁均未交付。
