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
import { createEvaluationEngine } from 'oh-my-knowledge/eval-core';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createExecutorFnAdapter,
  createInvokeExecutorIdentity,
  createMeasurementPolicy,
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

调度前先 prepare，并与终态结果并发消费 event：

```ts
const prepared = await createEvaluationEngine(runtime).prepare(definition, policy);
const run = prepared.start({ runId: crypto.randomUUID(), eventBufferCapacity: 256 });
const draining = (async () => {
  for await (const event of run.events) await publishProgress(event);
})();
const result = await run.result;
await draining;

if (result.status === 'failed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

随机 `runId` 用于区分执行，并影响 artifact identity，但不属于测量计划。同一份 Definition、Policy、Runtime identity 与显式 seed 会生成相同的 `runContractDigest`。

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

可运行 package fixture 分别覆盖[精确匹配](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/embedded-host.mjs)和[宿主持有的 Rubric Judge 网关](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/rubric-judge-host.mjs)。
