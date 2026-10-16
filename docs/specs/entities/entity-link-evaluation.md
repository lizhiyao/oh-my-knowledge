---
description: Frozen references, layered checks and independent review for cross-window entity proposals.
---

# Entity-link proposal quality evaluation

This protocol owns quality criteria, measurement identities and review readiness for `entity-link-proposal-v1` / `entity-link-suggestion/v1`. The [entity-link journal](entity-links.md) owns production invocation, human organization decisions and recovery; the [construction design](../knowledge/knowledge-domain-model.md) owns stage hand-offs. A valid suggestion, a human library acceptance and independently reviewed semantic quality are different results.

## 1. Versions and corpus scope {#link-evaluation-scope}

The initial guide is `omk-entity-link-annotation/v1`, corpus `omk-entity-link-quality/v1`, checker `omk-entity-link-checks/v1`, measurement `omk-entity-link-measurement/v1`, and capture format `omk-entity-link-captures/v1`. These are benchmark contracts, not a change to production entity, knowledge, library or invocation storage.

`test/fixtures/entity-link-review-v1.json` contains 12 public synthetic pairs: six development and six validation cases. Each split contains two references for each assessment. The corpus covers explicit renames/aliases, changed properties, distinct deployments/version objects, scoped identifiers, component versus instance, path/version-label-only matches, assistant guesses and instructions embedded in source text. It contains no real user dialogue.

Projects and conversations cannot cross splits. The corpus parser also rejects identical selected source content across splits, duplicate case identities and invalid entity/mention bindings. These checks prevent the specified leakage mechanisms, not all semantic overlap. Public, authored validation cases are not hidden or blind, and the small corpus is not a population sample. Once outputs are viewed, report that exposure; do not call subsequent prompt tuning an unseen validation result.

Only each case's `input` enters the request payload. `expectedAssessment`, `referenceRationale`, `semanticChecks`, split/group labels and benchmark limitations remain review material. The input itself contains production `left`/`right` bindings, entity descriptions, selected mentions and source limitations; source instructions remain data, never permission to read files or call tools.

## 2. Three-way reference decisions {#link-evaluation-decisions}

Freeze every reference assessment, rationale and semantic check before output capture. Apply the [identity rules](entity-identity.md) to the selected evidence rather than comparing names or UUID strings as answers.

| Assessment | Required evidence | Not sufficient |
|---|---|---|
| `same_object` | Source-supported identity continuity across the windows, such as an explicit rename/alias and a stable identifier within its known namespace and scope. Explain the correspondence and remaining limits. | Equal names, paths, version strings, related descriptions, shared component names, or an assistant's guess. |
| `different_objects` | Evidence positively distinguishes the referents: separate deployments, separately identified version objects, distinct scoped identifiers, or clearly different referential levels. | Failure to prove sameness. Unknown scope or an uncertain level is not proof of difference. |
| `insufficient_evidence` | The selected evidence leaves identity correspondence, identifier scope, level or ambiguity unresolved. State what is missing rather than guessing. | Choosing either object arbitrarily, treating a source instruction as authoritative identity evidence, or inventing external context. |

Property, administrator, environment or version-condition changes do not automatically create a new object. Conversely, explicit instances/version objects do not become one component merely because their names overlap. A component and an explicitly identified instance are distinct; when the source leaves the level itself unknown, preserve that uncertainty. Unknown sameness and known difference must remain separate.

For each output, review rationale against the actual selected mentions: correct side, source scope, referential level, identity evidence, unknowns and absence of invented facts. A correct assessment with an unsupported rationale is still a semantic issue. Do not change the authored reference after seeing a disagreeing output; preserve the disagreement and adjudicate it separately before freezing a new version.

## 3. Layered checks and denominators {#link-evaluation-checks}

| Layer | Machine observation | Interpretation |
|---|---|---|
| Planned capture | `planned`, `recorded`, `unattempted`, `callFailures`, `cancelled`; unknown, duplicate, changed-input or unplanned records are rejected. | Missing attempts are not successful empty outputs; an internal checker error is not a model failure. |
| JSON parsing | `parse_failure`; `parseFailureRate = parseFailures / outputCount`, or `null` without outputs. | Calls without captured output do not enter this denominator. |
| Response Schema | `schema_rejection`; `structureRejectionRate = schemaRejections / (outputCount - parseFailures)`, or `null` without parsed outputs. | This rate excludes binding rejections and semantic errors; report their counts separately. |
| Selected evidence binding | `binding_rejection` or `admitted`; check exact left/right entity IDs, unique mention IDs and membership in that side's selected mentions. | Closed references establish neither correct identity nor a supported rationale. |
| Authored reference agreement | For admitted outputs only, record `authorReferenceCompared`, `authorReferenceMatches` and each disagreement. | This is agreement with authored labels, not independent accuracy; it does not score rationale. |
| Semantic review | Every record keeps `rationaleReview: pending`; summaries keep `semanticReview: pending` and `qualityConclusion: not_evaluated`. | Human review must evaluate the rationale and frozen checks. The checker never promotes agreement to semantic success. |

Retain original output, raw usage observations and all failure records. Capture records may carry actual nonnegative `durationMs` and reported `costUSD`; missing costs stay absent. `reportedCostUSD` covers reported records only; `totalCostUSD` is non-null only when the complete plan is recorded and every record reports cost. Neither a normalized zero nor partial cost coverage establishes a zero-cost complete run. Planned but unattempted work remains separate from recorded-attempt costs.

The offline command exits nonzero for unattempted slots or any non-admitted record. Assessment disagreement alone does not cause a failing exit. A successful exit means structural checks completed, not semantic or independent acceptance. Production [workspace quality observations](entity-links.md) use their own review/invocation/admission/decision denominators and are not this corpus's quality score.

## 4. Author and independent review {#link-evaluation-review}

Reuse the extraction annotation receipt formats, with this measurement's identity and complete case set:

| Record | Required fields and meaning |
|---|---|
| Author | `selfReviewVersion: omk-entity-author-review/v1`, `measurementId`, corpus-author `reviewer`, `reviewedAt`, `reviewedBeforeOutputs: true`, and one `decisions` entry per case containing `caseId`, `approved`/`changes_requested`, and rationale. |
| Independent human | `reviewVersion: omk-entity-annotation-review/v1`, the same identity/time/case coverage, `reviewKind: independent-human`, `reviewedBeforeOutputs: true`, `independenceAttestation: true`, plus `disputes` entries with case, question, resolution and independent adjudicator. The reviewer cannot be a listed corpus author. |

Both receipts must cover every case exactly once and precede output capture; future times, wrong identities, missing cases and author self-attestation as independent are rejected. Disputes must be resolved before outputs or remain `changes_requested`. These checks validate record closure and attestations, not the reviewer's real identity or semantic correctness. Another AI agent is not an independent human reviewer.

Completed author review alone permits `exploratoryReady: true`; missing independent review remains `pending`, with `goldReady: false`. `goldReady` requires both completed author review and `attested_independent_human`. Any provided `changes_requested` blocks both readiness flags. Annotation readiness still does not review later output rationales or complete quality acceptance. Keep those output judgments separate; do not manufacture a human receipt from model recommendations or library decisions.

## 5. Measurement identity and zero-call preparation {#link-evaluation-identity}

The measurement identity binds corpus/guide/check versions, raw corpus bytes, both language guide bytes, compiled checker components, the built production runtime tree, package manifest/lockfile, actual Zod validator version/tree, Node version/binary, and exact governed prompt version/raw UTF-8 hash and response-Schema hash. Runtime and validator tree digests cover `.js`/`.json` paths and bytes; the checker includes its shared annotation components. The package/lock digest records dependency declarations, not every installed transitive byte. Any changed bound byte requires a new frozen bundle and receipts; rebuilding is not automatically identity-neutral. This is the declared artifact closure, not an assertion that all operating-system, account, credential or provider state is captured.

Update the runtime build before preparation, then create a fresh repository-external bundle:

```bash
yarn build:runtime
node dist-scripts/bench/entity-link-review.js \
  --corpus test/fixtures/entity-link-review-v1.json \
  --output /private/tmp/omk-link-review-unique
```

The output must be absolute, outside the repository even through symlinks, with an existing parent and an absent target. The bundle saves manifest, raw corpus, both guides, exact system and response Schema, reference-free per-case inputs, and unsigned author/independent templates. This command imports no executor and makes zero model calls. Preparation and annotation review never authorize execution.

After actually reviewing all cases, supply `--self-review /absolute/self-review.json`; optionally supply `--review /absolute/independent-review.json`, using another fresh `--output` directory. `--captures /absolute/captures.json` checks already saved outputs without invoking a model. Captures bind this `measurementId`, one split, one or two declared repeats, start time, executor/model and case/repeat/input digests. Unknown, duplicate and extra slots cannot be silently included.

## 6. Explicit live capture and recovery {#link-evaluation-live}

`entity-link-live` is a separately confirmed benchmark runner using the production request adapter and Codex executor. It does not prove that Codex satisfies the production durable journal's capacity contract; that host still owns its supported producer boundary. A live plan binds the measurement bundle, author receipt, exact per-case requests, actual runtime/checker/dependency/validator/Node identity, runner and Codex binary, model, split and selected slots.

Create a plan from an author-approved bundle. This example selects the six development cases once, without executing them:

```bash
node dist-scripts/bench/entity-link-live.js prepare \
  --repository /absolute/path/to/oh-my-knowledge \
  --bundle /private/tmp/omk-link-reviewed-unique \
  --out /private/tmp/omk-link-live-development-unique \
  --executor codex --model gpt-6.1-sol --max-calls 6 \
  --split development \
  --cases dev-component-rename,dev-component-properties,dev-separate-deployments,dev-version-objects,dev-path-only,dev-assistant-guess
```

Use another plan and output directory for validation, with its six `val-*` IDs from the frozen corpus. Every selected case requires one unique slot; `maxCalls` must equal the selected-case count. The private working directory excludes project instructions, while runtime-default global skills and effort remain part of the declared Codex context. The governed system is prepended through the request adapter, not claimed to be the CLI's only global system context.

Inspect `plan.json` and its exact inputs/model/limits, then explicitly confirm its actual `planId`:

```bash
node dist-scripts/bench/entity-link-live.js execute \
  --repository /absolute/path/to/oh-my-knowledge \
  --out /private/tmp/omk-link-live-development-unique \
  --confirm-plan 'sha256:<actual-plan-digest>'
node dist-scripts/bench/entity-link-live.js check \
  --repository /absolute/path/to/oh-my-knowledge \
  --out /private/tmp/omk-link-live-development-unique
```

Before each invocation the runner exclusively publishes a reservation. It archives complete returned executor JSON before deriving admission, usage and capture records. A reserved slot without native evidence stays unknown and is never redispatched. Existing native evidence can reconstruct a derived record; already completed slots are not called again. Execution stops on failure, invalid output/binding, observed tools, explicitly unreported usage or unknown reserved slots, without automatic retries. Read-only `check` makes no model calls and reports `complete` and `stopped`; inspect those values rather than treating exit zero as completed acceptance.

`maxCalls` caps OMK invocations only. It does not cap internal provider requests, tokens, or USD; Codex cost is unknown unless the executor explicitly reports it. Cancellation and process loss cannot undo consumed requests or fees. Do not substitute a normalized `costUSD: 0` for reported billing. Retain native output, reservations, derived records and `captures.json` as private external evidence, then use the offline checker in a new bundle to report layered results. This protocol specifies the run; it does not assert any model result in advance.

## 7. Comparison and completion boundaries {#link-evaluation-completion}

Freeze split, sample selection, repeats, model, actual requests, runtime, budgets and review criteria before comparisons. Report per-case failures and disagreements alongside denominators; do not select only successes. Extraction prompt-json and strict requests use the [extraction evaluation protocol](entity-extraction-evaluation.md), with their own wire/prompt identities and parse/structure counts. A comparison changing prompt examples and output mode together is a comparison of those complete requests, not an isolated causal estimate of Schema enforcement.

This corpus's strict semantic acceptance requires all planned records, no call/parse/schema/binding failure, agreement with references settled before outputs, and independent itemwise review of all output rationales and checks without unresolved issues. A post-output annotation dispute stays a limitation of this run; changing references requires a new frozen version, without regrading the old result. Missing independent evidence remains explicit; author-reviewed exploratory results can support development without being called Gold or complete quality acceptance. Small synthetic results do not establish overall accuracy, stability, real-dialogue coverage, automatic cross-Agent identity or task benefits.
