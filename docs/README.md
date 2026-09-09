# OMK Documentation

Choose an entry for your task. Version 1.0 is still in Beta iteration; existing users should read the [migration guide](./guides/v1-preview-migration.md) first. [简体中文 index](./zh/README.md).

## Get started

| Goal | Start here | Reference when needed |
|---|---|---|
| Compare two skills from the CLI | [Quickstart](./quickstart-skill-eval.md) | [CLI](./reference/cli.md) · [Executors](./reference/executors.md) · [Sample format](./reference/eval-sample-format.md) · [Artifact layout](./reference/artifact-layout.md) |
| Integrate a Node.js service | [Service guide](./guides/eval-runtime.md) | [Runtime API](./reference/eval-runtime-api.md) · [Core API](./reference/embedded-api.md) |
| Inspect real tasks and knowledge gaps | [Observation and task trajectories](./guides/observe-production.md) | [Codex case](./guides/codex-observe-case.md) · [Effective review semantics](./explanation/effective-observation-review.md) |

## Complete a task

- [Use the OMK Skill in an agent](./quickstart-skill-eval.md#use-inside-an-agent)
- [Run doctor checks](./guides/run-doctor-checks.md) · [Auto-improve a skill](./guides/auto-improve-skills.md)
- [Evaluate agents and project context](./guides/agent-eval.md) · [Use non-Claude models](./guides/non-claude-models.md)
- [Compose an MCP integration](./guides/mcp-integration.md) · [DeepSeek Harness integration](./reference/executors.md#deepseek-harness-prefer-the-host-plugin)

- Runtime topics: [scoring](./guides/eval-runtime-scoring.md) · [experiments and reuse](./guides/eval-runtime-experiments.md) · [execution and storage](./guides/eval-runtime-infrastructure.md) · [Agent integration](./guides/eval-runtime-agents.md)

## Understand results and limits

- [Who OMK is for](./explanation/who-omk-is-for.md) · [How OMK understands knowledge](./explanation/knowledge.md)
- [Three-stage workflow](./explanation/three-stage-workflow.md) · [Architecture](./explanation/architecture.md)
- [Statistical rigor](./explanation/statistical-rigor.md) · [Scoring formulas](./specs/scoring.md) · [Sample design](./specs/sample-design-spec.md)
- [Glossary](./reference/glossary.md) · [Tool comparison](./reference/comparison.md)

## Migration and design specs

- [1.0 Beta migration](./guides/v1-preview-migration.md) · [Core cutover](./guides/eval-core-cutover.md) · [Storage layout](./specs/storage-layout-spec.md)
- [Core design](./specs/eval-core-vnext.md) · [Scoring equivalence](./specs/evaluation-scoring-equivalence.md) · [CLI input compilation](./specs/cli-evaluation-input-compilation.md)
- [Knowledge domain model (draft)](./specs/knowledge-domain-model.md) · [Knowledge-gap signals](./specs/knowledge-gap-signal-spec.md) · [Evidence-gated management](./specs/evidence-gated-management.md)
- [RAG metrics](./specs/rag-metrics-spec.md) · [Terminology](./specs/terminology-spec.md)
