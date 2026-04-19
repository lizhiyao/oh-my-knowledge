# Changelog

omk（`oh-my-knowledge`）的版本变更记录。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

**0-1 阶段说明**：omk 仍处于 0-1 阶段，用户规模小。破坏性调整直接移除旧接口，不挂兼容别名、不打 deprecation warning——保留旧行为只会让歧义继续影响新用户。详见 [`docs/roadmap-v0.16.md`](./docs/roadmap-v0.16.md) 第 8 节"执行原则"。

---

## [Unreleased]

### Added

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

---

## [0.15.0] 及更早

本文件从 v0.16 起追踪详细变更。v0.15 及之前的演进见 git log 与 `docs/roadmap-v0.16.md` 开头的基线说明（"v0.15 omk 的四件独家事已立：控制变量 / 统计严谨 / 缺口信号 / evolve"）。
