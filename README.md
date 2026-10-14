# OMK

[![Beta @next](https://img.shields.io/npm/v/oh-my-knowledge/next.svg?label=Beta)](https://www.npmjs.com/package/oh-my-knowledge?activeTab=versions)
[![CI](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml/badge.svg)](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**English** | [简体中文](./README.zh.md)

**Observe. Measure. Know.** Turn working experience into knowledge you can keep maintaining.

OMK is for agent users and AI application developers. Extract candidates from real work, review sources and conditions, accumulate and revise knowledge around objects, then update the skills or prompts that reference it. When you need evidence about a change, compare artifact versions under controlled conditions independently.

## Start with local work records

Requires **Node.js ≥22**. The library, artifact authoring, and change review described here require **1.0.0-beta.14 or later**, from the **`@next` channel**; npm `latest` is a separate stable channel. Beta.13 does not include this maintenance UI. Read the [migration guide](docs/guides/maintenance/v1-preview-migration.md) before upgrading an older installation.

```bash
npm i -g oh-my-knowledge@next
omk --version
omk studio
```

Open the local URL returned by the command and inspect an existing Codex task and its source records. This step makes no model call; Studio offers source and collection guidance when no conversations exist. Follow the [observation guide](docs/guides/observe/observe-production.md) for other log sources.

Next, choose a conversation and turns under “Knowledge → Candidate review”, inspect the material to send, and extract candidates. **Extraction calls a model**, so prepare an [authenticated runtime](docs/reference/integration/executors.md#prerequisites) first. Link sources in the library, revise outdated content, then explicitly generate and save an artifact. Its detail view lets you review knowledge changes and old and new references. Follow the [knowledge maintenance workflow](docs/guides/knowledge/extract-knowledge.md).

## When knowledge changes, review its artifacts

![SDK historical artifact changes in the Studio reader, captured from the Chinese case](./docs/public/sdk-maintenance-review.png)

In the existing SDK maintenance case, old statements were limited to their historical context, one item was discarded, and another gained a clearer boundary for its static observations. v4 retains three historical references and shows two changes; v5 explicitly selects two currently retained items, while old content and references remain available. [Read the case, sources, and review steps](docs/guides/knowledge/sdk-maintenance-case.md).

This verifies maintenance and reference behavior. It does not verify dynamic SDK effects, time saved, or cross-agent reuse benefits. Retaining knowledge, saving artifacts, using them, and verifying effects are separate records. Complete automatic management and reuse across agents remain in development.

## Continue with your task

- **Compare two artifacts directly**: preview the plan in the [evaluation quickstart](docs/guides/evaluation/quickstart-skill-eval.md), configure a runtime, then call the model. Fix models and cases, record execution conditions, and inspect decisions, uncertainty, and failed-case evidence.
- **Embed evaluation in a service**: begin with the [offline Node example](docs/guides/integration/eval-runtime.md), complete a traceable comparison, then choose models and configuration as needed.
- **Use OMK inside agents or DSH**: [install the official Skill](docs/guides/evaluation/quickstart-skill-eval.md#use-inside-an-agent), [submit MCP feedback](docs/guides/integration/mcp-integration.md), or use the [DSH host plugin](docs/reference/integration/executors.md#deepseek-harness-prefer-the-host-plugin).
- **Verify an agent’s file changes**: use independent checks in [local task acceptance](docs/guides/evaluation/local-tasks.md), or screen candidate versions with [iterative improvement](docs/guides/evaluation/auto-improve-skills.md).

Starter cases check the workflow; `UNDERPOWERED` is expected. Release decisions need your own domain cases and independent evidence. Observation signals do not establish causality; passing an evaluation does not mean an artifact took effect or a version was published.

## Look up details and upgrade

[Documentation start](docs/README.md) · [Website](https://oh-my-knowledge.pages.dev/) · [CLI](docs/reference/cli.md) · [Runtimes and executors](docs/reference/integration/executors.md) · [Settings and environment variables](docs/reference/shared/settings.md) · [Examples](examples/README.md)

Beta APIs and storage contracts may change. Knowledge stays in the explicitly selected workspace; execution evidence and machine preferences have their own storage scopes. Back up before upgrading, then establish new evidence through the migration guide.

## Security notice

Use a trusted local environment. Tasks, verifiers, and custom assertions execute local code and should be reviewed first; workspace copies are not security sandboxes. Inspect the material before a model call: source records and artifacts may contain sensitive information. The local report server has no authentication and should not be exposed publicly.

See [GitHub Releases](https://github.com/lizhiyao/oh-my-knowledge/releases) for release notes and [CONTRIBUTING](./CONTRIBUTING.md) for the contribution workflow.
