# 组合 ChatGPT MCP 集成

OMK 为本地 stdio 和标准 Streamable HTTP 暴露同一份 knowledge feedback loop 契约。公共边界把 observation 语义、人工复核门禁和 sample 草稿生命周期留在 OMK，让私有宿主只注入身份、策略、持久化和部署能力。

该集成只采集用户明确授权并通过工具提交的反馈。所有结果仍是 `coverageStatus: partial`；它不代表 OMK 能读取完整对话、其他工具调用或隐藏推理。

## 选择部署形态

| 形态 | 身份与存储 | 用途 |
| --- | --- | --- |
| 本地 stdio | 固定本地主体和既有 `.omk/observe-inbox` v1 File Store | 单个开发者在本机使用 OMK |
| 私有宿主 | 宿主提供 `PrincipalResolver` 和 `ObservationCaptureStore`，通过 Streamable HTTP 提供服务 | 多用户共享宿主自己的认证和持久化边界 |
| OMK 托管服务 | 当前未提供 | 可能的未来服务；不能从当前 npm 包推断其存在 |

## 工具与领域门禁

| 工具 | Scope | OMK 保证 |
| --- | --- | --- |
| `capture_observation` | `observation:capture` | 只接受用户明确确认的可见证据，幂等写入 |
| `get_observation` | `observation:read` | 只返回当前 principal 分区中的证据、复核状态和 `partial` coverage |
| `record_observation_review` | `observation:review` | 只记录 `real_issue`／`not_issue`／`needs_more_context` 人工结论 |
| `draft_sample_from_observation` | `observation:draft` | 只允许从 `real_issue` 生成候选草稿；不写正式 eval sample |
| `render_observation_review` | `observation:read` | 从权威 observation 快照渲染可选的对话内复核组件 |

`draft_sample_from_observation` 由当前 ChatGPT 根据 `get_observation` 返回的授权证据提供候选 prompt 和 rubric。OMK 负责复核门禁、provenance、原始证据引用和草稿状态，不把 ChatGPT 当作受控评委。

MCP `tools/list` 还会按 resolver 返回的 scope 裁剪：用户没有的能力不会出现在工具列表中。

## 对话内复核组件

四个数据工具在不支持自定义 UI 的 MCP 客户端中仍可独立使用。`render_observation_review` 是单独的展示工具，也是唯一关联版本化 `ui://omk/observation-review/v1.html` resource 的工具；capture、读取和写入不会反复挂载组件。

组件遵循开放 MCP Apps bridge：通过 `ui/notifications/tool-result` 接收结构化工具结果，通过 `tools/call` 发起复核和草稿操作。组件不在浏览器存储中保存权威 review 或 draft 状态；每次变更仍由服务端重新鉴权并持久化，组件根据写工具返回的权威结果更新。卡片会先展示 `coverageStatus: partial` 和未观测事件，再提供人工结论操作。

典型模型调用顺序是先 `get_observation`，再 `render_observation_review`。模型只能根据 `get_observation` 返回的授权证据提出候选 prompt 和 rubric，用户可在生成草稿前编辑。标准 resource 与 bridge 契约见 OpenAI 的 [MCP Apps UI 指南](https://developers.openai.com/plugins/build/chatgpt-ui)。

## 本地 stdio

安装 OMK 后启动既有 MCP Server：

```bash
omk-chatgpt-mcp
```

该入口继续使用原有单用户目录布局和 v1 capture record。

## 组合 Streamable HTTP 服务

公共集成契约从 `oh-my-knowledge/chatgpt-plugin` 导出。下面的示例故意把凭据校验留给宿主；不要把 `hostAuth.verify` 替换成未校验的身份 header。

```ts
import type { IncomingMessage } from 'node:http';
import {
  FileObservationFeedbackStore,
  OBSERVATION_CAPTURE_SCOPE,
  OBSERVATION_DRAFT_SCOPE,
  OBSERVATION_READ_SCOPE,
  OBSERVATION_REVIEW_SCOPE,
  ObservationPrincipalError,
  startChatGptObservationHttpServer,
  type PrincipalResolver,
} from 'oh-my-knowledge/chatgpt-plugin';

const principalResolver: PrincipalResolver<IncomingMessage> = {
  async resolve(request) {
    const subject = await hostAuth.verify(request);
    if (!subject) {
      throw new ObservationPrincipalError('unauthenticated', 'Invalid credential.');
    }
    if (!subject.canCaptureObservation) {
      throw new ObservationPrincipalError('forbidden', 'Capture is not allowed.');
    }
    return {
      tenantId: subject.tenantId,
      principalId: subject.stableSubjectId,
      scopes: [
        OBSERVATION_CAPTURE_SCOPE,
        OBSERVATION_READ_SCOPE,
        OBSERVATION_REVIEW_SCOPE,
        OBSERVATION_DRAFT_SCOPE,
      ],
    };
  },
};

const started = await startChatGptObservationHttpServer({
  host: '127.0.0.1',
  port: 0,
  principalResolver,
  captureStore: new FileObservationFeedbackStore({
    observationsDir: '/srv/omk/observations',
  }),
});

console.log(started.url.href);
```

`tenantId` 和 `principalId` 只来自 resolver，不会出现在 MCP 工具输入 schema 中。File Store 会把二者分别哈希后用于目录分区，因此同一个 `captureId` 会在每个 `(tenantId, principalId)` 组合内独立幂等。原始 principal 标识不会写入 capture record 或文件路径。

未提供 resolver 时，HTTP helper 默认只监听 loopback，并使用本地主体；没有显式 resolver 时，它会拒绝绑定非 loopback 地址，并拒绝非 loopback `Host` 或 `Origin`，关闭浏览器跨站请求和 DNS rebinding 路径。入口还限制请求体大小、并发数、字段长度和请求体读取超时。生产宿主应自行提供 TLS 终止、限流策略、生命周期管理和运行遥测，但不应记录反馈或 evidence 正文。

## 实现其它 Store

`ObservationCaptureStore` 是最小持久化接缝；实现它时 MCP Server 只注册 `capture_observation`。`ObservationFeedbackStore` 在此基础上增加 `get`、`review` 和 `draftSample`；实现完整接口时才注册三个 feedback 数据工具和可选复核组件。这样旧 adapter 不会被迫虚假承诺未实现的能力。

OMK 同时导出准备标准 v1 record 和生成标准结果的 helper，因此 capture adapter 不需要重新实现 capture 哈希、coverage 或 Inbox identity。

```ts
import {
  assertCompatibleExplicitObservationCapture,
  explicitObservationCaptureResult,
  prepareExplicitObservationCaptureRecord,
  type ObservationCaptureStore,
} from 'oh-my-knowledge/chatgpt-plugin';

const captureStore: ObservationCaptureStore = {
  async create(principal, input) {
    const candidate = prepareExplicitObservationCaptureRecord(input);
    const outcome = await persistence.insertOrLoad({
      uniqueKey: [principal.tenantId, principal.principalId, candidate.captureId],
      record: candidate,
    });
    assertCompatibleExplicitObservationCapture(outcome.record, candidate);
    return explicitObservationCaptureResult(outcome.record, outcome.created);
  },
};
```

`insertOrLoad` 必须是原子操作。重复键返回已有 record；同一 identity 对应不同 payload 时必须 fail closed。持久化实现属于宿主，不包含在 OMK 中。

完整私有 adapter 应实现 `ObservationFeedbackStore`，并保持与 `FileObservationFeedbackStore` 相同的不变量：所有操作按 `(tenantId, principalId)` 隔离；不存在的 observation fail closed；只有 `real_issue` 可写草稿；草稿持续保留 source evidence hash，且不能直接混入正式评测集。

## 认证边界

`PrincipalResolver` 是 adapter contract，不是 OAuth 实现。用于 ChatGPT 生产连接时，应遵循 [OpenAI 官方认证指南](https://developers.openai.com/plugins/build/auth)中的 MCP OAuth 要求，包括 protected-resource metadata、token audience 与 scope 校验，以及正确的 `401` challenge。OAuth metadata 和标准 adapter 有意不包含在本次集成边界内。

## 使用 MCP Inspector 验证

启动 HTTP 服务后运行：

```bash
npx @modelcontextprotocol/inspector@latest
```

选择 **Streamable HTTP**，填入 `startChatGptObservationHttpServer` 返回的实际 URL，并配置宿主 resolver 所需的凭据。依次验证初始化、`tools/list`、`resources/list`、组件 resource 的 MIME type、工具 annotation、授权调用、重复调用返回 `created: false`、无效确认、缺少 scope 和无效凭据。先调用 `get_observation`，再调用 `render_observation_review`；后者应是唯一携带 `_meta.ui.resourceUri` 的工具。OpenAI 的 [MCP Server 指南](https://developers.openai.com/plugins/build/mcp-server#run-and-test-locally)建议在连接 ChatGPT 前先完成 Inspector 验证。

Secure MCP Tunnel 可以在 ChatGPT developer mode 中连接私有开发服务。它是开发连接路径，不能代替公开提交插件所需的稳定公共 HTTPS endpoint。
