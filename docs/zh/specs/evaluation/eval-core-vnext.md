# Evaluation Core 测量契约

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
