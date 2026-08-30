# 嵌入式 Evaluation Core API

当 Node.js 宿主自行负责数据集、凭证、队列、存储和业务工作流，而希望 OMK 负责评测计划、执行、测量、分析与报告物化时，使用包根嵌入式 API。

嵌入式 API 仅提供 ESM 构建，要求 Node.js 22 或更高版本：

```ts
import {
  createEvaluationEngine,
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
  type EvaluationDefinition,
  type EvaluationEngineRuntime,
  type MeasurementPolicy,
} from 'oh-my-knowledge';
```

CommonJS 宿主通过动态导入使用：

```js
const { createEvaluationEngine } = await import('oh-my-knowledge');
```

OMK 有意不支持同步 `require('oh-my-knowledge')`，也不发布第二份 CommonJS 构建，从而避免两个模块实例持有相互分裂的 Runtime registry。包根以下路径均为私有实现，`oh-my-knowledge/dist/*` 会被 package export map 阻断。

## Runtime 边界

Engine 接收实现与基础设施 port。函数实现只存在于内存，不会进入可序列化 Definition：

```ts
const runtime: EvaluationEngineRuntime = {
  preparation: {
    resolveExecutor(requirement) {
      return executorRegistry.resolve(requirement);
    },
    resolveEvaluator(requirement) {
      return evaluatorRegistry.resolve(requirement);
    },
    resolveAnalysis(requirement) {
      return resolveBuiltinAnalysisRuntime(requirement)
        ?? analysisRegistry.resolve(requirement);
    },
  },
  executors,
  evaluators,
  clock,
  schemaValidators: new Map([
    ...createBuiltinAnalysisSchemaValidators(),
    ...hostSchemaValidators,
  ]),
  analysisNodes: new Map([
    ...createBuiltinAnalysisNodes(),
    ...hostAnalysisNodes,
  ]),
  missingPolicies: createBuiltinMissingPolicies(),
  decisionPolicies: createBuiltinDecisionPolicies(),
  executionCache,
  evaluationCache,
  executionContentStore,
  evaluationContentStore,
  contentResolver,
};

const engine = createEvaluationEngine(runtime);
```

Preparation resolver 负责证明 Runtime identity 及其 capabilities 满足实现与版本约束。注册在 `executors`、`evaluators` 或 Analysis registry 中的实现，必须暴露与 preparation 阶段封存结果相同的 identity。这样可以避免 fingerprint、能力声明和实际代码静默漂移。

长期存活的 registry、客户端、cache 和 store 由宿主持有。Executor、Evaluator 与 Analysis implementation 打开 run 级资源，OMK 在对应阶段边界释放这些资源。启动或取消一个 run 不会释放另一个 run 的资源。

## 启动一次运行

```ts
const run = engine.start(definition satisfies EvaluationDefinition, {
  policy: measurementPolicy satisfies MeasurementPolicy,
  runId: 'release-candidate-2026-08-30',
  signal: abortController.signal,
  annotations: { release: 'candidate-42' },
  eventBufferCapacity: 512,
});

const collecting = (async () => {
  for await (const event of run.events) {
    await progressView.observe(event);
  }
})();

const result = await run.result;
await collecting;
```

`runId` 由宿主分配且必填。OMK 会据此确定性派生 Bundle 与 Report identifier。Definition、Sample、Policy、Runtime identity、seed 与 fingerprint 都会封存进结果的证据链。

如果宿主希望在调度前完成配置和 capability 校验，可以先调用 `await engine.prepare(definition, policy)`。返回的 `PreparedEvaluation` 持有不透明 `SealedRunPlan` capability，可以用同一个不可变计划启动多个相互隔离的 run。

## 结果与错误

`run.result` 会解析为带判别字段的 `EvaluationRunResult`：

- `completed`、`cancelled` 与 `budget-exhausted` 会包含可序列化的 Execution、Evaluation、Analysis Bundle 和 Report；
- `failed` 会包含机器可判别的 `EvaluationError`；如果流水线已经到达物化阶段，还会保留部分 artifact 与 Report；
- configuration、infrastructure、execution、evaluation、analysis 与 internal failure 保持可区分；
- assertion 不通过、质量回归或无方向性 decision 都是有效报告证据，不会导致 Promise reject。

`engine.prepare()` 是显式 preflight API，配置无效时会 reject。`engine.start()` 会把 preparation 和 Runtime failure 收敛到 `run.result`，方便调度器只处理一个终态结果通道。

## Event 与持久化投递

每个 run 独占自己的 EventSequencer。sequence 从零开始，跨 Execution、Evaluation、Analysis、Decision 与 Report materialization 严格递增。Event 可序列化，只包含稳定 identity、status、coverage 和 reason code，不包含 provider secret。

异步 iterable 是单消费者、有界的进度通道。它不会反压权威评测计算；消费者落后时会丢弃缓冲区中最旧的 event。如果需要完整实时进度，应当与 `run.result` 并发消费。

需要无损持久化时，在 `MeasurementPolicy.eventDelivery` 中声明投递策略，并通过 run options 注入 `eventWriter`。封存的 writer mode、backpressure mode 与 failure mode 决定持久化失败是否终止 run；内存 event stream 始终只是观测通道。

## 隔离与副作用

导入包根不会读取用户配置、初始化 CLI 或 Studio、创建文件、写输出，也不会注册进程 hook。纯内存运行只访问宿主显式注入的 port。这个 API 不提供队列、租户隔离、跨进程重试或不可信代码 sandbox。

完整的独立宿主验收示例见 [`test/evaluation-core/fixtures/embedded-host.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/evaluation-core/fixtures/embedded-host.mjs)。
