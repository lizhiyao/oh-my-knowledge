# Studio 代码导航

Studio 将观测记录和评测产物呈现给用户，不定义评分口径，也不修改原始证据。

| 目录 | 职责 |
| --- | --- |
| `view-models/` | 跨层共享的类型契约，不含运行时计算。 |
| `application/` | 查询、聚合和视图投影。`replay/` 分开投影装配、卡片布局、操作摘要、时间格式和连线计算。 |
| `http/` | 请求、响应、路由和服务生命周期。`app-host.ts` 定义应用宿主接口，不生成 HTML。 |
| `presentation/` | 独立 HTML 报告页，以及其样式、脚本生成和转义工具。 |
| `web/` | Next.js 应用。`components/observe`、`measure`、`knowledge`、`inbox` 按功能组织，`components/layout` 放共享外壳和主题。 |
| `index.ts` | `oh-my-knowledge/studio` 公开入口，导出 catalog、投影、view-model 与 JSON 路由。渲染实现不属于公开面，内部模块也直接引用所属层，不经过公开聚合入口。 |

原 `core-runs/` 已按职责归入上述目录；文件名中的 `core-run` 表示消费 Evaluation Core 产物，不表示 Studio 属于 eval-core。

## 两类页面宿主

CLI `studio`、DSH 插件 `/omk observe` 与 CLI 评测预览使用 `createNextStudioServer`。Observe 的会话与任务页、观测收件箱、Measure、Knowledge 的列表与详情由 Next 渲染，其余报告页与 API/SSE 由 HTTP adapter 处理。Next 宿主只接管宿主已注册的路由组：被 `observationInbox`／`studioPages` 裁掉的组不再拦截，落回 HTTP adapter 得到 404，而不是改渲染一套手写页面。同一个 `studioPages` 开关也裁掉 `web/components/layout/shell` 的一级导航——不挂页面组的宿主没有可去的兄弟路由，渲染导航等于把用户导向 404。

CLI 评测预览以 `studioPages: false` 只挂 `/measure` 与评测 JSON API（`/api/reports`；评测页每次装载是静态的，没有 SSE），因此不为用不到的观测页面在用户项目里创建 observations 目录。`/measure` 只有一份实现：HTML 渲染层与其公开渲染导出已删除，评测运行状态、预算、coverage、observation 与 lineage 的口径集中在 `application/core-run-format.ts`，中英文与未来任何界面都从这里取事实，不另算一份。

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
| CLI `omk studio`（`cli/commands/studio.ts`） | Next（`createNextStudioServer`） | 会话列表/详情/轨迹、观测收件箱、观测健康列表/详情/趋势/差异、Measure、Knowledge 列表/详情为 React；其余路径回落到下方 HTML 路由。 |
| CLI 评测预览（`cli/lib/run-core-evaluation.ts`，TTY 下 eval 完成后自动启动） | Next（`createNextStudioServer`，`studioPages: false`） | 只有 `/measure`、`/measure/:runId`（React）与 `/api/reports`；观测、知识页面组和收件箱路由组都不注册，壳层不渲染一级导航，相关路径 404。 |
| DSH 插件 `/omk observe`（`dsh-plugin/index.ts`） | Next（`createNextStudioServer`） | 会话列表/详情、观测健康列表/详情/趋势/差异、任务轨迹 `/observe/conversations/:thread/tasks/:turn`（React）；健康页的入口是 `/observe` 顶部的分区导航。收件箱路由组不注册（`observationInbox: false`，#839 批次 0）；收件箱数据经数据层落盘，不走页面。 |

### 模块组用途与保留理由

| 模块组 | 现有用途与调用方 |
| --- | --- |
| `core-run-renderer` | 已删除。`/measure` 列表与详情只由 `web/app/measure/**`（React + AntD）渲染，展示无关的事实口径在 `application/core-run-format.ts`；`http/routes/core-runs` 只保留 `/api/reports` 的 JSON 投影，公开渲染导出 `renderCoreRunList`／`renderCoreRunDetail` 与其 `CoreStudioRenderRoutes` 注入点一并退出。 |
| `skill-list-renderer`、`skill-detail-renderer` | 已删除。`/knowledge` 与 `/knowledge/skills/:name` 只由 `web/app/knowledge/**`（React + AntD）渲染：HTML 宿主的知识路由组与 Next 的拦截条件同为 `studioPages`，两者不可能同时生效，因此这两个 HTML 出口在任何真实宿主上都不再可达。`/api/skills`、`/api/skills/:skill/diagnostics` 作为 JSON 事实源保留。 |
| `knowledge-reports-renderer`、`skill-health-renderer` | 已删除。`/observe/health`、`/observe/health/:id`、`/observe/health-diff`、`/observe/skill-trend/:skill` 只由 `web/app/observe/health*`、`web/app/observe/skill-trend/*`（React + AntD）渲染；展示无关的事实口径（分档配色、样本不足静音、趋势折线几何、差异 Δ）在 `application/health-format.ts`，路径识别与 400/404 语义在 `http/health-page.ts`。`/api/observe-health*`、`/api/skill-trend/*`、`/api/analyses-diff` 作为 JSON 事实源保留。 |
| `doctor-detail-renderer` | `/knowledge/doctors/:id` 体检报告（只读报告）。 |
| `managed-history-renderer` | `/knowledge/managed` 及受管对象历史（只读报告）。 |
| `observation-inbox-renderer`、`observation-inbox/` | 已删除（#839 收口）。`/observe/inbox` 现由 Next 宿主 `web/components/inbox/`（React + AntD）渲染；共享投影与语义位于 `observability/inbox/`（view-model、signal-semantics、skill-rollups、metric-semantics、review-semantics）。 |
| `conversation-renderer`、`knowledge-debugger-renderer`、`trajectory-live`、`trajectory-routing` | 已删除。会话列表/详情与任务轨迹只由 `web/app/observe/**` 渲染，`/observe/sessions/:id` 手写调试入口随之退出；轨迹的连线计算保留在 `application/replay/routing.ts`，由 React 直接消费。HTML 宿主不再挂 `/observe`、`/observe/conversations/*`、`/observe/sessions/*`。 |
| `layout`、`report-shell`、`icons`、`inline-markdown` | 上述 HTML 页面的外壳、图标和安全内容渲染。Markdown 解析与纯文本计算位于 application。 |

观测健康四页曾是「没有入口的孤岛」：一级导航三项（`/observe`、`/measure`、`/knowledge`）都是 React，全仓没有任何页面或 CLI/MCP 输出链进这一组，只能手打地址访问。本次按「先给 React 树真实入口 → 迁移 → 删 HTML 渲染层」的顺序收口：`/observe` 列表页顶部的分区导航（`web/components/observe/section-nav.tsx`）指向 `/observe/health`，健康详情再链向单 skill 趋势与批次差异，然后才删除两个 HTML renderer，避免出现「旧渲染层已删、入口仍缺失」的悬空窗口。收件箱刻意不进分区导航：它受宿主开关控制，在 DSH 上是 404，静态链接会承诺宿主未必提供的能力。

剩下的只读报告页（体检详情 `/knowledge/doctors/:id`、受管历史 `/knowledge/managed`）仍不在 Next 的拦截集合里，两个 Next 宿主都回落到 HTML，且同样没有 React 入口，所以「迁 React」还是「退役页面、只留 `/api/*` 事实源」是产品判断，不是渲染层清理；迁移其中任何一页都不会减少渲染层数量，除非同时裁掉对应 HTML 路由，目录名本身不是废弃标记。`/measure` 的双轨已收口：HTML renderer 及其公开渲染导出删除，CLI 评测预览改挂 Next，`oh-my-knowledge/studio` 不再导出任何渲染实现，一级导航可达的页面全部是 React，`presentation/` 只服务上面列出的两页与共享外壳。
