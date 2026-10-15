# Studio 数据流

本页梳理一条 Studio 请求的完整链路——HTTP 预加载 → AsyncLocalStorage → Next.js 服务端渲染 → 客户端刷新与 SSE——并标明查询、投影、序列化和缓存边界。

## 链路

Studio 有两个宿主，共享同一应用层：

- **Next.js 宿主（`omk studio`、DSH 插件 `/omk observe`、CLI 评测预览）**：`next-server.ts` 分两种方式接管页面。`/observe` 与对话／收件箱／健康页、`/measure*`、`/knowledge` 与 `/knowledge/skills/*`、`/agents` 由 `http/pages/` 预加载模型，在 Next 流式响应前处理 400／404／503，再通过 `Symbol.for` 桥接的 AsyncLocalStorage 向服务端组件提供请求快照。`/agents` 对缺失或不可读报告呈现页面状态。缺失 store 是装配错误（`studio_context_missing` → 500），区别于数据源不可用。
- **客户端知识页**：`/knowledge/candidates`、`/knowledge/entities` 和 `/knowledge/library` 同样由 Next 接管，但不预加载知识模型；客户端通过 `/api/*` 查询候选、实体、知识库与载体并呈现加载／失败状态。不能把它们说成每请求一份 RSC 知识快照，也不能从页面 200 推定 API 读取成功。
- **宿主开关与未匹配地址**：`observationInbox: false` 关闭收件箱页面和 API；`studioPages: false` 关闭观测／知识页面组。CLI 评测预览只提供 Measure 页面并隐藏一级导航；`/_next/*` 静态资源仍由 Next 服务。未匹配地址交还 HTTP handler，得到纯文本 404；Next 客户端 `not-found` 不替代宿主的预加载错误契约。
- **独立 report-server 宿主**：`request-handler.ts` 每请求解析一次目录选择，经声明式路由表（`routes/router.ts`）分发到 JSON API、SSE、`/health` 与纯文本状态文档。它不渲染页面 HTML；即使 Next 宿主关闭页面组，页面地址也直接返回 404。Next 宿主包裹的就是这个 handler，未被拦截的路径——包括评测 JSON 投影 `/api/reports`，以及 `GET /`（挂了观测路由组的宿主 302 到 `/observe`，其余给 404）——都由它服务。`studioPages: false` 同时抑制 observations 目录的创建副作用，因此只挂评测页的宿主不会在用户项目里落盘。

## 边界

- **请求主机**：监听器在 Next 或 API 分发前校验唯一且格式合法的 `Host`。允许回环主机与显式配置的监听主机名；通配网络绑定同时允许字面 IP 地址，保留局域网访问。其它 DNS 名即使 Origin 与 Host 一致也返回 `403 studio_host_not_trusted`，阻断 DNS rebinding。显式对外暴露仍须使用可信网络；此校验不提供认证。
- **查询**（`application/`）：Skill 报告查询中，`buildSkillIndex` 使用缓存（有界 keyed LRU，容量 8；键包含目录与展示语言，每请求按文件元数据重算指纹）。`listAnalyses` / `loadAnalysis` / `querySkillTrend` 刻意保持无缓存单次全扫。会话目录维护按线程的 rollout 索引文件缓存，按 size + mtime 校验新鲜度。
- **观测证据**：问题模式在调用、会话与 skill 聚合间保留完整去重证据身份和物理会话身份，诊断预览最多显示五条引用和五个近期会话。skill 定义查找使用容量为八组搜索根的 LRU，按已搜索目录重新校验，新增或删除 skill 无需重启即可生效。后台会话索引有两分钟进程截止时间（嵌入方可配置 `indexProcessTimeoutMs`），会终止卡住的进程并释放待处理条目供重试。失败或空输出的软标准提取不落盘、不缓存；历史派生报告保持原样，需从原始 trace 重建，才能应用修正后的结论与计数。
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

## 当前不变量

1. **每请求一份快照。** Next 预加载页面每请求装载一次模型；独立宿主不加载 HTML 页面模型，revision 从同一对象派生；并发请求经 ALS 隔离（`next-context.test.ts` 覆盖）。
2. **无重复刷新机制。** 这里讨论的对话生命周期轮询与任务轨迹 SSE 各有用途，各页面按数据生命周期采用必要的请求机制。
3. **revision 覆盖。** 轨迹 revision 基于文件 stat，覆盖一切内容变化；列表/详情 revision 覆盖全部生命周期级可见变化（包括标题改名）；增长信号按设计排除，见上。
4. **竞态、取消与清理路径。** 客户端轮询在卸载时中止、`document.hidden` 时跳过、串行化并发请求；SSE 客户端 250ms 防抖刷新，`liveObservable: false` 与 `trajectory-error` 时关闭，并提供重试。服务端 `PollingSubscriptionHub` 每个任务键共享一条顺序轮询循环，终态、出错或最后一个订阅者退订时释放，定时器 unref，`close()` 随服务关闭执行。
5. **失败语义。** 刷新失败保留已渲染数据并给出显式重试（`ActivityNotice`）；装配错误与源不可用分别产出 500/503。

## 已记录的取舍

- 对话列表全量传输、客户端过滤分页（20 条/页）；当前 Next 页面与远端托管的容量仍需在对应机器和数据规模下验证。
- Measure 页面当前没有实时刷新；运行中的评测靠导航重新查看。这是记录在案的决策，不是疏漏。
- 标题改名会触发 revision；增长信号不会。未来若某界面需要在列表/详情页显示实时计数，应显式加入 snapshot 状态，而不是隐式带入。
