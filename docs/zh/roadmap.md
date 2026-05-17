# OMK 下一阶段路线图笔记

> [!NOTE]
> 本文是 planning note，记录 2026-05-03 时点对项目方向的判断。
> **不是 release 承诺，也不替代 issue / PR 的具体设计**。
> 任何 minor 版本到来前内容可能已过时——请以最近的 PR 标题、release notes 为准。
> 本 roadmap 至少每个 minor 版本回顾一次；如果 git 最近修改时间 > 60 天，大概率已过时。

日期： 2026-05-03

## 核心判断

OMK 下一步不应继续横向堆 metric，而应做“可信评测产品化”：把现有统计严谨性、知识输入定位、Claude / Codex agent 工作流变成低摩擦、可复现、可审计的一条主路径。

当前优势：

- 统计严谨性默认开启：Bootstrap CI、Krippendorff alpha、长度去偏、饱和曲线。
- artifact 隔离和 construct validity 是差异化能力，尤其适合 skill / prompt / RAG / agent workflow。
- 多执行器和多评委已经具备基础：Claude、Codex、OpenAI、Gemini、自定义命令。
- 中文体验和中文文档是明确差异化点。

当前短板：

- 真实用户闭环还弱：生产 session / trace 到 eval dataset 的路径不够顺滑。
- 首次上手路径偏工程化：能力很多，但用户第一份可信报告的路径还不够短。
- warning / fatal / progress noise 的语义区分还不够清楚，容易影响调试判断。
- 安全 / red-team 与生产 trace 回流还没有形成产品化主线。
- distribution / community 维度不足：当前真实外部 visitor、star、issue、fork 都很少。单纯继续做产品功能无法自动解决 awareness 问题。

## 近期使用信号

- npm 下载在 2026-04-23 后明显抬升，最近一周约 779 downloads。
- GitHub 近两周 traffic 显示有 clone 和浏览行为，但 star / issue / discussion 还很少。
- 近期 PR 集中在 `omk doctor`、`eval.yaml v0.2 / judgeModels`、release flow、README 定位、测试维护性。
- 实际协作暴露出的用户摩擦包括：
  - agent 容易忘记项目工作流和分支规则。
  - 预期内 warning / fatal 会被误认为测试失败风险。
  - 测试数量变化需要解释，否则容易被误读为覆盖下降。
  - Codex / Claude Code 的入口和职责边界需要持续清晰化。

这些信号说明 OMK 当前更像“早期高频验证 + 自动化使用”阶段，还没有形成稳定外部社区反馈循环。

## 成功标准

这份 roadmap 不是 release 承诺，但每个阶段都需要复盘锚点。下面数字是 planning anchor，后续可以按真实数据修正。

项目级指标：

- GitHub：stars 从 1 增长到 25+；至少 3 个外部 issue / discussion；至少 1 个外部 PR 或明确外部用户案例。
- npm：weekly downloads 从约 779 增长到 1500+。
- 首次成功路径：新用户从 `omk init` 到第一份 HTML report 的中位时间低于 5 分钟。
- 社区反馈：至少 3 个非作者团队实际跑过 `omk eval` 并反馈问题。

功能成功指标：

- v0.26：新模板项目在干净环境中 `init -> dry-run -> run -> report` 成功率接近 100%；doctor 输出的问题可直接行动。
- v0.27：至少 10 条真实 session / trace 能自动转成 eval sample 草稿；trace adapter 遇到未知 vendor schema 时降级而不是崩溃。
- v0.28：MVP 只覆盖知识 artifact 相关安全面，能跑出安全 verdict 和可复现 case，不追求通用 red-team 覆盖。
- v0.29：报告可以一键导出 PR / CI / 审计材料，并被至少 1 个真实 PR 流程使用。

## 行业方向

行业趋势和 OMK 的关系：

- LangSmith 的主线是 offline eval + online eval + production trace 反馈闭环。OMK 已有 session observability，下一步应把真实失败 trace 回流到 offline eval 做顺。
- DeepEval 强调 pytest 风格、本地优先、50+ metrics、component-level tracing。OMK 不应追 metric 数量，但需要把 agent / tool trace 的组件级定位做得更直接。
- Promptfoo / OpenAI Frontier 方向表明 red-team、安全、合规、traceability 已经是企业 agent eval 的核心诉求。OMK 可以做知识 artifact 语境下的安全评测，但不必复刻完整 red-team 平台。
- Ragas 已经覆盖 RAG / agent / tool / SQL / 通用 metric。OMK 更适合互操作和报告整合，不应重复造完整专项 metric zoo。
- Inspect AI 的强项是 agent eval + sandbox + 外部 agent。OMK 可以兼容其产物，但短期不应投入大型 sandbox。
- NIST / MLCommons AILuminate / HELM 都在强化多维、标准化、透明、可审计评测。这与 OMK 的统计严谨性护城河一致。

## 并行 distribution / community stream

这个 stream 不绑定具体 minor 版本，应与 v0.26-v0.29 并行推进。原因：当前 OMK 更缺真实用户和外部反馈，不是只缺产品功能。

低成本高 ROI 动作：

- 写 1 篇长文：主题聚焦“为什么 prompt / RAG / skill / agent 需要可信评测，不是凭感觉上线”。
- 做 1-2 个 demo video：5 分钟从 `omk init` 到 report；另一个展示 trace 回流 eval dataset。
- 内部推广 3 个真实团队或项目，收集失败路径和术语误解。
- 在 dev.to / 掘金 / GitHub Discussions 发布中文和英文短版。
- 给 awesome-llm-eval / awesome-ai-agents 等列表提 PR，把 OMK 加进去。
- 把 `assets/screenshots` 和 README 首屏调整成可传播材料，避免只有技术细节没有第一眼价值。

distribution 成功标准：

- 每月至少 1 个外部渠道发布。
- 每月至少 3 个真实用户访谈或异步反馈。
- 每个 minor 版本至少 1 个 demo artifact / report 可公开展示。
- 每次发布后记录 npm downloads、GitHub views/clones、stars、issues 的变化。

## 时间节奏和风险

建议节奏：

- v0.26：2-3 周，偏产品打磨和文案。
- v0.27：3-5 周，取决于 Claude / Codex session schema 稳定性。
- v0.28：4-6 周，必须限制为 MVP，否则会滑向完整 red-team 平台。
- v0.29：2-4 周，偏导出、报告和 CI 集成。

主要风险：

- vendor trace schema 改动会拖累 v0.27。需要 schema-version-aware adapter，未知字段保留、未知版本降级、输出明确 warning。
- v0.28 容易被低估。prompt injection、RAG poisoning、tool misuse 都是完整领域，OMK 只做知识 artifact 语境下的最小闭环。
- distribution 如果不并行推进，即使 v0.26-v0.29 全做完，仍可能只有很少外部用户。

## 分阶段计划

### v0.26：首次成功路径

目标：用户从安装到第一份可信报告不掉坑。

优先事项：

- `omk init` 增加更明确模板：`skill` / `prompt` / `rag` / `agent`。
- `omk doctor` 输出更可操作的 fix hints，并补强 `doctor --json` 给 agent / CI 使用。
- 把预期内 progress noise、warning、fatal 区分清楚，避免用户把预期噪声误读为真实失败。
- 修正 report server 在受限环境下 `listen(0)` 被拒时误报 `port 0 is already in use` 的错误文案。
- 压缩 README 首屏信息密度，把“5 分钟得到可信报告”变成唯一主线。
- 成功标准：`init -> dry-run -> run -> report` 中位时间低于 5 分钟；npm weekly downloads 达到 1500+；新增至少 3 条外部 issue / discussion / 用户反馈。

### v0.27：production trace 到 eval dataset 闭环

目标：把 OMK 从离线评测工具推进到“真实使用问题回流评测”的工具。

优先事项：

- 抽出 schema-version-aware trace adapter：Claude / Codex / future vendor trace 都先归一到 OMK 内部 trace schema。
- `omk observe sessions` 输出候选失败样本。
- `omk sample --from-traces` 把真实失败 trace 转成 eval sample 草稿。
- 报告展示“本次 eval 覆盖了哪些真实使用缺口”。
- 对 Claude Code / Codex trace 做更清晰的 tool trajectory 诊断。
- 成功标准：至少 10 条真实 trace 能自动生成 sample 草稿；未知 vendor trace 字段不导致崩溃；至少 1 个真实问题通过 trace 回流后被 eval 防回归。

### v0.28：安全与知识污染专项

目标：承接行业 red-team 趋势，但保持 OMK 的知识 artifact 定位。

范围约束：

- 只做 knowledge-artifact profile，不做通用 red-team 平台。
- 只覆盖 5 类 MVP 风险：prompt injection、skill leakage、RAG poisoning、tool misuse、baseline contamination。
- 每类先做少量高质量固定用例 + 可解释 verdict，不追求攻击库规模。
- 对外部 red-team 工具优先做 import / report integration，不复刻其攻击生成能力。

优先事项：

- 增加 red-team 入口（命名待定，候选：`omk redteam --profile knowledge-artifact`）。
- 覆盖 prompt injection、skill leakage、RAG poisoning、tool misuse、baseline contamination。
- 输出独立安全维度 verdict，不混入综合质量分。
- 支持导入 promptfoo / Inspect 结果，整合到 OMK 报告。
- 成功标准：每类 MVP 风险至少 3 条可复现用例；安全 verdict 可独立导出；至少 1 个外部工具结果能被导入 OMK 报告。

### v0.29：可信报告包

目标：让团队能把报告用于 code review、事故复盘、release notes 和审计。

优先事项：

- 报告 emission 能力（github-summary / junit / sarif / markdown）：`omk export` 已下线，需要重新设计入口（候选：`eval --emit <fmt>` 跑时直接吐 / studio 加下载入口 / `report` 顶层重启）。
- 报告增加“审计摘要”：样本数、CI、judge hash、human alpha、dataset version、artifact hash、已知 caveat。
- Release notes 自动提示 `BREAKING-COMPARABILITY` 和测量不变量变化。
- 生成可直接贴到 PR 的中文摘要。
- 成功标准：GitHub summary / markdown 至少被 1 个真实 PR 使用；CI/JUnit/SARIF 至少能在 GitHub Actions 中消费；审计摘要包含所有测量学不变量和 caveat。

## 暂缓事项

短期不建议投入：

- SaaS dashboard。
- 大而全 metric zoo。
- 通用模型 leaderboard。
- 复杂 Docker / Kubernetes sandbox。
- 过早做插件市场。

这些方向会分散 OMK 的核心定位。短期应优先强化可信、低摩擦、真实使用闭环。

---

## 修订记录

- 2026-05-03 v1：初稿，六段（核心判断 / 短板 / 信号 / 行业方向 / 分阶段 / 暂缓）。
- 2026-05-03 v2：加成功标准量化 / 并行 distribution stream / 时间节奏与风险 / v0.28 范围约束 / 每个 minor 版本独立成功标准。

如果你打算更新本文档，建议保留 git history 而非整段 rewrite——后人需要从 history 看判断是怎么演化的。
