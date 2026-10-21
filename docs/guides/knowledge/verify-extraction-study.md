# Verify extraction evidence and semantic review

Use this guide when you receive a frozen extraction study or need to check whether a change improves entity extraction. For ordinary candidate maintenance, start with [extract and maintain knowledge](extract-knowledge.md). Check its [capability tiers](extract-knowledge.md#availability) first: the installed inspection command described here belongs to current main, beyond published Beta.14.

## Inspect a received study without calling a model

Ask the study author for `evidence.json` and any original review receipts. The evidence contains selected source text and generated content; share it only with intended reviewers. Keep the original files and identities when you add another review.

```bash
omk observe knowledge study --evidence /absolute/study-report/evidence.json --json
```

The command verifies the frozen evidence and recomputes the report. It makes no model call, requires no model credentials or knowledge workspace, and does not resume or write extraction runs. Do not add `--workspace`, `--model` or generation flags. Input capacity comes from the [generated current contract](../../reference/shared/knowledge-contract.md); oversized inputs are rejected rather than truncated.

Add only the receipts you actually have; every receipt is optional, and missing evidence remains visible:

```bash
omk observe knowledge study \
  --evidence /absolute/study-report/evidence.json \
  --author-review /absolute/reference-author.json \
  --reference-review /absolute/reference-independent.json \
  --output-review /absolute/output-review.json \
  --judge-review /absolute/agent-judge-review.json
```

| Input | What it establishes |
|---|---|
| `--author-review` | The reference author's review of the frozen sources and reference obligations before outputs. |
| `--reference-review` | A separately arranged independent human's pre-output reference review. An author or another AI cannot supply independent human approval. |
| `--output-review` | Item judgments bound to the actual completed outputs. Human independence, timing, coverage and the declared gates are checked separately. |
| `--judge-review` | Saved AI-judge decisions and their declared model/prompt/configuration identity and separate usage; inspection does not execute the judge. |

In Studio, open candidate review and choose **Inspect study evidence** from the actions menu. Select the evidence and optional receipts, then inspect the source excerpts, output objects, exact quotes, judgments and missing targets. This also works without selecting a knowledge workspace. Results remain in the drawer and clear when it closes; selecting different files clears the previous conclusions. Portable identities do not become editable objects in the active workspace.

## Read the result before deciding

A zero exit code means inspection completed; it does not mean the extraction passed semantic review. Read the engineering, reference, output-review and calibration states separately.

| Result | Interpretation and next step |
|---|---|
| `pending` | Review or evidence is incomplete. Inspect missing/uncertain targets and collect the actual receipts. |
| `blocked` | A declared gate, evidence check or semantic obligation failed. Inspect its reason; keep the failed observation. |
| `exploratory_reviewed` | Exploration was reviewed, without independent human acceptance. Use it to identify candidate fixes. |
| `accepted_within_scope` | The declared frozen scope met its independent-review and applicable gates. This is not population accuracy or general release eligibility. |

`goldReady` concerns reference readiness; it cannot replace independent output review. Exact quote locations, valid structure and accepted writes do not prove correct meaning or complete extraction. Review every output's description, qualifiers and mention rationale as well as required omissions. Preserve source assertions, context, actor roles and unknown fact times rather than treating them as externally verified facts.

For `critical_only` references, report finite required-object/mention coverage and errors; overall matching precision, recall and F1 remain unavailable. An `unannotated` set supports engineering capture and exploration only. Fully annotated independent references may support matching metrics within their declared finite scope. Repeated windows from one conversation are not independent samples; source grouping, seen/unseen exposure and development/validation splits still constrain the conclusion.

Keep planned, completed, failed, cancelled and unattempted slots visible. Invocation attempts and returned native outcomes are different counts. Report known usage/cost and its coverage; unknown values stay unknown, and provider-internal requests are not inferred. Reviewer effort and model-judge usage are separate from generation cost. Missing verified completion time also limits post-completion review, matching metrics and calibration.

## Prepare a new study in the repository

Study execution and receipt preparation are repository tools, not additional installed `omk` generation commands. Use the [contributing workflow](../contributing.md) to install dependencies and build the runtime. Freeze the final runtime before handing formal references to reviewers. Historical studies require their original frozen environment when host identity differs; do not rewrite their evidence to fit today's build.

1. Select and authorize the real source windows, including their transmission destination. Capture sources using the [ordinary source workflow](extract-knowledge.md); local capture does not authorize model transmission.
2. Before outputs, declare project/conversation/lineage grouping, exposure, reference scope and allowed equivalents. Keep development and validation independent. For formal semantic acceptance, arrange author and independent human reference reviews before outputs. Engineering-only development exploration can proceed without that human receipt, keeping reference readiness and formal acceptance incomplete. Preserve disagreements rather than filling human attestations with AI output.
3. Declare the compared variable, model, policy, repeats, loss-based thresholds, budget rationale, stopping and interruption rules. A replication uses the same condition twice; it does not create an old/new version comparison. Follow the [corpus and configuration contract](../../specs/entities/entity-extraction-study.md) for the complete input shapes.

Prepare a new plan from the existing snapshots and independently prepared corpus/configuration:

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-study.js prepare \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --corpus /private/tmp/study-corpus.json \
  --config /private/tmp/study-configuration.json
node dist-scripts/bench/knowledge-study.js report \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --output /private/tmp/new-reference-handoff
```

Both commands make zero model calls. Producer inspection can require configured credentials; it does not save secrets as study configuration. Study/report output directories must be new explicit absolute paths outside the checkout and selected workspace, with existing parents; do not overwrite an earlier report.

The handoff's `report.json` contains `referenceAuthorTemplate`, `independentReferenceTemplate` and `outputReviewTemplate`. For formal reference acceptance, extract the first two as separate JSON receipts and have the actual reviewers fill them before outputs. Blank identities/times/decisions are deliberately invalid. The software checks declarations and chronology, without authenticating a person or proving their judgment correct. An output template made before generation is not a completed-output review.

Only `run` sends selected content. Read the exact `planId`, selected slot and frozen request before authorizing it; substitute the real values from `plan.json`:

```bash
node dist-scripts/bench/knowledge-study.js run \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --slot '<slot-id>' --authorize-plan 'sha256:<plan-id>'
```

Run only the authorized planned slots under the frozen stopping rule. Repeating an already started run performs recovery without generation; unknown interruption does not authorize resending or refunding usage. Change a prompt, policy or timeout by declaring a new study, preserving the old results and remaining slots. A new plan does not justify replacing unfavorable slots or selecting only favorable observations; disclose adaptive changes and retain prior stopping and cost evidence.

After capture, run `report` again into another new directory. Use its fresh output-bound template to review all output entities, mentions, knowledge statements, reference obligations, semantic checks and cases. Complete disputes explicitly; do not widen references after seeing outputs. Add completed receipts with `report --author-review ... --reference-review ... --output-review ...`, or use the installed read-only command above on the exported `evidence.json`. Engineering-only reports remain valid evidence with semantic acceptance incomplete.

## Compare reviewers and keep unresolved work visible

Arrange independent humans when formal acceptance is needed. AI can screen outputs and organize review, while its judgments remain separately identified. Judge calibration compares saved AI decisions against independent human decisions on the same outputs; complete coverage alone does not certify the judge or demonstrate quality improvement.

For multiple raters, declare the roster and separate adjudicator before judgments if using a prospective panel. A declaration after judgments must be retrospective; missing/uncertain judgments stay in coverage, and observed agreement is not correctness. The [multi-rater handoff](../../specs/entities/entity-extraction-study.md#_7-independent-multi-rater-output-panels) gives the repository-only panel commands, original-receipt inventory and adjudication procedure. Adjudication preserves initial disagreements and agreement statistics; it does not change `goldReady` or replace semantic acceptance.

If reviewers or independent validation are unavailable, report the completed engineering work and explicit semantic blockers. Do not close that gap with synthetic examples, nearby renamed conversations, another model, green CI or a zero exit code. See the [semantic review protocol](../../specs/entities/entity-extraction-semantic-review.md) for review targets and evidence limits.
