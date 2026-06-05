<!--
title: 统计严谨性 — Bootstrap CI / Krippendorff α / 长度去偏 / 饱和曲线
description: 为什么 omk 的评测结果可被审计而不是声称严谨。无分布假设的置信区间、评委 ↔ 人工一致性、长度去偏判分、饱和曲线 —— Bootstrap CI / 长度去偏 / 饱和曲线默认开，Krippendorff α 提供 gold 集即自动计算。
-->

# 统计严谨性

omk 要回答的问题是 **"你给 LLM 的知识，价值在哪里？"** —— 用客观数据，不靠凭感觉。LLM 评测最常踩的坑是 **"自信的偏差"** —— CI 很窄但结论错。omk 带四件事让结论可被外部审计：Bootstrap CI / 长度去偏 / 饱和曲线默认开，Krippendorff α 提供 gold 集即自动计算。

本页是深度参考。README 顶部的 callout 是入口，公式 / flag / 设计动机来这里查。

## 1. Bootstrap CI(`--bootstrap`)

**不假设分布的置信区间。**

t 检验在 LLM 序数评分（Likert 类离散桶，不是正态分布的连续值）上失效。Bootstrap 直接重采样原始观测值，对小 N(< 30)和偏态分布都稳。

- **每个 variant 的均值 CI** —— 有放回重采样 N 次（默认 1000）
- **两个 variant 之间的 pairwise diff CI** —— 重采样后的均值差；如果 CI 不跨 0，差异在选定 α（默认 0.05 → 95% CI）显著
- **输出**：每个 `VariantResult.bootstrapCI` 含均值跟 pairwise 的 `[lo, hi]`；HTML 报告画 CI 带状区域；CLI `omk eval` 在六档 verdict 逻辑里消费这些 CI

**参考**：Efron & Tibshirani (1993), "An Introduction to the Bootstrap"。omk 实现：`src/eval-core/bootstrap.ts` —— 公式由 `test/eval-core/bootstrap.test.ts` 覆盖，文档里的默认值（重采样次数、α）由 `test/scripts/doc-constants-drift.test.ts` 与代码常量保持同步。

## 2. Human Gold + Krippendorff α(`--gold-dir`)

**评委 ↔ 人工一致性，外部锚定。**

CI 告诉你"评委在重采样里稳不稳"。α 告诉你"评委跟人工标准对不对"。两个互补维度：

- **稳定 + α 低** = 评委稳定地错（系统性偏差）
- **不稳定 + α 高** = 评委平均跟人工一致但波动大
- **稳定 + α 高** = 这个 rubric 下评委可信
- **不稳定 + α 低** = 评委坏了

omk 自动检测 gold-judge 同源污染：如果 gold annotator 跟评委是同一个模型（比如都是 `claude-3.5-sonnet`），α 会被抬高（两者共享偏差）。omk 警告 + 报告调整后的 α。

**公式**：标准 Krippendorff α + 序数距离度量。实现：`src/grading/human-gold.ts`。输入：`<gold-dir>/<sample_id>.json` per-用例每维度的人工评分。

## 3. 长度去偏的评委 prompt（默认开启）

**研究证实 LLM 评委隐性偏向更长的回答。** 越长分越高，跟质量无关。omk 的评委 prompt 显式声明"长度不是质量信号"+ chain-of-thought + 长度归一化启发式。

- Template hash `v3-cot-length` —— 旧报告用 `v2-cot`（去偏前），报告 hash 肉眼可辨
- 报告元数据记录评委 prompt hash 和长度去偏设置；需要专门审计长度偏差时，用带 / 不带 `--no-debias-length` 的两份报告做对照
- `--no-debias-length` 给研究 / 复现场景留 opt-out 口子
- 参考：Saito et al. (2023), "Verbosity Bias in Preference Labeling by Large Language Models"

**冻结**：`test/grading/judge-hash-frozen.test.ts` 字节级 hash 冻结，防版本间 prompt 悄悄漂移。

## 4. 饱和曲线

**回答"我跑够样本了吗"。**

`--repeat ≥ 5` 时，omk 累积 N → bootstrap CI 序列。当 CI 宽度衰减率 < 5% 持续 3 个窗口，评测**饱和** —— 再多样本对结论无实质收益，额外的成本是浪费。

- HTML 报告内联 SVG 饱和曲线 + verdict 标签
- `omk eval` 把饱和度作为六档 verdict 逻辑的输入之一
- 默认窗口大小：3 个连续测量；阈值：CI 宽度相对衰减 5%
- 参考：omk 自有设计，不是已发表方法。实现：`src/eval-core/saturation.ts`

## 四件事一起看

每件事守住一个不同的失败模式：

| 失败模式 | 守口 |
|---|---|
| "v2 看着更好但其实在误差范围内" | Bootstrap CI（pairwise diff CI 不跨 0） |
| "评委说 v2 更好但我不信评委" | Krippendorff α（评委 ↔ 人工） |
| "评委偏向冗长的回答" | 长度去偏的评委 prompt |
| "我跑了 10 个用例就停了 —— 够吗？" | 饱和曲线 |

少一件，洞就出来。Bootstrap CI / 长度去偏 / 饱和曲线默认开（长度去偏可为研究复现 opt out，其余无条件）；Krippendorff α 在你提供 gold 集（`--gold-dir`）后自动开启。

## 用例隔离（`--strict-baseline`，默认开）

跟上面四件并列、但也是默认开的第五件：

baseline 拿到的 prompt **不应**包含被测 skill。omk 切断三条污染路径，防止 baseline 偷偷看到对照组的 skill：

1. SDK skill auto-discovery
2. subagent Skill 工具
3. cwd 文件系统（顺 `skills/<name>/` symlink 直接 Read 到 SKILL.md）

`eval.yaml` 的 `allowedSkills` 支持 per-variant 白名单给高级场景。没有隔离时，任何"v2 比 baseline 好"的结论都可疑 —— baseline 可能通过这三条路径之一已经看到 v2 的 SKILL.md。

详见：[docs/zh/specs/sample-design-spec.md](../specs/sample-design-spec.md) 的相关用例设计。

---

## 可复现 / 审计追溯

每份报告携带：
- omk 版本(`reportMeta.cliVersion`)
- Node 版本(`reportMeta.nodeVersion`)
- 评委模型 + hash(`reportMeta.judgeModel` / `reportMeta.judgePromptHash`)
- Executor runtime 指纹(`reportMeta.executorRuntime` / `reportMeta.judgeRuntime`)
- 用例指纹(`reportMeta.sampleHashes`)
- skill 隔离快照(`reportMeta.skillIsolation`)
- Schema 版本(`reportMeta.schemaVersion`)

跨版本可比性由 [GitHub Releases](https://github.com/lizhiyao/oh-my-knowledge/releases) 中的 `BREAKING-COMPARABILITY` callout 强制 —— 测量学不变量改了，你能看到。
