# Changelog

omk（`oh-my-knowledge`）的版本变更记录。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

**0-1 阶段说明**：omk 仍处于 0-1 阶段，用户规模小。破坏性调整直接移除旧接口，不挂兼容别名、不打 deprecation warning——保留旧行为只会让歧义继续影响新用户。详见 [`docs/roadmap-v0.16.md`](./docs/roadmap-v0.16.md) 第 8 节"执行原则"。

---

## [Unreleased]

### Added

- **PR-2 三层独立 t 检验**：fact / behavior / quality 三个内部层各自计算 Welch's t-test + Cohen's d + 95% CI，避免"质量层 +0.8、事实层 +0.1"这类结构性差异被合成分稀释。`VarianceComparison.byLayer` 挂结构化数据，HTML 报告在每个 comparison 下附一个可展开的 `<details>` 子表。
- CLI `--layered-stats`：HTML 报告里默认展开三层独立显著性面板（不传时默认折叠，点 summary 展开）。写入 `Report.meta.layeredStats`，渲染器读取。
- 类型层新增 `VarianceLayerKey`（`fact` / `behavior` / `quality`）、`VariantVariance.byLayer`、`VarianceComparison.byLayer`、`ReportMeta.layeredStats`。
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
- **稳定性语义修正**：四维对比表"稳定性"列主指标从"成功率 %"改为 **CV（变异系数）= σ / mean**，数据来自跨 run 的 `report.variance.perVariant[v]`（需 `--repeat ≥ 2`）。副区显示 `σ + 95% CI`。无 variance 数据时主值显示 `—` + 副区 `需 --repeat ≥ 2`，不再虚报成功率。
  - 原因：v0.15 及更早把"稳定性"主值挂成执行成功率、副值挂成跨样本 min~max 分数范围——两者都不是稳定性。成功率是执行健康度、跨样本 range 反映的是样本难度差异而非 variant 波动。行业共识（psychometrics / Anthropic / OpenAI eval docs / Braintrust / Langfuse）里稳定性 = test-retest reliability，即跨重复运行的分数一致性。
  - 影响：单轮评测（无 `--repeat`）报告不再显示"稳定性 100%"，改为诚实占位"— 需 `--repeat ≥ 2`"；成功率 < 100% 时作为副区 alert 保留。
  - 详见 `docs/terminology-spec.md` 第三节第 5 条。

---

## [0.15.0] 及更早

本文件从 v0.16 起追踪详细变更。v0.15 及之前的演进见 git log 与 `docs/roadmap-v0.16.md` 开头的基线说明（"v0.15 omk 的四件独家事已立：控制变量 / 统计严谨 / 缺口信号 / evolve"）。
