# OMK 存储布局 v2

> **范围：**项目级与机器级存储的正式契约。所有路径由 `src/omk-layout/` 统一生成，业务模块不得自行拼项目根 `.omk`。本次只改变存储位置，不改变报告 schema、评分语义、prompt、统计公式或长度去偏。

## 设计原则

- 顶层名称跟用户看得见的产品域一致：`eval`、`doctor`、`observe`。
- 每份持久测量记录独占一个自包含目录。`report.json` 是权威数据，可重建视图放进 `derived/`。
- 路径直接表达生命周期。持久证据、observation、治理、备份与可重建 `state` 不再平铺混放。
- 绑项目的证据默认写入 `<project>/.omk`。机器工具、缓存、隧道、物化树和跨项目索引只能进入全局 `state/`。
- 记录身份来自报告 ID 与内容 digest，不依赖绝对路径；搬迁不会改变报告 JSON 或 digest。

## 项目级布局

```text
.omk/
├── layout.json
├── .gitignore
├── eval/
│   └── <record-id>/
│       ├── manifest.json
│       ├── report.json
│       └── derived/
│           ├── graph.json
│           └── card.md
├── doctor/
│   └── <record-id>/
│       ├── manifest.json
│       ├── report.json
│       └── derived/
│           ├── graph.json
│           └── card.md
├── observe/
│   ├── health/
│   │   └── <record-id>/
│   │       ├── manifest.json
│   │       └── report.json
│   ├── inbox/
│   │   ├── reports/
│   │   ├── captures/
│   │   └── review-state.json
│   ├── drafts/
│   └── archive/
├── governance/
│   └── managed/
├── backups/
│   └── doctor-fix/
└── state/
    ├── jobs/
    ├── locks/
    └── tmp/
```

`<record-id>` 是一份报告 bundle 的防碰撞文件系统身份；manifest 保存公开的 report／run 身份。Evaluation Core bundle 还会把封存的 plan、execution、evaluation、analysis 文档跟 `report.json` 放在同一目录，这些文档仍属于经过认证的 bundle。

`layout.json` 只包含：

```json
{
  "layoutVersion": 2
}
```

目录 skill 的 authoring 约定 `<skill>/.omk/eval-samples.{json,yaml}` 本期明确不变。

## 机器级布局

`OMK_HOME` 默认是 `~/.oh-my-knowledge`，并整体重定向这棵树：

```text
~/.oh-my-knowledge/
├── layout.json
├── eval/
├── doctor/
├── observe/
├── governance/
├── backups/
└── state/
    ├── cache/
    ├── tools/
    ├── tunnels/
    ├── trees/
    ├── isolated-cwd/
    ├── artifact-index/
    ├── jobs/
    ├── locks/
    └── tmp/
```

项目与机器的持久数据使用同一套领域结构。机器专属内容不得进入项目 `.omk`。Codex、Claude、DSH 的原始 trace 继续留在来源位置；OMK 默认只读分析，不复制进项目。

## 生命周期与 Git 策略

| 路径 | 语义 | 默认删除？ | 项目 Git 策略 |
|---|---|---:|---|
| `eval/` | A/B 评测证据与发布判断 | 否 | 忽略 |
| `doctor/` | skill 体检报告 | 否 | 忽略 |
| `observe/health/` | 从真实 trace 聚合的健康度 | 否 | 忽略 |
| `observe/inbox/` | 待复核 observation 与人工状态 | 否 | 忽略，可能含敏感信息 |
| `observe/drafts/` | 从 observation 生成的样本草稿 | 否 | 忽略 |
| `governance/managed/` | install／evidence／promote／rollback 历史 | 否 | 默认追踪 |
| `backups/` | 自动修改前的恢复副本 | 否 | 忽略 |
| `state/` | 任务、锁、临时文件及全局可重建缓存 | 是 | 忽略 |

`omk init` 会写内部 `.omk/.gitignore`，忽略 `eval/`、`doctor/`、`observe/`、`backups/` 和 `state/`，但不忽略 `layout.json` 与 `governance/`。

## 兼容边界

v2 是唯一受支持的存储布局。OMK 不读取旧存储根，不提供迁移命令，也不会自动搬动或删除旧数据。已有旧 `.omk` 数据保持原样，但不会被 v2 读侧发现；用户可以先备份，再显式删除。Evaluation Core bundle 只支持 manifest v2 与 `report.json`。

## 清理契约

- `omk clean --dry-run` 预览精确路径与预计释放空间。
- `omk clean` 只删除 `state/`。
- `--reports` 选择 `eval/`、`doctor/`、`observe/health/`。
- `--observations` 选择 inbox、drafts 和 archive，并要求 `--force`。
- `--backups` 选择备份。
- `--governance` 是独立选项，并要求 `--force`。
- `--all` 选择 state、报告、observation 与备份，但不含治理记录。

递归删除前，清理器会同时校验目标位于选定 OMK 根内，并且属于固定类别白名单。

## 为什么这样命名

不设顶层 `runs`：它容易被理解成可随时删除的执行状态，而 eval 与 doctor 是持久证据。不设顶层 `measurements`：它会遮住用户已经熟悉的 CLI 产品域。不设顶层 `observations`：健康报告与待复核 observation 是共同 `observe` 域下的兄弟管线。选择 `derived` 而不是 `projections`，因为其中内容是由一份权威报告派生、可重建的物化结果，不是独立产品域。

## 相关文档

- [OMK 为谁而做](../explanation/who-omk-is-for.md)
- [术语规范](terminology-spec.md)
- [证据门控管理](evidence-gated-management.md)
