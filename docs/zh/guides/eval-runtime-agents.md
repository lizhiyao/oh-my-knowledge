# 接入带工具和会话的 Agent

首次接入先完成[服务接入指南](./eval-runtime.md)。本页按需查阅，无需按顺序阅读所有章节。

代码片段中的 `input`、`variants` 和应用客户端沿用[完整接入示例](./eval-runtime-scoring.md#exact-match-评测)或由你的应用提供；它们不是 OMK 自带的服务。

<a id="内容寻址-workspace"></a>

## 为 Agent 提供相互隔离的文件工作区

如果 Agent 要读取代码仓库或修改文件，需要让不同用例使用各自的工作区，避免前一次修改影响后一次评分。用 `WorkspaceDescriptor` 记录文件快照的内容摘要，用 `WorkspaceProvider` 创建工作目录并在结束后清理。下面的 `cas` 代表你自己的快照存储和工作目录管理实现；示例摘要需要替换成真实内容摘要。

本地路径只交给执行器，不放进 `runtimeContext`，以便同一份文件内容在不同机器上仍有相同身份：

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

如果有些用例只允许搜索和读取、有些用例不允许调用任何工具，可以按用例配置允许使用的工具。先确认 Agent 后端能够严格执行这份列表，再声明支持并转发 `allowedTools`。OMK 不会代替后端拦截调用：

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

MCP 是 Agent 连接外部工具服务的协议。如果不同用例需要连接不同的 MCP 服务，用描述符标识配置版本，由你提供的 `mcpConfigProvider` 读取真正的配置与凭证。OMK 不会自动查找本机 MCP 配置。下面的 `secretStore` 是你的凭证存储；摘要和大小应按实际配置计算：

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
<a id="按-attempt-隔离-mock-interception"></a>

## 用模拟结果替换指定工具调用

例如，评测退款 Agent 时希望返回固定的查询结果、又不访问真实业务接口，可以让支持拦截的后端使用 `execution.mockInterception`。Mock 就是为指定工具调用提供预先准备的模拟响应。它可以直接接收一个 secret `MockInterceptionDescriptor`，也可以使用 `{ default, bySampleId }`，其中 `null` 表示为该 sample 禁用 interception。Executor 必须成对声明 `capabilities.mockInterception: 'pre-tool-call'` 与 `mockInterceptionProvider`：

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
<a id="有状态-agent-session"></a>

## 为多步 Agent 保留一次评测内的会话

Agent 需要在一次任务内保留多步状态或复用会话句柄时，使用 `SessionExecutor`。不同用例和计划执行各自创建会话；失败重试沿用本次会话。无状态的一次请求继续使用`Executor`。`Executor` 继续表示简洁的无状态 `omk.invoke/v1` 接口；`EvaluationExecutor` 是 Variant 接受的联合类型，`InvokeExecutor` 是无状态形态的显式名称：

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
