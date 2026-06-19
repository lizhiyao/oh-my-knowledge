# Skill Map showcase

这个示例是为了让用户第一眼就看到：一个目录式 skill 可以被 doctor 解析成可视化图谱的输入。

skill 目录包含：

- `SKILL.md`：包含 frontmatter、`hardRules` 和 `workflows`
- `references/`：存放策略和 runbook 材料
- `scripts/`：存放确定性的 preflight 检查脚本
- 项目根目录的 `eval-samples.json`

先跑静态 doctor：

```bash
omk doctor skills/release-readiness --static-only
```

当前 main 上的预期输出：

- `.omk/doctors/<id>.json`

启用 Skill Information Graph 支持后，同一条命令还会写入：

- `.omk/graphs/doctor/<id>.json`
- `.omk/graphs/doctor/<id>.md`

Markdown 文件是可分享的 Evidence Card。它应该展示 references、scripts、workflows、workflow nodes、sample count 和 doctor status。

继续进入评测前，先预览任务计划：

```bash
omk eval --control baseline --treatment release-readiness --dry-run
```
