# Studio 数据流

本页梳理一条 Studio 请求的完整链路——HTTP 预加载 → AsyncLocalStorage → Next.js 服务端渲染 → 客户端刷新与 SSE——并标明查询、投影、序列化和缓存边界。它同时记录 issue #836 §1.1 的核验结论。

## 链路

Studio 有两个宿主，共享同一应用层：

- **Next.js 宿主（`omk studio`、DSH 插件 `/omk observe`）**：`next-server.ts` 拦截 `/observe*`、`/measure*`、`/knowledge*` 的 GET 请求，**每请求恰好装载一次**页面模型（`loadObservePage` / `loadKnowledgePage` / `catalog.list|get`），存入经 `Symbol.for` 桥接的 AsyncLocalStorage（CLI 模块图与 Next 产物解析到同一个 store），随后渲染。服务端组件经 `web/catalog.tsx` 读取快照；store 缺失是装配错误（`studio_context_missing` → 500），不是数据源失败（→ 503）。拦截集合跟随宿主的开关收缩：`observationInbox: false` 摘掉收件箱页面与 API，`studioPages: false` 摘掉整个观测／知识页面组，被摘掉的路径不再拦截，落回 HTTP 适配器得到 404。只读报告页（skill-health、体检、受管历史、趋势与差异）始终不在拦截集合里，由 HTTP 适配器渲染。
- **独立 report-server 宿主（CLI 评测预览）**：`request-handler.ts` 每请求解析一次目录选择，经声明式路由表（`routes/router.ts`）分发到 JSON API 与 HTML 渲染器。该宿主以 `studioPages: false` 只保留 `/measure` 与评测 API/SSE，因此不启动 Next，也不创建 observations 目录。

## 边界

- **查询**（`application/`）：`buildSkillIndex` 是唯一带缓存的查询（有界 keyed LRU，容量 8；每请求按文件元数据重算指纹）。`listAnalyses` / `loadAnalysis` / `querySkillTrend` 刻意保持无缓存单次全扫。会话目录维护按线程的 rollout 索引文件缓存，按 size + mtime 校验新鲜度。
- **投影**（`view-models/` 与页面装载器）：页面模型每请求从同一快照投影一次——HTML props 与 activity revision 来自同一个内存对象，页面不可能渲染出与自身内容不一致的 revision。
- **序列化**：页面模型只经一次 RSC 边界传递；API 返回 JSON 且 `Cache-Control: no-store`。
- **缓存**：见上；不缓存任何渲染后的 HTML。

## 刷新模型

| 界面 | 机制 | 闸门 |
| --- | --- | --- |
| 会话列表 / 详情 | 5 秒轮询 `/api/conversations/*/activity` | sha256 revision，只覆盖**生命周期字段**：线程 id、标题、归档、任务数、运行中任务 id（列表）；标题、逐任务 id/状态/起止时间（详情） |
| 任务轨迹 | SSE `/api/conversations/:thread/tasks/:turn/live` | revision = `sourceSize:mtimeMs:status`；hub 每 750ms 轮询源文件，stat 快路径 |
| Measure 页面 | 无 | 每次加载静态；靠导航刷新 |

revision 闸门意味着只有用户可见的生命周期状态变化时才触发 `router.refresh()`。**增长信号被刻意排除**——工具调用数、事件数和最近活动时间在任务运行期间持续推进，纳入它们会让每轮轮询都重渲染整页。实时跟随由轨迹页承担；列表与详情页只在生命周期跃迁（新任务、状态变化、改名、归档）时刷新。该取舍由 `conversation-activity-server.test.ts`（“without tracking event growth”）锁定。

## 核验结论（#836 §1.1）

1. **每请求一份快照。** 两个宿主都每请求装载一次页面模型，revision 从同一对象派生；并发请求经 ALS 隔离（`next-context.test.ts` 覆盖）。
2. **无重复刷新机制。** 每个页面只使用一条通道（轮询**或** SSE），不存在既轮询又流式的页面。
3. **revision 覆盖。** 轨迹 revision 基于文件 stat，覆盖一切内容变化；列表/详情 revision 覆盖全部生命周期级可见变化（本批补齐标题改名）；增长信号按设计排除，见上。
4. **竞态、取消与清理路径。** 客户端轮询在卸载时中止、`document.hidden` 时跳过、串行化并发请求；SSE 客户端 250ms 防抖刷新，`liveObservable: false` 与 `trajectory-error` 时关闭，并提供重试。服务端 `PollingSubscriptionHub` 每个任务键共享一条顺序轮询循环，终态、出错或最后一个订阅者退订时释放，定时器 unref，`close()` 随服务关闭执行。
5. **失败语义。** 刷新失败保留已渲染数据并给出显式重试（`ActivityNotice`）；装配错误与源不可用分别产出 500/503，符合错误语义批次的契约。

## 已记录的取舍

- 会话列表全量传输、客户端过滤分页（20 条/页）。在已测规模下可接受（见 [Studio 性能基线](/zh/explanation/studio-performance-baseline)）；出现远端托管场景时重估。
- Measure 页面当前没有实时刷新；运行中的评测靠导航重新查看。这是记录在案的决策，不是疏漏。
- 标题改名会触发 revision；增长信号不会。未来若某界面需要在列表/详情页显示实时计数，应显式加入 snapshot 状态，而不是隐式带入。
