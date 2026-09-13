# Studio 代码导航

Studio 将观测记录和评测产物呈现给用户，不定义评分口径，也不修改原始证据。

| 目录 | 职责 |
| --- | --- |
| `view-models/` | 跨层共享的类型契约，不含运行时计算。 |
| `application/` | 查询、聚合和视图投影。`replay/` 分开投影装配、卡片布局、操作摘要、时间格式和连线计算。 |
| `http/` | 请求、响应、路由和服务生命周期。`app-host.ts` 定义应用宿主接口，不生成 HTML。 |
| `presentation/` | 独立 HTML 报告页，以及其样式、脚本生成和转义工具。 |
| `web/` | Next.js 应用。`components/observe`、`measure`、`knowledge`、`inbox` 按功能组织，`components/layout` 放共享外壳和主题。 |
| `index.ts` | `oh-my-knowledge/studio` 公开入口，保持既有类型、常量、查询、投影、渲染与路由导出。内部模块直接引用所属层，不经过公开聚合入口。 |

原 `core-runs/` 已按职责归入上述目录；文件名中的 `core-run` 表示消费 Evaluation Core 产物，不表示 Studio 属于 eval-core。

## 两类页面宿主

CLI `studio` 与 DSH 插件 `/omk observe` 使用 `createNextStudioServer`。Observe 的会话与任务页、观测收件箱、Measure、Knowledge 的列表与详情由 Next 渲染，其余报告页与 API/SSE 由 HTTP adapter 处理。Next 宿主只接管宿主已注册的路由组：被 `observationInbox`／`studioPages` 裁掉的组不再拦截，落回 HTTP adapter 得到 404，而不是改渲染一套手写页面。

CLI 评测预览使用 `createReportServer` 并设置 `studioPages: false`，只挂 `/measure` 与评测 API/SSE，因此既不启动 Next，也不为用不到的观测页面在用户项目里创建 observations 目录。HTML 和 React 共用 application 查询与投影，不能为各自页面另算一份业务口径。

## 观测收件箱页面盘点（React）

默认宿主 `GET /observe/inbox` 由 Next 渲染（`web/app/observe/inbox/page.tsx`，`force-dynamic`），组件在 `web/components/inbox/`；CLI 评测预览从不注册收件箱路由组，DSH 插件以 `observationInbox: false` 退出，因此两者的任意收件箱路径都 404。页面只呈现 `observability/inbox/` 的宿主无关投影与语义，不自算口径。

| 子视图 | 组件 | 数据来源 |
| --- | --- | --- |
| 信号 | `signals.tsx` | `model.items`，可按 Skill 本地筛选 |
| Skill 看板 | `skill-board.tsx` | `inbox/skill-rollups.ts` 聚合 |
| 体验复盘 | `experience-review.tsx` | `effectiveExperienceReports` 与 `unappliedMetricAnnotations` |
| 指标 | `metrics-guide.tsx`、`metric-badge.tsx` | `inbox/metric-semantics.ts` 文案 |
| 时间轴 | `timeline-view.tsx` | `effectiveExperienceReports` |
| 复核待办 | `review-actions-panel.tsx` | `buildReviewActionItems` 优先级判定 |
| Skill 链 | `skill-chains.tsx` | `model.skillChains` |

复核写入只有 `experience_session` 一类：同意／否决／留意见走 `POST /api/observe-inbox/review-state`，再次点击当前结论即撤销，走 `DELETE`。撤销判定收敛在 `inbox/review-semantics.ts` 的 `reviewActionRequest` 纯函数里，可脱离 DOM 独立测试。渲染的是读取时派生的有效复核投影，不是原始 `experienceReports`，否则已提交的结论会被静默忽略。

### 相对历史 HTML 版的显式减法

以下能力随 HTML 渲染层一并删除，React 版当前不提供：

- `evidence_metric`、`goal_slice_correction`、`reviewer_judgment`、`soft_standard` 四类复核写入入口；读侧仍保留「标注未生效」提示。
- 全文筛选输入框与严重度筛选按钮组；现只有 Skill 看板点击筛选与 `?skill=` 过滤标识。
- 经验详情弹窗与时间轴全文弹窗；下钻改由「查看对话任务」深链到 `/observe/conversations/:threadId`。
- 过程发现工作区（过程发现 JSON 与 Skill 下钻明细）。

补回其中任何一项都要先确定它在七个子视图里的归属，不把旧页面的筛选栏原样搬到新信息架构上。

## HTML 调用盘点

当前 presentation 的模块均能从生产入口沿调用链到达，没有可整文件删除的无调用者实现。以下按入口说明保留用途；新增应用页面使用 Next，不向 HTML 路径复制页面。

### 生产入口与宿主

| 入口 | 宿主 | 直达页面 |
| --- | --- | --- |
| CLI `omk studio`（`cli/commands/studio.ts`） | Next（`createNextStudioServer`） | 会话列表/详情/轨迹、观测收件箱、Measure、Knowledge 列表/详情为 React；其余路径回落到下方 HTML 路由。 |
| CLI 评测预览（`cli/lib/run-core-evaluation.ts`，TTY 下 eval 完成后自动启动） | 独立（`createReportServer`，`studioPages: false`） | 只有 `/measure/:runId`（HTML）与评测 API/SSE；观测、知识页面组和收件箱路由组都不注册，相关路径 404。 |
| DSH 插件 `/omk observe`（`dsh-plugin/index.ts`） | Next（`createNextStudioServer`） | 任务轨迹 `/observe/conversations/:thread/tasks/:turn`（React）。收件箱路由组不注册（`observationInbox: false`，#839 批次 0）；收件箱数据经数据层落盘，不走页面。 |

### 模块组用途与保留理由

| 模块组 | 现有用途与调用方 |
| --- | --- |
| `core-run-renderer` | `http/routes/core-runs` 输出独立评测运行列表、详情和错误页；CLI 评测预览直达 `/measure/:runId`；公开渲染 API 也从这里导出。 |
| `skill-list-renderer`、`skill-detail-renderer` | `/knowledge` 与 `/knowledge/skills/:name` 的 HTML 页，由 `http/routes/knowledge` 调用。两个 Next 宿主都会拦截这两个路径，只挂评测页面的独立宿主又不注册知识路由，因此它们现在只服务公开渲染 API，不再是任何真实入口的页面。 |
| `knowledge-reports-renderer`、`skill-health-renderer` | 观测健康列表、报告详情、趋势与差异页（只读报告）。 |
| `doctor-detail-renderer` | `/knowledge/doctors/:id` 体检报告（只读报告）。 |
| `managed-history-renderer` | `/knowledge/managed` 及受管对象历史（只读报告）。 |
| `observation-inbox-renderer`、`observation-inbox/` | 已删除（#839 收口）。`/observe/inbox` 现由 Next 宿主 `web/components/inbox/`（React + AntD）渲染；共享投影与语义位于 `observability/inbox/`（view-model、signal-semantics、skill-rollups、metric-semantics、review-semantics）。 |
| `conversation-renderer`、`knowledge-debugger-renderer`、`trajectory-live`、`trajectory-routing` | 已删除。会话列表/详情与任务轨迹只由 `web/app/observe/**` 渲染，`/observe/sessions/:id` 手写调试入口随之退出；轨迹的连线计算保留在 `application/replay/routing.ts`，由 React 直接消费。HTML 宿主不再挂 `/observe`、`/observe/conversations/*`、`/observe/sessions/*`。 |
| `layout`、`report-shell`、`icons`、`inline-markdown` | 上述 HTML 页面的外壳、图标和安全内容渲染。Markdown 解析与纯文本计算位于 application。 |

只读报告页（skill-health、体检、受管历史、趋势与差异）不在 Next 的拦截集合里，两个 Next 宿主都回落到 HTML，因此它们仍是活跃的页面能力。迁移其中任何一页到 React 都不会减少渲染层数量，除非同时裁剪对应的 HTML 路由。删除这些模块需要先迁移对应真实入口；目录名本身不是废弃标记。已被 Next 遮蔽的 HTML 知识页同时是 `oh-my-knowledge/studio` 的公开导出，删除属于公开契约变更，需要单独确认，不做静默清理。
