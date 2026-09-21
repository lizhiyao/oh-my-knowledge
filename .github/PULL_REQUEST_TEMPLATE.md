<!--
Before opening a PR, read AGENTS.md, CONTRIBUTING.md, and CODE_REVIEW.md.
Write conclusions and evidence, not a restatement of the diff. Remove instructional
comments, but keep every heading; use "无" when a section does not apply.
打开 PR 前先读 AGENTS.md、CONTRIBUTING.md 与 CODE_REVIEW.md。写结论与证据，不要复述 diff。
保留每个小节标题，删掉说明性注释；某一节不适用时写「无」。
-->

## 用户影响 / User impact

<!-- 解决什么用户问题？可链接 issue，例如 Closes #123。 / Which user problem does this solve? Link an issue, e.g. Closes #123. -->

## 迁移／兼容决策 / Migration and compatibility decisions

<!-- 是否需要迁移？是否保留兼容？说明明确决策，不要默认添加 shim。 / Is a migration needed? Is compatibility kept? State the decision; do not add shims by default. -->

## 测量学影响 / Measurement impact

<!-- 是否影响 construct validity、Schema identity、评分、统计、prompt 或报告可比性？ / Does it change construct validity, schema identity, scoring, statistics, prompts or report comparability? -->

## 自主 CR / Autonomous review

<!-- 风险等级、已审查的高风险面、finding 处理情况与最终结论。不要用复选框代替证据。 / Risk tier, high-risk surfaces reviewed, finding disposition and the conclusion. Do not replace evidence with checkboxes. -->

## 验证 / Verification

<!-- 定向验证、与风险档位相称的那一层本地门禁（`ci:quick` 或完整 `yarn ci`），以及与风险匹配的真实用户路径／clean-room／UI 验收证据。 / Targeted checks, the local gate that matches the risk tier (`ci:quick` or full `yarn ci`), and real user-entrypoint / clean-room / UI evidence. -->

## 未解决风险 / Open risks

<!-- 已接受的 P3、外部阻塞或 follow-up；没有则写「无」。 / Accepted P3s, external blockers or follow-ups; write "无" when there are none. -->
