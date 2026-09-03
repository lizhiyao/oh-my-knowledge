# 在 Node.js 服务中嵌入 OMK

当服务已经负责业务调用、凭证、租户、队列与存储，而希望 OMK 负责评测计划、测量、对比和报告时，使用 `oh-my-knowledge/eval-runtime`。

## 选择正确入口

| 需求 | 入口 |
|---|---|
| 使用 OMK 管理的 provider 配置评测仓库用例，并持久化报告 | OMK CLI |
| 在 FaaS 或 Node.js 服务内嵌纯内存评测 | `oh-my-knowledge/eval-runtime` |
| 自定义阶段编排、artifact admission、重放或可比性 | `oh-my-knowledge/eval-core` |

`eval-runtime` 是接入层，不是企业服务框架。认证、租户隔离、模型网关、队列、数据库和运维控制仍由宿主负责。导入它不会加载 CLI、Studio、MCP、provider adapter 或用户配置。

> **`1.0.0-beta` 迁移：**canonical 入口现在只导出日常宿主 API。生命周期 adapter、support-port type、Rubric 手工 factory、clock helper 和旧 `ExecutorFn` bridge 改从 `oh-my-knowledge/eval-runtime/advanced` 导入；source-neutral trace 与 Rubric wire schema 改从 `oh-my-knowledge/eval-runtime/contracts` 导入。实现深路径仍是私有边界。

## 十分钟完成 exact-match 对比

该入口仅提供 ESM，要求 Node.js 22 或更高版本。先在服务中安装：

```bash
npm install oh-my-knowledge zod
```

为已部署的调用实现创建一份 identity。下面每个字段都会影响测量，并进入封存的 Runtime fingerprint：

```ts
import { z } from 'zod';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
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

使用任意带 `parse(unknown)` 方法的运行时 schema 收窄 input、Target config 和 output。下面使用 Zod；adapter 会透传 Core 的 `AbortSignal`，并继续使用 `omk.invoke/v1`，不会增加第三套调用协议。两个 Target 复用同一个 implementation 时要使用 factory，以获得相互隔离的生命周期：

```ts
const createExecutor = () => createJsonExecutorAdapter({
  identity,
  inputParser: z.object({ prompt: z.string() }).strict(),
  targetConfigParser: z.object({ deployment: z.string() }).strict(),
  outputParser: z.string(),
  outputClassification: 'sensitive',
  async invoke({ input, targetConfig, signal }) {
    const response = await modelGateway.generate({
      deployment: targetConfig.deployment,
      prompt: input.prompt,
      signal,
    });
    return {
      invocationStatus: 'completed',
      output: response.text,
      usage: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        totalTokens: response.inputTokens + response.outputTokens,
      },
    };
  },
});

const runtime = createEvaluationRuntime({
  executors: [{
    implementationId: identity.implementationId,
    createPort: createExecutor,
  }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
```

Parser 的返回类型会自动贯穿 `invoke`，因此这里不需要 `as`。Parser 同时承担运行时信任边界：不合法的 sample input、Target config、output、usage 或 trace 会成为稳定且脱敏的结构化 execution failure。Parser 只能校验并收窄，不能 coercion、补默认值或删除字段；任何 JSON transform 都会被拒绝，避免同一 Runtime identity 下静默改变实际调用。需要变换时，在 identity 已覆盖相应实现 revision 的 `invoke` 内显式完成。若宿主已经实现 OMK 既有 `ExecutorFn`，仍可从 `oh-my-knowledge/eval-runtime/advanced` 导入 `createExecutorFnAdapter` 作为 bridge；它不是新服务接入的推荐入口。

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
  createRubricJudgeKit,
  createRuntimeIdentity,
  type OmkLlmJudgeInvocationPort,
} from 'oh-my-knowledge/eval-runtime';

const gatewayIdentity = createRuntimeIdentity({
  implementationId: 'acme.model-gateway/v1',
  version: '2026.09.03',
  capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
  fingerprintFacets: { deploymentRevision: 'sha256:...' },
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
const judge = createRubricJudgeKit({
  evaluatorId: 'correctness-judge',
  metricId: 'correctness-score',
  model: 'judge-model',
  effort: 'low',
  invocation,
});
const criterion = judge.createCriterion({
  criterionId: 'correctness',
  prompt: '法国的首都是哪里？',
  rubric: '答案必须指出巴黎。',
});
```

由 kit 把 `criterion` 放入每个 sample 的 `evaluationContext` 封存路径，再使用它生成的匹配 Core 片段与 Runtime registration：

```ts
const runtime = createEvaluationRuntime({
  executors: [/* 业务 Target registrations */],
  evaluators: [judge.evaluatorRegistration],
});

const definition = createPairedComparisonDefinition({
  datasetId: 'rubric-release-gate',
  seed: 'rubric-release-42',
  samples: samples.map((sample) => ({
    ...sample,
    evaluationContext: judge.createEvaluationContext(criterion),
  })),
  control: {
    targetId: 'control',
    executorId: identity.implementationId,
    config: { deployment: 'baseline' },
  },
  treatment: {
    targetId: 'treatment',
    executorId: identity.implementationId,
    config: { deployment: 'candidate' },
  },
  evaluator: judge.evaluatorDefinition,
  metric: judge.metricDefinition,
});
```

Kit 会捕获一份 provider identity 与调用方法，再从这份冻结配置派生 instrument、prompt hash、criterion JSON Pointer、runtime config、Evaluator identity、Metric 和 registration。`createEvaluationContext()` 会物化与 pointer 完全匹配的 context，宿主不再手工同步路径。一个 Definition 包含多个 Rubric evaluator 时，Runtime 使用 `createRubricJudgeRegistration([firstKit, secondKit])`，每个 sample 使用 `createRubricJudgeEvaluationContext([{ kit: firstKit, criterion: first }, { kit: secondKit, criterion: second }])`。只有当所有 Target 都产出 `oh-my-knowledge/eval-runtime/contracts` 中的公共 `SourceNeutralTrace` 契约时，才使用 `tracePolicy: 'source-neutral'`；否则保留默认值 `none`。非 JSON、格式错误、越界分数或缺失理由都会成为结构化 invalid observation，而不是降级成 `0` 分。Provider failure 会保留计量事实并脱敏 provider 私有细节。未注册 Judge 时，不会发现 provider、读取凭证或执行 preflight。

## 高级宿主

当一个 Definition binding 独占 Core Executor 或 Evaluator port 时，使用 `{ port }` 注册；多个 Target 或 Evaluator 复用同一个 implementation 时，使用 `{ implementationId, createPort }`，让每个 binding 获得隔离的 run 生命周期。若 Definition 声明了 `versionConstraint`，而 registration 没有提供 `satisfiesVersionConstraint`，Runtime 会 fail closed。

自定义进程内 port 时，使用 `oh-my-knowledge/eval-runtime/advanced` 中的 `createSameProcessExecutorAdapter` 与 `createSameProcessEvaluatorAdapter`。该 subpath 也包含旧 `createExecutorFnAdapter`、Rubric 手工装配 factory、clock 和 registration SPI；Runtime wire contract 与 schema descriptor 位于 `oh-my-knowledge/eval-runtime/contracts`。需要分阶段执行、持久化 artifact admission、自定义 Analysis Runtime 或显式跨 run 可比性时，使用 `oh-my-knowledge/eval-core`。`package.json#exports` 之外的深路径不受支持。参见[嵌入式 Evaluation Core API](/zh/reference/embedded-api)与 [eval-runtime API 分层](/zh/reference/eval-runtime-api)。

接纳新的 Executor adapter 前，从 `oh-my-knowledge/eval-runtime` 调用 `runExecutorConformance({ implementationId, createExecutor, success, failure, cancellation })`。它通过三次真实 Core run 检查独立 binding、run／trial 清理、原始 `AbortSignal`、telemetry 声明、稳定结构化失败、exact-match observation、配对分析与 Decision。若实现忽略取消，cancellation callback 仍须自行保证有界，因为进程内探针不会隔离恶意代码。Adapter 测试可调用 `assertExecutorConformance(result)`，以稳定 check ID 报错。探针自身不会发现文件系统、网络、凭证或环境配置。

建议从可运行的[最小公开示例](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime)开始。Package fixture 还覆盖[宿主持有的 Rubric Judge 网关](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/rubric-judge-host.mjs)和[高级五阶段宿主](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/advanced-host.mjs)。CI 会在隔离的用户目录中，使用打包后的产物执行公开示例与这些 fixture。
