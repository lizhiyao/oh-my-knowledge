# OMK 文档

**Observe. Measure. Know.** 让 AI 应用的知识改动有据可依。

按受众或分类浏览。英文文档请看 [English index](../README.md)。

## 我想用 omk

- [omk 为谁做、解决什么](./explanation/who-omk-is-for.md) —— 用户、问题和第一条发布判断工作流
- [快速上手](./quickstart-skill-eval.md) —— 5 分钟跑完第一次评测
- [安装 omk Agent Skill](./quickstart-skill-eval.md) —— 用 `omk install omk-agent-skill` 开启 agent 驱动工作流
- [CLI 参考](./reference/cli.md)
- [嵌入式 Evaluation Core API](./reference/embedded-api.md)
- [评测用例格式](./reference/eval-sample-format.md)
- [执行器](./reference/executors.md)
- [指定被测对象(artifact / variant)](./reference/artifact-layout.md)
- [7 工具对比](./reference/comparison.md)
- [术语表](./reference/glossary.md)

## 操作指南

- [doctor 体检](./guides/run-doctor-checks.md)
- [评测 agent（项目级 runtime context）](./guides/agent-eval.md)
- [自动迭代 skill](./guides/auto-improve-skills.md)
- [观测生产 trace](./guides/observe-production.md)
- [组合 OMK MCP 集成](./guides/mcp-integration.md)
- [复现 Codex 父子任务观测](./guides/codex-observe-case.md)
- [使用非 Claude 模型（GLM / 通义 / DeepSeek / Moonshot / Ollama）](./guides/non-claude-models.md)

## 我想懂工作原理

- [omk 为谁做、解决什么](./explanation/who-omk-is-for.md) —— 为什么 doctor / eval 是发布前主干，observe 是发布后反馈
- [三阶段：doctor / eval / observe](./explanation/three-stage-workflow.md)
- [工作原理](./explanation/architecture.md)
- [统计严谨性](./explanation/statistical-rigor.md)
- [评分公式](./specs/scoring.md)

## 我想贡献 / 看设计 spec

- [Evaluation Core vNext RFC](./specs/eval-core-vnext.md)
- [CLI 评测输入编译规范](./specs/cli-evaluation-input-compilation.md)
- [用例设计科学性指南](./specs/sample-design-spec.md)
- [知识缺口信号规范](./specs/knowledge-gap-signal-spec.md)
- [RAG metrics 规范](./specs/rag-metrics-spec.md)
- [术语规范](./specs/terminology-spec.md)
