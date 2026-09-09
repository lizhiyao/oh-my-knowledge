# 选择评分方法

首次接入先完成[服务接入指南](./eval-runtime.md)。本页按需查阅，无需按顺序阅读所有章节。

代码片段中的 `input`、`variants` 和应用客户端沿用[完整接入示例](./eval-runtime-scoring.md#exact-match-评测)或由你的应用提供；它们不是 OMK 自带的服务。

<a id="评测术语"></a>

## 读懂代码中的几个名字

可以把一次评测理解为：准备题目 → 分别运行待比较版本 → 按规则评分 → 汇总差异。代码中的字段对应这些工作：

| 字段／术语 | 你要提供或得到的内容 |
|---|---|
| `artifact`（知识载体） | 被修改的 prompt、skill、agent、workflow 或空白基线。 |
| `variant`（待测版本） | 知识载体加上运行它所需的配置，例如「旧 prompt」和「新 prompt」。 |
| `dataset`／`sample`（数据集／用例） | 一组测试输入；`expected` 保存标准答案，供评分使用。 |
| `executor`（执行器） | 你编写的调用代码，接收输入并返回实际输出。 |
| `evaluator`（评分器） | 判断输出的规则，例如完全匹配、检索指标或 LLM 评委。 |
| `metric`（指标） | 一个读数的名字和含义，例如 `correct` 表示是否完全匹配。 |
| `comparison`（比较关系） | 哪个是对照版本（`control`），哪个是候选版本（`treatment`），比较哪些指标。 |
| `experiment`（实验设计） | 用例如何分配、重复运行几次、使用什么测量种子。 |
| `analysis`（统计分析） | 如何将逐条读数汇总为均值、差值或置信区间。 |
| `decision`（可选结论规则） | 根据指定分析给出结论；声明评分器本身不会自动产生发布结论。 |
| `policy`（运行限制） | 并发、超时、重试、预算和证据保留方式。 |
| `result`（结果） | 运行状态、逐条证据、统计分析、可选结论与报告。 |

执行器负责「运行」，评分器负责「评分」，分析负责「汇总」。后文的宿主指你的 Node.js 应用；Core 指 OMK 的测量引擎；封存指在执行前固定配置，以免运行中改变评分口径。`trial` 是一次计划执行，`attempt` 是其中的一次尝试，失败重试会增加尝试次数。
<a id="exact-match-评测"></a>

## 判断输出是否与标准答案完全一致（Exact match）

当任务要求返回固定答案、分类标签或结构化数据时，可以使用「完全匹配」评分器（`exact-match`）。你为每条样本提供标准答案 `expected`，OMK 将执行器返回的 `output` 与它比较：一致记为 `true`，不一致记为 `false`，默认指标名为 `correct`。这项比较不需要调用 LLM 评委。

例如，标准答案是字符串 `"巴黎"` 时：

| 实际输出 | 是否匹配 | 原因 |
|---|---|---|
| `"巴黎"` | 是 | 与标准答案完全一致。 |
| `"法国的首都是巴黎"` | 否 | 意思正确，但输出内容不同。 |
| `"巴黎。"` | 否 | 多了句号。 |
| `" 巴黎 "` | 否 | 多了前后空格，评分器不会自动去除。 |

它适合要求精确输出的任务，例如返回 `"退款"` 或 `"咨询"` 的分类任务。允许多种正确表述的开放问答，应考虑 [Rubric 评委](./eval-runtime-scoring.md#rubric-评委评测)，按明确的评分标准判断答案；需要自行去除空格、忽略大小写或提取字段后再比较时，可使用 [自定义评分器](./eval-runtime-scoring.md#custom-evaluator)。

对于 JSON 输出，OMK 比较规范化后的 JSON 值：对象字段顺序不影响结果，数组元素顺序、值的类型和字符串内容仍须一致。例如，`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 匹配，数字 `4` 与字符串 `"4"` 不匹配。字符串形式的 JSON 不会自动解析成对象。

下面演示如何接入模型服务、提供标准答案，并比较两个 prompt 版本的完全匹配率。`modelGateway` 和 `reportStore` 代表你自己的模型调用与报告存储代码，需要替换为实际实现。

安装 OMK 和一个运行时 schema 库。Schema 只需提供 `parse(unknown)` 方法；下面使用 Zod：

```bash
npm install oh-my-knowledge zod
```

### 1．接入自己的服务

执行器声明输入、配置和输出的格式，并在 `execute()` 中调用你的服务。`capabilities` 必须描述服务的真实能力；例如随机模型不能声明为确定性服务，声明支持取消时必须将 `signal` 传给实际调用。版本和 `fingerprintFacets` 用来识别实际实现，示例占位值需要替换。

```ts
import { z } from 'zod';
import { evaluate, type EvaluateInput, type Executor, type Variant } from 'oh-my-knowledge';

type Input = { prompt: string };
type Config = { deployment: string };

const executor: Executor<Input, Config, string> = {
    executorId: 'acme.answer-service/v1',
    version: '1.4.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ deployment: z.string() }).strict(),
      output: z.string(),
    },
    outputClassification: 'sensitive',
    capabilities: {
      determinism: 'stochastic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe', maxInFlight: 16 },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'required' },
    },
    fingerprintFacets: { deploymentRevision: 'sha256:...' },
    async execute({ input, artifact, config, runtimeContext, signal }) {
      const response = await modelGateway.generate({
        deployment: config.deployment,
        prompt: `${artifact.content ?? ''}\n${input.prompt}`,
        context: runtimeContext?.values,
        signal,
      });
      return { output: response.text, usage: response.usage };
    },
};
```

### 2．声明待比较的版本

下面只改变 prompt，两个版本使用同一模型部署和运行配置。这样才能将差异归因于 prompt；如果模型、知识库或工具也变了，需要把它们作为有意改变的条件说明。

```ts
const variants: Variant<Input, Config, string>[] = [{
  variantId: 'prompt-v1',
  artifact: {
    name: 'answer-prompt-v1',
    kind: 'prompt',
    source: 'inline',
    content: '简洁回答。',
  },
  execution: {
    executor,
    config: { deployment: 'deployment-a' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
}, {
  variantId: 'prompt-v2',
  artifact: {
    name: 'answer-prompt-v2',
    kind: 'prompt',
    source: 'inline',
    content: '简洁、准确地回答。',
  },
  execution: {
    executor,
    config: { deployment: 'deployment-a' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
}];
```

### 3．准备标准答案并运行

`input` 是发送给服务的内容，`expected` 是供评分使用的标准答案；不要将标准答案拼进待测 prompt。下面让两个版本回答相同的两道题（`paired`），再比较完全匹配率。两条用例只展示接线方式，真实结论需要有代表性、数量充分的评测数据。

示例服务不支持控制模型种子，因此显式设置 `seedCoupling: 'uncontrolled'`：同一条用例仍在两个版本上配对运行，但模型随机性不受控。`experiment.seed` 固定 OMK 的测量设计，不会让模型自动变成确定性服务；默认的共享种子配对不能用于这种执行器。

```ts
const input: EvaluateInput = {
  dataset: {
    datasetId: 'answer-regression',
    samples: [
      { sampleId: 'one', input: { prompt: '法国的首都是哪里？' }, expected: '巴黎' },
      { sampleId: 'two', input: { prompt: '2 + 2 等于几？' }, expected: '4' },
    ],
  },
  variants,
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [{
    comparisonId: 'prompt-v1-vs-v2',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct'],
  }],
  analyses: [{
    analysisId: 'prompt-v1-vs-v2-correct',
    analysisKind: 'comparison-interval',
    statistic: 'mean-difference',
    comparisonId: 'prompt-v1-vs-v2',
    treatmentVariantId: 'prompt-v2',
    metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1_000 },
  }],
  decision: {
    decisionKind: 'analysis',
    analysisId: 'prompt-v1-vs-v2-correct',
  },
  experiment: {
    seed: 'release-2026-09-04',
    trials: 1,
    sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' },
  },
  policy: {
    execution: { maxConcurrency: 4 },
    evaluation: { maxConcurrency: 4 },
  },
};
const result = await evaluate(input);

if (result.status === 'failed') throw new Error(result.error.code);
if (result.status !== 'completed') throw new Error(`评测未完成：${result.status}`);
await reportStore.put(result.report);
```
<a id="retrieval-评测"></a>

## 判断检索结果是否相关、排序是否合理

检索评测回答的是「找到了多少相关文档、相关文档排得够不够靠前」，不会判断最终生成的回答质量。准备每道查询的已知相关文档 ID，再让检索执行器返回实际的有序 ID 列表。

下面的 `retrieverVariant` 需要由你按前面的接入方式定义：接收 `{ query: string }`，成功时返回 `{ output: { documents: ['refund-policy', 'other-doc'] } }`，并声明匹配的输出 schema。`/documents` 表示读取输出对象的 `documents` 字段；`/relevantDocumentIds` 表示读取 `expected` 中的同名字段。`cutoff: 10` 只检查前 10 个结果。使用 `solo` 时，执行器须为确定性执行或真实支持 OMK 传入的测量种子；能力要求详见 [API 参考](../reference/eval-runtime-api.md)。

```ts
import { evaluate, type RetrievalEvaluator } from 'oh-my-knowledge';

const retrieval: RetrievalEvaluator = {
  evaluatorKind: 'retrieval',
  evaluatorId: 'retrieval-quality',
  cutoff: 10,
  ranking: { source: 'output', pointer: '/documents' },
  relevantDocumentIdsPointer: '/relevantDocumentIds',
  metricIds: {
    recallAtK: 'recall-at-10',
    precisionAtK: 'precision-at-10',
    reciprocalRankAtK: 'reciprocal-rank-at-10',
    ndcgAtK: 'ndcg-at-10',
  },
};

const result = await evaluate({
  dataset: {
    datasetId: 'search-regression',
    samples: [{
      sampleId: 'refund-policy',
      input: { query: '退款规则是什么？' },
      expected: { relevantDocumentIds: ['refund-policy', 'billing-faq'] },
    }],
  },
  variants: [retrieverVariant],
  evaluators: [retrieval],
  comparisons: [],
  analyses: [{
    analysisId: 'mean-reciprocal-rank-at-10',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: retrieverVariant.variantId,
    metricId: 'reciprocal-rank-at-10',
  }],
  experiment: { seed: 'search-v1', sampling: { samplingKind: 'solo' } },
  policy: {},
});
```

| 指标 | 回答的问题 | 数值解读 |
|---|---|---|
| Recall@K（召回率） | 已知相关文档找全了多少？ | 前 K 条中命中的相关 ID 数除以已知相关 ID 总数。 |
| Precision@K（查准率） | 前 K 个位置有多少命中？ | 命中数除以 K；只返回 1 条正确结果，K 为 10 时仍是 `0.1`。 |
| Reciprocal Rank@K（倒数排名） | 第一条相关文档出现得够早吗？ | 第 1 名为 `1`，第 2 名为 `0.5`，前 K 条未命中为 `0`。多条用例的均值称为 MRR。 |
| nDCG@K（归一化折损累计增益） | 相关文档整体是否排在前面？ | 与理想排序比较，取值为 0～1，越高越好。 |

上例的汇总位于 `result.analysisResults['mean-reciprocal-rank-at-10']`，只请求了 MRR；需要其它指标的均值时，为其分别声明 `summary` 分析。没有任何相关文档的用例，应按下一节的弃答场景评测，不要用空标注冒充零分。

Ranking 必须是由不重复、非空字符串 ID 组成的有序数组，可来自 `output` 或 `trace`；relevant ID 始终来自 `expected`，不会传给 Executor。该预设先按 `cutoff` 截断，再以 `hits / known relevant` 计算 Recall、以 `hits / cutoff` 计算 Precision、以首个 relevant 文档的名次计算 Reciprocal Rank，并使用 binary gain 与 log2 discount 计算 nDCG。空返回 ranking 是合法的零分；重复或非法 ID、空 relevant 集合会产出 invalid evidence。Reciprocal Rank 的 mean summary 才是 MRR，不要把单个 sample 的观测称为 MRR。
<a id="retrieval-abstention"></a>

## 召回与空返回混合评测

要同时回答「有方案时找得对吗」「没方案时能正确空返回吗」「是否推荐了明确不可用的方案」，从单文件 `examples/eval-runtime/retrieval-abstention.mjs` 开始。OMK 内置召回与弃答评分；文件中的数据准备和禁用 ID 检查是可修改的业务示例，不需要自己重写弃答评分器。

### 1．先跑通示例

使用 Node.js 22 或更高版本，在包含该示例的源码检出目录运行：

```bash
yarn install --immutable
yarn build
node examples/eval-runtime/retrieval-abstention.mjs
```

示例使用合成数据，不需要 API Key 或业务服务。独立项目只需复制这一个 `.mjs` 文件，安装包含 `AbstentionEvaluator` 的 OMK 版本及示例直接使用的 Zod：

```bash
npm install oh-my-knowledge zod
node retrieval-abstention.mjs
```

如果功能尚未随 npm 版本发布，先使用[主指南的源码运行方式](./eval-runtime.md)；复制新示例配合旧版安装包不会获得新增能力。

### 2．替换 `source` 数据

保持每个 `sampleId` 唯一。下面是一条已确认没有适用方案的样本：

```js
{
  sampleId: 'no-solution-001',
  input: { query: '这个问题没有适用的现有方案' },
  expected: {
    shouldAbstain: true,
    acceptableSolutionIds: [],
    forbiddenSolutionIds: ['solution-wrong'],
  },
  quality: { reviewStatus: 'reviewed' },
}
```

| 样本情况 | 填写方式 |
|---|---|
| 有适用方案 | `shouldAbstain: false`，`acceptableSolutionIds` 非空。 |
| 没有适用方案 | `shouldAbstain: true`，`acceptableSolutionIds: []`。 |
| 尚未确认答案 | `shouldAbstain: null`，或 `reviewStatus: 'pending_human_annotation'`；即使已有 AI 初始标签，也按待标注处理。 |
| 已知不可用方案 | 写入 `forbiddenSolutionIds`；为空时不参与禁用命中统计。 |

`prepareRecommendationDataset()` 默认遇到待标注就报错；演示代码显式使用 `pendingPolicy: 'exclude'`，运行结果的 `audit.excluded` 会列出排除对象和原因。正式评测可删除这个选项以恢复默认阻止行为，同时把 `sourceRevision` 改为真实数据版本。

`query` 是示例字段，不是 OMK 的固定要求。若业务数据使用 `input.prompt`，可以先映射成 `query`；也可同步修改示例的 `Row`、Executor input schema 和调用代码。期望答案、禁用标签和审核状态留在评测侧，不放入发给被测系统的 `input`。

### 3．替换 `executor.execute()`

在该函数中调用自己的检索服务，并把经过应用过滤后的**最终有序方案 ID 列表**映射为以下返回值：

| 执行结果 | 返回形式 |
|---|---|
| 成功推荐方案 | `return { output: { solutionIds: ['solution-a', 'solution-b'] } };` |
| 成功执行，但没有推荐方案 | `return { output: { solutionIds: [] } };` |
| 调用失败 | 抛出异常，或 `return { errorCode: 'recommendation-request-failed' };`；不能伪装成成功空返回。 |

向业务调用传递收到的 `signal`，并如实更新 Executor 的 `version`、`fingerprintFacets` 和 `capabilities`。示例的 `deterministic` 只描述合成检索器；当前 `solo` 配置要求被测系统确定性执行，或实际支持并消费 OMK 传入的 `seed`。无 seed 支持的随机服务不能通过照抄 `deterministic` 声明接入；需要选择支持无控随机性的测量设计，参见[公开采样契约](../reference/eval-runtime-api.md)。

按示例输出 `solutionIds` 时，`evaluators` 和 `analyses` 可直接使用。需要改为其它输出结构时，同步修改 output schema 和各评分器的绑定；JSON Pointer `/solutionIds` 表示读取输出对象的 `solutionIds` 字段。默认召回和禁用检查都取 top-3；调整范围时分别修改 retrieval 的 `cutoff`、`forbiddenIdEvaluator(3)` 的参数及相应指标名称。保留 `analyses` 中的 cohort 过滤，使各项失败覆盖数仍对应自己的适用样本群。

### 4．解读输出

原样运行示例，应排除 1 条待标注样本，并成功执行剩余 2 条。`metrics` 中的预期结果如下：

| 指标 | 含义 | 示例值／有效分母 |
|---|---|---|
| `recall-at-3` | 正向样本的已知正确方案召回比例，越高越好。 | `1`／`1` |
| `precision-at-3` | 前三项中正确方案数除以 3，越高越好。只返回 1 个正确方案仍为三分之一。 | `0.333…`／`1` |
| `rr-at-3`、`ndcg-at-3` | 首个正确方案的位置、排序质量，越高越好。`rr-at-3` 的均值即 MRR。 | 均为 `1`／`1` |
| `correct-abstention` | 应空返回样本的成功、合法响应中，空列表的比例，越高越好。 | `1`／`1` |
| `false-abstention` | 应返回方案样本的成功、合法响应中，空列表的比例，越低越好。 | `0`／`1` |
| `forbidden-hit` | 有禁用标注且响应成功、合法的样本中，前三项命中禁用 ID 的比例，越低越好。 | `0`／`2` |

每项先看 `status` 和 `coverage`：`planned` 是对应样本群的计划数，`included` 是实际参与计算的分母；`sourceUnavailable` 可能来自执行失败或缺失输出，`invalid` 表示非法证据。没有有效观测时 `value` 为 `null`，不是零分。再看 `executionCoverage` 的整体执行情况；有效响应上的百分之百不代表全部请求都成功。完整协议与限制见[内置弃答参考](../reference/eval-runtime-api.md#内置弃答与混合召回评测)。
<a id="工具轨迹评测"></a>

## 检查 Agent 是否按要求调用工具

例如，你希望 Agent 先搜索、再读取文档，可以检查它的工具调用记录（轨迹）。下面要求 `Search` 出现在 `Read` 之前，允许中间有其它调用。把 `trajectory` 加入 `evaluate()` 的 `evaluators`，把 `sample` 放入 `dataset.samples`。

执行器需要返回符合 `omk.source-neutral-trace/v2` 的 `trace`，不能直接传入某个模型厂商的原始日志；先由接入代码将日志转换为这个统一格式。只检查调用过程并不能证明工具成功或最终答案正确：

```ts
import { evaluate, type ToolTrajectoryEvaluator } from 'oh-my-knowledge';

const trajectory: ToolTrajectoryEvaluator = {
  evaluatorKind: 'tool-trajectory',
  evaluatorId: 'tool-trajectory',
  metricId: 'tool-trajectory-match',
  tracePointer: '',
  expectedToolNamesPointer: '/expectedToolNames',
  match: 'contains-in-order',
};

const sample = {
  sampleId: 'research-policy',
  input: { request: '检索并总结这项规则。' },
  expected: { expectedToolNames: ['Search', 'Read'] },
};
```

模式名直接描述 actual trajectory 与 expected trajectory 的关系：`exact-order` 要求序列完全相同；`same-tools` 忽略顺序；`contains-in-order` 允许额外调用，但 expected 必须保持为 subsequence；`contains-any-order` 同时允许额外调用与任意顺序。所有模式都保留重复调用 multiplicity，并区分 source-neutral 工具名的大小写。Success、failure、cancelled 与 unknown 调用全部参与；工具执行结果属于另一项 construct。空 actual 轨迹合法；空 expected 只允许 exact 模式，用于断言“不应调用工具”。如果路径和最终结果都重要，可将这个 boolean Metric 与 final-output 或 Rubric 评委 evaluator 组合。
<a id="custom-evaluator"></a>

## 编写自己的评分规则（Custom Evaluator）

业务规则无法由内置评分器表达时，使用 `CustomEvaluator`，每个评分器负责一个指标。例如检查禁用 ID、字段格式，或统计输出长度。

下面统计去除前后空格后的 JavaScript 字符串长度（UTF-16 码元数，部分 emoji 会占两个或更多码元），并汇总候选版本的平均值。示例声明越短越好，只用于展示规则接入，不能把长度当成整体回答质量。替换 `evaluate()` 回调、指标定义与输入 schema 即可实现自己的规则：

```ts
import { z } from 'zod';
import { evaluate, type CustomEvaluator } from 'oh-my-knowledge';

const outputLength = {
  evaluatorKind: 'custom',
  evaluatorId: 'output-length',
  instrumentId: 'output-length-v1',
  metric: {
    metricId: 'output-length-chars',
    valueType: 'numeric',
    unit: 'characters',
    direction: 'lower-is-better',
    missingPolicyId: 'exclude/v1',
  },
  bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
  parameters: { trim: true },
  implementation: {
    implementationId: 'acme.output-length/v1',
    version: '1.0.0',
    schemas: {
      bindings: z.object({ actual: z.string() }).strict(),
      value: z.number().int().nonnegative(),
      fingerprintFacets: { bindings: 'actual-string/v1', value: 'nonnegative-integer/v1' },
    },
    fingerprintFacets: { sourceRevision: 'sha256:...' },
    evaluate({ bindings, parameters, signal }) {
      signal.throwIfAborted();
      const actual = parameters?.trim ? bindings.actual.trim() : bindings.actual;
      return { resultKind: 'score', value: actual.length };
    },
  },
} satisfies CustomEvaluator<{ actual: string }, { trim: boolean }>;

const result = await evaluate({
  dataset: input.dataset,
  variants,
  evaluators: [outputLength],
  comparisons: [{
    comparisonId: 'prompt-v1-vs-v2',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['output-length-chars'],
  }],
  analyses: [{
    analysisId: 'candidate-output-length',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: 'prompt-v2',
    metricId: 'output-length-chars',
  }],
  experiment: { seed: 'length-release-42', sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' } },
  policy: { evaluation: { timeoutMs: 5_000 } },
});
```

查看 `result.analysisResults['candidate-output-length']` 的状态、有效观测数和均值。这里只汇总 `prompt-v2`；要对比两个版本，应声明引用同一指标的比较分析。

Bindings 是最小权限 allowlist。只有 evaluator 确实需要 gold data 时才声明 `expected` 或 `evaluation-context`；callback 无法读取未声明的 sample 字段。JSON Pointer 会在投递前进一步收窄 source。`execution-facts` 是例外：它的 pointer 必须为空，让 callback 消费完整、已经脱敏的 canonical facts projection，避免产生第二套 projection identity。Binding 与 value schema 只能校验和收窄，不能 coercion、补默认值或删除字段。

Callback 可返回 `score`、`missing`、`invalid` 或 `failed`。Score 会作为 measurement data 直接持久化，不是带 classification 的 source content；text、category 与 ranking schema 必须把它约束在安全的测量词表内，绝不能回显 answer、trace、secret 或评委解释。这类支撑材料应放入显式声明 classification 的 `CustomEvaluatorContent` evidence。Invalid value 同样使用 `CustomEvaluatorContent`；普通异常会被脱敏。不要在 callback 内自行重试或实现超时：Core 会执行已封存的并发、超时、预算、取消、计量与失败策略。Callback 必须无状态、可安全并行且协作响应 `signal`；需要有状态资源时使用 advanced 生命周期 SPI。

OMK 不会根据 `Function#toString()` 推导 provenance，因此 identity 必须显式声明。当代码、依赖、schema 或 provider 配置改变测量行为时，必须更新 `version`、schema `fingerprintFacets` 或 implementation `fingerprintFacets`。单个 custom evaluator 不得产出多个 Metric，也不代表 ensemble member。Numeric 与 boolean Metric 必须声明单调 direction；只有调用方声明兼容的具名 summary 或 interval 后，它们才会成为 analysis result。Categorical、text 与 ranking Metric 在通过 advanced API 明确选择兼容 estimator 前只保留为 evaluation evidence。比较估计值保持原始 treatment-minus-control 差值。单 analysis progress Decision 只接受 `higher-is-better`；需要分别约束不同原始有符号 effect 时，应使用显式 comparison-family criterion。
<a id="rubric-评委评测"></a>

## 让 LLM 按明确的评分标准评价答案

Rubric 就是明确写出的评分标准。开放问答允许多种正确表述时，可以让 LLM 评委按标准给出 1～5 分，而不是逐字比较答案。你提供评分标准和模型调用，OMK 负责组织评分提示、解析结果和聚合读数。

下面使用一个评委模型，对每条实际输出评分两次，再取平均，并汇总候选版本的平均分。`internalGateway` 和 `judge-model` 需要替换为真实模型接入；评分会产生额外的模型调用。正式评测前应明确各分档的含义，并用人工标注样例校准标准。

```ts
const result = await evaluate({
  dataset: input.dataset,
  variants,
  evaluators: [{
    evaluatorKind: 'rubric-judge',
    evaluatorId: 'correctness-judge',
    metricId: 'correctness-score',
    rubric: {
      criterionId: 'correctness',
      prompt: '判断答案在事实层面是否正确。',
      rubric: '完全正确为 5 分，完全错误为 1 分。',
    },
    judges: [{
      memberId: 'primary',
      model: 'judge-model',
      effort: 'low',
      replicateCount: 2,
      judge: {
        judgeId: 'acme.model-gateway/v1',
        version: '2026.09.04',
        providerCost: { reporting: 'optional' },
        fingerprintFacets: { deploymentRevision: 'sha256:...' },
        async invoke(request) {
          const response = await internalGateway.generate({
            model: request.model,
            system: request.system,
            prompt: request.prompt,
            signal: request.signal,
          });
          return { invocationStatus: 'completed', output: response.text, usage: response.usage };
        },
      },
    }],
    aggregation: { method: 'mean', missing: 'require-complete' },
  }],
  comparisons: [{
    comparisonId: 'prompt-v1-vs-v2',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correctness-score'],
  }],
  analyses: [{
    analysisId: 'candidate-correctness',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: 'prompt-v2',
    metricId: 'correctness-score',
  }],
  experiment: { seed: 'rubric-release-42', sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' } },
  policy: {},
});
```

查看 `result.analysisResults['candidate-correctness']` 的状态、有效观测数和均值。这里只汇总 `prompt-v2`；要对比两个版本，应声明引用同一指标的比较分析。

评委 callback 只执行一次 provider 调用，不得自行重试。`replicateCount` 只重复评测，不重复 Target 执行，也不增加 Bootstrap 样本量。存在多个成员时，`mean` 会在各成员的 replicate 先求均值后赋予成员等权；`weighted-mean` 要求为每个 `memberId` 显式提供正权重，且总和为 1。`require-complete` 会在任一计划坐标不可用时排除整个 Target × Sample × Trial panel 读数。Provider failure 会保留合法的计量事实，并移除 provider 私有原因与 usage details。只有当所有 Executor 都返回 `oh-my-knowledge/eval-runtime/contracts` 中的版本化 trace 契约时，才使用 `tracePolicy: 'source-neutral'`。
