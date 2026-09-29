# OMK

[![npm version](https://img.shields.io/npm/v/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![npm weekly downloads](https://img.shields.io/npm/dw/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![CI](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml/badge.svg)](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/node/v/oh-my-knowledge.svg)](https://nodejs.org)

**English** | [简体中文](./README.zh.md)

**Observe. Measure. Know.** Make knowledge changes in your AI application evidence-backed.

OMK is a toolkit for observing, evaluating, and improving knowledge in AI applications. Inspect how real tasks ran, extract reviewable knowledge items from work logs, and measure changes to prompts, RAG, skills, agents, or workflows to inform adoption, rollback, and further improvement.

**Observe** preserves real behavior and its sources. **Measure** fixes models and cases, controls and records execution conditions, and compares knowledge artifacts. **Know** connects decisions back to evidence. If you already have two artifact versions, start directly with evaluation; logs are not a prerequisite.

Version 1.0 is still **in Beta iteration**; APIs and storage contracts may change. Read the [migration guide](docs/guides/v1-preview-migration.md) before upgrading an older installation.

![OMK: from controlled evaluation to real-world feedback](./docs/public/omk-knowledge-flow-en-animated.gif)

The diagram describes composable workflows: review knowledge and manually apply it to an artifact. Complete links across these stages and an automated end-to-end workflow remain partly unimplemented.

## Choose how to use OMK

| Interface | Use it for |
|---|---|
| **CLI** | Run checks, evaluations, observation, and improvement workflows from a terminal, coding agent, or CI |
| **Studio** | Browse task trajectories, review knowledge items, and inspect reports and source evidence in a local workbench |
| **eval-runtime** | Embed execution, scoring, and version comparison in your Node.js service or platform, without going through the CLI or starting Studio |
| **DSH plugin** | Use `/omk eval` and `/omk observe` inside DeepSeek Harness with the current profile’s model, credentials, tools, and sandbox; see [host plugin setup](docs/reference/executors.md#deepseek-harness-prefer-the-host-plugin) |

## Start with your goal

| Goal | Entry point | What you get |
|---|---|---|
| Understand a real task | [Studio and task trajectories](docs/guides/observe-production.md) | Conversation, execution, results, and knowledge lanes with inspectable source records |
| Preserve knowledge from work | [Extract knowledge from logs](docs/guides/extract-knowledge.md) | Candidate knowledge with sources and conditions; revise, retain, or discard it |
| Record a confirmed knowledge problem | [MCP feedback](docs/guides/mcp-integration.md) | An observation for review; draft a case after confirming a real issue |
| Decide whether to adopt a change | [Evaluation quickstart](docs/quickstart-skill-eval.md) | A version decision, uncertainty, failed cases, and scoring evidence |
| Verify that an agent completed a task | [Local task acceptance](docs/guides/local-tasks.md) | Modified files, independent checks, and diagnostics after failure, timeout, or cancellation |
| Try improving a skill automatically | [Iterative improvement](docs/guides/auto-improve-skills.md) | Candidate versions screened through controlled comparisons |
| Embed evaluation in a service or platform | [Node.js service](docs/guides/eval-runtime.md) · [Platform host](docs/guides/platform-host-integration.md) | Composable execution, scoring, and comparison interfaces |

## Quick start

Installation requires Node.js >=22. Model calls also require an authenticated runtime; see [Requirements](#requirements).

```bash
npm i -g oh-my-knowledge@next
```

Local task acceptance requires `1.0.0-beta.13` or later. Check `omk --version` after installation, then follow the [local-task guide](docs/guides/local-tasks.md) to run a trusted example.

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

### Verify the actual file changes

Local tasks run two knowledge variants from declared file snapshots, collect files, and check them with an independent verifier. Failures, timeouts, and cancellations also retain declared files and partial logs. This measures explicitly supplied knowledge content, not native skill discovery. Tasks and verifiers must be trusted; workspace copies are not security sandboxes.

The [cart example with an npm dependency](examples/local-task/project/README.md) records one real Codex run: treatment changed the target source and passed six checks; the negative control, instructed not to edit, passed three. This establishes a working execution and acceptance path, not general knowledge effectiveness. Model settings, usage, and durations are recorded in the example. The [local-task guide](docs/guides/local-tasks.md) covers installation, configuration, and evidence access.

## Use inside agents and DSH

### Agent Skill and MCP

```bash
omk install omk-agent-skill
```

Install the Skill, then ask your coding agent: “Use omk to compare these two skills; preview the plan first.” See the [quickstart](docs/quickstart-skill-eval.md#use-inside-an-agent) for installation targets and usage.

The [MCP integration](docs/guides/mcp-integration.md) accepts user-authorized knowledge feedback. It records partial evidence submitted at its tool boundary; it does not automatically monitor complete conversations.

### DeepSeek Harness plugin

If you already use DSH, add OMK to an existing profile. For example, use the command-enabled `web` profile:

```bash
dsh plugin --profile web add oh-my-knowledge
dsh --profile web
```

Inside DSH, run:

```text
/omk eval eval.yaml
/omk observe
/omk observe <session-id>
```

Evaluation reuses the host’s model, credentials, tools, and sandbox, creating an isolated session for each case. Observation reads snapshots of completed sessions and returns a Studio task-trajectory URL; it does not currently live-follow running DSH sessions. See [DSH integration](docs/reference/executors.md#deepseek-harness-prefer-the-host-plugin) for configuration requirements and current plugin limitations.

## Use the evidence

A knowledge item is a reviewable fact, experience, or method. An artifact is a prompt, document, skill, or other carrier of that content. Candidate knowledge describes content awaiting review; a candidate version describes a proposed artifact version.

1. **Observe and review**: inspect tasks and sources in Studio; extract knowledge or confirm observations, preserving conditions and review reasons.
2. **Prepare a measurable change**: manually apply selected content to an artifact and turn reproducible problems into evaluation cases. Candidates do not take effect automatically.
3. **Compare under control**: `doctor` performs preflight checks; `eval` compares control and treatment with a Decision, coverage, failed cases, and costs.
4. **Adopt or improve further**: use evidence to `promote` or `rollback` managed skills. `evolve` screens candidate versions through A/B gates and compares again before writing back.

These paths compose; they are not a mandatory linear state machine. Passing an evaluation does not mean knowledge has been written or a version published.

Fixed configuration cannot guarantee identical external model services or rerun outcomes. Conclusions depend on the cases, scoring criteria, and execution environment. Observation signals are not causal conclusions, and generated cases are not an independent release-validation set. See [statistical rigor](docs/explanation/statistical-rigor.md) and the [three-stage workflow](docs/explanation/three-stage-workflow.md) for the method and limits.

Project evaluation and observation evidence lives under `.omk/`; local tasks default to `.omk/eval`, with `--output` selecting another report and diagnostic directory. Machine-level state lives under `~/.oh-my-knowledge/`. Extracted knowledge items live in the explicitly selected knowledge workspace. The current version neither reads nor migrates the old storage layout. Back up before upgrading and follow the [migration guide](docs/guides/v1-preview-migration.md) to establish new evidence.

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
| **Local tasks and verifiers** | Executors and independent verifiers run local code; raw artifacts / logs may contain sensitive information | Use reviewed tasks, inspect file lists and output directories; copies are not security sandboxes |
| **eval-samples.json** | assertion configs can reference external file paths | don't use sample files from untrusted sources |

**Recommendations:**

- Do not expose the local report server on the public internet (no auth)
- Don't use third-party eval-samples you haven't vetted
- Custom assertions have a 30-second timeout but no sandbox isolation

---

See [GitHub Releases](https://github.com/lizhiyao/oh-my-knowledge/releases) for release notes. Contributions welcome — see [CONTRIBUTING](./CONTRIBUTING.md).
