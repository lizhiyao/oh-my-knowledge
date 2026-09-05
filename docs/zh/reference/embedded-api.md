# 嵌入式 API

当 Node.js 宿主自行负责模型调用，而希望 OMK 负责测量、对比与报告时，使用包根 Runtime façade。它仅提供 ESM 构建，要求 Node.js 22 或更高版本：

```ts
import { evaluate, assessComparability, checkExecutor } from 'oh-my-knowledge';
```

CommonJS 宿主通过动态导入使用：

```js
const { evaluate } = await import('oh-my-knowledge');
```

OMK 有意不支持同步 `require('oh-my-knowledge')`，也不发布第二份 CommonJS 构建，从而避免两个模块实例持有相互分裂的 Runtime registry。只支持以下公共入口：

| 入口 | 职责 |
|---|---|
| `oh-my-knowledge` | 面向普通宿主的推荐 `evaluate()`、`assessComparability()` 与一致性检查 façade |
| `oh-my-knowledge/eval-core` | 高级分阶段执行、artifact admission 与验证、comparability、Series 和 Schema 发现 |
| `oh-my-knowledge/eval-runtime` | 与包根 Runtime façade 完全等价的显式入口 |
| `oh-my-knowledge/eval-runtime/advanced` | 底层 Runtime 装配、identity、adapter、builder 与生命周期 SPI |
| `oh-my-knowledge/projections` | 下游 artifact projection |
| `oh-my-knowledge/studio` | Studio Core-run catalog 与 route |
| `oh-my-knowledge/mcp`／`oh-my-knowledge/dsh-plugin` | 集成专用 API |

其它路径均为私有实现，包括 `oh-my-knowledge/dist/*` 在内，都会被 package export map 阻断。

## Evaluation Core 边界

标准服务宿主优先参考[eval-runtime 接入指南](/zh/guides/eval-runtime)。需要自定义 Analysis implementation、分阶段重放或基础设施 port 的宿主，应显式导入底层 Core surface：

```ts
import {
  createEvaluationEngine,
  createBuiltinAnalysisSchemaValidators,
  type EvaluationDefinition,
  type EvaluationEngineRuntime,
  type MeasurementPolicy,
} from 'oh-my-knowledge/eval-core';
```

Engine 接收实现与基础设施 port。函数实现只存在于内存，不会进入可序列化 Definition：

```ts
const runtime: EvaluationEngineRuntime = {
  bindings: {
    async resolveExecutor(requirement) {
      const { port, satisfiesVersionConstraint } = await executorRegistry.bind(requirement);
      return {
        runtimeKind: 'executor',
        resolution: { identity: port.identity, satisfiesVersionConstraint },
        port,
      };
    },
    async resolveEvaluator(requirement) {
      const { port, satisfiesVersionConstraint } = await evaluatorRegistry.bind(requirement);
      return {
        runtimeKind: 'evaluator',
        resolution: { identity: port.identity, satisfiesVersionConstraint },
        port,
      };
    },
    resolveAnalysis(requirement) {
      return analysisRegistry.bind(requirement);
    },
  },
  clock,
  schemaValidators: new Map([
    ...createBuiltinAnalysisSchemaValidators(),
    ...hostSchemaValidators,
  ]),
  executionCache,
  evaluationCache,
  executionContentStore,
  evaluationContentStore,
  contentResolver,
};

const engine = createEvaluationEngine(runtime);
```

每个 binding resolver 必须同时返回解析结果与已配置 port。OMK 会验证两者的 Runtime identity 完全一致，以 Definition 中的稳定 reference ID 捕获该 port，并让所有 prepared run 使用同一份 binding 快照。因此，两个 Target 或 Evaluator 可以复用同一个 implementation ID，同时保留不同的 model、fingerprint、配置、session 与取消边界。resolver／port split-brain 会在任何 Runtime 资源打开前于 preparation 阶段失败。

这是一次有意的嵌入式 API 不兼容修正。仍使用旧 `preparation` 加 implementation-keyed `executors`、`evaluators` 和 Analysis map 的宿主，需要把装配迁入 `bindings`。低层阶段端口现分别命名为 `executorsByTargetId`、`evaluatorsByEvaluatorId`、`analysisNodesByNodeId`、`missingPoliciesByPolicyId` 与 `decisionPoliciesByDecisionPolicyId`；不提供旧 API adapter。

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

`runId` 由宿主分配且必填。同一个 Engine 实例中，所有 active run 的 `runId` 必须唯一，因为 OMK 会据此确定性派生 Event、Bundle 与 Report identifier。并发重复会立即以 `EVALUATION_ENGINE_RUN_ID_ACTIVE` 结束；原 run 到达任意终态后可以复用该 identifier。Definition、Sample、Policy、Runtime identity、seed 与 fingerprint 都会封存进结果的证据链。

如果宿主希望在调度前完成配置和 capability 校验，可以先调用 `await engine.prepare(definition, policy)`。返回的 `PreparedEvaluation` 持有不透明 `SealedRunPlan` capability 与捕获后的 binding 快照，可以用同一个不可变计划和同一组 port 启动多个相互隔离的 run。

## 高级分阶段运行

当宿主需要持久化某个阶段、只修改下游输入并重算受影响后缀时，从显式高级入口导入：

```ts
import { createEvaluationEngine } from 'oh-my-knowledge/eval-core';

const original = await createEvaluationEngine(runtime).prepare(definition, policy);
const executionSession = original.stages({ runId: 'execute-v1' });
const execution = await executionSession.execute().source;
await executionSession.close();

const changed = await createEvaluationEngine(runtime).prepare(changedDefinition, policy);
const admittedExecution = changed.admitExecutionBundle(
  persistedExecutionBundle,
  executionVerification,
);
const session = changed.stages({ runId: 'rescore-v2' });
const evaluation = await session.evaluate({ execution: admittedExecution }).source;
const analysis = await session.analyze({
  execution: admittedExecution,
  evaluation,
}).source;
const decision = await session.decide({
  execution: admittedExecution,
  evaluation,
  analysis,
}).source;
const report = await session.materializeReport({
  execution: admittedExecution,
  evaluation,
  analysis,
  ...(decision === undefined ? {} : { decision }),
}).result;
```

每次阶段调用都会暴露可序列化的 `.result`；除 Report materialization 外，还会暴露不可序列化的 `.source` capability。source envelope 携带对应的 `.bundle`，或 Decision `.result`。只有当前 Runtime 签发的 source，或匹配的 `admit*` 方法签发的 source，才能授权下游阶段。admission 会递归验证 plan identity 与 parent lineage；除非宿主提供有效的外部 verification fact，否则传输后的 provenance 仍保持 indeterminate。digest、Runtime identity、cache provenance 或 parent lineage 被篡改时都会 fail closed。

同一 session 中每个阶段最多执行一次，阶段调用不能重叠。Report materialization 会自动关闭 session；若工作流有意提前停止，必须调用 `await session.close()`，从而取消仍在运行的阶段、等待资源释放并归还 `runId`。

发布的 JSON Schema 使用带版本的 package 路径。代码不应自行拼接 package 内部路径，而应通过 current-contract resolver 获取：

```ts
import { resolveEvaluationCoreJsonSchema } from 'oh-my-knowledge/eval-core';

const schemaUrl = resolveEvaluationCoreJsonSchema('execution-bundle.schema.json');
```

每个已发布文件都以 canonical raw catalog URL 作为 `$id`，JSON Schema 工具可以解析其 document identity。
Catalog 共包含 21 个根契约名称；当前有 2 个根契约使用 v5，1 个使用 v4，1 个使用 v3，4 个使用 v2，13 个使用 v1。对应 package 路径分别是 `oh-my-knowledge/eval-core/schemas/v5/<file>.schema.json`、`oh-my-knowledge/eval-core/schemas/v4/<file>.schema.json`、`oh-my-knowledge/eval-core/schemas/v3/<file>.schema.json`、`oh-my-knowledge/eval-core/schemas/v2/<file>.schema.json` 与 `oh-my-knowledge/eval-core/schemas/v1/<file>.schema.json`。部分已升级的契约保留冻结的旧版快照，用于解析历史 identity；breaking Definition 与 Plan 切换有意不提供早期版本 reader。Runtime 不会根据磁盘上存在的文件猜测当前版本。Node.js 宿主应优先使用 `eval-core` package subpath 或 `resolveEvaluationCoreJsonSchema()`；resolver 是每个已安装 current contract 的单一真值来源。

## 结果与错误

`run.result` 会解析为带判别字段的 `EvaluationRunResult`：

- `completed`、`cancelled` 与 `budget-exhausted` 会包含可序列化的 Execution、Evaluation、Analysis Bundle 和 Report；
- `failed` 会包含机器可判别的 `EvaluationError`；如果流水线已经到达物化阶段，还会保留部分 artifact 与 Report；
- configuration、infrastructure、execution、evaluation、analysis 与 internal failure 保持可区分；
- assertion 不通过、质量回归或无方向性 decision 都是有效报告证据，不会导致 Promise reject。

`engine.prepare()` 是显式 preflight API，配置无效时会 reject。`engine.start()` 与 `PreparedEvaluation.start()` 会把 façade option、preparation 和 Runtime failure 收敛到 `run.result`，方便调度器只处理一个终态结果通道。`eventBufferCapacity` 必须是正安全整数；非法值会产生 `EVALUATION_ENGINE_EVENT_BUFFER_CAPACITY_INVALID` 以及一个已经关闭的空 event stream，而不是同步抛出异常。

## Event 与持久化投递

每个 run 独占自己的 EventSequencer。sequence 从零开始，跨 Execution、Evaluation、Analysis、Decision 与 Report materialization 严格递增。Event 可序列化，只包含稳定 identity、status、coverage 和 reason code，不包含 provider secret。

异步 iterable 是单消费者、有界的进度通道。它不会反压权威评测计算；消费者落后时会丢弃缓冲区中最旧的 event。如果需要完整实时进度，应当与 `run.result` 并发消费。

需要无损持久化时，在 `MeasurementPolicy.eventDelivery` 中声明投递策略，并通过 run options 注入 `eventWriter`。封存的 writer mode、backpressure mode 与 failure mode 决定持久化失败是否终止 run；内存 event stream 始终只是观测通道。

## 隔离与副作用

导入包根不会读取用户配置、初始化 CLI 或 Studio、创建文件、写输出，也不会注册进程 hook。纯内存运行只访问宿主显式注入的 port。这个 API 不提供队列、租户隔离、跨进程重试或不可信代码 sandbox。

完整的独立宿主验收示例见 [`test/eval-core/fixtures/embedded-host.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-core/fixtures/embedded-host.mjs)。
