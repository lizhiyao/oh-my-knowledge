# Skill Map showcase

这个示例用于展示：一个目录式 skill 可以怎样为后续 Skill Information Graph 提供结构化输入。

skill 目录包含：

- `SKILL.md`：包含 frontmatter、`hardRules` 和 `workflows`
- `references/`：存放策略和 runbook 材料
- `scripts/`：存放确定性的 preflight 检查脚本
- `.omk/samples.json`：随 skill 一起分发的评测用例

`.omk/samples.json` 也演示了 `covers` 的推荐用法：只给关键用例声明它主要触达的 reference、hard rule、workflow 或 workflow node。它不是全量维护清单；未声明只表示 Skill Map 里暂时没有这条显式结构边，不代表该节点一定没有被测到。

先跑静态 doctor：

```bash
omk doctor skills/release-readiness --static-only
```

预期输出：

- `.omk/doctors/<skill>-<run>.report.json`

这里的 `.omk/doctors` 是项目级运行产物；skill 目录里的 `.omk/samples.json` 是随 skill 入库的源数据。启用 Skill Information Graph 支持后，同一条命令还会写入：

- `.omk/graphs/doctor/<skill>-<run>.graph.json`
- `.omk/graphs/doctor/<skill>-<run>.card.md`

Markdown 文件是可分享的 Evidence Card。它应该展示 references、scripts、workflows、workflow nodes、sample count 和 doctor status。

继续进入评测前，先预览任务计划：

```bash
omk eval --control baseline --treatment release-readiness --dry-run
```

真正跑完 eval 后，Studio 的 Skill Map 会把 sample 里的 `covers` 渲染成声明锚点。你应该能看到 release 决策用例连到 `release-review`、release policy 和 rollback runbook；线上事故用例连到 `incident-response` workflow 和 rollback runbook。
