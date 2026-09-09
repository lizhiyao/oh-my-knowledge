# omk quickstart: get to your first verdict

Use a demo to walk through “preview → evaluate → inspect evidence”, then switch to your own skill. Runtime and cost depend on the model, cases, and retries.

## Install and prepare a runtime

You need Node.js >=22 and an authenticated runtime: Codex CLI, Claude Code, or an API executor. See [Executors](./reference/executors.md) for setup.

```bash
npm i -g oh-my-knowledge@next
omk --version
```

This installs the actively evolving 1.0 Beta. Read the [migration guide](./guides/v1-preview-migration.md) before upgrading from 0.54.

Inside a Codex task, OMK defaults to Codex, reads the locally configured model, and reuses it as the judge. In a regular terminal you can select it explicitly:

```bash
export OMK_EXECUTOR=codex
```

Model selection, API credentials, and optional SDK prerequisites are documented in [Executors](./reference/executors.md).

## 1. Run the demo

```bash
omk init demo
cd demo
omk eval --control code-review-v1 --treatment code-review-v2 --dry-run
```

`init` creates two skills and three evaluation cases. `--dry-run` previews the execution plan and estimated calls. Check the plan before running the evaluation:

```bash
omk eval --control code-review-v1 --treatment code-review-v2
```

The real evaluation calls the model and runs a doctor check first by default. Cost and duration depend on the runtime; a preview is not a billing guarantee. Open Studio at the actual URL returned by the CLI, or use `omk studio` to browse past results.

Three cases check the workflow; `UNDERPOWERED` is expected. For the full starter set, use a new directory: `omk init demo-full --samples 20`. It covers four dimensions, varied difficulty, and no-defect controls. It produces 40 control/treatment executions, plus scoring and check calls.

**Starter cases are marked `provenance: llm-generated`.** Twenty cases meet only the default heuristic evidence floor, not an a priori power plan or a release-evidence requirement. Review and replace them with real domain cases before relying on the results.

## 2. Use your own skill

Prepare two versions in your own project:

```text
skills/
├── my-skill-v1.md
└── my-skill-v2.md
```

For accompanying references, use a directory such as `skills/my-skill-v2/SKILL.md`; see [artifact layout](./reference/artifact-layout.md). The variant name comes from the file or directory name, such as `my-skill-v2`.

```bash
omk sample skills/my-skill-v2.md
```

Review the generated criteria, weights, counterexamples, and boundary coverage. Use the same fixed cases for both versions. If you continue in the demo project, replace its cases rather than treating them as your own domain cases.

```bash
omk eval --control my-skill-v1 --treatment my-skill-v2 --dry-run
omk eval --control my-skill-v1 --treatment my-skill-v2
```

With only one skill, use `baseline` as the control to compare “without skill” against “with skill”. See the [sample format](./reference/eval-sample-format.md) for the schema and discovery rules.

## 3. Read the result and choose the next step

Start with the **verdict** and its reason codes, then inspect the difference Δ, the reported confidence interval, evidence coverage, and failed cases. A single comparison defaults to a 95% interval; comparison families adjust the confidence level. Evidence and policy gates also constrain the release decision.

| Verdict | Next step |
|---|---|
| `PROGRESS` | Evidence supports improvement. Review case representativeness and warnings before your release process; use `omk promote <name>` to record acceptance for a managed skill. |
| `CAUTIOUS` | Read the specific reasons and warnings, address them, and rerun; do not accept automatically. |
| `REGRESSION` | Diagnose failed cases and declining metrics, then reevaluate the revised artifact. |
| `NOISE` | Current evidence does not distinguish the difference. Review case discrimination and sample design before deciding whether to measure more. |
| `UNDERPOWERED` | Meet the declared sample-size requirement. Twenty comparable units is only a default heuristic floor; use external pilot assumptions for `decision.power` or register `decision.minimumComparisonUnits` for formal measurement. |
| `SOLO` | Add a control before making a cross-version decision. |

Conclusions apply only to these cases, criteria, and conditions. AI-generated cases can favor existing happy paths; add real failures, counterexamples, and misuse scenarios. Retain the report, case provenance, and human-review conclusions. Cases used during iteration are not an independent release-validation set. See [statistical rigor](./explanation/statistical-rigor.md) and [sample design](./specs/sample-design-spec.md).

## Use inside an agent

```bash
omk install omk-agent-skill
```

The default installs into detected supported targets: Codex/AGENTS for `~/.codex` or `~/.agents`, and Claude Code for `~/.claude`. `--to all` forces all currently known targets; `--dest` selects a custom skill root.

Explicitly use the OMK Skill in your agent and describe your goal, for example: “Use omk to compare skills/my-skill-v1 and skills/my-skill-v2; preview the plan first.” Claude Code can use its installed `/omk` entry; other hosts can ask the agent to execute the `omk` CLI. Review generated cases before running the real evaluation.

## Troubleshoot the first run

- **Model or authentication failure:** check runtime login, model name, and API endpoint; see [Executors](./reference/executors.md).
- **Doctor blocks the run:** fix the diagnosed artifact issues and retry. See the [CLI reference](./reference/cli.md) before deciding to skip the check.
- **Check assertions and reports only:** `--no-judge` skips the LLM judge, but target execution may still call a model. It is not an offline or free-run switch.
- **Preview fails:** resolve sample, path, or URL errors first; do not bypass them by starting a real run.

## Continue

[Auto-improve a skill](./guides/auto-improve-skills.md) · [Observe real tasks](./guides/observe-production.md) · [Node.js integration](./guides/eval-runtime.md) · [Documentation index](./README.md)

[Evaluation flow: from execution to decision](./explanation/architecture.md#single-run-evaluation-flow).
