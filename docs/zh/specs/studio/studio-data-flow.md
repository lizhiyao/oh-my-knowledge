# Studio 数据流

本页梳理一条 Studio 请求的完整链路——HTTP 预加载 → AsyncLocalStorage → Next.js 服务端渲染 → 客户端刷新与 SSE——并标明查询、投影、序列化和缓存边界。它同时记录 issue #836 §1.1 的核验结论。

## 链路

Studio 有两个宿主，共享同一应用层：

- **Next.js 宿主（`omk studio`、DSH 插件 `/omk observe`、CLI 评测预览）**：`next-server.ts` 分两种方式接管页面。`/observe` 与对话／收件箱／健康页、`/measure*`、`/knowledge` 与 `/knowledge/skills/*`、`/agents` 由 `http/pages/` 预加载模型，在 Next 流式响应前处理 400／404／503，再通过 `Symbol.for` 桥接的 AsyncLocalStorage 向服务端组件提供请求快照。`/agents` 对缺失或不可读报告呈现页面状态。缺失 store 是装配错误（`studio_context_missing` → 500），区别于数据源不可用。
- **客户端知识页**：`/knowledge/candidates`、`/knowledge/entities` 和 `/knowledge/library` 同样由 Next 接管，但不预加载知识模型；客户端通过 `/api/*` 查询候选、实体、知识库与载体并呈现加载／失败状态。不能把它们说成每请求一份 RSC 知识快照，也不能从页面 200 推定 API 读取成功。
- **宿主开关与未匹配地址**：`observationInbox: false` 关闭收件箱页面和 API；`studioPages: false` 关闭观测／知识页面组。CLI 评测预览只提供 Measure 页面并隐藏一级导航；`/_next/*` 静态资源仍由 Next 服务。未匹配地址交还 HTTP handler，得到纯文本 404；Next 客户端 `not-found` 不替代宿主的预加载错误契约。
- **独立 report-server 宿主**：`request-handler.ts` 每请求解析一次目录选择，经声明式路由表（`routes/router.ts`）分发到 JSON API、SSE、`/health` 与纯文本状态文档。它不渲染任何页面 HTML——最后两页只读报告迁到 Next 后，共享 HTML 渲染层已删除，因此即使 Next 宿主裁掉了页面组，这里也不会有页面地址被服务，那条路径直接 404。Next 宿主包裹的就是这个 handler，未被拦截的路径——包括评测 JSON 投影 `/api/reports`，以及 `GET /`（挂了观测路由组的宿主 302 到 `/observe`，其余给 404）——都由它服务。`studioPages: false` 同时抑制 observations 目录的创建副作用，因此只挂评测页的宿主不会在用户项目里落盘。

## 边界

- **查询**（`application/`）：旧 Skill 报告查询中，`buildSkillIndex` 使用缓存（有界 keyed LRU，容量 8；键包含目录与展示语言，每请求按文件元数据重算指纹）。`listAnalyses` / `loadAnalysis` / `querySkillTrend` 刻意保持无缓存单次全扫。会话目录维护按线程的 rollout 索引文件缓存，按 size + mtime 校验新鲜度。
- **投影**（`view-models/` 与页面装载器）：预加载页面模型从请求快照投影一次——HTML props 与 activity revision 来自同一个内存对象，页面不可能渲染出与自身内容不一致的 revision。
- **序列化**：预加载模型经 RSC 边界传递；客户端知识页独立消费 API；API 返回 JSON 且 `Cache-Control: no-store`。
- **缓存**：见上；不缓存任何渲染后的 HTML。

## 刷新模型

| 界面 | 机制 | 闸门 |
| --- | --- | --- |
| 会话列表 / 详情 | 5 秒轮询 `/api/conversations/*/activity` | sha256 revision，只覆盖**生命周期字段**：线程 id、标题、归档、任务数、运行中任务 id（列表）；标题、逐任务 id/状态/起止时间（详情） |
| 任务轨迹 | SSE `/api/conversations/:thread/tasks/:turn/live` | revision = `sourceSize:mtimeMs:status`；hub 每 750ms 轮询源文件，stat 快路径 |
| Measure 页面 | 无 | 每次加载静态；靠导航刷新 |

revision 闸门意味着只有用户可见的生命周期状态变化时才触发 `router.refresh()`。**增长信号被刻意排除**——工具调用数、事件数和最近活动时间在任务运行期间持续推进，纳入它们会让每轮轮询都重渲染整页。实时跟随由轨迹页承担；列表与详情页只在生命周期跃迁（新任务、状态变化、改名、归档）时刷新。该取舍由 `conversation-activity-server.test.ts`（“without tracking event growth”）锁定。

## 核验结论（#836 §1.1）

1. **每请求一份快照。** Next 预加载页面每请求装载一次模型；独立宿主不加载 HTML 页面模型，revision 从同一对象派生；并发请求经 ALS 隔离（`next-context.test.ts` 覆盖）。
2. **无重复刷新机制。** 这里讨论的对话生命周期轮询与任务轨迹 SSE 各有用途，不能将历史结论泛化为所有页面只能使用一种数据请求。
3. **revision 覆盖。** 轨迹 revision 基于文件 stat，覆盖一切内容变化；列表/详情 revision 覆盖全部生命周期级可见变化（本批补齐标题改名）；增长信号按设计排除，见上。
4. **竞态、取消与清理路径。** 客户端轮询在卸载时中止、`document.hidden` 时跳过、串行化并发请求；SSE 客户端 250ms 防抖刷新，`liveObservable: false` 与 `trajectory-error` 时关闭，并提供重试。服务端 `PollingSubscriptionHub` 每个任务键共享一条顺序轮询循环，终态、出错或最后一个订阅者退订时释放，定时器 unref，`close()` 随服务关闭执行。
5. **失败语义。** 刷新失败保留已渲染数据并给出显式重试（`ActivityNotice`）；装配错误与源不可用分别产出 500/503，符合错误语义批次的契约。

## 已记录的取舍

- 对话列表全量传输、客户端过滤分页（20 条/页）。历史测量仅证明当时实现与数据规模（见[Studio 性能基线](history/studio-performance-baseline.md)），不能直接作为当前 Next 页面或远端托管的容量验收。
- Measure 页面当前没有实时刷新；运行中的评测靠导航重新查看。这是记录在案的决策，不是疏漏。
- 标题改名会触发 revision；增长信号不会。未来若某界面需要在列表/详情页显示实时计数，应显式加入 snapshot 状态，而不是隐式带入。
