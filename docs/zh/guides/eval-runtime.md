# 在 Node.js 服务中嵌入 OMK

当服务已经负责业务调用、凭证、租户、队列与存储，而希望 OMK 负责评测计划、测量、对比和报告时，使用 `oh-my-knowledge/eval-runtime`。

## 选择正确入口

| 需求 | 入口 |
|---|---|
| 使用 OMK 管理的 provider 配置评测仓库用例，并持久化报告 | OMK CLI |
| 在 FaaS 或 Node.js 服务内嵌纯内存评测 | `oh-my-knowledge/eval-runtime` |
| 自定义阶段编排、artifact admission、重放或可比性 | `oh-my-knowledge/eval-core` |

`eval-runtime` 是接入层，不是企业服务框架。认证、租户隔离、模型网关、队列、数据库和运维控制仍由宿主负责。导入它不会加载 CLI、Studio、MCP、provider adapter 或用户配置。

## 十分钟完成 exact-match 对比

该入口仅提供 ESM，要求 Node.js 22 或更高版本。先在服务中安装：

```bash
npm install oh-my-knowledge
```

为已部署的调用实现创建一份 identity。下面每个字段都会影响测量，并进入封存的 Runtime fingerprint：

```ts
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createExecutorFnAdapter,
  createInvokeExecutorIdentity,
  createMeasurementPolicy,
  runEvaluation,
} from 'oh-my-knowledge/eval-runtime';

const identity = createInvokeExecutorIdentity({
  implementationId: 'acme.answer-service/v1',
  version: '1.4.0',
  determinism: 'stochastic',
  cancellation: 'cooperative',
  concurrency: { safety: 'parallel-safe', maxInFlight: 16 },
  seedControl: 'unsupported',
  telemetry: { trace: 'unsupported', usage: 'required' },
  fingerprintFacets: { deploymentRevision: 'sha256:...' },
});
```

适配 OMK 现有的 `ExecutorFn`。adapter 会透传 Core 的 `AbortSignal`，不会增加第三套调用协议。两个 Target 复用同一个 implementation 时要使用 factory，以获得相互隔离的生命周期：

```ts
const executorFn = async ({ model, prompt, abortSignal }) => {
  const response = await modelGateway.generate({
    deployment: model,
    prompt,
    signal: abortSignal,
  });
  return {
    ok: true,
    output: response.text,
    durationMs: response.durationMs,
    durationApiMs: response.durationMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokenUsageReportedByExecutor: true,
    costUSD: 0,
    costReportedByExecutor: false,
    stopReason: response.stopReason,
    numTurns: 1,
  };
};

const createExecutor = () => createExecutorFnAdapter({
  identity,
  executor: executorFn,
  outputClassification: 'sensitive',
  mapInput: ({ targetConfig, input }) => ({
    model: (targetConfig as { deployment: string }).deployment,
    prompt: (input as { prompt: string }).prompt,
  }),
});

const runtime = createEvaluationRuntime({
  executors: [{
    implementationId: identity.implementationId,
    createPort: createExecutor,
  }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
```

构造可序列化的 Definition 与 Policy。所有默认值都会写入不可变结果；seed 必填，且不会从时间、随机数或环境状态推断：

```ts
const definition = createExactMatchDefinition({
  datasetId: 'answer-regression',
  seed: 'release-2026-09-03',
  samples: [
    { sampleId: 'one', input: { prompt: '法国的首都是哪里？' }, expected: '巴黎' },
    { sampleId: 'two', input: { prompt: '2 + 2 等于几？' }, expected: '4' },
  ],
  control: {
    targetId: 'control',
    executorId: identity.implementationId,
    config: { deployment: 'deployment-a' },
  },
  treatment: {
    targetId: 'treatment',
    executorId: identity.implementationId,
    config: { deployment: 'deployment-b' },
  },
});
const policy = createMeasurementPolicy({ maxConcurrency: 4 });
```

默认使用 `runEvaluation`。它负责完整消费有界事件流；不关心进度时无需编写 drain 代码，需要进度时传入可选的 `onEvent`：

```ts
const result = await runEvaluation({
  runtime,
  definition,
  policy,
  runId: crypto.randomUUID(),
  onEvent: publishProgress,
});

if (result.status === 'failed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

`onEvent` 是按顺序调用的进度观察器，不承担持久化。观察器失败不会改变测量结果；helper 会停止后续回调、继续 drain 并清理 Runtime，随后抛出 `EvaluationEventConsumptionError`，其中的 `runResult` 保留 Core 终态。只有调用方 `AbortSignal` 负责取消评测。需要带 Core failure policy 的持久事件写入时使用 `eventWriter`。需要调度前审阅 sealed plan 时，仍可调用 `createEvaluationEngine(runtime).prepare(definition, policy)`。

随机 `runId` 用于区分执行，并影响 artifact identity，但不属于测量计划。同一份 Definition、Policy、Runtime identity 与显式 seed 会生成相同的 `runContractDigest`。

## 构造服务或 RAG 对比

以输出相等作为指标时，`createExactMatchDefinition` 是最短路径。服务或 RAG 评测使用自定义确定性指标或 Rubric Judge 时，使用 `createPairedComparisonDefinition`。它接收一个 Evaluator 片段及其匹配的 Metric 片段，返回普通、可序列化的 Core `EvaluationDefinition`，不会引入第二套 Runtime 专属契约：

```ts
import { createPairedComparisonDefinition } from 'oh-my-knowledge/eval-runtime';

const definition = createPairedComparisonDefinition({
  datasetId: 'retrieval-regression',
  seed: 'index-release-42',
  samples,
  control: {
    targetId: 'control',
    targetKind: 'rag',
    executorId: identity.implementationId,
    config: { indexRevision: 'baseline' },
  },
  treatment: {
    targetId: 'treatment',
    targetKind: 'rag',
    executorId: identity.implementationId,
    config: { indexRevision: 'candidate' },
  },
  evaluator,
  metric,
});
```

该 builder 有意只支持一个 `higher-is-better` 的 numeric 或 boolean 指标，并使用 `exclude/v1`。多指标图、`lower-is-better` 指标或其它缺失值策略应直接使用 `oh-my-knowledge/eval-core` 的底层契约，避免接入层静默近似测量设计。

## 通过内部模型网关接入 Rubric Judge

宿主只提供一次模型调用 port。冻结 prompt、输出解析、1～5 分指标契约、evidence、失败语义和 Evaluator identity 均由 OMK 负责。该 port 不应自行重试；重试、超时、预算、缓存和取消仍由 Core 统一控制。

```ts
import {
  createRubricJudgeCriterion,
  createRubricJudgeEvaluatorDefinition,
  createRubricJudgeEvaluatorRegistration,
  createRubricJudgeInstrument,
  createRubricJudgeMetricDefinition,
  createRubricJudgeRuntimeConfig,
  createRuntimeIdentity,
  type OmkLlmJudgeInvocationPort,
} from 'oh-my-knowledge/eval-runtime';

const gatewayIdentity = createRuntimeIdentity({
  implementationId: 'acme.model-gateway/v1',
  version: '2026.09.03',
  capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
  fingerprintFacets: { deploymentRevision: 'sha256:...' },
});
const instrument = createRubricJudgeInstrument();
const judgeRuntime = createRubricJudgeRuntimeConfig({
  executorId: gatewayIdentity.implementationId,
  model: 'judge-model',
  effort: 'low',
  instrument,
});
const criterion = createRubricJudgeCriterion({
  criterionId: 'correctness',
  prompt: '法国的首都是哪里？',
  rubric: '答案必须指出巴黎。',
});

const invocation: OmkLlmJudgeInvocationPort = {
  identity: gatewayIdentity,
  providerCost: { reporting: 'optional' },
  async invoke(request) {
    const response = await internalGateway.generate({
      model: request.model,
      system: request.system,
      prompt: request.prompt,
      signal: request.signal,
    });
    return { invocationStatus: 'completed', output: response.text, usage: response.usage };
  },
};
```

把 `criterion` 放入各 sample 的 `evaluationContext` 稳定路径，再把匹配的普通 Core 片段加入 Definition：

```ts
const evaluator = createRubricJudgeEvaluatorDefinition({
  evaluatorId: 'correctness-judge',
  metricId: 'correctness-score',
  instrument,
  runtime: judgeRuntime,
  criterionPointer: '/correctness',
});
const metric = createRubricJudgeMetricDefinition('correctness-score');

const runtime = createEvaluationRuntime({
  executors: [/* 业务 Target registrations */],
  evaluators: [createRubricJudgeEvaluatorRegistration([{
    evaluatorId: evaluator.evaluatorId,
    instrument,
    runtime: judgeRuntime,
    invocation,
  }])],
});
```

只有当所有 Target 都产出公共 `SourceNeutralTrace` 契约时，才使用 `tracePolicy: 'source-neutral'`；否则保留默认值 `none`。非 JSON、格式错误、越界分数或缺失理由都会成为结构化 invalid observation，而不是降级成 `0` 分。Provider failure 会保留计量事实并脱敏 provider 私有细节。未注册 Judge 时，不会发现 provider、读取凭证或执行 preflight。

## 高级宿主

当一个 Definition binding 独占 Core Executor 或 Evaluator port 时，使用 `{ port }` 注册；多个 Target 或 Evaluator 复用同一个 implementation 时，使用 `{ implementationId, createPort }`，让每个 binding 获得隔离的 run 生命周期。若 Definition 声明了 `versionConstraint`，而 registration 没有提供 `satisfiesVersionConstraint`，Runtime 会 fail closed。

自定义进程内 port 时，使用 `createSameProcessExecutorAdapter` 与 `createSameProcessEvaluatorAdapter`。需要分阶段执行、持久化 artifact admission、自定义 Analysis Runtime 或显式跨 run 可比性时，使用 `oh-my-knowledge/eval-core` 的高级 API。参见[嵌入式 Evaluation Core API](/zh/reference/embedded-api)。

接纳新的 Executor adapter 前，从 `oh-my-knowledge/eval-runtime` 调用 `runExecutorConformance({ implementationId, createExecutor, input, expected })`。它会通过真实 Core pipeline 检查隔离的 control／treatment 生命周期、重复调用、exact-match observation、配对分析与 Decision。Adapter 测试可调用 `assertExecutorConformance(result)`，以稳定 check ID 报错。该探针与框架无关，自身不会发现文件系统、网络、凭证或环境配置。

建议从可运行的[最小公开示例](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime)开始。Package fixture 还覆盖[宿主持有的 Rubric Judge 网关](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/rubric-judge-host.mjs)和[高级五阶段宿主](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/advanced-host.mjs)。CI 会在隔离的用户目录中，使用打包后的产物执行公开示例与这些 fixture。
