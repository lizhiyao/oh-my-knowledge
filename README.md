# OMK

[![npm version](https://img.shields.io/npm/v/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![npm weekly downloads](https://img.shields.io/npm/dw/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![CI](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml/badge.svg)](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/node/v/oh-my-knowledge.svg)](https://nodejs.org)

**English** | [简体中文](./README.zh.md)

**Observe. Measure. Know.** Make knowledge changes in your AI application evidence-backed.

OMK helps authors of prompts, RAG systems, skills, and agents compare versions, inspect evidence, and find knowledge gaps in real tasks. A controlled comparison keeps the **same model and evaluation samples, changing only the knowledge artifact**.

Version 1.0 is still **in Beta iteration**; APIs and storage contracts may change. Read the [migration guide](docs/guides/v1-preview-migration.md) before upgrading an older installation.

![OMK: from controlled evaluation to real-world feedback](./docs/public/omk-knowledge-flow-en-animated.gif)

## Start with your goal

| Goal | Entry point |
|---|---|
| Compare two skills and inspect the verdict, interval, and failed cases | [CLI quickstart](docs/quickstart-skill-eval.md) |
| Add scoring and version comparisons to a Node.js service | [Service integration guide](docs/guides/eval-runtime.md), including an example without model credentials |
| Inspect one task or find problems in historical logs | [Observation and task trajectories](docs/guides/observe-production.md) |

## Quick start

You need Node.js >=22 and an authenticated model runtime; see [Requirements](#requirements). Install the Beta and preview your first comparison:

```bash
npm i -g oh-my-knowledge@next
omk init demo
cd demo
omk eval --control code-review-v1 --treatment code-review-v2 --dry-run
```

After checking the plan and estimated calls, run the evaluation (this calls the model):

```bash
omk eval --control code-review-v1 --treatment code-review-v2
```

The scaffold contains two skills and three cases. This small default set checks the workflow; `UNDERPOWERED` is expected. Starter cases are marked `llm-generated`. Even the full pack created with `omk init demo-full --samples 20` only meets the default heuristic evidence floor, not an a priori power plan or a release-evidence requirement. Review and replace starter cases with real domain cases before relying on the results.

The [full walkthrough](docs/quickstart-skill-eval.md) covers runtime selection, your own skills, and interpreting results. The [example gallery](examples/README.md) offers more runnable scenarios.

## Use inside AI Coding Agents

```bash
omk install omk-agent-skill
```

Then ask your coding agent: “Use omk to compare these two skills.” See the [quickstart](docs/quickstart-skill-eval.md#use-inside-an-agent) for installation targets and usage. DeepSeek Harness users can use the [host plugin](docs/reference/executors.md#deepseek-harness-prefer-the-host-plugin) to reuse their current profile.

The [MCP integration](docs/guides/mcp-integration.md) accepts user-authorized knowledge feedback. It records partial evidence submitted at its tool boundary; it does not automatically monitor complete conversations.

## Use the evidence

`doctor` checks the artifact, `eval` compares versions, and `studio` presents results and raw evidence. When evidence meets the gate, `promote` can accept a version; `evolve` can generate a candidate. Gaps found by `observe` can become draft cases for review before the next evaluation.

Conclusions depend on the cases, scoring criteria, and execution environment. Observation signals are not causal conclusions, and generated cases are not an independent release-validation set. See [statistical rigor](docs/explanation/statistical-rigor.md) and the [three-stage workflow](docs/explanation/three-stage-workflow.md) for the method and limits.

Project evidence lives under `.omk/`; machine-level state lives under `~/.oh-my-knowledge/`. The current version neither reads nor migrates the old storage layout. Back up before upgrading and follow the [migration guide](docs/guides/v1-preview-migration.md) to establish new evidence.

## Documentation

[Documentation index](docs/README.md) · [Online docs](https://oh-my-knowledge.pages.dev) · [CLI reference](docs/reference/cli.md) · [Sample format](docs/reference/eval-sample-format.md) · [Executors](docs/reference/executors.md) · [How OMK understands knowledge](docs/explanation/knowledge.md)

## Environment variables

| Variable | Description |
|---|---|
| `OMK_EXECUTOR` | default executor preference, e.g. `codex` / `codex-sdk` / `claude` |
| `OMK_MODEL` | default evaluated model; Codex reads local `config.toml` when unset |
| `OMK_JUDGE_MODELS` | default judge list in `executor:model[,...]` format |
| `CCV_PROXY_URL` | proxy requests through cc-viewer for live eval-traffic visualization |
| `OMK_REPORT_PORT` | report server port (default: 7799) |

## Requirements

- Node.js >= 22
- At least one authenticated model runtime:
  - Codex: install and authenticate the Codex CLI (`npm i -g @openai/codex`); Codex tasks in the ChatGPT desktop app select it automatically
  - Claude: install and authenticate [Claude Code](https://claude.ai/code)
  - API / other executors: configure them as described in [Executors](docs/reference/executors.md)
- Advanced `claude-sdk` / `codex-sdk` executors are optional and are not downloaded by the base OMK install. Install the matching SDK in the same local project or global npm prefix only when you select one; see [Executor prerequisites](docs/reference/executors.md#prerequisites).

## Security notice

This tool is designed for **local trusted environments** (dev machines, CI pipelines). The following features execute local code — make sure inputs come from a trusted source:

| Feature | Risk | Scope |
|---|---|---|
| **Custom assertions** (`custom`) | dynamically loads and executes user-specified `.mjs` files | only use assertion files you authored or reviewed |
| **eval-samples.json** | assertion configs can reference external file paths | don't use sample files from untrusted sources |

**Recommendations:**

- Do not expose the local report server on the public internet (no auth)
- Don't use third-party eval-samples you haven't vetted
- Custom assertions have a 30-second timeout but no sandbox isolation

---

See [GitHub Releases](https://github.com/lizhiyao/oh-my-knowledge/releases) for release notes. Contributions welcome — see [CONTRIBUTING](./CONTRIBUTING.md).
