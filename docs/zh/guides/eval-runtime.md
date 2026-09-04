# 在 Node.js 服务中嵌入 OMK

应用自行负责模型调用，而希望 OMK 负责测量、对比和报告时，使用 `oh-my-knowledge` 包根入口。普通接入只有一个主入口：

```ts
import { evaluate } from 'oh-my-knowledge';
```

该包仅支持 ESM，要求 Node.js 22 或更高版本。它不会自行发现凭证、provider、文件、环境变量、CLI 配置或 Studio 状态。

## 评测术语

`evaluate()` 与 OMK 其它入口使用同一套术语：

| 术语 | 含义 |
|---|---|
| artifact | 被改动的知识载体：prompt、skill、agent、workflow 或空 baseline。 |
| variant | 一个具名 artifact，以及它的 runtime context 和 Executor config。 |
| comparison | 显式声明一个 control Variant、一个或多个 treatment Variant，以及要比较的 Metric。 |
| dataset／sample | 评测输入，以及 expected 或 evaluation context。 |
| executor | 针对一个 sample 运行 artifact 的宿主代码。 |
| evaluator | 测量方法，例如 exact match 或 Rubric 评委。 |
| experiment／analysis／decision／policy | 采样设计、估计方法、可选的单一 Decision 与运行限制。 |
| result | Core 产出的运行 artifact、evidence、Decision 与 Report。 |

Core 编译后的 `Target` 仍是内部执行概念，不是 artifact 或 variant 的第二个公开名称。

一句话：Executor 负责运行 artifact，Evaluator 负责评价结果。

## Exact-match 评测

安装 OMK 和一个运行时 schema 库。Schema 只需提供 `parse(unknown)` 方法；下面使用 Zod：

```bash
npm install oh-my-knowledge zod
```

```ts
import { z } from 'zod';
import { evaluate, type Executor, type Variant } from 'oh-my-knowledge';

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
    config: { deployment: 'deployment-b' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
}];

const result = await evaluate({
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
    comparisonKind: 'paired',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct'],
  }],
  analysis: { analyses: [{
    analysisId: 'prompt-v1-vs-v2-correct',
    analysisKind: 'comparison-interval',
    statistic: 'mean-difference',
    comparisonId: 'prompt-v1-vs-v2',
    treatmentVariantId: 'prompt-v2',
    metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1_000 },
  }] },
  decision: {
    decisionKind: 'analysis',
    analysisId: 'prompt-v1-vs-v2-correct',
  },
  experiment: {
    seed: 'release-2026-09-04',
    trials: 1,
    sampling: { samplingKind: 'paired' },
  },
  policy: { maxConcurrency: 4 },
  runId: crypto.randomUUID(),
});

if (result.status !== 'completed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

`result.definition` 与 `result.policy` 是 façade 实际编译出的 sealed Core Definition 和完整物化的 Measurement Policy。`result.analysisResults[analysisId]` 是同一批 Core Analysis record 的只读索引，不会重新计算统计量。其余 Core 运行结果字段保持不变：evidence 位于 `result.artifacts`，Decision 位于 `result.artifacts.decision`，Report 位于 `result.report`。

除上面展示的值外，`executor.execute()` 还会收到 `variantId`。比较角色属于 `comparisons`，不会注入 Executor invocation。可预期的宿主失败应返回 `{ errorCode }`，其中 error code 必须稳定且不包含敏感信息；普通异常会统一成为脱敏的 `EVAL_RUNTIME_EXECUTOR_FAILED`。

Schema 只能校验并收窄。若 parser coercion、补默认值或删除 JSON 字段，OMK 会拒绝执行，因为这些行为会在同一 identity 下静默改变实际测量。需要有意变换时，应在 `execute()` 内完成，并提升 `version` 或测量相关的 `fingerprintFacets`。

Variant `config` 与 `runtimeContext` 会序列化进入 sealed Definition，因此只应放入可重放、非敏感的测量输入。凭证、client 与进程内资源应保留在 Executor closure 中，绝不能进入 Definition。

使用独立组时，必须同时调整 comparison 与 sampling 声明，并为每个 Variant 声明一个 allocation：

```ts
comparisons: [{
  comparisonId: 'prompt-v1-vs-v2',
  comparisonKind: 'independent',
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

`exact-match` 比较 actual output 与 sample `expected` 的 canonical JSON 值，不是字符串字节逐一比较。

`onEvent` 是可选的 best-effort 进度观察器。已投递事件保持顺序，但慢观察器不会反向阻塞测量：有界 Core stream 会丢弃最旧的待处理进度并保留较新的事件，因此序号允许出现缺口。`eventBufferCapacity` 控制这项内存上界，默认值为 256。观察器失败时，OMK 完成清理后抛出 `EvaluationEventConsumptionError`，其中保留终态 `runResult`，并由 canonical façade 隐去宿主回调的原始异常。`evaluate()` 有意不提供持久、无损的事件投递；advanced 宿主应通过显式的 `createMeasurementPolicy({ eventDelivery: ... })`、`eventWriter` 与 `runEvaluation()` 配对使用。取消只由调用方传入的 `AbortSignal` 控制。

## Custom Evaluator

确定性规则、领域 parser 或宿主持有的评价服务不适合 exact match 或内置 Rubric 评委时，使用 `evaluatorKind: 'custom'`。一个 custom evaluator 只测量一个 sample-scope `Metric`：

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
  dataset,
  variants,
  evaluators: [outputLength],
  comparisons: [{
    comparisonId: 'prompt-v1-vs-v2',
    comparisonKind: 'paired',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['output-length-chars'],
  }],
  experiment: { seed: 'length-release-42', sampling: { samplingKind: 'paired' } },
  policy: { evaluationTimeoutMs: 5_000 },
  runId: crypto.randomUUID(),
});
```

Bindings 是最小权限 allowlist。只有 evaluator 确实需要 gold data 时才声明 `expected` 或 `evaluation-context`；callback 无法读取未声明的 sample 字段。JSON Pointer 会在投递前进一步收窄 source。`execution-facts` 是例外：它的 pointer 必须为空，让 callback 消费完整、已经脱敏的 canonical facts projection，避免产生第二套 projection identity。Binding 与 value schema 只能校验和收窄，不能 coercion、补默认值或删除字段。

Callback 可返回 `score`、`missing`、`invalid` 或 `failed`。Score 会作为 measurement data 直接持久化，不是带 classification 的 source content；text、category 与 ranking schema 必须把它约束在安全的测量词表内，绝不能回显 answer、trace、secret 或评委解释。这类支撑材料应放入显式声明 classification 的 `CustomEvaluatorContent` evidence。Invalid value 同样使用 `CustomEvaluatorContent`；普通异常会被脱敏。不要在 callback 内自行重试或实现超时：Core 会执行已封存的并发、超时、预算、取消、计量与失败策略。Callback 必须无状态、可安全并行且协作响应 `signal`；需要有状态资源时使用 advanced 生命周期 SPI。

OMK 不会根据 `Function#toString()` 推导 provenance，因此 identity 必须显式声明。当代码、依赖、schema 或 provider 配置改变测量行为时，必须更新 `version`、schema `fingerprintFacets` 或 implementation `fingerprintFacets`。单个 custom evaluator 不得产出多个 Metric，也不代表 ensemble member。Numeric 与 boolean Metric 必须声明单调 direction；只有调用方声明兼容的具名 summary 或 interval 后，它们才会成为 analysis result。Categorical、text 与 ranking Metric 在通过 advanced API 明确选择兼容 estimator 前只保留为 evaluation evidence。比较估计值保持原始 treatment-minus-control 差值。Canonical Decision 只接受 `higher-is-better`，并通过 `analysisId` 选择一个 interval；对于 lower-is-better Metric，应省略 `decision` 后解释区间符号，或让 callback 返回 higher-is-better utility score。

## Rubric 评委评测

输出不适合做完全相等判断时，使用 `evaluatorKind: 'rubric-judge'`，并显式声明一个或多个评委成员及其聚合方式。每次 callback 只负责一次模型调用；冻结 prompt、输出解析、1～5 分指标、evidence、重试、超时、预算、取消与聚合语义均由 OMK 负责：

```ts
const result = await evaluate({
  dataset,
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
    comparisonKind: 'paired',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correctness-score'],
  }],
  experiment: { seed: 'rubric-release-42', sampling: { samplingKind: 'paired' } },
  policy: {},
  runId: crypto.randomUUID(),
});
```

评委 callback 只执行一次 provider 调用，不得自行重试。`replicateCount` 只重复评测，不重复 Target 执行，也不增加 Bootstrap 样本量。存在多个成员时，`mean` 会在各成员的 replicate 先求均值后赋予成员等权；`weighted-mean` 要求为每个 `memberId` 显式提供正权重，且总和为 1。`require-complete` 会在任一计划坐标不可用时排除整个 Target × Sample × Trial panel 读数。Provider failure 会保留合法的计量事实，并移除 provider 私有原因与 usage details。只有当所有 Executor 都返回 `oh-my-knowledge/eval-runtime/contracts` 中的版本化 trace 契约时，才使用 `tracePolicy: 'source-neutral'`。

## 认证 Executor

接纳 adapter 前运行 `checkExecutor()`。它会让同一份 declaration 经历真实的成功、失败和取消 Core run，并检查 binding 隔离、生命周期清理、telemetry、observation、配对分析与 Decision：

```ts
import { checkExecutor } from 'oh-my-knowledge';

const certification = await checkExecutor({
  variant: variants[1],
  success: { input: successInput, expected: expectedOutput },
  failure: { input: failureInput, expectedErrorCode: 'model-unavailable' },
  cancellation: { input: longRunningInput },
});

if (!certification.conformant) console.error(certification.checks);
```

若实现忽略取消信号，cancellation input 仍必须自行保证有界；进程内检查不会隔离恶意代码。

## 高级接入与迁移

Canonical 入口有意不导出 Core builder、Runtime registration、adapter 生命周期 SPI 或 Rubric 手工 factory。已有接入只需迁移 import，不改变行为：

```ts
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createJsonExecutorAdapter,
  runEvaluation,
} from 'oh-my-knowledge/eval-runtime/advanced';
```

显式子路径 `oh-my-knowledge/eval-runtime` 与包根暴露同一套 canonical façade。自定义 port、分阶段宿主装配或旧 `ExecutorFn` bridge 使用 `oh-my-knowledge/eval-runtime/advanced`；版本化 wire schema 使用 `oh-my-knowledge/eval-runtime/contracts`；多指标图、自定义 Analysis Runtime、artifact 重放或显式跨 run 可比性使用 `oh-my-knowledge/eval-core`。`eval-workflows` 只依赖 runtime foundation 叶子模块，不依赖任一用户 façade。`package.json#exports` 之外的深路径均为私有实现。

可运行的[最小示例](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime)与 packed-package fixture 会在 clean host 中验证 canonical API。
