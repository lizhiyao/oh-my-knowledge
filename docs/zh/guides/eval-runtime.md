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
| control／treatment | 实验角色。任一角色都可以承载任意 artifact kind；`baseline` 不是 `control` 的别名。 |
| dataset／sample | 评测输入，以及 expected 或 evaluation context。 |
| executor | 针对一个 sample 运行 artifact 的宿主代码。 |
| evaluator | 测量方法，例如 exact match 或 Rubric 评委。 |
| experiment／policy | 统计设计与运行限制。 |
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
import { evaluate } from 'oh-my-knowledge';

const result = await evaluate({
  executor: {
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
  },
  dataset: {
    datasetId: 'answer-regression',
    samples: [
      { sampleId: 'one', input: { prompt: '法国的首都是哪里？' }, expected: '巴黎' },
      { sampleId: 'two', input: { prompt: '2 + 2 等于几？' }, expected: '4' },
    ],
  },
  control: {
    variantId: 'prompt-v1',
    artifact: {
      name: 'answer-prompt-v1',
      kind: 'prompt',
      source: 'inline',
      content: '简洁回答。',
    },
    config: { deployment: 'deployment-a' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
  treatment: {
    variantId: 'prompt-v2',
    artifact: {
      name: 'answer-prompt-v2',
      kind: 'prompt',
      source: 'inline',
      content: '简洁、准确地回答。',
    },
    config: { deployment: 'deployment-b' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
  evaluator: { evaluatorKind: 'exact-match' },
  experiment: {
    seed: 'release-2026-09-04',
    trials: 1,
    bootstrap: { resamples: 1_000, alpha: 0.05 },
  },
  policy: { maxConcurrency: 4 },
  runId: crypto.randomUUID(),
});

if (result.status !== 'completed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

`result.definition` 与 `result.policy` 是 façade 实际编译出的 sealed Core Definition 和完整物化的 Measurement Policy。其余 Core 运行结果字段保持不变：evidence 位于 `result.artifacts`，Decision 位于 `result.artifacts.decision`，Report 位于 `result.report`。

除上面展示的值外，`executor.execute()` 还会收到显式的 `experimentRole` 与 `variantId`。可预期的宿主失败应返回 `{ errorCode }`，其中 error code 必须稳定且不包含敏感信息；普通异常会统一成为脱敏的 `EVAL_RUNTIME_EXECUTOR_FAILED`。

Schema 只能校验并收窄。若 parser coercion、补默认值或删除 JSON 字段，OMK 会拒绝执行，因为这些行为会在同一 identity 下静默改变实际测量。需要有意变换时，应在 `execute()` 内完成，并提升 `version` 或测量相关的 `fingerprintFacets`。

Variant `config` 与 `runtimeContext` 会序列化进入 sealed Definition，因此只应放入可重放、非敏感的测量输入。凭证、client 与进程内资源应保留在 Executor closure 中，绝不能进入 Definition。

`exact-match` 比较 actual output 与 sample `expected` 的 canonical JSON 值，不是字符串字节逐一比较。

`onEvent` 是可选的有序进度观察器，`eventWriter` 是 Core 的持久事件端口。观察器失败时，OMK 完成清理后抛出 `EvaluationEventConsumptionError`，其中保留终态 `runResult`，并由 canonical facade 隐去宿主回调的原始异常。取消只由调用方传入的 `AbortSignal` 控制。

## Rubric 评委评测

输出不适合做完全相等判断时，使用 `evaluatorKind: 'rubric-judge'`。宿主只负责一次模型调用；冻结 prompt、输出解析、1～5 分指标、evidence、重试、超时、预算和取消语义均由 OMK 负责：

```ts
const result = await evaluate({
  executor,
  dataset,
  control,
  treatment,
  evaluator: {
    evaluatorKind: 'rubric-judge',
    evaluatorId: 'correctness-judge',
    metricId: 'correctness-score',
    model: 'judge-model',
    effort: 'low',
    rubric: {
      criterionId: 'correctness',
      prompt: '判断答案在事实层面是否正确。',
      rubric: '完全正确为 5 分，完全错误为 1 分。',
    },
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
  },
  experiment: { seed: 'rubric-release-42' },
  policy: {},
  runId: crypto.randomUUID(),
});
```

评委 callback 只执行一次 provider 调用，不得自行重试。Provider failure 会保留合法的计量事实，并移除 provider 私有原因与 usage details。只有当所有 Executor 都返回 `oh-my-knowledge/eval-runtime/contracts` 中的版本化 trace 契约时，才使用 `tracePolicy: 'source-neutral'`。

## 认证 Executor

接纳 adapter 前运行 `checkExecutor()`。它会让同一份 declaration 经历真实的成功、失败和取消 Core run，并检查 binding 隔离、生命周期清理、telemetry、observation、配对分析与 Decision：

```ts
import { checkExecutor } from 'oh-my-knowledge';

const certification = await checkExecutor({
  executor,
  variant: treatment,
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
