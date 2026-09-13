# Evaluation Core Studio 投影

> 状态：已实现。[#535](https://github.com/lizhiyao/oh-my-knowledge/issues/535) 的只读 catalog／view model 边界与 [#537](https://github.com/lizhiyao/oh-my-knowledge/issues/537) 的 renderer／route adapter 已成为生产 Evaluation 视图，只读取通过认证的 Core run。

## 一、权威边界

Studio 只是 Evaluation Core 事实的 consumer，不是第二套报告模型。`CoreRunArtifactStore` 继续负责 schema、digest、content closure 与 lineage 校验。`createCoreStudioCatalog()` 只接收该 store port，不引入文件系统、server 或 renderer 依赖。

catalog 提供三种操作：

- `list()` 只投影已校验的 manifest index card，不加载完整 artifacts；
- `inspect(runId)` 执行同语义的点查询，不声称 content 可用；
- `get(runId)` 必须先加载并校验完整 artifact set，再构建 detail view。

project／global 行为复用 `createOverlayCoreRunArtifactStore()`。同一 `runId` 的相同 artifact set 去重，不同 artifact set 使用现有稳定 overlay conflict code 显式失败。Studio 不另造更宽松的冲突策略。

## 二、版本化视图

`omk.studio-core-run-card/v1` 只包含 manifest 事实：run／report identity、artifact-set digest、创建时间、正交的 run／evidence／conclusion status、replayability 与最高 captured classification。

`omk.studio-core-run-detail/v1` 进一步投影：

- Dataset identity 与 sample count，不包含 Sample input；
- Target、Evaluator、measurement 与 Metric definition，不包含 config；
- stage Bundle identity、直接 parent lineage、显式状态、coverage、replayability、budget aggregate 与脱敏 provenance；
- Execution／Evaluation coordinate identity、状态、duration、安全 usage、cache status 与 error／reason code；
- 只投影数值 Metric observation；boolean、categorical、text 与 ranking value 继续隐藏；
- Analysis identity、output schema version／digest、coverage、exclusion count、assumption status，以及有限 scalar 数值；
- 已注册 Decision 的状态、verdict、reason code 与精确 Analysis result reference；
- manifest 中五份文档的 identity 与完整 document digest，不包含 filename 或 path。

两种 projection 都是 canonical、JSON-safe 且深冻结的值。未定义数值不折算为零，而是直接省略。

## 三、隐私与 construct validity

detail view 明确省略原始 input、execution context、expected、evaluation context、output、trace、evaluator evidence／metadata、Gold、任意 Analysis table、Runtime capability／facet、provenance facet／source identifier、usage details、extension 与 error message。

这是语义 allow-list。后续 renderer 无法把未捕获 evidence 当作空值，也无法泄漏受保护内容，因为这些字段不会跨过 projection 边界。新增 result type 必须建立显式的 schema-specific projection，禁止遍历任意对象直接展示。

视图状态不从分数阈值推导。run status、evidence status 与 conclusion status 保持正交；stage failure、cancel、budget exhaustion、missing observation、inconclusive Analysis 与 not-decided Decision 都保留 Core 原始状态和 reason code。

## 四、展示层与 route adapter

面向用户的 `/measure` 列表与详情是 `web/app/measure/**` 下的 React 服务端组件。它们消费的 `application/core-run-format.ts` 不含展示实现，只把两种版本化 view 变成有序的事实片段：列表把 run、evidence 与 conclusion status 作为三个独立状态轴展示，详情展示 plan identity、阶段 coverage／budget、安全记录与数值 observation、Analysis、Decision 以及完整的五文档 lineage。两者都不从分数推导总体质量状态。

所有投影值都被转义——页面由 React 的文本插值保证，仍存留的 HTML 外壳由显式转义保证——allow-list 之外的字段不会到达任一界面。表格把可见区块名与限定作用域的列标题配对，status group 带无障碍标签；中英文视图承载完全相同的事实，只有 label 被翻译，identifier、digest、status 与 reason code 原样保留。`web/components/measure/**` 是唯一渲染入口，独立 HTML renderer 及其 `CoreStudioRenderRoutes` 注入点已删除。

`createCoreStudioRouteHandler()` 是 `CoreStudioCatalog` 之上的纯 HTTP 形状 adapter，只提供机器可读资源。它返回不可变 response envelope，不依赖 Node request／response object，因此生产 host 可以挂载它，而不必把 server authority 交给 catalog。调用方提供唯一的 `apiBasePath`，整棵子树归它所有：区间外的路径返回 `undefined`，base path 返回 card 列表，单个可解码 segment 解析详情，空段、多余层级与不可解码 identifier 返回稳定 404，不支持的方法返回 405；source failure 只返回脱敏的 `core_studio_source_unavailable`，不暴露 exception text 或 filesystem path。

## 五、迁移边界

Core Studio 模块不导入已删除的旧 `ReportStore`、旧 `EvaluationReport`、`VariantResult` 或结果行。生产 server 直接挂载 Core handler，skill index 消费 Core card，旧 evaluation route 与 renderer 已不存在；没有 legacy reader、adapter、shadow read 或双视图。

这次单向删除属于 `BREAKING-SCHEMA`：旧报告文件不会迁移，也不会读取。本 projection 不改变 evaluator、analysis formula、prompt、missing-data policy 或 verdict 语义，因此不属于 `BREAKING-COMPARABILITY`。

## Studio 应用框架

Studio 的目标技术栈为 Next.js App Router、TypeScript 和 Ant Design。`/measure` 列表与详情在所有宿主上都是 React 组件，包括只挂评测页的 CLI 评测预览宿主——它同样启动 Next，并裁掉兄弟页面组。Observe 的会话列表、详情和实时任务轨迹也由 React 呈现，Knowledge 列表与详情也使用同一 StudioShell 和 Ant Design 组件；报告专属页面保留现有路由。已迁移页面只有一个生效实现，不回退到旧 HTML renderer。

Node 监听器负责 Next 的准备与关闭。服务端组件通过请求级上下文获得现有 `CoreStudioCatalog`，不同 Studio 实例不能串读彼此的数据源。在 HTML 流式响应开始前解析 catalog，以保持 404／503 状态。JSON API 的契约保留；独立 Core 渲染导出随 HTML measure renderer 一并删除，`/measure` 不再有两份实现可能彼此漂移。迁移不修改 Core 产物或测量语义。

`yarn build` 构建应用，并把生产资源复制到 `dist/studio/web`。发布包包含预构建 UI 和运行依赖；`omk studio` 沿用端口与目录参数，不在用户启动时构建前端。构建时关闭框架遥测。框架迁移需要通过隔离包安装、深层路由刷新、真实产物渲染以及监听器／SSE 清理验证。

Studio 的全屏应用原则适用于 Observe、Measure、Knowledge、报告详情及加载／异常页面。Measure 详情按评测范围、分析结果和证据分区；Knowledge 和报告详情固定导航与摘要，将长内容限制在命名的内容面板中。独立挂载的报告保留独立文档布局。Studio 使用占满视口的应用布局，一级导航固定，页面根节点不横向或纵向滚动；长列表、详情和时间轴仅在各自内容区域滚动。任务头部紧凑展示，四条泳道按剩余高度自适应，卡片与连线同步重排。表格为操作和数量保留明确列宽，长标题与路径省略展示并保留完整内容入口。

三个状态轴继续独立呈现。Ant Design 提供交互与视觉基础组件，状态、证据可用性和结论仍由领域代码定义。Observe 默认保留对话、执行、结果、知识四条泳道及时间轴、关联连线、卡片详情与实时跟随，复用现有泳道投影和避障路由，不用列表替代泳道。Observe 复用会话与任务轨迹投影，页面只接收选定任务的数据，不序列化整个源会话。列表通过轻量活动版本检查更新，任务通过现有 SSE 通知刷新，组件卸载时释放订阅和请求。原始记录按需加载，知识访问证据不表示因果关系。报告专属页面和受管决策史保留现有渲染入口。
