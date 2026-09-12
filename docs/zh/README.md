# OMK 文档

从当前任务选择入口。1.0 仍在 Beta 迭代；旧版本用户先看[迁移指南](./guides/v1-preview-migration.md)。[English index](../README.md)。

## 开始使用

| 目标 | 先读 | 按需查阅 |
|---|---|---|
| 命令行比较两版 skill | [快速上手](./quickstart-skill-eval.md) | [CLI](./reference/cli.md) · [执行器](./reference/executors.md) · [用例格式](./reference/eval-sample-format.md) · [载体布局](./reference/artifact-layout.md) |
| 在 Node.js 服务中接入 | [服务接入指南](./guides/eval-runtime.md) | [Runtime API](./reference/eval-runtime-api.md) · [底层 Core API](./reference/embedded-api.md) |
| 由平台宿主下发评测任务 | [平台宿主集成指南](./guides/platform-host-integration.md) | [参考执行器 API](./reference/eval-hosts-api.md) · [Runtime API](./reference/eval-runtime-api.md) |
| 查看真实任务与知识缺口 | [观测与任务轨迹](./guides/observe-production.md) | [Codex 案例](./guides/codex-observe-case.md) · [有效复核语义](./explanation/effective-observation-review.md) |

## 完成具体任务

- [在 Agent 中使用 OMK Skill](./quickstart-skill-eval.md#在-agent-中使用)
- [doctor 体检](./guides/run-doctor-checks.md) · [自动改进 skill](./guides/auto-improve-skills.md)
- [评测 agent 与项目上下文](./guides/agent-eval.md) · [使用非 Claude 模型](./guides/non-claude-models.md)
- [组合 MCP 集成](./guides/mcp-integration.md) · [DeepSeek Harness 接入](./reference/executors.md#deepseek-harness优先使用宿主插件)

## 理解结果与边界

- [为谁做、解决什么](./explanation/who-omk-is-for.md) · [OMK 如何理解知识](./explanation/knowledge.md)
- [三阶段工作流](./explanation/three-stage-workflow.md) · [架构](./explanation/architecture.md)
- [统计严谨性](./explanation/statistical-rigor.md) · [评分公式](./specs/scoring.md) · [用例设计](./specs/sample-design-spec.md)
- [术语表](./reference/glossary.md) · [工具对比](./reference/comparison.md)

## 迁移与设计规范

- [1.0 Beta 迁移](./guides/v1-preview-migration.md) · [Core 生产切换](./guides/eval-core-cutover.md) · [存储布局](./specs/storage-layout-spec.md)
- [Core 设计](./specs/eval-core-vnext.md) · [评分等价性](./specs/evaluation-scoring-equivalence.md) · [CLI 输入编译](./specs/cli-evaluation-input-compilation.md)
- [知识领域模型（草案）](./specs/knowledge-domain-model.md) · [知识缺口信号](./specs/knowledge-gap-signal-spec.md) · [证据门控管理](./specs/evidence-gated-management.md)
- [RAG metrics](./specs/rag-metrics-spec.md) · [术语规范](./specs/terminology-spec.md)
