# Skill Map 展示

[English](./README.md)

## 用途

这个示例展示目录式 skill 如何向 Doctor 和 Skill Map 提供结构化证据。目录包含：

- 带 frontmatter、`hardRules` 和 `workflows` 的 `SKILL.md`；
- 保存 policy 与 runbook 来源的 `references/`；
- 提供确定性 preflight 检查的 `scripts/`；
- 保存版本化 skill 私有用例的 `.omk/eval-samples.json`。

部分用例通过 `covers` 声明主要覆盖的 reference、hard rule、workflow 或 workflow node。缺少结构边只表示没有登记显式覆盖声明，不代表该节点一定未被测试。

## 运行

先运行不调用模型的静态 Doctor：

```bash
omk doctor skills/release-readiness --static-only
```

Doctor 会把报告和图谱 sidecar 写入项目级 `.omk/`。然后预览评测计划：

```bash
omk eval --control release-checklist --treatment release-readiness --dry-run
```

真实评测完成后，Studio 会把用例中的 `covers` 声明投影到 Skill Map。发布决策用例应连接 release-review workflow、release policy 和 rollback runbook；事故用例应连接 incident response 与 rollback 证据。

## 证据边界

显式 control 是通用发布检查清单，treatment 则增加结构化 policy、workflow 与 rollback 知识。`covers` 结构边是作者声明，不是用例已经充分测到目标的证明。Doctor 和 Skill Map 用于暴露结构与声明缺口，不能替代人工审核样本质量，也不能替代统计功效充分的正式评测。
