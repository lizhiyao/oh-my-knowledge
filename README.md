# OMK

[![npm version](https://img.shields.io/npm/v/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![npm weekly downloads](https://img.shields.io/npm/dw/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![CI](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml/badge.svg)](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/node/v/oh-my-knowledge.svg)](https://nodejs.org)

**English** | [简体中文](./README.zh.md)

**Observe. Measure. Know.** Make knowledge changes in your AI application evidence-backed.

OMK is a local knowledge workbench for AI application authors and maintainers. Inspect how real tasks ran, extract reviewable knowledge items from work logs, and measure changes to prompts, RAG, skills, agents, or workflows to inform adoption, rollback, and further improvement.

**Observe** preserves real behavior and its sources. **Measure** compares knowledge artifacts with the same model, cases, and execution conditions. **Know** connects decisions back to evidence. If you already have two artifact versions, start directly with evaluation; logs are not a prerequisite.

Version 1.0 is still **in Beta iteration**; APIs and storage contracts may change. Read the [migration guide](docs/guides/v1-preview-migration.md) before upgrading an older installation.

![OMK: from controlled evaluation to real-world feedback](./docs/public/omk-knowledge-flow-en-animated.gif)

## Start with your goal

| Goal | Entry point | What you get |
|---|---|---|
| Understand a real task | [Studio and task trajectories](docs/guides/observe-production.md) | Conversation, execution, results, and knowledge lanes with inspectable source records |
| Preserve knowledge from work | [Extract knowledge from logs](docs/guides/extract-knowledge.md) | Candidate knowledge with sources and conditions; revise, retain, or discard it |
| Record a confirmed knowledge problem | [MCP feedback](docs/guides/mcp-integration.md) | An observation for review; draft a case after confirming a real issue |
| Decide whether to adopt a change | [Evaluation quickstart](docs/quickstart-skill-eval.md) | A version decision, uncertainty, failed cases, and scoring evidence |
| Try improving a skill automatically | [Iterative improvement](docs/guides/auto-improve-skills.md) | Candidate versions screened through controlled comparisons |
| Embed evaluation in a service or platform | [Node.js service](docs/guides/eval-runtime.md) · [Platform host](docs/guides/platform-host-integration.md) | Composable execution, scoring, and comparison interfaces |

## Quick start

Installation requires Node.js >=22. Model calls also require an authenticated runtime; see [Requirements](#requirements).

```bash
npm i -g oh-my-knowledge@next
```

### Inspect an existing task

```bash
omk studio
```

Open the local URL returned by the command and select a local Codex conversation to inspect its task trajectory. No prior ingest or model call is needed; active tasks support live following. Claude Code, OpenClaw, and markdown logs enter observation reports through `omk observe`; see the [observation guide](docs/guides/observe-production.md).

To preserve reusable knowledge, choose “Extract knowledge from work logs” on the knowledge page. Select a workspace and a Codex log excerpt, inspect the source, then generate candidates. Generation calls a model. Retaining a candidate means you intend to maintain it, not that it is verified; it does not automatically update AGENTS.md or skills. See the [extraction guide](docs/guides/extract-knowledge.md).

### Or compare two skills directly

```bash
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

A knowledge item is a reviewable fact, experience, or method. An artifact is a prompt, document, skill, or other carrier of that content. Candidate knowledge describes content awaiting review; a candidate version describes a proposed artifact version.

1. **Observe and review**: inspect tasks and sources in Studio; extract knowledge or confirm observations, preserving conditions and review reasons.
2. **Prepare a measurable change**: manually apply selected content to an artifact and turn reproducible problems into evaluation cases. Candidates do not take effect automatically.
3. **Compare under control**: `doctor` performs preflight checks; `eval` compares control and treatment with a Decision, coverage, failed cases, and costs.
4. **Adopt or improve further**: use evidence to `promote` or `rollback` managed skills. `evolve` screens candidate versions through A/B gates and compares again before writing back.

These paths compose; they are not a mandatory linear state machine. Passing an evaluation does not mean knowledge has been written or a version published.

Conclusions depend on the cases, scoring criteria, and execution environment. Observation signals are not causal conclusions, and generated cases are not an independent release-validation set. See [statistical rigor](docs/explanation/statistical-rigor.md) and the [three-stage workflow](docs/explanation/three-stage-workflow.md) for the method and limits.

Project evaluation and observation evidence lives under `.omk/`; machine-level state lives under `~/.oh-my-knowledge/`. Extracted knowledge items live in the explicitly selected knowledge workspace. The current version neither reads nor migrates the old storage layout. Back up before upgrading and follow the [migration guide](docs/guides/v1-preview-migration.md) to establish new evidence.

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
