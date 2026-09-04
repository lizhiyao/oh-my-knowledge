<!--
title: Glossary — industry ML / stats terms and omk-specific names
description: A quick-reference glossary for omk docs readers. Covers industry-standard terms (bootstrap CI, Δ, Pearson, Krippendorff α, composite score, executor, reliability check) plus omk-internal naming (artifact, verdict, holdout). Each entry gives a one-line definition + where it shows up.
-->

# Glossary

omk docs (blog posts, SKILL.md, CLI output, report pages) freely mix industry-standard ML / statistics / measurement terms. These words are de facto standard in the English community, so this table is a quick-reference index: each entry gives a one-line definition + where it shows up in omk.

> **Scope**: a reader's cheat sheet, not a design spec. omk maintainers follow this vocabulary when writing new docs.
>
> **Sibling docs**: [terminology spec](../specs/terminology-spec.md) (maintainer-internal decision record) / [statistical rigor](../explanation/statistical-rigor.md) / [composite-score construct validity](../specs/scoring.md)

---

## 1. Statistics / measurement

| Term | One-line definition | Where it shows up in omk |
|---|---|---|
| bootstrap CI | Percentile confidence interval computed by resampling the registered sampling unit (1000 draws by default) | Core Bootstrap-family Analysis |
| Δ (delta) | Mean difference in composite score between treatment and control | Bootstrap comparison estimate and Studio projection |
| 95% CI | An interval from a procedure with 95% long-run coverage under its assumptions. A treatment-minus-control interval excluding 0 is directionally significant | Core Bootstrap-family Analysis |
| significant | The registered comparison interval excludes 0 at its effective family-corrected alpha | Core Decision evidence |
| Pearson r | Pearson correlation coefficient. 1 = perfectly aligned / 0 = unrelated / -1 = perfectly opposed | Judge-ensemble or Gold agreement diagnostics |
| MAD | Mean absolute difference among observed judge-member means for the same sample | Judge Ensemble Analysis |
| Krippendorff α | Agreement statistic using the registered interval-distance definition | Explicit Gold comparison or preregistered Agreement Analysis |
| effect size | The treatment-minus-control estimate on the registered score scale | Bootstrap comparison and practical-effect gate |
| variance | Dispersion across independent run-mean composite values | Evaluation Series Analysis |
| holdout (set) | Independent validation samples the skill never explicitly covered, used to guard against sample-set overfitting | post-evaluation follow-up recommendations |
| construct validity | Whether the measurement actually measures the intended thing (vs measurement error) | scoring.md: composite-score construct-validity argument |
| ad hoc | An implementation choice made without a principled justification — typically "ship it first, justify later" | scoring.md: equal-weight composite aggregation is ad hoc |
| sample-set overfitting | The evaluation set happens to be "already answered," inflating scores | scoring.md / evaluation blog caveat section |
| length debias | Correction for the known LLM-judge bias of scoring longer answers higher | on by default; disable with `omk eval --no-debias-length` |

---

## 2. omk evaluation concepts

| Term | One-line definition | Where it shows up in omk |
|---|---|---|
| [artifact](./artifact-layout.md) | The unified abstraction for omk's "thing under evaluation": skill / prompt / agent / workflow / baseline | determined by experiment role (`--control` / `--treatment` / baseline), not a standalone flag |
| [executor](./executors.md) | How the model is run: claude / codex / openai-api | `--executor` parameter; execution-environment fingerprint |
| ensemble (judge) | Multiple LLMs act as judges and score independently, then combine | `--judge-models claude:opus,claude:sonnet` |
| judge | An LLM scoring against a rubric | judge model parameter; evidence table |
| rubric | The detailed criteria a judge follows when scoring (must recognize X / must include Y / at least N items / ...) | rubric field in sample config |
| anchor | A method for calibrating the LLM judge against human standards | `--gold-dir` human anchors |
| gate (layer gate) | A registered treatment-layer threshold evaluated from authenticated Composite-layer evidence | Core release Decision |
| [verdict](../specs/scoring.md#decision-boundary) | One of six conclusions: PROGRESS / REGRESSION / CAUTIOUS / NOISE / UNDERPOWERED / SOLO | Core Report, CLI route, and Studio projection |
| sample (evaluation sample) | A single evaluation case | eval-samples.json |
| [eval-samples](./eval-sample-format.md) | The sample config file (each entry has prompt / rubric / assertion / capability) | `omk eval --samples` |
| baseline (reserved variant) | The empty-artifact variant; omk reserves this variant name, but it becomes the control only when selected for that experiment role | `--control baseline` |
| treatment | The experiment role compared with control; it may contain any artifact kind | `--treatment <name>` |
| control | The experiment role used as the reference side; it may contain a baseline or any other artifact kind | `--control <name>` |
| [composite (score)](../specs/scoring.md) | Equal-weight mean of observed present fact / behavior / judge layers on a 1-5 scale; zero observed layers is missing | Core Composite table and Studio projection |
| fact (layer) | Explicitly classified fact-criterion pass weight mapped to 1-5 | Assertion-layer Analysis |
| behavior (layer) | Explicitly classified behavior-criterion pass weight mapped to 1-5 | Assertion-layer Analysis |
| judge (layer) | Ensemble consensus or dimension aggregate bound as the judge source | Composite Analysis |
| dimension | An Analysis aggregate bound one-to-one to a Metric and upstream judge-ensemble result | Dimension Analysis |
| evidence coverage | Planned, observed, missing, invalid, failed, unavailable, and not-started evidence retained through lineage | Core Analysis and Decision gates |
| [managed record](../specs/evidence-gated-management.md) | A `.omk/governance/managed/<id>.json` fact record from `omk install` (source / contentHash / distribution / evidence / decisions) | `omk install`; evidence-gated management |
| lifecycle (installed / measurable / stale) | Read-time state of a managed skill: `installed` (no valid evidence) → `measurable` (eval evidence bound) → `stale` (content drifted off its evidence) | `deriveManagedState`; `omk eval` "→ measurable" |
| evidence (managed) | A `ManagedEvidenceRef` an eval run appends to a managed record, bound to the content fingerprint it measured (report id / sample coverage / verdict / comparability) | `omk eval` auto-write |

---

## 3. Machine learning / AI general

| Term | One-line definition |
|---|---|
| prompt | The input text given to an LLM |
| system prompt | Background instructions injected before user input; for evaluation omk injects the entire SKILL.md as the system prompt |
| agent | An AI that can call tools and run over multiple turns |
| workflow | A multi-step AI process orchestration |
| skill | One of omk's core evaluation targets, usually in the form of a `SKILL.md` |
| tool call | An external function the LLM invokes during execution |
| turn | One interaction unit of "LLM output + user/tool response" |
| context | All the history the LLM sees while generating |
| fingerprint | A stable runtime or content identity used to verify consistency and comparability across runs |
| session trace | The event stream of one complete AI conversation (prompt / tool calls / output / scoring), the object observe parses |

---

## 4. omk's three stages

omk's loop runs in three stages — **doctor** (preflight health) → **eval** (offline A/B + verdict) → **observe** (production traces) — together covering knowledge **evaluation + management + insight**. See [the three stages](../explanation/three-stage-workflow.md) for the full mental model.

---

## Writing conventions

The terms above are the shared vocabulary for omk docs. Detailed naming *decisions* for omk-internal terms (artifact / executor / variant / verdict, etc.) live in the [terminology spec](../specs/terminology-spec.md) (a maintainer archive). The Chinese docs additionally follow GB/T 15834 punctuation and a set of translation rules, documented in the Chinese glossary; they don't apply to English prose.
