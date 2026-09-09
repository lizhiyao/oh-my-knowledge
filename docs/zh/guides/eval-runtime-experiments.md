# 设计比较与复用评测证据

首次接入先完成[服务接入指南](./eval-runtime.md)。本页按需查阅，无需按顺序阅读所有章节。

代码片段中的 `input`、`variants` 和应用客户端沿用[完整接入示例](./eval-runtime-scoring.md#exact-match-评测)或由你的应用提供；它们不是 OMK 自带的服务。

<a id="prepare-plan"></a>

## 先检查计划，再决定是否运行

需要 dry-run 检查、预算复核或人工审批时，先完成准备：

```ts
const prepared = await prepareEvaluation(input);

console.log(prepared.definition, prepared.policy);
console.log(prepared.planDigest, prepared.resolvedRuntimes);
console.log(prepared.estimatedWork);

const result = await prepared.run({ runId: 'approved-release-42', signal });
```

准备阶段会解析 capability 并封存完整 Core Plan，不会调用 Target 或 Evaluator。`prepared.run()` 精确执行这份不可变 Plan；准备后修改原始 input，不会改变 Definition、Policy、digest 或执行行为。`estimatedWork` 给出 retry 或提前终止前计划的 execution／evaluation coordinate，并明确标出只有运行时才能确定的 duration 与 provider cost。直接调用 `evaluate(input, options)` 与 `prepareEvaluation(input).run(options)` 保持 canonical equivalence。
<a id="compare-runs"></a>

## 检查两次历史测量是否可比

需要判断两次独立 Run 是否支持精确比较时，把两份原始 result 交给 `assessComparability()`，并将每个有意变化的 Variant 显式映射成 subject：

```ts
import { assessComparability } from 'oh-my-knowledge';

const assessment = assessComparability({
  comparisonScope: 'decision',
  subjects: [{
    subjectId: 'candidate-under-test',
    leftVariantId: 'candidate',
    rightVariantId: 'candidate',
  }],
  left: previousResult,
  right: candidateResult,
});

if (assessment.comparabilityStatus !== 'compatible') {
  console.error(assessment.designStatus, assessment.evidenceQualificationStatus);
}
```

该 Assessment 不会比较分数，也不会判断候选是否进步；它只检查声明 subject 变化后，测量设计是否保持不变，以及两条 source chain 是否具备足够的认证证据。必须保留原始 result object：clone 或反序列化 artifact 无法保留进程内 Core source authority，因此会失败关闭。跨进程持久化 admission 在 Runtime artifact-store adapter 落地前继续由高级 Core surface 提供。
<a id="重复运行稳定性"></a>

## 重复整轮评测，检查结果是否稳定

如果一次测量看起来有提升，但你担心换一轮运行就得到不同结论，可以让 OMK 重复执行整轮评测。Evaluation Series 固定数据、评分方式和测量种子，记录每轮指定统计量的均值与波动。下面的 `repeatableInput` 需要另行准备：沿用[接入示例](./eval-runtime-scoring.md#exact-match-评测)中比较的分析 ID，但使用确定性服务，或真实支持种子控制的执行器，并声明受控的种子配对设计。该接入示例的 `uncontrolled` 配置不满足跨轮精确可比性要求，直接用于 Series 会得到 `inconclusive`，不能靠反复运行得到稳定性数值。

满足这些前提后，使用下面的代码重复运行并读取结果：

```ts
import { prepareEvaluationSeries } from 'oh-my-knowledge';

const preparedSeries = await prepareEvaluationSeries({
  evaluation: repeatableInput,
  seriesInstanceId: 'release-42-repeatability',
  repeatCount: 10,
  stability: {
    sourceAnalysisId: 'prompt-v1-vs-v2-correct',
    projection: 'interval-estimate',
  },
});

// 此时尚未调用 Target 或 Evaluator。
console.log(preparedSeries.memberPlans, preparedSeries.estimatedWork);

const series = await preparedSeries.run({ signal });
if (series.status === 'failed') throw new Error(series.error.code);
if (series.status === 'cancelled') throw new Error('Series 已取消。');
if (series.stability?.analysisStatus === 'completed') {
  console.log(series.stability.value.mean);
  console.log(series.stability.value.sampleStandardDeviation);
} else {
  console.error(series.stability);
}
```

必须在执行前声明完整 `repeatCount`。OMK 只捕获一次 Evaluation 声明，预注册全部 membership，并验证每个 member 的各阶段 plan digest 保持一致，同时为其分配唯一 Run contract。Member 按顺序执行，Execution／Evaluation cache 必须禁用。失败或取消的 member 会保留真实的 partial、failed、cancelled 或 missing coverage 状态，绝不会被替换；API 也不会根据已观察值提前停止。每个 member 独立使用自己的 Run budget。

Series 的实验单位是一轮完整 Run。Trial、retry、sample 与评委 replicate 仍嵌套在 Run 内，不会增加 `runCount`。测量 seed 与其它设计条件一起保持固定，因此支持 seed 的 Executor 会在各 member 收到相同 trial seed；有意改变 Run-level seed 需要另一种实验契约。稳定性表只提供描述性统计：mean、分母为 `n - 1` 的贝塞尔校正样本方差、标准差、最小值、最大值与极差；它不会发布 release verdict、估计 iid 置信区间，也不能证明跨环境复现性。全部预注册 slot 都必须符合 evidence 门槛并可比较，否则 stability 为 inconclusive，不会静默删除失败或缺失 Run。使用 `projection: 'scalar'` 选择 scalar Analysis result；需要提取区间点估计时，必须显式使用 `interval-estimate` projection。默认只接纳完整 evidence；只有对应 missingness policy 对目标结论合理时，才显式允许 partial evidence。

`PreparedEvaluationSeries` 只能使用一次，`seriesInstanceId` 标识本次有意执行。真正开始一轮新 Series 时应使用新的值。直接调用 `evaluateSeries(input, options)` 等价于准备后运行一次。
<a id="reuse-stages"></a>

## 改了标注或统计方法后，复用已有输出

修正了标准答案、调整了评分规则或统计方式时，不一定需要再次调用模型。按变化发生的位置选择下面的函数，并传入上一次运行的原始 `result`：

| 改了什么 | 调用什么 | 哪些工作会重做 |
|---|---|---|
| 标准答案或评分规则 | `rescore()` | 评分及其后的分析、结论。 |
| 统计分析方式 | `reanalyze()` | 分析及结论。 |
| 结论规则 | `redecide()` | 只重做结论。 |

如果 prompt、实际输入或执行配置变了，应重新运行 `evaluate()`。下面的 `correctedGoldDataset` 等变量代表你更新后的完整声明：

```ts
import { reanalyze, redecide, rescore } from 'oh-my-knowledge';

const rescored = await rescore(
  { ...input, dataset: correctedGoldDataset },
  originalResult,
  { runId: 'corrected-gold' },
);
const reanalyzed = await reanalyze(
  { ...input, analyses: revisedAnalyses },
  rescored,
  { runId: 'revised-analysis' },
);
const redecided = await redecide(
  { ...input, analyses: revisedAnalyses, decision: revisedDecision },
  reanalyzed,
  { runId: 'revised-decision' },
);
```

`rescore()` 复用 Execution，`reanalyze()` 复用 Execution 与 Evaluation，`redecide()` 复用 Execution、Evaluation 与 Analysis。每次调用都接收一份完整的新声明，确保默认值与 identity 在后缀运行前封存。Core 会拒绝任何属于已跳过阶段的变化；只有当前进程中的原始 canonical result object 携带所需 source authority。Run options、进度事件与预算消耗只作用于新执行的后缀；复用 bundle 保留原始 identity 与历史 evidence，不会再次计费。跨进程复用持久化 Bundle 时，应通过 Core 显式 admission 并独立验证 provenance；report 或 JSON clone 绝不是充分证据。
<a id="independent-groups"></a>

## 让不同用例分配给不同版本

`paired` 设计让每条用例都运行两个版本。若实验要求每条用例只运行其中一个版本，改用 `independent` 并声明各版本的分配权重。下面按 `locale` 分层分配，要求数据中提供 `executionContext.locale`，且用例数量满足每组及每层的最低要求；[接入示例](./eval-runtime-scoring.md#exact-match-评测)中的两条教学用例无法满足这个配置：

```ts
comparisons: [{
  comparisonId: 'prompt-v1-vs-v2',
  controlVariantId: 'prompt-v1',
  treatmentVariantIds: ['prompt-v2'],
  metricIds: ['correct'],
}],
experiment: {
  seed: 'release-2026-09-04',
  sampling: {
    samplingKind: 'independent',
    allocations: [
      { variantId: 'prompt-v1', weight: 1 },
      { variantId: 'prompt-v2', weight: 1 },
    ],
    minimumSamplesPerVariant: 20,
    minimumSamplesPerVariantPerStratum: 5,
    stratumKey: '/executionContext/locale',
  },
},
```

OMK 会在执行前确定性地为每个 sample 封存唯一 Variant。重复 trial 沿用该分组；改变 seed、weight、stratum 或 minimum 都会产生新的 randomization identity。
<a id="multiple-criteria"></a>

## 同时约束多个发布指标

如果发布必须同时满足「正确性不能下降太多」和「安全性不能下降」，应在运行前一起声明这组比较和阈值。比较越多，单独看每个 95% 区间越容易作出错误的联合判断；`comparison-family` 会对这组区间进行多重比较校正。下面假设已定义 `correctness` 与 `safety` 评分指标：

```ts
analyses: [{
  analysisId: 'release-family',
  analysisKind: 'comparison-family',
  statistic: 'mean-difference',
  members: [
    {
      analysisId: 'v2-correctness',
      comparisonId: 'prompt-v1-vs-v2',
      treatmentVariantId: 'prompt-v2',
      metricId: 'correctness',
    },
    {
      analysisId: 'v2-safety',
      comparisonId: 'prompt-v1-vs-v2',
      treatmentVariantId: 'prompt-v2',
      metricId: 'safety',
    },
  ],
  confidence: {
    method: 'bonferroni-percentile-bootstrap',
    level: 0.95,
    resamples: 10_000,
  },
}],
decision: {
  decisionKind: 'comparison-family',
  analysisId: 'release-family',
  rule: 'all',
  criteria: [
    { analysisId: 'v2-correctness', minimumEffect: -0.01 },
    { analysisId: 'v2-safety', minimumEffect: 0 },
  ],
},
```

上例两个 member 使用 97.5% 边际区间；当边际区间过程达到其标称覆盖率时，目标是让已声明 family 的同时覆盖率至少为 95%。Percentile Bootstrap 仍是近似方法，因此这项校正不构成无条件的有限样本覆盖保证。Family record 位于 `result.analysisResults['release-family']`，每个 member 仍可通过自己的 `analysisId` 定位。成员会在执行前固定，preset 绝不会从 Bootstrap 区间伪造 p-value。

可选的 family `decision` 会指向该外层 family，并为每个 member 声明一项有界 criterion。Boundary 使用原始 treatment-minus-control effect 单位，相等视为 acceptable。使用 `rule: 'all'` 时，只有每个完整同时区间都落入各自声明的 boundary，OMK 才返回 `RELEASE`；任一区间完全落在某条 boundary 外即返回 `BLOCK`；任一区间仍跨越 boundary 则返回 not-decided。Criterion 不能缺失、重复、在看到结果后补充、加权，或折叠为 composite score。
<a id="composite-score"></a>

## 将多个指标合成为一个分数

如果业务明确规定「总体质量由正确性占 70%、简洁性占 30% 构成」，可以声明加权综合分。先确认这种权衡有业务依据，再固定权重；不能用综合分掩盖必须分别达标的安全或质量要求。下面假设已经定义了这两个指标：

```ts
analyses: [{
  analysisId: 'v2-overall-quality',
  analysisKind: 'composite-comparison-interval',
  compositeMetricId: 'overall-quality',
  comparisonId: 'prompt-v1-vs-v2',
  treatmentVariantId: 'prompt-v2',
  components: [
    { metricId: 'correctness', weight: 0.7 },
    { metricId: 'conciseness', weight: 0.3 },
  ],
  aggregation: { method: 'weighted-mean', missing: 'require-complete' },
  confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 10_000 },
}],
```

每个 component 必须是 boolean Metric，或具有单调 direction 的有界 numeric Metric。OMK 会依据 sealed source Metric 将其转换到 `[0, 1]`，在实验单位内合成完整读数，最后才对 derived Metric 执行 Bootstrap。权重必须为正、按 `metricId` 唯一且严格求和为一；系统不会提供默认权重、覆盖 scale、clamp 越界值，也不会在证据缺失后重新归一化。单 Variant 质量使用带 `variantId` 的 `composite-quality-interval`；treatment-minus-control 变化使用 `composite-comparison-interval`，并由 paired 或 independent Sampling Design 决定重采样语义。Decision 通过 `analysisId` 选择其中任一结果。
