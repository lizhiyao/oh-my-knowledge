# 在 Node.js 服务中嵌入 OMK

应用自行负责模型调用，而希望 OMK 负责测量、对比和报告时，使用 `oh-my-knowledge` 包根入口。多数接入直接调用 `evaluate`；需要执行前检查或审批的宿主使用 `prepareEvaluation`：

```ts
import { evaluate, prepareEvaluation } from 'oh-my-knowledge';
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

const input = {
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
    sampling: { samplingKind: 'paired' },
  },
  policy: {
    execution: { maxConcurrency: 4 },
    evaluation: { maxConcurrency: 4 },
  },
};
const result = await evaluate(input);

if (result.status !== 'completed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

`result.runId` 是实际运行身份；未在可选第二参数中传入时由 OMK 自动生成。`result.definition` 与 `result.policy` 是 façade 实际编译出的 sealed Core Definition 和完整物化的 Measurement Policy。`result.analysisResults[analysisId]` 是同一批 Core Analysis record 的只读索引，不会重新计算统计量。其余 Core 运行结果字段保持不变：evidence 位于 `result.artifacts`，Decision 位于 `result.artifacts.decision`，Report 位于 `result.report`。

需要 dry-run 检查、预算复核或人工审批时，先完成准备：

```ts
const prepared = await prepareEvaluation(input);

console.log(prepared.definition, prepared.policy);
console.log(prepared.planDigest, prepared.resolvedRuntimes);
console.log(prepared.estimatedWork);

const result = await prepared.run({ runId: 'approved-release-42', signal });
```

准备阶段会解析 capability 并封存完整 Core Plan，不会调用 Target 或 Evaluator。`prepared.run()` 精确执行这份不可变 Plan；准备后修改原始 input，不会改变 Definition、Policy、digest 或执行行为。`estimatedWork` 给出 retry 或提前终止前计划的 execution／evaluation coordinate，并明确标出只有运行时才能确定的 duration 与 provider cost。直接调用 `evaluate(input, options)` 与 `prepareEvaluation(input).run(options)` 保持 canonical equivalence。

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

## 重复运行稳定性

需要判断同一份封存评测在多个完整 member Run 之间是否稳定时，使用 Evaluation Series：

```ts
import { prepareEvaluationSeries } from 'oh-my-knowledge';

const preparedSeries = await prepareEvaluationSeries({
  evaluation: input,
  seriesInstanceId: 'release-42-repeatability',
  repeatCount: 10,
  stability: {
    sourceAnalysisId: 'candidate-correct-rate',
    projection: 'scalar',
  },
});

// 此时尚未调用 Target 或 Evaluator。
console.log(preparedSeries.memberPlans, preparedSeries.estimatedWork);

const series = await preparedSeries.run({ signal });
if (series.status === 'failed') throw new Error(series.error.code);
if (series.status === 'cancelled') throw new Error('Series 已取消。');
if (series.stability?.analysisStatus !== 'completed') {
  throw new Error(series.stability?.reasonCodes.join(', '));
}
console.log(series.stability.value.mean);
console.log(series.stability.value.sampleStandardDeviation);
```

必须在执行前声明完整 `repeatCount`。OMK 只捕获一次 Evaluation 声明，预注册全部 membership，并验证每个 member 的各阶段 plan digest 保持一致，同时为其分配唯一 Run contract。Member 按顺序执行，Execution／Evaluation cache 必须禁用。失败或取消的 member 会保留真实的 partial、failed、cancelled 或 missing coverage 状态，绝不会被替换；API 也不会根据已观察值提前停止。每个 member 独立使用自己的 Run budget。

Series 的实验单位是一轮完整 Run。Trial、retry、sample 与评委 replicate 仍嵌套在 Run 内，不会增加 `runCount`。测量 seed 与其它设计条件一起保持固定，因此支持 seed 的 Executor 会在各 member 收到相同 trial seed；有意改变 Run-level seed 需要另一种实验契约。稳定性表只提供描述性统计：mean、分母为 `n - 1` 的贝塞尔校正样本方差、标准差、最小值、最大值与极差；它不会发布 release verdict、估计 iid 置信区间，也不能证明跨环境复现性。全部预注册 slot 都必须符合 evidence 门槛并可比较，否则 stability 为 inconclusive，不会静默删除失败或缺失 Run。使用 `projection: 'scalar'` 选择 scalar Analysis result；需要提取区间点估计时，必须显式使用 `interval-estimate` projection。默认只接纳完整 evidence；只有对应 missingness policy 对目标结论合理时，才显式允许 partial evidence。

`PreparedEvaluationSeries` 只能使用一次，`seriesInstanceId` 标识本次有意执行。真正开始一轮新 Series 时应使用新的值。直接调用 `evaluateSeries(input, options)` 等价于准备后运行一次。

只有下游测量声明发生变化时，可以复用已经认证的前缀，避免再次支付相同 Target 工作的成本：

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

除上面展示的值外，`executor.execute()` 还会收到 `variantId`。比较角色属于 `comparisons`，不会注入 Executor invocation。可预期的宿主失败应返回 `{ errorCode }`，其中 error code 必须稳定且不包含敏感信息；普通异常会统一成为脱敏的 `EVAL_RUNTIME_EXECUTOR_FAILED`。

Schema 只能校验并收窄。若 parser coercion、补默认值或删除 JSON 字段，OMK 会拒绝执行，因为这些行为会在同一 identity 下静默改变实际测量。需要有意变换时，应在 `execute()` 内完成，并提升 `version` 或测量相关的 `fingerprintFacets`。

Variant `config` 与 `runtimeContext` 会序列化进入 sealed Definition，因此只应放入可重放、非敏感的测量输入。凭证、client 与进程内资源应保留在 Executor closure 中，绝不能进入 Definition。

## Reference 证据与宿主内容存储

默认的 `full` mode 会内联保存 output、trace 和 Evaluator evidence。面对较大或敏感的值时，注入一个内容寻址 store 及其 resolver：

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

## 复用执行与评价结果

Execution 与 Evaluation 缓存相互独立，由宿主注入存储 port，由 Core 派生 key、验证 entry 并记录命中 provenance：

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
  ...input,
  policy: {
    ...input.policy,
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

## 内容寻址 Workspace

Agent 或 Workflow 需要文件时，应通过内容身份声明文件，由宿主负责物化；不要把 `cwd`、checkout 路径、credential 或 CAS URL 放进 `runtimeContext`：

```ts
import type {
  Executor,
  WorkspaceDescriptor,
  WorkspaceProvider,
} from 'oh-my-knowledge';

const workspace: WorkspaceDescriptor = {
  resourceId: 'support-repository',
  digest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'application/vnd.acme.source-tree',
  classification: 'sensitive',
  size: 184_320,
};

const workspaceProvider: WorkspaceProvider = {
  providerId: 'acme.cas-overlay/v1',
  version: '2.1.0',
  fingerprintFacets: { materializer: 'overlayfs-v2' },
  async open({ descriptor, runId, trialId }) {
    // 返回可写、trial 私有 overlay 前，必须验证 descriptor.digest。
    const root = await cas.createOverlay(descriptor, { runId, trialId });
    return { root, close: () => cas.removeOverlay(root) };
  },
};

const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.workspace-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  workspaceProvider,
  async execute({ input, workspace, signal }) {
    if (workspace === undefined) return { errorCode: 'workspace-required' };
    return { output: await agent.run(input.task, { cwd: workspace.root, signal }) };
  },
};

const variant = {
  variantId: 'workspace-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: { executor, workspace },
};
```

不同 sample 需要不同 snapshot 时，使用 `{ default, bySampleId }`，其中 `null` override 表示该 sample 显式不使用 workspace。OMK 会在执行前封存 descriptor 与 provider identity，为每个 Target × Sample × Trial 打开一份新 lease，只在该 trial 的 retry 间复用，并在所有终态路径关闭。物理 root 不会成为测量 identity 或自动 evidence。Provider 必须完成有界的本地资源获取并自行验证内容；OMK 不发现文件、locator 或 credential。可写 lease 用于隔离测量，不是不可信代码的 sandbox。

## 按用例约束工具访问

当 Agent 后端能够准确执行工具列表时，在 Executor 上声明 capability，并在 Variant 上选择工具：

```ts
const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.tool-restricted-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  capabilities: {
    toolPolicy: 'allow-list',
    cancellation: 'cooperative',
  },
  async execute({ input, allowedTools, signal }) {
    return {
      output: await agent.run(input.task, {
        tools: allowedTools,
        signal,
      }),
    };
  },
};

const variant = {
  variantId: 'restricted-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: {
    executor,
    allowedTools: {
      default: ['Read', 'Search'],
      bySampleId: {
        offline: [],
        unrestricted: null,
      },
    },
  },
};
```

直接传入数组时，该列表适用于所有 sample。在 plan 中，`[]` 表示禁用全部工具，`null` 表示为该 sample 有意恢复 Executor runtime 默认值。OMK 会为 canonical identity 排序，始终隔离不同 Sample 的列表，并在一个 Trial 的 retry 间传递同一份不可变列表；OMK 本身既不发现工具，也不执行 provider 调用限制。Executor 必须把 `allowedTools` 转换为后端的准确约束；如果后端只能近似执行、忽略或扩大列表，就绝不能声明 `toolPolicy: 'allow-list'`。Variant 请求列表而 Executor 缺少 capability 时，`prepareEvaluation()` 会失败关闭。

## 按用例选择原生 MCP 配置

不同 sample 需要不同的原生 MCP server 配置时，使用 secret、内容寻址的 descriptor。Descriptor 是可安全进入测量 identity 的声明；宿主持有的 provider 则把 credential、物理位置与 JSON byte 保留在 Definition 之外：

```ts
const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.mcp-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  capabilities: { mcp: 'native-config' },
  mcpConfigProvider: {
    providerId: 'acme.secret-store/v1',
    version: '1.0.0',
    async open({ descriptor }) {
      const config = await secretStore.readJson(descriptor.resourceId);
      return { config, close: () => secretStore.release(descriptor.resourceId) };
    },
  },
  async execute({ input, mcpConfig, signal }) {
    return { output: await agent.run(input.task, { mcp: mcpConfig?.config, signal }) };
  },
};

const variant = {
  variantId: 'mcp-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: {
    executor,
    mcpConfig: {
      default: {
        resourceId: 'mcp-config-a',
        digest: 'sha256:<canonical-json-digest>',
        size: 123,
        mediaType: 'application/json',
        classification: 'secret',
      },
      bySampleId: { offline: null },
    },
  },
};
```

OMK 会验证 provider 返回值的 canonical JSON digest 与 byte size，为每个 Trial 打开一份新 lease，只在该 Trial 的 retry 间复用，并在所有终态路径关闭。原生配置只对选中用例的 Executor invocation 或 session 可见，OMK 不会把它写入 result 或 error；Executor 自己也不能通过 output 或 trace 返回 secret。逐 sample descriptor 变化只会失效选择该 descriptor 的 coordinate；provider identity 变化则会保守失效使用该 Executor 的全部 coordinate。Runtime 有意不发现 MCP 文件，也不选择 provider 默认值；产品层 discovery 与 Workflow 到 Runtime 的装配属于 `eval-workflows`。

## 按 attempt 隔离 Mock interception

当某个 sample 必须在真实 provider 收到请求前替换特定工具调用时，使用 `execution.mockInterception`。它可以直接接收一个 secret `MockInterceptionDescriptor`，也可以使用 `{ default, bySampleId }`，其中 `null` 表示为该 sample 禁用 interception。Executor 必须成对声明 `capabilities.mockInterception: 'pre-tool-call'` 与 `mockInterceptionProvider`：

```ts
const executor: Executor<string, undefined, string> = {
  executorId: 'acme.mockable-agent/v1',
  version: '1.0.0',
  schemas: { input: z.string(), output: z.string() },
  capabilities: { mockInterception: 'pre-tool-call' },
  mockInterceptionProvider: {
    providerId: 'acme.mock-provider/v1',
    version: '1.0.0',
    async open({ descriptor, signal }) {
      const plan = await mockStore.readAndVerify(descriptor, signal);
      const matcher = createMatcher(plan);
      return {
        intercept: ({ callId, toolName, input, signal: callSignal }) =>
          matcher.intercept({ callId, toolName, input, signal: callSignal }),
        close: () => matcher.close(),
      };
    },
  },
  async execute({ input, signal, mockInterception }) {
    return { output: await agent.run(input, { signal, mockInterception }) };
  },
};
```

Descriptor media type 固定为 `application/vnd.omk.mock-interception-plan+json`；其 digest-bound plan 必须覆盖 strictness、first-match 规则顺序和有序返回 payload descriptor。Provider 负责加载 plan，并在返回 lease 前校验 digest、byte size、media type 与 classification。Runtime 为每个 attempt 打开一份新 lease，retry 也不复用，因此返回序列和命中状态会重置。Runtime 校验 `mocked`、`pass-through` 与 `denied` decision，等待 Target 调用 settle 后再清理，并对 provider failure 脱敏。Interception 生效时产生的 output 与 trace 会保守标记为 `secret`。Strict miss 必须返回 `denied`，绝不能静默调用真实工具。`checkExecutor()` 暂不认证 interception，应通过真实 Evaluation 验证。

## 有状态 Agent Session

当 Agent 或有状态 Workflow 需要按 trial 隔离的 session 时，使用 `SessionExecutor`。`Executor` 继续表示简洁的无状态 `omk.invoke/v1` 接口；`EvaluationExecutor` 是 Variant 接受的联合类型，`InvokeExecutor` 是无状态形态的显式名称：

```ts
import type { SessionExecutor } from 'oh-my-knowledge';

const agentExecutor: SessionExecutor<{ task: string }, undefined, string> = {
  protocol: 'session',
  executorId: 'acme.research-agent/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ task: z.string() }).strict(),
    output: z.string(),
  },
  capabilities: {
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  async openSession({ runId, trialId, input }) {
    const handle = agentClient.createLocalHandle({ runId, trialId, task: input.task });
    return {
      async execute({ attemptId, signal }) {
        const response = await handle.run({ idempotencyKey: `${runId}:${attemptId}`, signal });
        return { output: response.text, usage: response.usage };
      },
      close: () => handle.close(),
    };
  },
};
```

OMK 会为每个 Target × Sample × Trial 打开一个新的 `ExecutorSession` object，并拒绝跨 trial 或 Run 复用同一个 object。Retry 会以新的 `ExecutorSessionAttempt` 调用同一 session。`attemptId` 在对应测量坐标内稳定，但可能在另一个 Run 中重复，因此 provider 幂等键必须用 `runId`（或等价的 provider session scope）限定命名空间；远端提交状态不明确时要失败关闭。`ExecutorSessionContext` 包含 `runId`、`trialId`、Variant 最小投影与 execution context，不包含 Gold、evaluation context 或 analysis membership。成功、失败、timeout 或取消后，`close()` 都只运行一次。`openSession()` 与 `close()` 必须是有界的本地生命周期工作；打开 session 是未计量的资源获取，不得执行模型推理或其它计费 attempt 工作。这个生命周期是临时测量边界，不是产品用户的持久 conversation store。

使用独立组时，只需调整 sampling 声明。Sampling Design 是 paired／independent 语义的唯一来源，同时必须为每个 Variant 声明一个 allocation：

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

多个预注册 contrast 属于同一个推断 family 时，应把它们共同声明，不能分别运行多个 nominal 95% 区间：

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

只有当产品 construct 本身就是显式加权的 utility，而不是一组彼此独立的发布标准时，才使用 composite interval：

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

`exact-match` 比较 actual output 与 sample `expected` 的 canonical JSON 值，不是字符串字节逐一比较。

`runId`、`signal`、`onEvent`、`clock`、报告 annotation／summary 与 `eventBufferCapacity` 都属于可选的第二个 `EvaluationRunOptions` 参数，不属于测量声明。`onEvent` 是 best-effort 进度观察器。已投递事件保持顺序，但慢观察器不会反向阻塞测量：有界 Core stream 会丢弃最旧的待处理进度并保留较新的事件，因此序号允许出现缺口。`eventBufferCapacity` 控制这项内存上界，默认值为 256。观察器失败时，OMK 完成清理后抛出 `EvaluationEventConsumptionError`，其中保留终态 `runResult`，并由 canonical façade 隐去宿主回调的原始异常。`evaluate()` 有意不提供持久、无损的事件投递；advanced 宿主应通过显式的 `createMeasurementPolicy({ eventDelivery: ... })`、`eventWriter` 与 `runEvaluation()` 配对使用。取消只由调用方传入的 `AbortSignal` 控制。

## Retrieval 评测

Executor 返回有序文档 ID，并且每个 sample 声明已知 relevant ID 时，使用内置 `RetrievalEvaluator`。普通用户不需要手写 Core Definition 或 custom callback：

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

Ranking 必须是由不重复、非空字符串 ID 组成的有序数组，可来自 `output` 或 `trace`；relevant ID 始终来自 `expected`，不会传给 Executor。该预设先按 `cutoff` 截断，再以 `hits / known relevant` 计算 Recall、以 `hits / cutoff` 计算 Precision、以首个 relevant 文档的名次计算 Reciprocal Rank，并使用 binary gain 与 log2 discount 计算 nDCG。空返回 ranking 是合法的零分；重复或非法 ID、空 relevant 集合会产出 invalid evidence。Reciprocal Rank 的 mean summary 才是 MRR，不要把单个 sample 的观测称为 MRR。

## 工具轨迹评测

需要对 source-neutral Agent 工具调用提出确定性预期时，使用 `ToolTrajectoryEvaluator`。Executor trace 必须满足 `omk.source-neutral-trace/v2`；provider adapter 应先把原生 event 归一化，再返回给 Runtime：

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

## 生产策略

Execution 与 evaluation 是相互独立的 runtime stage。两者分别配置并发、timeout 与 retry；OMK 会在第一次 Target 调用前封存全部默认值，scheduler 仍只由 Core 实现：

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
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['output-length-chars'],
  }],
  experiment: { seed: 'length-release-42', sampling: { samplingKind: 'paired' } },
  policy: { evaluation: { timeoutMs: 5_000 } },
});
```

Bindings 是最小权限 allowlist。只有 evaluator 确实需要 gold data 时才声明 `expected` 或 `evaluation-context`；callback 无法读取未声明的 sample 字段。JSON Pointer 会在投递前进一步收窄 source。`execution-facts` 是例外：它的 pointer 必须为空，让 callback 消费完整、已经脱敏的 canonical facts projection，避免产生第二套 projection identity。Binding 与 value schema 只能校验和收窄，不能 coercion、补默认值或删除字段。

Callback 可返回 `score`、`missing`、`invalid` 或 `failed`。Score 会作为 measurement data 直接持久化，不是带 classification 的 source content；text、category 与 ranking schema 必须把它约束在安全的测量词表内，绝不能回显 answer、trace、secret 或评委解释。这类支撑材料应放入显式声明 classification 的 `CustomEvaluatorContent` evidence。Invalid value 同样使用 `CustomEvaluatorContent`；普通异常会被脱敏。不要在 callback 内自行重试或实现超时：Core 会执行已封存的并发、超时、预算、取消、计量与失败策略。Callback 必须无状态、可安全并行且协作响应 `signal`；需要有状态资源时使用 advanced 生命周期 SPI。

OMK 不会根据 `Function#toString()` 推导 provenance，因此 identity 必须显式声明。当代码、依赖、schema 或 provider 配置改变测量行为时，必须更新 `version`、schema `fingerprintFacets` 或 implementation `fingerprintFacets`。单个 custom evaluator 不得产出多个 Metric，也不代表 ensemble member。Numeric 与 boolean Metric 必须声明单调 direction；只有调用方声明兼容的具名 summary 或 interval 后，它们才会成为 analysis result。Categorical、text 与 ranking Metric 在通过 advanced API 明确选择兼容 estimator 前只保留为 evaluation evidence。比较估计值保持原始 treatment-minus-control 差值。单 analysis progress Decision 只接受 `higher-is-better`；需要分别约束不同原始有符号 effect 时，应使用显式 comparison-family criterion。

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
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correctness-score'],
  }],
  experiment: { seed: 'rubric-release-42', sampling: { samplingKind: 'paired' } },
  policy: {},
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

显式子路径 `oh-my-knowledge/eval-runtime` 与包根暴露同一套 canonical façade。自定义 port、分阶段宿主装配或旧 `ExecutorFn` bridge 使用 `oh-my-knowledge/eval-runtime/advanced`；版本化 wire schema 使用 `oh-my-knowledge/eval-runtime/contracts`；多指标图、自定义 Analysis Runtime、artifact 重放、跨进程 transported comparability 或自定义 comparability policy 使用 `oh-my-knowledge/eval-core`。`eval-workflows` 只依赖 runtime foundation 叶子模块，不依赖任一用户 façade。`package.json#exports` 之外的深路径均为私有实现。

可运行的[最小示例](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime)与 packed-package fixture 会在 clean host 中验证 canonical API。
