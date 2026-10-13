# Evaluation Core 测量契约 {#evaluation-core-vnext-rfc}

本文说明当前 Core 的职责、不变量和阶段产物；精确 API 与 wire Schema 以[Core API](../../reference/integration/embedded-api.md)及包导出的 Schema resolver 为准。普通 Node 调用者先读[服务评测入门](../../guides/integration/eval-runtime.md)。

## 1. 输入与职责 {#current-input}

Core 是 Node 侧的确定性测量内核，依赖 Node 运行时，不依赖 CLI、文件系统、网络、环境变量、Studio 或具体执行器。声明用 JSON 表达测量意图，函数、客户端和资源由宿主提供。

Definition 声明 Dataset、Target、Evaluator、Metric、实验、分析及 Decision；MeasurementPolicy 声明并发、重试、预算、缺失证据与事件投递等条件。Runtime binding 将声明关联到实际 port、identity 和能力。

## 2. 封存与四阶段 {#current-stages}

准备阶段验证 Schema、引用、能力、实际 Runtime identity 和 policy；在首个外部调用前封存 SealedRunPlan。宿主不能跳过此边界或伪造第二份 plan。

| 阶段 | 产物与职责 |
|---|---|
| Execution | 执行 Target，保存实际输出、状态、来源及声明证据 |
| Evaluation | 用绑定的 Evaluator 消费允许的执行证据，产生具名 Metric observations |
| Analysis | 按封存的分析图、采样单位和缺失策略派生统计结果 |
| Decision | 按已注册 policy 消费分析证据，产生有范围的结论 |

Report 是上述产物的物化视图，事件只提供生命周期通知。调用失败、缺失证据与否定结果不混为成功或零分。

## 3. 身份、复用与重算 {#current-identity}

完整 Dataset revision 与执行／评估／分析投影有独立摘要。摘要证明内容身份，不证明实际来源、可复现性或任务收益。阶段复用验证 plan、来源信任、Runtime identity 与 parent lineage；不是发现一个同名缓存就直接读取。

下游调整只允许在充分执行证据、相应新封存设计及验证边界内重算。事后调整保留身份和来源关系，不覆盖原结果，也不能伪装为预注册的发布结论。

## 4. 证据与结论 {#current-conclusions}

金标与评分期望按投影边界隔离，不交给 Target。观测、统计、诊断、发布决定各自拥有职责，不用 UI 展示或来源记录替代因果证据。

一次 Run 不拥有跨独立运行的稳定性证据。独立 Series 的分析与决定另有封存设计。评分公式、冻结 prompt、Schema identity 或持久化变化须显式版本化，不能静默改变历史可比性。

## 5. 宿主与资源 {#current-runtime}

具体调用、资源租约、证据存储及页面呈现在 Core 外装配。长期 registry、客户端、cache 和 store 由宿主持有；各 run 的阶段资源按生命周期释放，取消时等待清理，不提前关闭别的 run。

产品接线依次见[输入编译](cli-evaluation-input-compilation.md)、[Runtime Adapter](evaluation-runtime-adapter.md)、[产物持久化](evaluation-artifact-persistence.md)和[Studio 投影](evaluation-studio-projection.md)。用户操作见[评测指南](../../guides/evaluation/index.md)。

## 6. 历史决策 {#current-history}

原 vNext RFC、迁移背景、类型草图和后续 ADR 保存在[架构决策历史](history/eval-core-vnext-design.md)。本文不复制历史接口或固定一份会过时的 wire 版本清单。

<!-- 保留旧章节链接；历史内容在上述归档页。 -->
<a id="一、摘要"></a>
<a id="二、问题"></a>
<a id="三、目标与非目标"></a>
<a id="目标"></a>
<a id="非目标"></a>
<a id="四、设计原则与测量不变量"></a>
<a id="_1-先定义-estimand-再执行任务"></a>
<a id="_2-统一接口不等于统一分数"></a>
<a id="_3-缺失不是零"></a>
<a id="_4-缓存不是新试验"></a>
<a id="_5-可比性是显式关系"></a>
<a id="_6-标准兼容-不被标准绑架"></a>
<a id="五、领域模型"></a>
<a id="_1-definition"></a>
<a id="_2-dataset-与用例投影"></a>
<a id="_3-target-与-runtime-capability"></a>
<a id="_4-experimentdesign-与-samplingdesign"></a>
<a id="_5-evaluator、metric、reducer-与-decisionpolicy"></a>
<a id="六、计划、bundle-与-report"></a>
<a id="_1-sealed-runplan"></a>
<a id="_2-executionbundle"></a>
<a id="_3-evaluationbundle"></a>
<a id="_4-analysisbundle"></a>
<a id="_5-evaluationreport"></a>
<a id="_6-replayability"></a>
<a id="七、身份、规范化与可比性"></a>
<a id="_1-adr-在不变测量系统下比较显式声明的研究对象"></a>
<a id="_2-policy-与-assessment-契约"></a>
<a id="_3-scope-投影"></a>
<a id="_4-status-推导与-fail-closed-规则"></a>
<a id="_5-影响与否决方案"></a>
<a id="八、运行时、资源与取消"></a>
<a id="九、event-语义"></a>
<a id="十、错误与失败"></a>
<a id="十一、内容、安全与隐私"></a>
<a id="十一-一-adr-v1-evidencepolicy-不承载-dataset-input"></a>
<a id="十二、公共-api-草案"></a>
<a id="十三、conformance-与验证"></a>
<a id="十四、被否决的方案"></a>
<a id="_1-在现有-runevaluation-上继续加-options"></a>
<a id="_2-只保留一个-report-重评分时从-report-取数据"></a>
<a id="_3-把-event-log-当作唯一事实源"></a>
<a id="_4-所有-metric-统一到-0–1-并默认平均"></a>
<a id="_5-所有-target-使用一个不断增长的-capability-列表"></a>
<a id="_6-透明复用所有-execution-cache"></a>
<a id="_7-在-core-内实现数据库、队列和-checkpoint"></a>
<a id="十五、交付顺序"></a>
<a id="十六、rfc-决议记录"></a>
<a id="十七、contracts-v1-实现基线"></a>
<a id="十八、evaluation-runtime-v1-实现基线"></a>
<a id="十九、analysis-与-decision-runtime-v1-实现基线"></a>
<a id="二十、conformance-v1-实现基线"></a>
<a id="二十一、分析-cohort、评委重复测量与-evaluation-series"></a>
<a id="_21-1-analysis-only-sample-投影"></a>
<a id="_21-2-评委测量-identity"></a>
<a id="_21-3-evaluation-series"></a>
<a id="二十二、共享-run-预算契约与权威账本"></a>
<a id="二十三、sample-scoped-execution-control"></a>
<a id="二十四、adr-通过-prepared-capability-发布分阶段执行"></a>
<a id="二十五、行业参考"></a>
<a id="相关文档"></a>
