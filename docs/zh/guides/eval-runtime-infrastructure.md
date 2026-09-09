# 配置评测运行与存储

首次接入先完成[服务接入指南](./eval-runtime.md)。本页按需查阅，无需按顺序阅读所有章节。

代码片段中的 `input`、`variants` 和应用客户端沿用[完整接入示例](./eval-runtime-scoring.md#exact-match-评测)或由你的应用提供；它们不是 OMK 自带的服务。

<a id="executor-contract"></a>

## 接入服务时的输入、错误与凭证约定

除[接入示例](./eval-runtime-scoring.md#exact-match-评测)展示的值外，`executor.execute()` 还会收到 `variantId`。比较角色属于 `comparisons`，不会注入 Executor invocation。可预期的宿主失败应返回 `{ errorCode }`，其中 error code 必须稳定且不包含敏感信息；普通异常会统一成为脱敏的 `EVAL_RUNTIME_EXECUTOR_FAILED`。

Schema 只能校验并收窄。若 parser coercion、补默认值或删除 JSON 字段，OMK 会拒绝执行，因为这些行为会在同一 identity 下静默改变实际测量。需要有意变换时，应在 `execute()` 内完成，并提升 `version` 或测量相关的 `fingerprintFacets`。

Variant `config` 与 `runtimeContext` 会序列化进入 sealed Definition，因此只应放入可重放、非敏感的测量输入。凭证、client 与进程内资源应保留在 Executor closure 中，绝不能进入 Definition。
<a id="reference-证据与宿主内容存储"></a>

## 把较大或敏感的输出保存在自己的存储中

默认会将实际输出、调用记录和评分依据直接保存在运行结果中（`full`）。如果内容太大，或应由自己的存储服务控制访问，可选择 `reference`：你负责保存和读取内容，OMK 在结果中保留可校验的引用。评分时需要读取引用内容，因此同时提供 `contentStore` 和 `contentResolver`。下面的 `objectStore` 需要替换为你的存储实现：

```ts
import { checkContentStore, type ContentResolver, type ContentStore } from 'oh-my-knowledge';

const contentStore: ContentStore = {
  async put(request) {
    // 验证 request.digest，持久化 canonical JSON 值，再返回 descriptor。
    return objectStore.putVerified(request);
  },
};

const contentResolver: ContentResolver = {
  async resolve(descriptor) {
    return objectStore.resolveVerified(descriptor);
  },
};

const storageCheck = await checkContentStore({ contentStore, contentResolver });
if (!storageCheck.conformant) throw new Error('内容存储未通过一致性检查。');

const result = await evaluate({
  ...input,
  policy: {
    ...input.policy,
    evidence: {
      output: 'reference',
      trace: 'digest',
      evaluatorEvidence: 'reference',
      maximumClassification: 'sensitive',
    },
  },
  infrastructure: { contentStore, contentResolver },
});
```

`checkContentStore()` 会写入两次相同的固定 public probe，再回读一次；稳定 reason code 不会保留 payload 或宿主异常文本。`full` 内联 canonical JSON 值，`reference` 持久化该值并记录经过验证的 descriptor，`digest` 只保留 canonical value digest，`none` 则省略该项捕获；output、trace 与 `evaluatorEvidence` 可以分别选择。内容超过 `maximumClassification` 时会失败关闭。Evaluator 把 output 或 trace 声明为输入后，对应 capture 必须保留为 `full` 或 `reference`；reference 输入还必须提供 resolver。OMK 会在 prepare 阶段、任何 Target 调用之前校验这些依赖。Store 实现与 credential 绝不进入 Definition；返回的 descriptor 会进入 run artifact，因此可选 `uri` 必须是稳定、opaque 且不含 credential 的 locator，不能是物理路径或 signed URL。授权与大小限制仍由宿主负责。

检查默认最多等待每个操作 5 秒；若存储服务使用不同的本地 SLO，可显式设置 `timeoutMs`。Content port 不暴露取消能力，因此 timeout 后停止底层操作仍由宿主负责。
<a id="复用执行与评价结果"></a>

## 使用缓存，减少重复调用

多次运行相同任务时，可以分别复用系统输出（执行缓存）或评分结果（评价缓存）。它们默认不开启，需要你提供缓存存储。执行缓存只适用于可验证身份的确定性执行器，不能直接拿来复用随机模型输出；如果只改了评分或分析，先看[分阶段复用](./eval-runtime-experiments.md#reuse-stages)。

下面的 `cacheableInput` 是你为确定性执行器准备的评测声明，不能直接使用随机模型配置。缓存和部署认证服务也由你的应用提供；OMK 负责生成缓存键、校验记录并保留命中来源：

```ts
import type {
  EvaluationCache,
  ExecutionCache,
  ExecutorIdentityVerifier,
} from 'oh-my-knowledge';

const executionCache: ExecutionCache = durableExecutionCache;
const evaluationCache: EvaluationCache = durableEvaluationCache;
const executorIdentityVerifier: ExecutorIdentityVerifier = {
  verifierId: 'acme.signed-deployment-registry/v1',
  async verify({ executor, declaredIdentity }) {
    const attestation = await deploymentRegistry.verifyCallable({
      implementation: executor,
      declaredIdentity,
    });
    return { attestationDigest: attestation.digest };
  },
};

const cached = await evaluate({
  ...cacheableInput,
  policy: {
    ...cacheableInput.policy,
    cache: { execution: 'reuse', evaluation: 'reuse' },
  },
  infrastructure: {
    executionCache,
    evaluationCache,
    executorIdentityVerifier,
  },
});
```

`execution: 'reuse'` 表示命中时复用，miss 时执行并写入；它只适用于声明为 deterministic 的 Executor，并且必须由独立认证器把捕获的实际 callable、依赖和部署配置绑定到稳定 attestation。`checkExecutor()` 只检查行为一致性，不会把自报身份升级为 verified；认证器也不能只复述 `declaredIdentity`。`execution: 'replay-only'` 不写入，任一 miss 都会在调用 Target 前失败，适合显式离线重放。`evaluation: 'reuse'` 独立复用已完成的评价记录。

缺少所需 cache port 或透明 Execution 复用所需的认证器时，`prepareEvaluation()` 会失败关闭。缓存实现和 credential 不进入 Definition；缓存 entry 类型是公开的 `ExecutionCacheEntry` 与 `EvaluationCacheEntry`，但调用方不应自行放宽或重写 Core 的验证规则。不同实现、workspace、工具策略、评测输入或测量策略会通过 sealed identity 失效相应缓存。
<a id="run-progress"></a>

## 接收进度与取消运行

在 `evaluate()` 的第二个参数中接收进度事件，并传入用于取消的信号。下面的 `controller` 应由你的取消按钮或请求生命周期持有；需要取消时调用 `controller.abort()`。

```ts
const controller = new AbortController();
const running = evaluate(input, {
  signal: controller.signal,
  onEvent(event) { console.log(event); },
});
const result = await running;
```

进度事件用于观察，可能丢失；最终结论以返回的 `result` 为准。它不适合作为必须逐条保留的审计日志。

`runId`、`signal`、`onEvent`、`clock`、报告 annotation／summary 与 `eventBufferCapacity` 都属于可选的第二个 `EvaluationRunOptions` 参数，不属于测量声明。`onEvent` 是 best-effort 进度观察器。已投递事件保持顺序，但慢观察器不会反向阻塞测量：有界 Core stream 会丢弃最旧的待处理进度并保留较新的事件，因此序号允许出现缺口。`eventBufferCapacity` 控制这项内存上界，默认值为 256。观察器失败时，OMK 完成清理后抛出 `EvaluationEventConsumptionError`，其中保留终态 `runResult`，并由 canonical façade 隐去宿主回调的原始异常。`evaluate()` 有意不提供持久、无损的事件投递；advanced 宿主应通过显式的 `createMeasurementPolicy({ eventDelivery: ... })`、`eventWriter` 与 `runEvaluation()` 配对使用。取消只由调用方传入的 `AbortSignal` 控制。
<a id="生产策略"></a>

## 设置并发、超时、重试和预算

接入真实服务后，按服务容量和费用设置 `policy`。`execution` 限制待测系统的调用，`evaluation` 限制评分器或评委的调用，两者分别设置。下面的数值仅展示配置方式，应根据你的服务调整；`maxAttempts: 3` 包含第一次调用和最多两次重试。预算根据已上报用量检查，并发调用可能使最终成本超过设定值。

```ts
policy: {
  execution: {
    maxConcurrency: 8,
    timeoutMs: 30_000,
    retry: {
      maxAttempts: 3,
      retryableErrorCodes: ['rate-limit', 'timeout'],
      backoff: {
        backoffKind: 'exponential',
        initialDelayMs: 250,
        maxDelayMs: 5_000,
      },
    },
  },
  evaluation: {
    maxConcurrency: 4,
    timeoutMs: 10_000,
    retry: {
      maxAttempts: 2,
      retryableErrorCodes: ['judge-rate-limit'],
      backoff: { backoffKind: 'fixed', initialDelayMs: 200 },
    },
  },
  failure: { failureMode: 'failure-threshold', maxFailures: 2 },
  budget: {
    run: {
      maxInvocations: 1_000,
      maxActiveDurationMs: 300_000,
      maxWallClockMs: 600_000,
      maxProviderCost: { amount: 20, currency: 'USD' },
    },
    execution: { maxInvocations: 800, maxProviderCost: { amount: 12, currency: 'USD' } },
    evaluation: { maxInvocations: 200, maxProviderCost: { amount: 8, currency: 'USD' } },
    coordinate: { maxInvocations: 4 },
    attempt: { maxProviderCost: { amount: 0.25, currency: 'USD' } },
    onUnreportedProviderCost: 'fail-run',
  },
  evidence: { maximumClassification: 'sensitive' },
},
```

`maxAttempts` 包含第一次尝试。只有显式列出的宿主稳定错误码可以重试；普通抛错仍会脱敏，绝不被静默归类为可重试。`none` 立即重试，`fixed` 使用固定 delay，`exponential` 从 `initialDelayMs` 增长到可选的 `maxDelayMs`。`continue` 与 `fail-fast` 不接受 `maxFailures`；`failure-threshold` 必须声明它，并在已完成的失败数超过 threshold 后停止接纳后续 scheduling block。

预算采用分层且可审计的模型。`run` 同时覆盖 execution 与 evaluation；`execution` 和 `evaluation` 分别限制对应 stage；`coordinate` 作用于每个 Target／Sample／Trial 坐标；`attempt` 限制一次 attempt 上报的 provider cost。Invocation 数量包含 retry。`maxActiveDurationMs` 累加已完成 attempt 的执行时长；仅属于 run 的 `maxWallClockMs` 使用单调时钟计量完整经过时间，包括排队与 backoff。同一 run 中配置的所有 provider-cost limit 必须使用相同的三位大写货币代码。

Canonical façade 固定采用 Core 的 `bounded-overshoot` admission。它会在接纳新工作前检查已累计上报成本，但这不是调用前的硬性金额上限：已经接纳的并发调用仍可能让最终金额超过 limit，签名预算摘要会如实记录 overshoot。Provider cost 缺失时需要失败关闭，可设置 `onUnreportedProviderCost: 'fail-run'`；默认 `mark-unverifiable` 会保留 run，同时把成本验证标为 indeterminate。Attempt cost 同样根据调用结束后的上报 usage 判断；attempt 时长由 stage `timeoutMs` 控制，不属于 attempt budget。

默认值为 execution／evaluation 并发 4、无 timeout、不重试、failure `continue`、`run.maxInvocations` 10,000、无其它 budget limit、`onUnreportedProviderCost: 'mark-unverifiable'`，以及 maximum classification `gold`。
<a id="检查-runtime-组件"></a>

## 检查接入代码是否符合 OMK 要求

写好执行器或评分器后，用 `checkRuntime()` 检查成功、失败、取消和资源清理等行为是否符合 OMK 的要求。它会实际调用被检查的组件，应使用专门的测试输入和可丢弃资源。下面的三类输入需要由你准备：一条成功、一条返回预期错误码、一条可验证取消行为。

```ts
import { checkRuntime } from 'oh-my-knowledge';

const runtimeCheck = await checkRuntime({
  runtimeKind: 'executor',
  variant: variants[1],
  success: { input: successInput, expected: expectedOutput },
  failure: { input: failureInput, expectedErrorCode: 'model-unavailable' },
  cancellation: { input: longRunningInput },
});

if (!runtimeCheck.conformant) console.error(runtimeCheck.checks);
```

`runtimeKind` 判别字段还可以选择 `evaluator`、`judge`、`cache`、`content-store` 或 `workspace-provider`。`checkExecutor()` 与 `checkContentStore()` 继续作为复用既有探针的聚焦入口。无效声明会以 `EVAL_RUNTIME_INPUT_INVALID` 拒绝；宿主行为不符合契约时返回带稳定 reason code 的 `conformant: false`。检查通过不会把自报 Runtime identity 升级为已认证，也不证明模型 provider 的质量；随后仍应通过真实 `evaluate()` 验证预期组件组合。

若实现忽略取消信号，cancellation case 仍必须自行保证有界；进程内检查无法 containment 恶意代码。Evaluation cache、Custom Evaluator 与 Judge 检查会经 Core 运行重叠调用；execution cache 只按 Core 当前的串行读取路径检查，不声称更多保证。Cache 与 ContentStore 检查会写入数据，因此应使用可丢弃资源，并为 cache 提供唯一 `probeNamespace`。Workspace 检查会观察 lease 隔离、retry 复用与清理，但不能证明物理删除或 sandbox；`timeoutMs` 会限制检查等待清理的时间，但无法停止 provider 底层 promise。Judge 检查最多执行四次 provider 调用并可能产生费用，因此必须显式设置 `allowExternalCalls: true`；每个 `publicProbeText` 都会发送给 provider，只能包含无害的 public data。结果会返回实际 invocation 数与 provider-cost 汇总。稳定结果不会保留 probe payload、provider exception 文本、prompt、模型 output、cache entry、workspace root、locator 或 credential。
<a id="高级接入与迁移"></a>

## 何时需要高级 API

多数业务接入使用包根的 `evaluate()` 和[评分方法](./eval-runtime-scoring.md)中的评分器即可。只有需要自己管理组件生命周期、分阶段装配运行环境或接入更底层的测量能力时，才使用高级入口。已有代码如果使用下面这些底层函数，应从 `advanced` 子路径导入：

```ts
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createJsonExecutorAdapter,
  runEvaluation,
} from 'oh-my-knowledge/eval-runtime/advanced';
```

显式子路径 `oh-my-knowledge/eval-runtime` 与包根暴露同一套 canonical façade。自定义 port、分阶段宿主装配或旧 `ExecutorFn` bridge 使用 `oh-my-knowledge/eval-runtime/advanced`；版本化 wire schema 使用 `oh-my-knowledge/eval-runtime/contracts`；多指标图、自定义 Analysis Runtime、artifact 重放、跨进程 transported comparability 或自定义 comparability policy 使用 `oh-my-knowledge/eval-core`。`eval-workflows` 只依赖 runtime foundation 叶子模块，不依赖任一用户 façade。`package.json#exports` 之外的深路径均为私有实现。

可运行的[最小示例](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime)与 packed-package fixture 会在 clean host 中验证 canonical API。
