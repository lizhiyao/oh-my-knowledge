# 平台宿主集成（评测中心类）

**什么时候需要这篇？** 你在构建企业「评测中心」类平台：平台统一下发结构化评测用例、评分标准与执行器标识并派发任务；执行侧 Node 脚本用 eval-runtime 串联准备→执行→打分→报告；过程与结果回写平台，各类评测复用同一套标准流程。这篇指南定义宿主侧的集成契约：下发什么、执行侧如何解析实现、如何持久回写过程、如何跨进程回读重评，以及如何治理可比性。

只在单个服务里调用 `evaluate()` 时，先读[在 Node.js 服务中使用](./eval-runtime)；本篇假设你已经理解 executor（执行器）、evaluator（评分器）、variant 与 control／treatment 的基本概念。

## 定位与边界

- **宿主持有 effect，Core 持有测量语义。** 凭证、网络、存储、队列、租户隔离全部由平台宿主实现；OMK Core 只表达可版本化的测量契约与确定性变换，不触碰任何 effect。
- **派发／队列／重试／续跑／租户是 OMK 非目标。** OMK 不提供任务派发、跨进程队列、平台级重试、断点续跑或多租户隔离，这些能力由平台自建。`policy` 里的 retry 只是单次 sealed 测量契约内的 attempt 级重试，不是任务重调度。
- **canonical Report 不可插拔。** 测量产生的 Report 字段语义是跨版本可比性的锚点，不能替换成宿主自定义结构。自定义报告只有两条路：用 `oh-my-knowledge/projections` 从 canonical 结果做派生视图，或把宿主元数据放进 Report 已有的宿主槽位——`summaries` 与 `annotations` 由 run options 传入并原样落进 Report，`extensions` 是 Report 自带的扩展字段。
- **派生视图不覆盖原始证据。** 平台可以缓存派生视图加速看板，但原始结果与证据链必须完整保留，且派生视图可以随时从原始证据重新生成。

## 下发映射契约

`EvaluateInput` 含代码注入点——`variant.execution.executor` 的 `execute()`／`openSession()`、custom evaluator 的 implementation、评委的 `invoke()` 都是回调。因此 **`EvaluateInput` 不可能、也不应该整体序列化为一个 wire schema**。推荐把下发契约拆成三部分：

| 下发内容 | 载体 | 执行侧映射 |
|---|---|---|
| 评测用例 | 已发布 schema `omk.eval-sample-set/v2`（入口 `oh-my-knowledge/eval-samples`；schema 文件用 `resolveEvalSampleJsonSchema` 解析） | 编译为 `EvaluateInput.dataset.samples` |
| analyses／decision／policy／experiment／comparisons 等可序列化测量声明 | 已发布 Core JSON Schema（`oh-my-knowledge/eval-core/schemas/v1..v5/*`），运行时按文件名用 `resolveEvaluationCoreJsonSchema` 解析；每个文件名只对应一个版本目录，如 `evaluation-definition.schema.json` 在 `v5`、`measurement-policy.schema.json` 在 `v1` | 映射为 `EvaluateInput.analyses`、`decision`、`policy`、`experiment`、`comparisons` |
| executor／evaluator／评委／报告逻辑 | 只下发「注册表 id＋配置＋版本 digest」，不下发代码 | 执行侧按 id 从自有注册表解析实现（见下一节），注入 `variants`／`evaluators` |

版本化规则：

- 下发契约自带 `schemaVersion`；字段增删必须升版本，不靠隐式约定兼容。
- **改评分标准＝改测量语义。** 修改 rubric、metric 定义或 decision 阈值必须发布新的契约版本，并标记 `BREAKING-COMPARABILITY` 语义：新版本的结果与旧版本不可直接比较，看板上分开展示。
- OMK 的解析在形状上 fail-closed：不做 parser coercion、不静默删字段；已发布 schema 全部是 strict 的，下发内容多出字段或缺少必填字段会在准备阶段报错，而不是在运行时被「修复」。唯一会被补全的是**可选**策略字段：`prepareEvaluation` 会把每个省略的可选项物化为文档化的 canonical 默认值——未声明 `policy.eventDelivery` 时得到 `writerMode: 'disabled'`，`writerFailureMode` 跟随 `writerMode`，未声明 `retry` 时得到「一次尝试、无可重试 code」——并把结果封存进 Plan。需要生效值时回读 sealed 的 `prepared.policy`，不要假设实际运行的就是下发的那份 payload。
- 用例集的 `requires`（工具、文件、环境变量、preflight 命令）是宿主侧依赖预检输入，不进入 Core 测量 digest。执行侧应在调用 Target 前完成预检并失败关闭，不静默降级成「能跑多少跑多少」。

## id→实现注册表

执行侧维护一个 versioned registry：按下发的 id 解析实现，并把版本与配置 digest 写进 identity 指纹。

```ts
import type { JsonValue } from 'oh-my-knowledge/eval-core';
import type {
  CustomEvaluator,
  EvaluationExecutor,
  Judge,
} from 'oh-my-knowledge/eval-runtime';

/** 已发布的 invoke／session Executor 联合类型，不必自己拼。 */
type DispatchedExecutor = EvaluationExecutor<JsonValue, JsonValue | undefined, JsonValue>;

/** 下发契约中的实现引用：只有 id、版本、配置与配置 digest，没有代码。 */
interface DispatchedRef {
  readonly registryId: string;
  readonly version: string;
  readonly configDigest: string; // config canonical JSON 的 sha256
  readonly config: Readonly<Record<string, JsonValue>>;
}

const executors = new Map<string, (ref: DispatchedRef) => DispatchedExecutor>();
const evaluators = new Map<string, (ref: DispatchedRef) => CustomEvaluator>();
const judges = new Map<string, (ref: DispatchedRef) => Judge>();

function resolveExecutor(ref: DispatchedRef): DispatchedExecutor {
  const build = executors.get(`${ref.registryId}@${ref.version}`);
  if (build === undefined) {
    // Fail closed：绝不降级，也绝不换一个「差不多」的实现顶上。
    throw new Error(`unregistered executor: ${ref.registryId}@${ref.version}`);
  }
  return build(ref);
}

executors.set('executor:http-qa@2026.09.1', (ref) => ({
  executorId: ref.registryId,
  version: ref.version,
  // parse(value: unknown) 只做校验与收窄，不改写 canonical JSON。
  schemas: { input: parseQaInput, output: parseQaOutput },
  // 把下发配置 digest 与部署 facet 写进 identity 指纹，
  // 可比性评估才能区分「同 id 不同配置」的两次运行。
  fingerprintFacets: { configDigest: ref.configDigest, endpoint: ref.config.endpoint },
  async execute(invocation) {
    return callQaService(invocation.input, invocation.signal, ref.config);
  },
}));
```

注册表要求：

- 注册键＝`registryId@version`；任何影响行为的变更（配置结构、依赖升级、prompt 改动）都必须升版本号。
- identity facet 完整落位：executor 声明 `executorId`、`version`、`fingerprintFacets`；custom evaluator 声明 `instrumentId` 与 `implementation.implementationId`／`implementation.version`／`implementation.schemas.fingerprintFacets`；评委声明 `judgeId`、`version`、`fingerprintFacets`。这些 facet 是可比性评估的 identity 输入。
- **capability 自我声明是诚实义务。** determinism、并发安全、取消支持、trace 与 usage 上报能力全部由执行器自我声明（可用 `oh-my-knowledge/eval-runtime/advanced` 的 `createInvokeExecutorIdentity`／`createSessionExecutorIdentity` 生成完整 capability 清单）。声明了不具备的能力会污染测量结论，而且比崩溃更难被发现。

注册表里的实现不在执行侧进程里时，不必自己拼子进程协议：`oh-my-knowledge/eval-runtime/advanced` 的 `createSubprocessCommandExecutor()` 把「一条命令」包成 Executor。交换协议是版本化的 `SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION`（`omk.subprocess-command-exchange/v1`）：请求以一行 canonical JSON 写进子进程 stdin，而子进程的**整个 stdout 必须恰好是一份响应文档**——结尾换行可以接受，但任何额外输出（调试打印、进度行）都会以 `OMK_SUBPROCESS_COMMAND_RESPONSE_INVALID` 失败关闭。诊断信息应写到 stderr：stderr 永不被解析，只计入字节上限；单条流超过 `DEFAULT_SUBPROCESS_COMMAND_MAX_OUTPUT_BYTES`（10 MiB）或超过 `timeoutMs` 即终止子进程并失败关闭。可执行文件路径、参数与环境变量来自你自己的注册表，摘要后进 `command` identity facet；子进程只继承 `PATH` 与你显式声明的环境变量。继承来的 `PATH` **不在** facet 内，因此裸命令名可能在另一台宿主上解析到不同的二进制，而 fingerprint 保持不变——需要让 fingerprint 钉住二进制时，声明绝对路径的 `executablePath`。

它只承载 `ExecutorInvocation` 合法持有的字段，不伪造 run／trial／attempt 坐标或执行计划 digest。调用里出现 leased 受控资源（workspace overlay、原生 MCP 配置、工具调用拦截）时失败关闭，声明这些 capability 也会在构造阶段被拒——需要受控资源时用同进程 Executor。它也不是插件加载器：OMK 不做实现发现、下载或动态装载，注册与版本治理始终是宿主的责任。

## 持久过程回写

`EvaluationRunOptions.onEvent` 是**有序、best-effort 的进度投影**：缓冲有界（`eventBufferCapacity`，默认 256），消费落后时会丢弃最旧的进度事件、保留最新事件，因此事件序号可能出现缺口；observer 失败也不影响测量终态。它适合做进度条，**不适合做审计**。

审计级的过程回写用两个字段配合：

- 准备或执行时在 `EvaluateInput.policy.eventDelivery` 声明投递模式（形状即 `MeasurementEventDeliveryInput`，可从 `oh-my-knowledge/eval-runtime/advanced` 具名导入；在 façade 上直接写字面量即可）：`writerMode` 取 `disabled`（默认）、`optional` 或 `required`，`writerFailureMode` 取 `ignore` 或 `fail-run`。两者按严格校验配对：`disabled` 只接受 `ignore`，`required` 只接受 `fail-run` 且缺省即 `fail-run`，`optional` 缺省为 `ignore`。
- 在 `EvaluationRunOptions.eventWriter` 传入写入器，按顺序逐条持久化事件；事件形状见已发布 schema `evaluation-event.schema.json`（`resolveEvaluationCoreJsonSchema` 可解析）。**完整性只由 `required` 保证**：写入失败即整次运行失败，过程记录里的空洞不可能被误认为完整。`optional`＋`ignore` 是 best-effort——该阶段首次写入失败后会静默停止持久投递，run 仍然完成，结果里也没有任何字段报告这次截断，因此记录本身就是交付物时不要用它。

```ts
const prepared = await prepareEvaluation({
  ...input,
  policy: {
    ...input.policy,
    // 审计运行：写入器失败＝run 失败，宁可失败也不留空洞的过程记录。
    eventDelivery: { writerMode: 'required' },
  },
});

const result = await prepared.run({
  eventWriter: {
    async write(event) {
      await auditLog.append(event); // append-only，逐条持久化，不批量丢弃
    },
  },
});
```

边界：

- **事件不改变测量终态。** 回写成功与否，结果的分数与证据都不受影响，声明了 Decision 时的 verdict 同样不受影响；`required`＋`fail-run` 改变的是 run 的成败判定，不是测量语义。
- **声明 `required` 却未注入写入器，会在调用任何 Target 之前失败关闭。** 每个 Core 阶段都会检查这组配对：`evaluate()` 与 `prepared.run()` 会 resolve 出 `status: 'failed'`、`error.code` 为 `EXECUTION_RUNTIME_EVENT_WRITER_REQUIRED`、`stage` 为 `configuration` 的结果；`rescore`／`reanalyze`／`redecide` 则以 `EVAL_RUNTIME_REUSE_INVALID` reject，因为复用边界用自身的 code 报告同一个 Core 配置失败。镜像情形在标准入口与复用入口共用同一道守卫并失败关闭：delivery 为 `disabled` 却传入写入器，会以 `EVAL_RUNTIME_INPUT_INVALID` 被拒。
- 消费侧失败收敛为 `EvaluationEventConsumptionError`（code 为 `EVAL_RUNTIME_EVENT_OBSERVER_FAILED` 或 `EVAL_RUNTIME_EVENT_STREAM_FAILED`），错误对象带 `runResult` 承载 Core 终态，宿主可以先落盘再决定告警。

## 跨进程回读与重评

在另一个进程（复评方、审计方）回读结果的标准链路：

1. **保存。** 执行侧调用 `saveEvaluationResult({ result, store })`：结果以版本化 envelope `omk.eval-runtime.stored-result/v1` 写入宿主注入的 `ContentStore`，classification 恒为 `gold`，mediaType 为 `EVALUATION_RESULT_MEDIA_TYPE`，返回 `ContentDescriptor` 引用。
2. **重新准备。** 另一进程用同一份下发契约走 `prepareEvaluation`，得到 `PreparedEvaluation`；其 sealed plan digest 就是回读的准入凭证——契约不同，plan digest 不同，回读直接被拒。
3. **加载。** `loadEvaluationResult({ prepared, reference, resolver, verifier })`。除了解析内容与校验 digest，还必须注入独立的 `EvaluationResultVerifier`：verifier 要认证 envelope digest（`verifiedResultDigest` 必须等于 reference 的 digest），并独立认证 provenance bundle、cache record、policy execution 三组 digest 集合。**只做 checksum 不够**——存储完整性不等于来源可信。验证失败以 `EvaluationResultStoreError` 关闭；无法 `structuredClone` 的 JSON 同样关闭，不做部分恢复。
4. **重评。** 按需 `rescore`（复用 Execution，重新打分）、`reanalyze`（复用打分，重新分析）、`redecide`（复用分析，重新决策），或用 `assessComparability` 比较两份 canonical 结果。

可运行的参考样板见 [`examples/eval-runtime/result-store.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/examples/eval-runtime/result-store.mjs)（临时目录上的文件后端 ContentStore／ContentResolver，在存储边界校验 digest，另配一个独立的审计回执 verifier）；单进程视角的同一流程见[在新进程里读回历史结果再复用](./eval-runtime#restore-stored-results)。

## 可比性治理工作流

- **identity facet 从第一天进下发协议。** executor 的 `executorId`／`version`／`fingerprintFacets`、evaluator 的 `instrumentId` 与 implementation 版本、评委的 `judgeId`／`version`、所用 schema 的 digest——全部属于测量身份，应当是下发契约的固定字段，而不是事后补充。
- **评测用例集同样要版本化。** `omk.eval-sample-set/v2` 文档自带 `schemaVersion`，但 `EvaluateInput.dataset` 只有 `datasetId`、样本内容与可选的 `analysisCohorts`／`annotations`，没有版本字段：样本内容变化会改变 sealed plan digest（跨进程回读必须用同一份声明），而 `datasetId` 本身不会告诉你标注是否被改过。平台应把用例集版本与内容 digest 作为下发契约的固定字段，并写进 `dataset.annotations`，让看板与 `assessComparability` 的 reason 能区分「同 id、不同标注」的两次测量。修正标注后用 `rescore()` 重评属于新的测量版本，必须与修正前的结果分区展示。
- **评分标准变更走版本化流程**：发布新契约版本→标记 `BREAKING-COMPARABILITY`→新旧结果在看板分区展示。仓库内的 rubric 评委 prompt 由 `test/measurement-governance` 的 prompt registry 冻结治理，任何字节漂移都会被测试拦截；平台自有的评委 prompt 也应有同样的冻结与版本管理。
- **`assessComparability` 的三个状态独立解读**：`designStatus`（compatible／incompatible）看测量设计是否可比；`evidenceQualificationStatus`（verified／conditional／rejected）看证据认证是否完整；`comparabilityStatus`（compatible／conditional／incompatible）是派生的总体结论。设计可比不代表证据过关，反之亦然。
- **看板分区展示。** 不可比（incompatible）的结果单独分区并展示 reason code，不与可比结果混在同一条趋势线里；conditional 的结果标注限制条件后再展示。

## Gold 与访问控制

stored result 恒为 `gold` 分类——包含原始输出、trace 与完整证据链。宿主的 `ContentStore` 必须实施与 gold 匹配的访问控制：最小授权、租户隔离、访问审计。

回写评测中心的副本应定位为**下发配置＋派生状态／视图**（进度、verdict 摘要、报告投影），用于展示与检索；gold 原件与其证据链保留在受控 store 中，派生副本永远不替代原件。

## 相关阅读

- [在 Node.js 服务中使用](./eval-runtime)
- [Runtime API 参考](../reference/eval-runtime-api)
- [底层 Core API（高级）](../reference/embedded-api)
- [评测用例格式](../reference/eval-sample-format)
- [术语表](../reference/glossary)
