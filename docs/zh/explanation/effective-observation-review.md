# 有效观测审阅视图

收件箱分别保留原始报告与人工审阅状态。有效审阅是读取时生成的派生视图，不替换持久化原始报告，也不把观测线索当作 skill 的因果评测结论。

## 共享视图

`omk observe inbox --json` 在原有 `items` 数组之外提供 `effectiveExperienceReports`、`resolvedReviewSessions` 和 `unappliedMetricAnnotations`。`GET /api/observe-inbox/view` 提供同样三个字段，两者均支持按 skill 筛选。原有 `GET /api/observe-inbox` 的条目列表响应保持不变。Studio 消费同一领域投影。

有效会话指标、依据代码、规则发现、辅助推断、优先级和 skill 汇总由 observability 负责，不由 HTML renderer 定义。确定性优先级使用领域加权分数：至少三分为 `review_first`，大于零且不足三分为 `sample_review`，零分为 `routine_sample`。领域审阅发现可以进一步提升优先级。既有显式 LLM 与人工审阅优先关系保留，来源通过 `resolvedReviewSessions.source` 表达。

## 证据与标注

规范化反馈归因决定反馈属于哪个 skill，并包含允许归入的下游反馈。人工反对的反馈不计入有效数量。存在完整归属事件关系时，其余指标标注基于这些证据应用，而不是从预览窗口推算总量。

预览截断或缺失不代表发生次数为零。能够定位标注、但无法使用完整证据安全重放时，保留已存指标，并在 `unappliedMetricAnnotations` 中记录对应会话的指标键。这表示证据限制，不表示该标注已经改变总数。

收件箱 ViewModel 中的原始 `reports`、原始 `experienceReports`、原始轨迹证据与审阅状态仍各自保留。不要将 `effectiveExperienceReports` 覆盖写回原始报告。此投影不改变公开测量 Schema、prompt 字节或持久化统计结果。
