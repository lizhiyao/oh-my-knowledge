# Studio 代码导航

Studio 将观测记录和评测产物呈现给用户，不定义评分口径，也不修改原始证据。

| 目录 | 职责 |
| --- | --- |
| `view-models/` | 跨层共享的类型契约，不含运行时计算。 |
| `application/` | 查询、聚合和视图投影。`replay/` 分开投影装配、卡片布局、操作摘要、时间格式和连线计算。 |
| `http/` | 请求、响应、路由和服务生命周期。`app-host.ts` 定义应用宿主接口，不生成 HTML。 |
| `web/` | Next.js 应用。`components/observe`、`measure`、`knowledge`、`inbox` 按功能组织，`components/layout` 放共享外壳和主题。 |
| `index.ts` | Studio 模块聚合入口，导出 catalog、投影、view-model 与 JSON 路由。渲染实现不属于公开面，内部模块也直接引用所属层，不经过公开聚合入口。 |

原 `core-runs/` 已按职责归入上述目录；文件名中的 `core-run` 表示消费 Evaluation Core 产物，不表示 Studio 属于 eval-core。

## 两类页面宿主

CLI `studio`、DSH 插件 `/omk observe` 与 CLI 评测预览使用 `createNextStudioServer`。所有页面都由 Next 渲染：Observe 的会话与任务页、观测收件箱、观测健康四页、Measure、Knowledge 的列表／详情与受管决策史两页。HTTP adapter 只提供 `/api/*` 的 JSON 事实源、SSE 和缺页／错误文档，不再挂任何页面路由。Next 宿主只接管宿主已注册的路由组：被 `observationInbox`／`studioPages` 裁掉的组不再拦截，落回 HTTP adapter 得到 404，而不是改渲染一套手写页面。同一个 `studioPages` 开关也裁掉 `web/components/layout/shell` 的一级导航——不挂页面组的宿主没有可去的兄弟路由，渲染导航等于把用户导向 404。

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

## 知识分区页面盘点（React）

`/knowledge` 顶部分区导航（`web/components/knowledge/section-nav.tsx`）给两个入口：知识对象（体检 + 生产观测的聚合）与受管决策史。两者此前都是没有入边的孤岛，只能手打地址访问；补真实入口之后才删除对应的 HTML 渲染层，避免出现「旧渲染层已删、入口仍缺失」的悬空窗口。同一做法用于观测健康四页（`web/components/observe/section-nav.tsx` 指向 `/observe/health`）。收件箱刻意不进任何分区导航：它受宿主开关控制，在 DSH 上是 404，静态链接会承诺宿主未必提供的能力。

| 页面 | 组件 | 数据来源 |
| --- | --- | --- |
| 受管列表 `/knowledge/managed` | `web/components/knowledge/managed.tsx` | `http/managed-page.ts` → `application/managed-format.ts` 的 `projectManagedListRow` |
| 决策史 `/knowledge/managed/:id` | 同上（`pageKind: 'detail'`） | `projectManagedTimeline` 的版本分段与事件行 |
| 体检详情（原独立页） | `web/components/knowledge/knowledge.tsx` 的体检面板 | `application/doctor-format.ts` 的 `projectDoctorRules`／`projectDoctorSampling` |

受管根目录按请求解析，不在启动时冻结，否则长会话里会跟 `omk list` 分叉（口径见 `http/managed-root.ts`）；JSON 路由 `/api/managed` 与页面宿主共用同一解析器。记录的 `source.locator`／`url` 是用户机器上的绝对路径，不进页面模型——RSC 会把 props 序列化进页面负载。

### 知识分区相对历史 HTML 版的显式减法

- `/knowledge/doctors/:id` 独立体检页退役，无替代 URL：它的独有信息（逐条 finding 与修复建议、多采样 `k/n` 支持度、采样降级告警、跨轮次体检历史与 `?doctorRun=` 下钻）全部并进了 skill 详情的体检面板。全仓没有任何页面、CLI 或 MCP 输出链向该地址。
- 受管页的时间显示从服务端本地时区改为显式 UTC 标注。同一时刻在两种宿主下读出不同墙上时间是原页面的缺陷，跨机器对账证据时尤其危险，因此不做兼容。
- 体检面板顶部的通过／警告／失败计数沿用报告自带的 `passCount`／`warnCount`／`failCount`，它们把信息性的 `:_summary` 也计入，因此该轮 `_summary` 仅为信息性（pass／warn）时列表会比规则项多一项——与列表页「健康体检」列同一份数，不改评分口径；`_summary` 自己失败时（全部采样解析失败，它是这一轮唯一的失败记录）它会作为失败规则出现在列表里，页面不会既报红又宣称「所有规则通过」。以上口径由测试显式钉住。

## HTML 渲染层的终点

`src/studio/presentation/` 已随本批删除：最后两页只读报告（体检详情、受管历史）迁到 Next，共享外壳 `layout.ts`／`report-shell.ts`／`icons.ts` 与 `view-models/report-context.ts` 一并退出，因为 React 侧由 `web/components/layout/shell` 与 antd 提供外壳和图标。Studio 自此只有一份页面实现，Markdown 解析与纯文本计算留在 `application/`，`http/` 层不再产出页面 HTML。

旧外壳的 `#lang-toggle`（一键切中英文并保留当前 path／query／hash）随外壳删除，Next 壳层未提供等价控件：站内语言由 `?lang=en` 与站点导航决定，页内跳转自行继承该参数。补齐它需要壳层的当前路径感知，属于全站（含此前已迁移的观测、评测页面）共同缺失的能力，不随本批只做局部兼容层。
