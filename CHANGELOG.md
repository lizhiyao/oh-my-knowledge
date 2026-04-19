# Changelog

omk（`oh-my-knowledge`）的版本变更记录。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

**0-1 阶段说明**：omk 仍处于 0-1 阶段，用户规模小。破坏性调整直接移除旧接口，不挂兼容别名、不打 deprecation warning——保留旧行为只会让歧义继续影响新用户。详见 [`docs/roadmap-v0.16.md`](./docs/roadmap-v0.16.md) 第 8 节"执行原则"。

---

## [Unreleased]

### Added

- **v0.17 工作项 A · 知识缺口信号严重度加权（PR-2 / spec §6）**:`GapSignalRef.weight` 新增必填字段,每个 signal 按类型自带权重——failed_search / repeated_failure 为强证据(权重 1.0),explicit_marker / hedging 为弱信号(权重 0.5)。`GapReport` 新增 `weightedGapRate: number` 指标,按样本最强信号权重聚合,和 `gapRate` 并列展示。
  - 目的:v0.1 所有四类信号等权聚合,hedging 高假阳率(spec §2.8)会把软信号稀释真信号。v0.2 区分硬证据 vs 软信号,`weightedGapRate ≤ gapRate`,差值反映软信号占比。
  - UI 改动:gap section 副区增加"加权严重度 X%"提示,差值 ≥ 10% 时明示"软信号占比大,建议复核"。
  - spec §6 更新:从"v0.1 不选严重度加权"明文改为"v0.2 起引入",加 SIGNAL_WEIGHTS 表与 weightedGapRate 聚合公式。
  - 测试:+5 case 覆盖 signal weight 字段、weightedGapRate 按样本最强权重聚合、同一样本 max 取权重不累加、全弱信号 gap rate 拉高但 weighted 砍半、空 report 不崩。

- **v0.17 工作项 B · hedging 信号 LLM-assisted 二次判定（spec §四.3）**:新增 `src/analysis/hedging-classifier.ts`。流水线:regex 召回 candidate → LLM 小模型(默认 claude-haiku-4-5)二次判定 → `isUncertainty=false` 的 candidate 直接丢弃, `=true` 的保留并把 verdict 挂到 `GapSignalRef.classifierVerdict`。
  - 目的:v0.1 hedging 纯 regex 假阳率高——"可能是" / "likely" 在业务推理 / 假设分析里大量误判,稀释 weightedGapRate 信号意义。v0.2 用 LLM 把"知识层面不确定"和"业务可能性 / 礼貌措辞"分开。
  - 关键约束:cost 上限默认 50 candidate / evaluation(超出截断 + warn);in-memory cache by sentence sha256(同句子不重复调用);失败降级 → `isUncertainty=true` 保守保留(宁可多统计软信号也不丢真信号);batch size 默认 10 条 / 调用。
  - 类型层:`HedgingVerdict { isUncertainty, confidence, reason }` + `GapSignalRef.classifierVerdict?: HedgingVerdict`(仅 hedging 类型可能有此字段)。
  - 集成接口:`applyHedgingClassifier(report, executor, opts)` 接收 GapReport + executor 返回过滤后的 report + costUSD;`applyHedgingClassifierToReports(reports, ...)` 批量版串行跑(让 cache hit 在第一批后被复用,避免 rate limit)。computeGapReport 仍 sync,classifier 走异步 post-processing,caller 可选启用。
  - weight 不变:classifier 通过的 hedging 仍是 0.5(弱信号)。weight 升级到 1.0 需要等到 v0.3 引入 confidence 校准实验。
  - 测试:+11 case 覆盖 happy path / cache hit / batch 切分 / truncation / exec 失败降级 / parse 失败降级 / 空输入零调用 / 集成层 byType.hedging 重算 / 失败时不丢 signal / 不影响其他 type / 无 hedging 时不调 executor。

---

## [0.16.0] - 2026-04-19

**一句话**:废 composite 主分、立三层独立可观察维度;废 `--variants` 改 experiment role 显式声明;立 `eval.yaml` 为"evaluation as code"主入口;把稳定性从"成功率 / 跨样本 range"修到跨重复运行的 CV;把 bench ci 从守合成分改成三层 all-pass。

### Added

- **PR-2 三层独立 t 检验**：fact / behavior / judge 三个内部层各自计算 Welch's t-test + Cohen's d + 95% CI，避免"judge 层 +0.8、事实层 +0.1"这类结构性差异被合成分稀释。`VarianceComparison.byLayer` 挂结构化数据，HTML 报告在每个 comparison 下附一个可展开的 `<details>` 子表。
- CLI `--layered-stats`：HTML 报告里默认展开三层独立显著性面板（不传时默认折叠，点 summary 展开）。写入 `Report.meta.layeredStats`，渲染器读取。
- 类型层新增 `VarianceLayerKey`（`fact` / `behavior` / `judge`）、`VariantVariance.byLayer`、`VarianceComparison.byLayer`、`ReportMeta.layeredStats`。
- CLI `--control <expr>` / `--treatment <v1,v2,...>`：按 experiment role 显式声明 variant 与角色
- CLI `--config <path>`：YAML/JSON 配置文件（evaluation as code），`.json` / `.yaml` / `.yml` 自动识别
- `src/inputs/eval-config.ts`：config 加载 + schema 校验；相对路径按 config 文件所在目录解析；`baseline` / `git:` 前缀保持原样
- 类型层：`VariantConfig.experimentRole`、`Artifact.experimentRole`（run-time 属性）、`VariantSpec`、`EvalConfig`、`EvalConfigVariant`
- 术语规范 `docs/terminology-spec.md` 第 4 节 Experiment Role，明确 `control` / `treatment` 术语与 `baseline` kind 的正交边界
- 能力迭代路线图 `docs/roadmap-v0.16.md`：v0.16-v0.20+ 节奏与执行原则
- dry-run 输出新增 `experimentRole` 字段

### Changed

- 参数优先级收敛为 **CLI > config > 硬编码默认**；`RUN_OPTIONS` 不再内置 default，全部集中到 `parseRunConfig` resolve
- `buildVariantConfig` 从 `artifact.experimentRole` 读取角色（暂留从 `artifact.kind` 推断的 fallback，标记 `TODO(v0.16-A-D3)`，下一个迭代移除）
- `each-workflow` 显式为 baseline artifact 标 `experimentRole: control`、为 skill artifact 标 `treatment`，不再依赖下游 kind 反推

### Removed / BREAKING

- **CLI `--variants` 直接移除**（0-1 阶段窗口期内一次清理）。迁移：
  - `--variants baseline,my-skill`  →  `--control baseline --treatment my-skill`
  - `--variants v1,v2,v3`  →  `--control v1 --treatment v2,v3`
  - 复杂场景推荐 `--config eval.yaml`，CLI 参数覆盖 config 字段
- **三层评分第三层 rename**：`LayeredScores.qualityScore` → `judgeScore`、`VariantSummary.avgQualityScore` → `avgJudgeScore`、`VarianceLayerKey: 'quality'` → `'judge'`。UI 展示同步改为 "LLM 评价"（中文）/ "LLM judge"（英文）。
  - 原因：`quality`（字段名） 与表头 "质量"（composite 合成分 / 基础四维之一）字面重名，读者无法区分 "质量 3.85" 和 "质量层: 4" 是两个不同概念。语义上这一层就是 LLM judge 基于 rubric 的主观评分，命名应如实反映。
  - 影响：旧 report JSON（v0.15 或更早）里的 `qualityScore` / `avgQualityScore` 字段在 v0.16 renderer 下会被当成 undefined；不做向后兼容（0-1 阶段窗口期策略）。重新跑一次 eval 即可。
  - 详见 `docs/terminology-spec.md` 第三节第 6 条。
- **`bench ci --threshold` 从"守合成分"改"守三层 all-pass"（PR-3 工作项 C）**：门禁语义从 `avgCompositeScore >= threshold` 改为 `avgFactScore >= threshold AND avgBehaviorScore >= threshold AND avgJudgeScore >= threshold`，任一层低于 threshold 即 FAIL。输出格式展示每层分数和破 gate 的层，读者一眼看出是哪一层拉胯。
  - 原因：composite 合成分均化掩盖结构性差异——`v1→v2 事实 4.5→2.5 但 judge 3→5` 在 composite 上均值不变（3.75），一-gate CI 会通过，但事实层实际崩盘。Three-gate 把这种 case 暴露出来，符合 PR-3 精神。
  - 影响：老 CI 脚本 `omk bench ci --threshold 3.5` 语义从单-gate 变 three-gate，**通常更严格但信息更丰富**（旧 PASS 的 case 绝大多数仍 PASS，除非靠 layer-averaging 躲过 gate 的 case）。
  - **不提供 composite fallback**：三层都缺（eval-samples 既没定义断言也没定义 rubric）时直接 FAIL + 引导用户补配置，不偷偷走合成分。符合 0-1 窗口期不做兼容的执行原则与 PR-3"拒绝合成分掩盖"精神。
- **稳定性语义修正**：四维对比表"稳定性"列主指标从"成功率 %"改为 **CV（变异系数）= σ / mean**，数据来自跨 run 的 `report.variance.perVariant[v]`（需 `--repeat ≥ 2`）。副区显示 `σ + 95% CI`。无 variance 数据时主值显示 `—` + 副区 `需 --repeat ≥ 2`，不再虚报成功率。
  - 原因：v0.15 及更早把"稳定性"主值挂成执行成功率、副值挂成跨样本 min~max 分数范围——两者都不是稳定性。成功率是执行健康度、跨样本 range 反映的是样本难度差异而非 variant 波动。行业对照（Anthropic / OpenAI eval docs / Braintrust / Langfuse）里稳定性以跨重复运行的方差为核心——CV 是工程领域相对离散度指标，与 psychometrics 意义的 test-retest reliability（ICC / Pearson r）不完全等价，阈值 `<5% / 5~15% / >15%` 为 1-5 分数量纲的内部经验值。
  - 影响：单轮评测（无 `--repeat`）报告不再显示"稳定性 100%"，改为诚实占位"— 需 `--repeat ≥ 2`"；成功率 < 100% 时作为副区 alert 保留。
  - 详见 `docs/terminology-spec.md` 第三节第 5 条。
- **新增必填字段（旧 v0.15 / 更早 report JSON 在新 renderer 下部分维度退化为 `—`）**：
  - `VariantConfig.experimentRole: 'control' | 'treatment'`（必填），`Artifact.experimentRole`（run-time 可选字段）
  - `ReportMeta.layeredStats?: boolean`
  - `VariantVariance.byLayer` / `VarianceComparison.byLayer`
  - 旧 report JSON 缺这些字段时，新 renderer 在部分列显示 `—`（稳定性主值、三层分数等）。不做向后兼容，重新跑一次 eval 即可。

---

## [0.15.0] 及更早

本文件从 v0.16 起追踪详细变更。v0.15 及之前的演进见 git log 与 `docs/roadmap-v0.16.md` 开头的基线说明（"v0.15 omk 的四件独家事已立：控制变量 / 统计严谨 / 缺口信号 / evolve"）。
