<!--
title: 术语对照表 — 业内通用 ML / 统计 / omk 名词的中英对照
description: 给 omk 文档读者用的术语速查。覆盖 bootstrap CI / Δ / Pearson / Krippendorff α / 综合分 / executor / 测评可信度 等业内通用术语，以及 omk 内部命名(artifact / verdict / 外验集 等)。每条给一句话定义 + 在哪用到。
-->

# 术语对照表

omk 文档（包括博客、SKILL.md、CLI 输出、报告页）会混用一些 ML / 统计 / 测量学的业内通用英文术语 —— 这些词在英文社区里已经是事实标准，强行中文化反而显得在「翻译外文」。这份对照表给读者一个速查入口：每条给中文译名 + 一句话定义 + 在 omk 哪用到。

> **定位**：读者速查表，不是设计规范。omk 维护者写新文档时遵循这份用语。
>
> **姊妹文档**：[术语规范 (terminology-spec.md)](../specs/terminology-spec.md)（维护者内部决策归档）/ [统计严谨性](../explanation/statistical-rigor.md) / [综合分构造效度](../specs/scoring.md)

---

## 1. 统计 / 测量学

| 英文 | 中文 | 一句话定义 | 在 omk 哪用到 |
|---|---|---|---|
| bootstrap CI | 自助法置信区间 | 不假设分布的 95% 置信区间，靠重采样（默认 1000 次）算出 | `omk eval --bootstrap`；报告页「配对对比」表 |
| Δ (delta) | 分差 / 均值差 | treatment 与 control 的综合分均值差 | hero 「分差 +2.778」；配对对比表 |
| 95% CI | 95% 可信区间 | 真实均值有 95% 概率落在这个区间。CI 不含 0 = 显著差异 | hero tooltip；配对对比表 |
| significant | 显著差异 / 显著 | CI 不含 0（差距不是偶然） | 测评可信度 ✓ 差异显著 badge |
| Pearson r | 皮尔逊（相关）系数 | 1=完全同向 / 0=无关 / -1=完全反向 | 多评委 ensemble 的「跨用例评委一致性」表 |
| MAD | 平均绝对差 | 多个评委对同一用例打分的平均距离。1-5 制下 < 0.5 紧密一致，> 1.5 大分歧 | 多评委一致性表 |
| Krippendorff α | Krippendorff α / 一致性系数 | 区间加权多评委一致性，α ≥ 0.8 高度一致 / 0.667-0.8 可接受 / < 0.4 低 | 人工锚点 (Human gold) section |
| p-value | p 值 | 「这种差距碰巧出现」的概率，越小越显著（一般 0.05 阈值） | t-test 部分（omk 不主推，bootstrap 优先） |
| effect size | 效应量 | 差距相对于波动的比例（Cohen's d / Hedges' g），刻度化「差距有多大」 | 波动 / 显著性表的 Cohen's d 列 |
| CV | 变异系数 | stddev / mean，稳定性指标。1-5 制下 < 5% 稳 / 5-15% 中 / > 15% 不稳 | 稳定性列 + hero tooltip |
| stddev (σ) | 标准差 | 数值波动幅度的统计量 | 稳定性列 |
| saturation | 饱和（曲线） | 加更多用例不再让结论变化的点（CI 宽度衰减放缓） | 测评可信度「✓ 已饱和」badge |
| holdout (set) | 外验集 | skill 显式没写过的独立验证用例，用来防样本驯化 | 评测后置工作建议 |
| construct validity | 构造效度 | 测量是否真测了想测的东西（vs 测量误差） | scoring.md：综合分构造效度论证 |
| ad hoc | 临时拼装 / 没有原理论证的 | 通常用来形容「先做出来再说」的实现选择 | scoring.md：综合分等权聚合是 ad hoc |
| sample-set overfitting | 样本驯化 / 用例过拟合 | 评测集恰好被「答过案了」，分数虚高 | scoring.md / 测评博客 caveat 部分 |
| length debias | 长度去偏 | 校正 LLM 评委「答案越长打分越高」的已知偏差 | 默认开；`omk eval --no-debias-length` 关闭 |

---

## 2. omk 评测概念

| 英文 | 中文 | 一句话定义 | 在 omk 哪用到 |
|---|---|---|---|
| [artifact](./artifact-layout.md) | 知识载体 | omk 的「被评测对象」统一抽象：skill / prompt / agent / workflow / baseline | 由实验角色决定（`--control` / `--treatment` / baseline），非单独 flag |
| [executor](./executors.md) | 执行器 | 跑模型的方式：claude / codex / openai-api / gemini | `--executor` 参数；执行环境指纹 |
| ensemble (judge) | 集成评委 / 多评委 | 多个 LLM 同时当评委独立打分，组合结果 | `--judge-models claude:opus,claude:sonnet` |
| judge | 评委 | LLM 当评委按 rubric 打分（zh 译作「评委」，**不要**译作「判官」） | judge model 参数；evidence 表 |
| rubric | 评分规则 | judge 打分时遵循的细则（应识别 X / 必须包含 Y / 至少 N 项 / ...） | sample 配置的 rubric 字段 |
| anchor | 锚点 | 用人工标准校准 LLM judge 的方法 | `--gold-dir` 人工锚点 |
| gate (layer gate) | 闸门 / 层独立闸门 | 三层独立显著性检验（fact / behavior / judge），任一层退步即触发 CAUTIOUS+ | verdict 算法；报告页「波动 / 显著性」表 |
| [verdict](../specs/scoring.md#六档-verdict-一览) | 判定 | PROGRESS / REGRESS / CAUTIOUS / NOISE / UNDERPOWERED / SOLO 六档 | hero badge；CLI verdict 输出 |
| sample (evaluation sample) | 评测用例 | omk user-facing zh 统一用「用例」（英文 sample 保留） | eval-samples.json |
| [eval-samples](./eval-sample-format.md) | 评测用例集 / 评测用例文件 | 用例配置文件（每条含 prompt / rubric / assertion / capability） | `omk eval --samples` |
| baseline (reserved variant) | 基线 / 对照（保留字） | 不注入 skill 的对照组，omk 保留变体名 | `--control baseline` |
| treatment | 实验组 | 注入 skill 的对比组 | `--treatment <name>` |
| control | 对照组 | baseline 的别名 | `--control <name>` |
| [composite (score)](../specs/scoring.md) | 综合分 | fact / behavior / judge 三层等权均值，1-5 制 | 六维对比表第一列 |
| fact (layer) | 事实层 | assertion 通过率经 `1 + ratio*4` 映射到 1-5 | 六维对比表「📋 事实」 |
| behavior (layer) | 行为层 | 执行过程类断言（工具调用 / 轮次 / 成本上限）通过率 | 六维对比表「🛠️ 行为」 |
| judge (layer) | LLM 评价层 | 评委按 rubric 直接给的 1-5 分 | 六维对比表「💬 LLM 评价」 |
| dimension | 维度 | capability-aligned 评分维度（v0.x 后期落地，未进 composite） | 五层评分管道架构 |
| reliability check | 测评可信度 | 评委一致 / 差异显著 / 已饱和 / 人工对齐四块证据，可折叠展开 | 报告页 details 块 |
| [managed record](../specs/evidence-gated-management.md) | 受管记录 | `omk install` 建的 `.omk/managed/<id>.json` 事实记录（源 / contentHash / 分发 / 证据 / 决定） | `omk install`；证据门控管理 |
| lifecycle | 生命周期（installed / measurable / stale） | 受管 skill 的读时状态：`installed`（无有效证据）→ `measurable`（eval 证据已绑）→ `stale`（内容漂移脱离证据） | `deriveManagedState`；`omk eval`「→ measurable」 |
| evidence (managed) | 证据 | eval 跑完追加进受管记录的 `ManagedEvidenceRef`，绑定它测的内容指纹（report id / 样本覆盖 / verdict / 可比性） | `omk eval` 自动写入 |

---

## 3. 机器学习 / AI 通用

| 英文 | 中文 | 一句话定义 |
|---|---|---|
| prompt | 提示词 | 给 LLM 的输入文本 |
| system prompt | 系统提示词 | 在用户输入之前注入的背景指令；omk 评测时把整份 SKILL.md 作 system prompt 注入 |
| agent | 智能体 | 能调工具、多轮执行的 AI |
| workflow | 工作流 | 多步骤的 AI 流程编排 |
| skill | 知识载体（skill） | omk 的核心评测对象之一，常以 `SKILL.md` 形式存在 |
| tool call | 工具调用 | LLM 在执行中主动调用的外部函数 |
| turn | 轮次 | 一次「LLM 输出 + 用户/工具响应」的交互单元 |
| context | 上下文 | LLM 在生成时看到的全部历史信息 |
| fingerprint | 指纹 | 用 SHA-256 前缀（默认 12 位）算的版本哈希，用于跨 run 校验 |
| session trace | 会话轨迹 | 一次完整 AI 对话的事件流（prompt / 工具调用 / 输出 / 评分），observe 解析的对象 |

---

## 4. omk 三阶段

omk 闭环分三阶段 —— **doctor**（前置健康检查）→ **eval**（离线 A/B + verdict）→ **observe**（生产 trace）—— 合起来覆盖知识**评测 + 管理 + 洞察**。完整心智模型见[三阶段](../explanation/three-stage-workflow.md)。

---

## 5. 写作约定

omk 文档（README.zh / docs/zh / SKILL.md / CLI zh 字符串 / PR description）写作时遵循：

- **业内通用术语英文保留**：bootstrap CI / Δ / Pearson / executor / fingerprint 等。强行中文化会显得文章在「翻译外文」。
- **第一次出现时给中文括注**：例如「外验集（holdout set，即 skill 显式没写过的独立验证用例）」，第二次以后用中文。
- **omk 内部命名按 [terminology-spec.md](../specs/terminology-spec.md)**：artifact / executor / variant / verdict 等。
- **特殊翻译规则**：
  - LLM judge → **评委**（不要译作「判官」）
  - sample → **用例**（不要用「样本」）
  - composite score → **综合分**（不要用「总分」/「合成分」）
  - methodology audit → **测评可信度**（不要用「方法学审计」，外行不懂）
- **标点符号**遵循 GB/T 15834：全角 `，。：；！？（）「」`，破折号 `——`（双字符）；半角仅限技术混排（代码块、文件路径、命令行、URL、英文术语括注）。
