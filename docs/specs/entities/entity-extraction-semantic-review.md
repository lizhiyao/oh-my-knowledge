---
description: Offline itemwise semantic review of frozen entity-extraction outputs and conservative scoped decisions.
---

# Entity extraction output semantic review

This specification owns the responsibility matrix and the offline review of **captured generated outputs**. The [extraction evaluation protocol](./entity-extraction-evaluation.md) keeps its existing annotation, capture, checker and pre-output reference-review contracts. The [identity rules](./entity-identity.md) and [extraction contract](./entity-extraction.md) remain the sources of domain meaning and execution invariants; this page does not redefine them.

The first implementation covers already captured public synthetic regressions. It does not execute models, modify production runs or histories, change prompts, or establish independent real-world semantic acceptance. The original outputs, structural rejections and old conclusions remain intact. A new review is a separately identified analysis of that evidence.

## 1. Rule, responsibility, examples and versions

The table maps existing rules to their execution and verification responsibilities. Examples illustrate the boundary; they are neither new reference annotations nor evidence of model quality. Full positive and negative examples stay in the linked rule owner.

| Rule owner | Deterministic execution and verification | Contextual review responsibility | Positive / negative boundary |
|---|---|---|---|
| [Object scope and granularity](./entity-identity.md) | Validate the declared entity structure and closed references; do not decide object meaning from a name blacklist. | Review every accepted entity for source support, independently discussed concepts, properties and excessive splitting; inspect omissions at case level. | Keep an independently discussed Session concept / do not create an entity for every count or value. |
| [Issue/PR collection scope](./entity-identity.md) | Preserve sources and knowledge context through explicit correction; do not strip identifiers to manufacture concepts. | Distinguish Issue/PR concepts from individual numbered work records under the current collection scope. This is not a universal exclusion of specific objects. | Keep a discussed PR concept and a record link in case context / do not create an entity for PR #1282 solely because it is named. |
| [Mention boundaries and ownership](./entity-identity.md) | Check exact source quotes, occurrence, UTF-16 positions and duplicate assignments. | Check that the selected phrase denotes the intended object and retains required owners and qualifiers. An exact span alone cannot establish this. | A qualified file phrase denotes the file / do not assign that whole phrase to its project. |
| [Coreference and ambiguity](./entity-identity.md) | Check identity/reference closure, allowed candidate levels and structural uncertainty constraints. | Check aliases, pronouns, homonyms and unsupported resolution against the complete source window. Independent human identity decisions remain separately attributable. | Preserve an ambiguous reference with reasons / do not select one same-named candidate without evidence. |
| [Referential levels and links](./entity-identity.md) | Check component/member references, supported levels, cycles and required mentions. | Check component/instance/version/collection meaning and whether qualifiers or outcomes were transferred without support. | Keep an instance's failure with that instance / do not give it the component's success. |
| [Knowledge endpoints and coverage](./entity-extraction-evaluation.md) | Locate accepted statements, source anchors and declared roles; preserve required versus optional coverage. | Review subjects, objects, relation direction and all required information; distinguish missing mandatory knowledge from unselected optional knowledge. | Preserve a field's value, type and conditions in selected knowledge / do not count an endpoint hit as complete knowledge. |
| [Polarity, modality, conditions and exceptions](./entity-extraction-evaluation.md) | Validate representations and bindings; no keyword classifier supplies a semantic pass. | Check each statement as a single proposition with uniform polarity/modality, including scope and exceptions. | Separate completed delivery from quality still unaccepted / do not combine them into one positive completion statement. |
| [Time and evidence level](./entity-extraction-evaluation.md) | Validate time/evidence structures and citation closure. | Distinguish message time from fact time, plans from execution, and source assertions from observations or externally verified truth. | Keep fact time unknown when unsupported / do not turn a message timestamp into an exact event time. |
| [Corrections, conflicts and history](./entity-extraction.md) | Preserve immutable originals, exact revision bindings, explicit new revisions and rejection/recovery paths. | Check later corrections, unresolved conflicts and retained speaker attribution; a correction must not strengthen the original evidence. | Correct attribution with a new revision and its evidence / do not reuse an old identity for a different object or overwrite a birth result. |
| [Metadata and truncated sources](./entity-extraction-evaluation.md) | Preserve the frozen input and its declared limitations. | Check instruction/metadata contamination, incomplete context and unsupported completion; evidence absent from the window remains unknown. | Label an environment message as metadata / do not treat it as a fact asserted by the user. |

Domain rules use guide `omk-entity-annotation/v11` and corpus `omk-entity-quality/v13`; deterministic critical checks remain `omk-entity-critical-checks/v5`. Production prompt-json `knowledge-extraction-v29`, strict `knowledge-extraction-v30`, response Schema v4, run v5 and quality projection v4 keep their separate identities; v4 separately records human sealing with execution unknown, without reinterpreting historical admission. The new output-review protocol has its own v1 identities. Adding it does not silently upgrade the old guide, recalculate historical scores or migrate stored runs. Temporal, referential-context, core-object and whole/part guidance and demonstration-byte changes explicitly declare **BREAKING-COMPARABILITY**, not semantic acceptance; itemwise time, identity and qualifier review remains necessary.

The v29/v30 source-claim guidance changes prompt rules and the output self-check within the same invocation with **BREAKING-COMPARABILITY**. All eight wire demonstrations and registered v19–v28 raw-byte constraints remain unchanged; no invocation stage, public Schema, storage, wire or policy change is introduced. The existing guide/checker identities and 64-case/212-critical-mention denominator are retained. Changed current guide-page bytes require fresh measurement digests and a newly frozen package, without rewriting historical evidence or claiming model acceptance.

## 2. Freeze the review scope before outputs

`omk-entity-semantic-plan/v1` contains `measurementId`, `declaredAt`, `split`, `repeats`, every selected `caseId`, `criteria` and its derived `planId`. The criteria require all four fields: `maxConfirmedErrors`, `confirmedErrorsRationale`, `maxRequiredGaps` and `requiredGapsRationale`; there are no default tolerances. Existing capture v1 supports development/validation and one or two repeats. These are format limits, not a statistical sample-size justification. The measurement resolves the original corpus, bilingual guide, checker, prompt, runtime, dependencies and Node environment. All planned cases and predeclared obligations stay visible; selecting only successful outputs is not an admissible plan.

The checker requires the declared plan time to be no later than the capture start time. The `prepare` command uses the current time and rejects a bundle that already contains `captures.json`; it cannot inspect every external copy of previously seen output. Existing `omk-entity-captures/v1` records contain no semantic plan identifier. The offline check therefore binds the declaration time and the **exact capture-file byte digest**; it cannot prove that the original transport or execution enforced this plan. This auditable limitation remains in the result. Reusing existing captures is reanalysis, not new model execution, a fresh independent sample or retroactive preregistration.

The frozen source, reference and capture bytes remain available. Plan changes produce a different `planId`; changed review decisions require a new external result directory, preserving the old receipt and report. Changes to output-review receipts, reference receipts or compiled semantic-tool bytes produce a different derived `reportId`. Semantic protocol changes require an explicit version change rather than reusing an old conclusion. They do not replace original evidence or make a viewed case unseen. This tool does not authorize data transmission, model calls or retries.

| Identity | Owns |
|---|---|
| `omk-entity-semantic-plan/v1` | Declared measurement, cases, repeat scope and explicit tolerance criteria; `planId` is derived from the plan body. |
| `omk-entity-output-review/v1` | Reviewer declarations and itemwise verdicts bound to the plan and exact capture digest. |
| `omk-entity-semantic-report/v1` | Derived scoped decision, review coverage, blockers and evidence limits; `toolDigest` records the compiled semantic-tool bytes, and `reportId` binds the complete derived report. |

## 3. Review every output and obligation

Itemwise review covers every accepted entity, mention and knowledge statement, every predeclared role, every case semantic criterion, and the case as a whole. Output units bind the precise captured case/repeat and item identity. Required role gaps, extractions outside scope and case-level omissions must remain reviewable even when the returned item count is small or knowledge is empty.

Review each item against the full frozen window, recording a decision and a concrete rationale. A correct source quotation does not prove correct meaning. A statement review includes endpoints, relation, polarity, modality, conditions, exceptions, time, citations and assertion/observation/plan status. Rejecting one item structurally can cause dependent rejections; these remain engineering evidence rather than multiple independently established semantic errors.

Referential-context review uses the existing `identity` and `unsupported_qualifier` error codes. Check each entity's description, qualifiers, mentions and rationales against the full window. Merging an isolated example, hypothetical or counterexample object into the current object is an identity defect; transferring a version or other property from another context is an unsupported qualifier. Preserve one identity when the source explicitly refers to the same object across a quotation, rather than splitting automatically. Keep an uncertain decision when correspondence cannot be confirmed. Exact quotations and structural admission do not establish these judgments.

Review whole/part boundaries by the actual referent, without mapping a part to its owner through a shared name, qualifiers or a containing span. A part's mention can be exact and correctly bound while a predeclared whole remains missing; the part's independent entity eligibility can separately remain uncertain. Confirm whole coverage only when the source independently discusses it and the reference declares the obligation, rather than forcing a split for every ownership phrase. Record affected decisions and their shared omission mechanism without treating multiple targets as independent error samples or rewriting references and old conclusions after output.

Review source faithfulness in every description, qualifier and mention rationale, even when the quote and object binding are correct. `basis: explicit` supports the existence of a direct referring expression, not every associated field. A shared review or PR does not establish containment, ownership or who originated an idea. Separate a source-unsupported assertion from whether that assertion happens to be true outside the window: the latter being unknown does not make the former uncertain. Record affected output decisions and the shared mechanism separately, using the existing semantic error vocabulary rather than new scoring rules.

Interpret phrases as a whole before classifying them. A source designation, complete span or reference to the whole may have a supported reading without asserting a complete component or canonical name; retain uncertain when materially different readings remain unresolved. An invented canonical identifier or an otherwise clear unsupported assertion must still be recorded as incorrect. Do not use a keyword rule, turn unresolved semantics into a pass, or let a correct locator excuse an unsupported rationale.

`omk-entity-output-review/v1` binds `planId` and `capturesDigest`, and records `reviewer: { actorKind, actorId }`, `independentHuman`, `reviewedAt` and `decisions`. `actorKind` is `agent` or `human`; an agent cannot attest independent human review. Each decision binds a `target`, a `verdict`, `errorCodes` and a nonempty `rationale`. The target always includes `caseId`, `repeat` and `itemKind`:

| `itemKind` | Additional identity |
|---|---|
| `entity` | `entityId` |
| `mention` | `mentionId` |
| `statement` | `proposalId` and `statementId` |
| `role` | Predeclared `roleKey` |
| `semantic_check` | Zero-based `checkIndex` |
| `case` | None; reviews the entire case/repeat |

The verdict vocabulary is `correct`, `incorrect`, `uncertain`, `required_missing` and `optional_not_selected`; a verdict must be valid for its target rather than a shortcut to skipping output review. The protocol validates coverage and declarations, not a person's real identity or the correctness of their judgment. A reviewer declares their role explicitly. An AI review can identify defects and support exploration; it cannot supply independent human approval. Independent reviewer declarations and reference readiness do not establish the truth of a source claim. Unresolved disagreement and missing review stay explicit.

Existing `omk-entity-captures/v1` has only `startedAt`, with no completion/archive timestamp. Capture checking rejects a start later than the checking clock; an output receipt is checked only against `capture.startedAt <= reviewedAt <= now`, which cannot establish review after every output completed. Output review here identifies the captured output being reviewed, not verified post-completion signing. Times and independence are attestations, not proof that a human read the evidence or judged correctly; never invent an old capture's completion from the current time, file mtime or an estimate. Changed checking-tool bytes produce new measurement/derived-report identities; old captures and readiness conclusions remain intact and require their original frozen build.

## 4. Conservative decisions

The result uses these four states. A known blocking condition takes precedence over pending review.

| State | Required evidence and limits |
|---|---|
| `pending` | No receipt, missing target decisions or unresolved `uncertain` decisions; no known blocker. |
| `blocked` | A known engineering/reference/plan blocker, a critical semantic error, or the planned error/gap threshold exceeded. Missing review cannot hide a known blocker. |
| `exploratory_reviewed` | Complete, determinate itemwise review within the declared limits, but only agent/author review or missing independent reference readiness. This is not independent acceptance. |
| `accepted_within_scope` | All engineering and semantic gates, the original two-record reference readiness, and a complete output review declared by an independent human other than a corpus author. |

Engineering blockers include call/parse/capture failures, structural rejection, cancellation, unattempted records and a plan declared too late. The original critical-mention/identity checks must satisfy the frozen regression gate; non-evaluable units cannot supply passing evidence. A reference record requesting changes blocks review rather than being overridden by an output receipt.

`countingUnit: review-decision` counts `incorrect` decisions as confirmed errors and `required_missing` decisions as required gaps. These are review-decision counts, not independent root causes or population accuracy. `optional_not_selected` applies only to `if_selected` roles and adds neither error nor gap. The error-code vocabulary is `scope`, `boundary`, `identity`, `referent_kind`, `unsupported_qualifier`, `relation`, `polarity`, `modality`, `conditions`, `time`, `coverage`, `provenance` and `unsupported_fact`. An `incorrect` decision containing `identity`, `provenance` or `unsupported_fact` always blocks acceptance even when an aggregate allowance would permit it. Other errors and required gaps are compared with the plan's explicit limits and rationale, never hidden by an average score.

`goldReady` continues to mean the old **pre-output reference annotation** readiness. This protocol does not rebuild or overwrite that flag. AI-only output review cannot produce independent acceptance; its highest nonblocking conclusion is exploratory review. `accepted_within_scope` applies only to the declared finite synthetic regression scope and the evidence supplied for it. It does not establish representative real-world precision/recall/F1, release readiness, independent real-world acceptance or a verified fact base.

Structural success, semantic faithfulness, identity confirmation, knowledge retention and external truth verification remain separate conclusions. Corrections do not improve the original run's birth quality. A missing optional item is not an error or evidence of a successful knowledge relation; missing required knowledge remains a gap.

## 5. Offline execution and retained evidence

Build the runtime/scripts, then declare a plan using an existing pre-output review bundle and a policy JSON containing the four criteria fields:

```bash
yarn build:runtime
node dist-scripts/bench/entity-semantic-review.js prepare \
  --bundle /private/tmp/existing-entity-review-bundle \
  --policy /private/tmp/semantic-policy.json \
  --split development --repeats 1 \
  --output /private/tmp/new-semantic-plan
```

After capture, enumerate the exact review targets and obtain the pending report/template without a receipt:

```bash
node dist-scripts/bench/entity-semantic-review.js review \
  --bundle /private/tmp/existing-entity-review-bundle \
  --plan /private/tmp/new-semantic-plan/plan.json \
  --captures /private/tmp/captures.json \
  --output /private/tmp/new-semantic-pending
```

Complete the template with actual itemwise judgments, preserving the original template. Repeat `review` with `--receipt /private/tmp/completed-output-review.json` and a different new external output directory. Neither a blank template nor a copied declaration establishes review.

The command has no executor/model/endpoint parameter and makes zero model calls. It verifies the original measurement manifest, raw UTF-8 corpus and bilingual guide, original compiled checker, runtime/prompt bytes, dependencies and Node version; a mismatch requires the original build rather than silently rechecking with current rules. It recomputes structural admission with the fixed production validator instead of trusting stored check results or ready flags.

`prepare` writes only `plan.json`. `review` preserves exact `plan.json`, `captures.json` and `corpus.json`, and writes `review-targets.json`, `review-template.json` and `report.json`; a supplied receipt is preserved verbatim as `output-review.json`. Existing author/independent reference receipts are copied verbatim as `reference-self-review.json` and `reference-review.json`; `report.referenceReceiptDigests` records their digests, or `null` when absent. `outputReviewDigest` is the SHA-256 digest of the supplied output receipt's original UTF-8 bytes, or `null` when absent. `reportId` is the SHA-256 digest of `JSON.stringify` applied to the complete report object excluding `reportId` itself, including receipt digests and `toolDigest`. Retain the original bundle as well, including its guide and reference-review records. Output directories must be new absolute paths outside the repository with an existing parent; repository-resolving symlinks and overwrites are rejected. Directories use mode `0700` and files `0600`. No old capture, production workspace or history is modified.

Standard output is one JSON result containing `output`, `status`, `modelCallsByThisCommand` and `exitCode`. A prepared plan exits zero. A review exits zero only for `accepted_within_scope`; `pending`, `blocked` and `exploratory_reviewed` exit nonzero while preserving the report. Invalid data, identity or paths exit nonzero rather than producing a pass.

The report keeps engineering failures, pending units, semantic errors and required gaps distinct. Cost, usage and duration come only from original capture records; missing values remain unknown. Reviewer work and any later model-judge calls need separate evidence and must not be represented as original generator cost.

## 6. Evidence still required for real acceptance

Independent real-world acceptance needs separately authorized real sources that were not used to tune the candidate, documented project/conversation/source grouping and duplicate lineage, frozen reference obligations and allowed equivalents, risk-based metrics and thresholds, and a justified sample size/stop policy. Public synthetic cases, nearby copied/redacted windows and a second review of seen outputs do not supply that independence.

A genuinely independent person must review the references and generated outputs, resolve disputes, and calibrate any semantic model judge against those human decisions before a judge-derived quality claim is made. AI screening, another model or green CI cannot replace that evidence. Existing [statistical methods](../../explanation/statistical-rigor.md) may be reused when their sampling-unit and metric assumptions hold; correlated mention pairs are not independent samples, and zero observed errors does not imply zero risk.

Engineering can prepare these bundles, deterministic checks and reports autonomously. Until the required independent evidence exists, keep real semantic acceptance incomplete and report the observed scope and remaining limits. Production CLI/Studio presentation and a locked real baseline/candidate study are separate follow-up delivery boundaries.
