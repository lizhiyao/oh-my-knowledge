# Studio 代码导航

Studio 将观测记录和评测产物呈现给用户，不定义评分口径，也不修改原始证据。

| 目录 | 职责 |
| --- | --- |
| `view-models/` | 跨层共享的类型契约，不含运行时计算。 |
| `application/` | 查询、聚合和视图投影。`replay/` 分开投影装配、卡片布局、操作摘要、时间格式和连线计算。 |
| `http/` | 请求、响应、路由和服务生命周期。`app-host.ts` 定义应用宿主接口，不生成 HTML。 |
| `presentation/` | 独立 HTML 报告与调试页面，以及其样式、脚本生成和转义工具。 |
| `web/` | Next.js 应用。`components/observe`、`measure`、`knowledge` 按功能组织，`components/layout` 放共享外壳和主题。 |
| `index.ts` | `oh-my-knowledge/studio` 公开入口，保持既有类型、常量、查询、投影、渲染与路由导出。内部模块直接引用所属层，不经过公开聚合入口。 |

原 `core-runs/` 已按职责归入上述目录；文件名中的 `core-run` 表示消费 Evaluation Core 产物，不表示 Studio 属于 eval-core。

## 两类页面宿主

CLI `studio` 使用 `createNextStudioServer`。Observe 的会话与任务页、Measure、Knowledge 的列表与详情由 Next 渲染，其余报告页与 API/SSE 由 HTTP adapter 处理。

DSH 插件和 CLI 评测预览使用 `createReportServer`，无需启动 Next。它们仍消费 HTML 渲染器。HTML 和 React 共用 application 查询与投影，不能为各自页面另算一份业务口径。

## HTML 调用盘点

当前 presentation 的模块均能从生产入口沿调用链到达，没有可整文件删除的无调用者实现。以下按入口说明保留用途；新增应用页面使用 Next，不向 HTML 路径复制页面。

### 生产入口与宿主

| 入口 | 宿主 | 直达页面 |
| --- | --- | --- |
| CLI `omk studio`（`cli/commands/studio.ts`） | Next（`createNextStudioServer`） | 会话列表/详情/轨迹、Measure、Knowledge 列表/详情为 React；其余路径回落到下方 HTML 路由。 |
| CLI 评测预览（`cli/lib/run-core-evaluation.ts`，TTY 下 eval 完成后自动启动） | 独立（`createReportServer`） | `/measure/:runId`（HTML）。收件箱路由组不注册（`observationInbox: false`，#839 批次 0）。 |
| DSH 插件 `/omk observe`（`dsh-plugin/index.ts`） | 独立（`createReportServer`） | 任务轨迹 `/observe/conversations/:thread/tasks/:turn`（HTML）。收件箱路由组不注册（`observationInbox: false`，#839 批次 0）；收件箱数据经数据层落盘，不走页面。 |

### 模块组用途与保留理由

| 模块组 | 现有用途与调用方 |
| --- | --- |
| `core-run-renderer` | `http/routes/core-runs` 输出独立评测运行列表、详情和错误页；CLI 评测预览直达 `/measure/:runId`；公开渲染 API 也从这里导出。 |
| `conversation-renderer` | 独立宿主的会话列表和详情，由 `http/routes/conversations` 调用。 |
| `knowledge-debugger-renderer` | 独立宿主任务轨迹、`/observe/sessions/:id` 调试入口；DSH `/omk observe` 直达页面。 |
| `skill-list-renderer`、`skill-detail-renderer` | 独立宿主的知识列表和详情，由 `http/routes/knowledge` 调用。 |
| `knowledge-reports-renderer`、`skill-health-renderer` | 观测健康列表、报告详情、趋势与差异页（只读报告）。 |
| `doctor-detail-renderer` | `/knowledge/doctors/:id` 体检报告（只读报告）。 |
| `managed-history-renderer` | `/knowledge/managed` 及受管对象历史（只读报告）。 |
| `observation-inbox-renderer`、`observation-inbox/` | 已删除（#839 收口）。`/observe/inbox` 现由 Next 宿主 `web/components/inbox/`（React + AntD）渲染；共享投影与语义位于 `observability/inbox/`（view-model、signal-semantics、skill-rollups、metric-semantics、review-semantics）。 |
| `layout`、`report-shell`、`icons`、`inline-markdown` | 上述 HTML 页面的外壳、图标和安全内容渲染。Markdown 解析与纯文本计算位于 application。 |
| `trajectory-live`、`trajectory-routing` | HTML 轨迹页的客户端脚本生成。纯连线计算位于 `application/replay/routing`，React 直接消费计算模块。 |

只读报告页（skill-health、体检、受管历史）被两个宿主共用：默认宿主回落到 HTML、独立宿主只有 HTML。迁移其中任何一页到 React 都不会减少渲染层数量，除非独立宿主退役或按 #839 批次 0 的方式先裁剪路由。删除这些模块需要先迁移对应真实入口；目录名本身不是废弃标记。
