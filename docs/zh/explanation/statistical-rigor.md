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
- **默认可复现**：CI 用固定内部种子，同一份 eval 跑两次得到逐字节相同的 CI、verdict 稳定 —— 临界点上 `significant` 不会 run-to-run 来回翻（非确定性 CI 会悄悄把 ship/no-ship 结论翻面）

**参考**：Efron & Tibshirani (1993), "An Introduction to the Bootstrap"。omk 实现：`src/eval-core/bootstrap.ts` —— 公式由 `test/eval-core/bootstrap.test.ts` 覆盖，文档里的默认值（重采样次数、α）由 `test/scripts/doc-constants-drift.test.ts` 与代码常量保持同步。

## 2. Human Gold + Krippendorff α(`--gold-dir`)

**评委 ↔ 人工一致性，外部锚定。**

CI 告诉你"评委在重采样里稳不稳"。α 告诉你"评委跟人工标准对不对"。两个互补维度：

- **稳定 + α 低** = 评委稳定地错（系统性偏差）
- **不稳定 + α 高** = 评委平均跟人工一致但波动大
- **稳定 + α 高** = 这个 rubric 下评委可信
- **不稳定 + α 低** = 评委坏了

omk 自动检测 gold-judge 同源污染：如果 gold annotator 跟评委是同一个模型（比如都是 `claude-3.5-sonnet`），α 会被抬高（两者共享偏差）。omk 警告 + 报告调整后的 α。

同一逻辑也适用于评委-vs-输出这条轴：如果评委与产出被测输出的执行器同模型家族——默认就是，`claude:haiku` 评 `claude:sonnet` 的输出——评委的自我偏好会抬高分数。omk 会标记（`judge_self_preference`；多评委且全同一厂商时再标 `single_vendor_ensemble`）并指出修法：换跨厂商评委（`--judge-models openai-api:gpt-4o`）或挂 gold 校准。因为 omk 固定模型、baseline 与 treatment 同源，自我偏好在 A/B **差值**里大幅抵消——真正受影响的是绝对分、版本回归曲线、跨模型比较，警告也只把自己限定在这些范围。

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

## Verdict 稳健性 —— 多重比较 + 稳定性门控

六档 verdict 把上面几件事汇成一个 ship / no-ship 结论。当实验设计给它加压时，两条校正让结论保持诚实：

- **多重比较校正（Bonferroni）。** K 个 treatment 同时跟一个 control 比时，每对 diff 各按 α 独立检验会让 family-wise 假阳性膨胀 —— worst-case roll-up 取最吵的那一对，任一对假「显著」就拉高总结论。omk 改成每对按 **α / K** 检验，把 family-wise error 压回名义 α。K = 1（经典 A/B）不变。每个被校正的 `VariantPairComparison` 记下它的有效 `alpha`，报告据此重标 CI —— 被 Bonferroni 收宽的区间绝不再标「95%」。
- **稳定性门控。** 跨轮不可复现的「显著」提升不可 ship。当稳定性**已被测量**（`--repeat ≥ 2`）且跨轮波动偏高（中位 CV > 15%）时，PROGRESS 降级为 CAUTIOUS，不稳定性在 headline 里点明。单轮报告**不**门控 —— 那里稳定性根本没测（rationale 已如实说明），把每个单轮 eval 都自动降级会过激。

实现：`src/eval-core/verdict.ts` 与 `src/eval-core/evaluation-reporting.ts`。CV 阈值由 `test/scripts/doc-constants-drift.test.ts` 与代码保持同步。

## 用例隔离（`--strict-baseline`，默认开）

跟上面四件并列、但也是默认开的第五件：

baseline 拿到的 prompt **不应**包含被测 skill。omk 切断三条污染路径，防止 baseline 偷偷看到对照组的 skill：

1. SDK skill auto-discovery
2. subagent Skill 工具
3. cwd 文件系统（顺 `skills/<name>/` symlink 直接 Read 到 SKILL.md）

`eval.yaml` 的 `allowedSkills: []` 可对任意变体强制严格隔离。没有隔离时，任何"v2 比 baseline 好"的结论都可疑 —— baseline 可能通过这三条路径之一已经看到 v2 的 SKILL.md。

详见：[docs/zh/specs/sample-design-spec.md](../specs/sample-design-spec.md) 的相关用例设计。

---

## 可复现 / 审计追溯

每份报告携带：
- omk 版本(`reportMeta.cliVersion`)
- Node 版本(`reportMeta.nodeVersion`)
- 评委模型 + hash(`reportMeta.judgeModels`，每条携带该评委的模型与 runtime 指纹；以及 `reportMeta.judgePromptHash`)
- Executor runtime 指纹(`reportMeta.executorRuntime`)
- 用例指纹(`reportMeta.sampleHashes`)
- skill 隔离快照(`reportMeta.skillIsolation`)
- Schema 版本(`reportMeta.schemaVersion`)

跨版本可比性由 [GitHub Releases](https://github.com/lizhiyao/oh-my-knowledge/releases) 中的 `BREAKING-COMPARABILITY` callout 强制 —— 测量学不变量改了，你能看到。
