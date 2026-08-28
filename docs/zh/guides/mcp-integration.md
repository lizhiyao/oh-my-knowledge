# 组合 OMK MCP 集成

OMK 为本地 stdio 和标准 Streamable HTTP 暴露同一份 knowledge feedback loop 契约。公共边界把 observation 语义、人工复核门禁和 sample 草稿生命周期留在 OMK，让私有宿主只注入身份、策略、持久化和部署能力。

## 能力定位

**OMK MCP 是主动知识反馈接口，不是对话监听器。** 标准 MCP 工具边界只允许客户端、模型或 component 主动调用 OMK 工具；OMK MCP 无法自行监听、订阅或拉取客户端的完整对话。

Agent Skill 可以根据当前可见上下文自动识别潜在的知识缺口并建议记录，但这只是 best-effort 的触发判断。只有用户确认后，客户端显式调用 `save_observation` 并提交授权内容，OMK 才会收到反馈。自动识别不等于自动监听。

该集成只采集用户明确授权并通过工具提交的反馈。所有结果仍是 `coverageStatus: partial`；它不代表 OMK 能读取完整对话、其他工具调用或隐藏推理。需要持续监听时，必须由有权访问事件流的宿主系统主动转交事件；监听、授权与脱敏属于宿主集成边界，OMK 只提供通用的反馈接收与后续处理能力。

## 可观测事件矩阵

| 事件 | OMK 是否可观测 | 可作为证据 | 边界 |
| --- | --- | --- | --- |
| `save_observation` 的输入与结果 | 是 | 是 | 只包含用户授权提交的字段 |
| `get_observation`、复核与草稿工具的输入与结果 | 是 | 是 | 只覆盖当前 principal 可访问的 OMK 记录 |
| OMK component 内的点击、编辑与工具调用 | 是 | 是 | 仅限 component 主动提交给 OMK 的操作 |
| 用户显式提交的消息片段 | 是 | 是 | 片段是用户提供的 evidence，不代表完整原始消息流 |
| 客户端 conversation／turn 标识 | 视宿主而定 | 仅在宿主提供时 | 不自行伪造稳定的客户端标识 |
| 当前对话的前后文 | 否 | 否 | 标准 MCP 工具边界不能被动订阅完整 transcript |
| 未经 OMK 调用的其它工具事件 | 否 | 否 | 不推断或补写缺失调用 |
| 隐藏 reasoning | 否 | 否 | 永不读取、保存或推断 |

## 选择部署形态

| 形态 | 身份与存储 | 用途 |
| --- | --- | --- |
| 本地 stdio | 固定本地主体和 `.omk/observe-inbox` v1 File Store | 单个开发者在本机使用 OMK |
| 私有宿主 | 宿主提供 `PrincipalResolver` 和 `ObservationCaptureStore`，通过 Streamable HTTP 提供服务 | 多用户共享宿主自己的认证和持久化边界 |
| OMK 托管服务 | 当前未提供 | 可能的未来服务；不能从当前 npm 包推断其存在 |

## 工具与领域门禁

| 工具 | Scope | OMK 保证 |
| --- | --- | --- |
| `save_observation` | `observation:capture` | 只接受用户明确确认的可见证据，幂等写入 |
| `get_observation` | `observation:read` | 只返回当前 principal 分区中的证据、复核状态和 `partial` coverage |
| `record_observation_review` | `observation:review` | 只记录 `real_issue`／`not_issue`／`needs_more_context` 人工结论 |
| `draft_sample_from_observation` | `observation:draft` | 只允许从 `real_issue` 生成候选草稿；不写正式 eval sample |
| `review_observation` | `observation:read` | 从权威 observation 快照展示可选的对话内复核组件 |

`draft_sample_from_observation` 由当前 MCP 客户端根据 `get_observation` 返回的授权证据提供候选 prompt 和 rubric。OMK 负责复核门禁、provenance、原始证据引用和草稿状态，不把客户端当作受控评委。

MCP `tools/list` 还会按 resolver 返回的 scope 裁剪：用户没有的能力不会出现在工具列表中。

## 对话内复核组件

四个数据工具在不支持自定义 UI 的 MCP 客户端中仍可独立使用。`review_observation` 是单独的展示工具，也是唯一关联版本化 `ui://omk/observation-review/v1.html` resource 的工具；capture、读取和写入不会反复挂载组件。

组件遵循开放 MCP Apps bridge：通过 `ui/notifications/tool-result` 接收结构化工具结果，通过 `tools/call` 发起复核和草稿操作。组件不在浏览器存储中保存权威 review 或 draft 状态；每次变更仍由服务端重新鉴权并持久化，组件根据写工具返回的权威结果更新。卡片会先展示 `coverageStatus: partial` 和未观测事件，再提供人工结论操作。

典型模型调用顺序是先 `get_observation`，再 `review_observation`。模型只能根据 `get_observation` 返回的授权证据提出候选 prompt 和 rubric，用户可在生成草稿前编辑。标准 resource 与 bridge 契约见 OpenAI 的 [MCP Apps UI 指南](https://developers.openai.com/plugins/build/chatgpt-ui)。

## 四种触发路径

### Skill 快捷触发

在 Codex 中输入 `$omk feedback`，显式调用 OMK Skill 保存当前对话里最近一个明确知识问题。该调用本身视为用户确认；Agent 以 `confirmedByUser: true` 调用 `save_observation`，但只提交最小可见证据。没有明确候选或存在多个候选时必须先追问。该快捷入口不是 CLI 子命令，也不能绕过后续人工复核门禁。

### 用户显式触发

用户说「刚才关于退款期限的回答错了，请记录这个问题」。模型调用 `save_observation`，并设置 `confirmedByUser: true`；evidence 只包含用户授权的纠正和必要片段。捕获后不会自动生成草稿或写入正式样本集。

### Skill 启发式建议

用户只说「不对，退款期限应该是 30 天，不是 7 天」时，skill 可以建议「要把这个知识缺口记录到 OMK 吗？」。在用户明确确认前，不调用 `save_observation`。这条路径依赖模型判断，是 best-effort，不能用作完整召回率。

### Component 操作

已有 observation 时，模型先调用 `get_observation`，再调用 `review_observation`。用户在 component 内选择「真实问题」后，component 调用 `record_observation_review`；只有服务端确认结论为 `real_issue` 后，才允许调用 `draft_sample_from_observation`。草稿仍与正式 eval sample 隔离。

仓库在 `examples/mcp-observation/eval-samples.json` 提供 direct／indirect／negative 行为用例。它们必须在能够暴露 MCP 工具轨迹的宿主中运行；普通文本执行器看不到工具调用，不能用于验证这组边界。

## 本地 stdio

安装 OMK 后启动 MCP Server：

```bash
omk-mcp
```

该入口使用单用户目录布局和 v1 capture record。

## 组合 Streamable HTTP 服务

公共集成契约从 `oh-my-knowledge/mcp` 导出。下面的示例故意把凭据校验留给宿主；不要把 `hostAuth.verify` 替换成未校验的身份 header。

```ts
import type { IncomingMessage } from 'node:http';
import {
  FileObservationFeedbackStore,
  OBSERVATION_CAPTURE_SCOPE,
  OBSERVATION_DRAFT_SCOPE,
  OBSERVATION_READ_SCOPE,
  OBSERVATION_REVIEW_SCOPE,
  ObservationPrincipalError,
  startObservationMcpHttpServer,
  type PrincipalResolver,
} from 'oh-my-knowledge/mcp';

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

const started = await startObservationMcpHttpServer({
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

`ObservationCaptureStore` 是最小持久化接缝；实现它时 MCP Server 只注册 `save_observation`。`ObservationFeedbackStore` 在此基础上增加 `get`、`review` 和 `draftSample`；实现完整接口时才注册三个 feedback 数据工具和可选复核组件。这样旧 adapter 不会被迫虚假承诺未实现的能力。

OMK 同时导出准备标准 v1 record 和生成标准结果的 helper，因此 capture adapter 不需要重新实现 capture 哈希、coverage 或 Inbox identity。

```ts
import {
  assertCompatibleExplicitObservationCapture,
  explicitObservationCaptureResult,
  prepareExplicitObservationCaptureRecord,
  type ObservationCaptureStore,
} from 'oh-my-knowledge/mcp';

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

`PrincipalResolver` 是 adapter contract，不是 OAuth 实现。生产宿主必须校验 MCP 客户端所需的认证协议，包括 token audience、scope 和正确的 `401` challenge。OAuth metadata 和标准 adapter 有意不包含在本次集成边界内。如果具体接入 ChatGPT，还应遵循 [OpenAI 官方认证指南](https://developers.openai.com/plugins/build/auth)中的 MCP OAuth 要求。

## 使用 MCP Inspector 验证

启动 HTTP 服务后运行：

```bash
npx @modelcontextprotocol/inspector@latest
```

选择 **Streamable HTTP**，填入 `startObservationMcpHttpServer` 返回的实际 URL，并配置宿主 resolver 所需的凭据。依次验证初始化、`tools/list`、`resources/list`、组件 resource 的 MIME type、工具 annotation、授权调用、重复调用返回 `created: false`、无效确认、缺少 scope 和无效凭据。先调用 `get_observation`，再调用 `review_observation`；后者应是唯一携带 `_meta.ui.resourceUri` 的工具。

对于 ChatGPT 这一具体客户端，Secure MCP Tunnel 可以在 developer mode 中连接私有开发服务。这条可选接入路径不改变 OMK 的通用 MCP 契约，也不能代替稳定的公共 HTTPS endpoint。
