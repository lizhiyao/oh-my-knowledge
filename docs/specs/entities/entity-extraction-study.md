---
description: Freeze real extraction studies, replay production outcomes, and separate engineering evidence from independent semantic acceptance.
---

# Real extraction studies

This specification covers an internal repository tool and shared study primitives. It extends the [evaluation protocol](./entity-extraction-evaluation.md) and [output semantic review](./entity-extraction-semantic-review.md) with separately identified real-source studies. It does not replace the production extraction workflow, create a workspace store, or establish release eligibility.

## 1. Scope and identities

The corpus, plan, reference reviews, output reviews, analysis, and original production runs have separate identities. A changed declaration or analysis produces new evidence; it never rewrites a historical run or makes a previously seen source unseen.

| Identity | Scope |
|---|---|
| `omk-extraction-study-corpus/v1` | Frozen selected source windows, grouping, exposure, reference scope and obligations; `corpusDigest` binds the normalized corpus body. |
| `omk-knowledge-extraction-study-configuration/v1` | Explicit actor, selected split, repeats, changed variable, sampling, criteria and two variant configurations. |
| `omk-knowledge-extraction-study/v1` | Output-before-execution declaration, exact corpus/configuration byte digests, host, prompts, inputs, producer evidence and ordered slots; `planId` binds its body. |
| `omk-knowledge-extraction-study-evidence/v1` | Plan, original corpus/configuration text and original production run/outcome JSON text. |
| `omk-extraction-study-reference-review/v1` | Separate author and independent reference review attestations. |
| `omk-extraction-study-output-review/v1` | Item judgments bound to `planId` and derived `outputDigest`. |
| `omk-extraction-study-review/v1` / `omk-extraction-study-analysis/v1` | Recomputed gates, per-variant and finite-set analysis. |
| `omk-extraction-study-judge-calibration/v1` | Comparison of saved agent judgments with independent human judgments. |

Existing synthetic corpus v13, annotation guide v11 and checker v5 retain their identities and denominators. Current defaults are prompt-json v29 and strict v30; the [temporal, referential-context, core-object and whole/part guidance corrections](./entity-extraction.md) declare **BREAKING-COMPARABILITY**, while production run v5 and quality projection v3 remain unchanged. Explicit study prompt profiles do not change either default; published default versions cannot label different prompt bytes. A future collection-policy or scoring change requires its own declared comparability impact. Earlier frozen studies remain bound to their original prompts, hosts and outputs; new defaults cannot recalculate them or inherit their quality conclusions.

Defaults v19/v20 present when explicit study profiles were introduced, and subsequent v21/v22, v23/v24 and v25/v26, retain their registered raw-byte digest constraints when defaults advance. A new default must explicitly register its version and digest; this neither loads historical implementations nor rewrites existing runs.

The v29/v30 changes to source-claim rules and the output self-check within the same invocation declare **BREAKING-COMPARABILITY**. Earlier v27/v28 and all registered v19–v28 digest constraints remain protected, and the eight wire demonstrations retain their bytes. Guide v11, checker v5, the 64-case/212-critical-mention denominator, public Schemas, storage, wire and single policy remain unchanged, with no new invocation stage. Changed prompt and current guide-page bytes require fresh frozen measurement identities; earlier evidence is not rescored. Seen diagnostic findings motivate the change without demonstrating model compliance, stable improvement or independent acceptance.

Preparation compares both archive producers on a common request so prompt-dependent request digests and archive bounds do not masquerade as environment drift. Each actual slot retains its complete request and archive proof, checked again per arm before running and dispatching; the common-request check does not replace actual request evidence.

## 2. Source grouping and reference scope

`freezeExtractionStudyCorpus(input)` creates a corpus identity; `parseExtractionStudyCorpus(input)` requires and recomputes it. Each case contains `caseId`, `split`, `exposure`, `projectGroup`, `conversationGroup`, `lineageGroup`, `ancestorLineageIds`, `stratumId`, `originDigest`, `transformation`, `sourceRecords`, a complete captured `window`, and `reference`. Original records have stable `recordId`, `recordIndex` and `originalDigest` declarations. The window is an existing production evidence snapshot, including raw selected records, excerpts and limitations.

Project, conversation, lineage/ancestor, origin and original-record identities cannot cross development and validation splits. Repeated source text is rejected even when its labels differ. Validation cases must declare `exposure: unseen`; a renamed, adjacent, copied or redacted development source does not become independent validation evidence. Provenance, exposure and lineage are declarations to audit, not facts authenticated by a digest.

| `annotationScope` | Permitted conclusions |
|---|---|
| `full` | A complete finite reference set can define entity/mention matching denominators after full independent reference and output review. |
| `critical_only` | Review declared critical obligations and every generated output; overall matching precision/recall/F1 remain `null`. |
| `unannotated` | Engineering capture and exploratory review only; no reference-answer denominator or scoped semantic acceptance. |

Reference entities and mentions include descriptions, allowed equivalent expressions and exact quote locators. Mentions link to a reference entity and can declare alternative exact boundaries through `locators`. Knowledge obligations distinguish `required` from `if_selected`; semantic checks remain explicit. Each reference entity requires a reference mention. Source quotes use the production locator and host UTF-16 convention. Text matching does not determine semantic equivalence.

Map references by object identity rather than name containment: returning a whole's guidance or property content does not cover the whole merely because its mention or qualifiers contain the owner's name. Record supported equivalents only when the source and output actually denote the same object, reporting exact declared-locator matches separately from logical coverage at another meaningful occurrence. Preserve a whole omission separately from uncertain part eligibility; do not add locators or amend references after seeing outputs to approve them. Repeated observations of seen sources remain development diagnostics rather than independent samples, stable-improvement evidence or human acceptance.

Review all generated descriptions, qualifiers and mention rationales for their own source support, separately from core-object coverage and exact locations. A same-review/PR association or `basis: explicit` does not supply an unstated relation or actor role. Keep confirmed source-unsupported assertions distinct from unknown external truth, and genuine wording ambiguity distinct from an invented canonical identifier: a complete source phrase may denote a whole without claiming a complete component name. Unresolved output semantics cannot count as passing evidence. Do not widen references after output or classify by keywords; preserve review revisions and their prior evidence when an interpretation is corrected.

To create a corpus from an independently prepared draft, use the built primitive; the draft must supply the real grouping, source windows and reference scope described above:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { freezeExtractionStudyCorpus } from './dist/knowledge/extraction/study-corpus.js';

const draft = JSON.parse(readFileSync('/private/tmp/study-corpus-draft.json', 'utf8'));
const corpus = freezeExtractionStudyCorpus(draft);
writeFileSync('/private/tmp/study-corpus.json', JSON.stringify(corpus, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
```

The draft body has `corpusVersion`, `sourceKind` (`private-real` or `public-redacted-real`), `authors` and `cases`. For engineering exploration, an unannotated case uses `reference: { annotationScope: 'unannotated', entities: [], mentions: [], knowledge: [], semanticChecks: [] }`. It remains unannotated after successful capture. The corresponding snapshots must already exist unchanged in the explicitly selected workspace; preparation does not capture new conversations or import sources.

## 3. Plan and production execution

The configuration requires `baseline` then `candidate`. Both share model, executor, source, output mode, wire, timeout and producer conditions. `changedVariable` permits exactly one dimension: `prompt` requires distinct raw system bytes and version labels; `policy` permits a different production generation policy and its output cap; `replication` requires otherwise identical configurations and makes no candidate-improvement claim.

Sampling freezes `selectionFrame`, `inclusionExclusion`, `unit: lineage-group`, selected `strata` with `coverageRationale`, `sampleSizeRationale`, `stoppingRule`, `budgetRationale` and `interruptionPolicy`. These explanations do not establish representative or independent sampling. Criteria explicitly require `maxConfirmedErrors`, `maxRequiredGaps` and a rationale for each. Thresholds need task-specific loss and risk justification before outputs.

This minimal development configuration exercises replication. Its one repeat and zero tolerances are example declarations, not recommended sample size or business acceptance criteria. Replace the model placeholder with the actual configured snapshot, and replace its frame, strata, justifications and actor truthfully before preparing an actual study:

```json
{
  "configurationVersion": "omk-knowledge-extraction-study-configuration/v1",
  "actor": { "actorKind": "agent", "actorId": "study-author", "executionRef": "study:development-example" },
  "changedVariable": "replication",
  "split": "development",
  "repeats": 1,
  "criteria": {
    "maxConfirmedErrors": 0,
    "confirmedErrorsRationale": "Development example; no semantic errors allowed within the declared scope.",
    "maxRequiredGaps": 0,
    "requiredGapsRationale": "Development example; declared required obligations must remain visible."
  },
  "sampling": {
    "selectionFrame": "Explicitly authorized existing development snapshots.",
    "inclusionExclusion": "Select the frozen corpus development split; exclude new private sources.",
    "unit": "lineage-group",
    "strata": [{ "stratumId": "work-record", "coverageRationale": "Exercise the declared development scenario." }],
    "sampleSizeRationale": "Engineering demonstration only; no population estimate.",
    "stoppingRule": "Use the predeclared slots; unknown reservations prevent later dispatch.",
    "budgetRationale": "One production invocation per slot; no retry or fallback.",
    "interruptionPolicy": "Recover the same run; never resend an unknown invocation."
  },
  "variants": [
    {
      "variantId": "baseline", "executor": "openai-api", "model": "<configured-model-snapshot>",
      "policy": { "policyId": "knowledge-generation-single/v1", "maxInvocations": 1, "retry": "none", "fallback": "none" }
    },
    {
      "variantId": "candidate", "executor": "openai-api", "model": "<configured-model-snapshot>",
      "policy": { "policyId": "knowledge-generation-single/v1", "maxInvocations": 1, "retry": "none", "fallback": "none" }
    }
  ]
}
```

Each arm optionally supplies `timeoutMs`, `maxOutputTokens` and `promptProfile: { profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion, system }`. `system` is the exact raw prompt text, not a file name. Omission uses the existing configured production default. Bounded retries use the existing explicitly declared production policy, including its verified endpoint/model budget profile, retry/reask limits, feedback version and nonrefundable token reservations. The study does not introduce another retry scheduler or arbitrary global call allowance.

The internal `timeoutMs` option defaults to `300000` and accepts an integer from 1 through `2147483647` milliseconds, matching the archive/subprocess bound. Both variants must use the same timeout. The actual timeout is frozen in the existing plan and slot request; execution also verifies the frozen producer evidence and passes the timeout unchanged; changing it requires a new plan rather than extending or resending an old invocation. It does not add a public CLI flag, change ordinary CLI/Studio defaults or authorize retries. A saved timeout remains a failed observation, and unknown usage is not refunded or recorded as zero.

Preparation freezes all selected split cases and preallocates each case × repeat × arm slot and production `runId`. First-arm order alternates across case/repeat pairs. The compact serialized plan has a 16 MiB technical evidence capacity, checked before expanding slots; this is not a model-call or spending budget. Actual authorized invocation limits come from the declared slots and production policies.

Every effect calls `KnowledgeApplication.generate` with the explicit frozen profile and policy. Before dispatch, the runner rechecks source, host, request, producer and saved attempt claim. Existing run identities grant only `resume`. An unknown or incomplete predecessor prevents later slots; failed recorded outputs remain in the planned paired denominator. A stale external lock requires inspection rather than automatic lock removal or a new run identity.

## 4. Repository commands and reviewer handoff

Build the current runtime first. The repository entry loads a fixed compiled production composition root, never source code selected by evidence:

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-study.js prepare \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --corpus /private/tmp/study-corpus.json \
  --config /private/tmp/study-configuration.json
```

`prepare` inspects the configured producer without dispatching a model. API inspection requires the actual configured environment, including credentials; secrets are not saved as configuration. Endpoint and credential-dependent producer bounds must still match at execution. Its new external directory saves `plan.json`, original `corpus.json`, original `configuration.json`, and exact `baseline-prompt.txt` / `candidate-prompt.txt`.

Before outputs, `report` can create unsigned reference templates in a new result directory:

```bash
node dist-scripts/bench/knowledge-study.js report \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --output /private/tmp/new-reference-handoff
```

Templates are embedded in `report.json` as `referenceAuthorTemplate`, `independentReferenceTemplate` and `outputReviewTemplate`. Blank identities, times and judgments are intentionally invalid. Authors and independently arranged humans complete separate reference receipts before outputs. AI assistance cannot fill human identity or independent approval. The program checks attestations and chronology; it does not authenticate a person or prove a judgment correct.

Only `run` sends selected input, and only for one explicitly authorized planned slot. Replace the following placeholders with the exact values in `plan.json`:

```bash
node dist-scripts/bench/knowledge-study.js run \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --slot '<slot-id>' --authorize-plan 'sha256:<plan-id>'
```

One slot can contain multiple attempts only under its frozen production policy. Repeating the command for an existing `runId` performs recovery without generation. After capture, make a fresh report to obtain the output-bound review template; a template made before output is not an output review. Supply completed receipts when available:

```bash
node dist-scripts/bench/knowledge-study.js report \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --output /private/tmp/new-reviewed-study \
  --author-review /private/tmp/reference-author.json \
  --reference-review /private/tmp/reference-independent.json \
  --output-review /private/tmp/output-review.json
```

All receipt flags are optional; absence remains visible. `report` makes zero model calls and writes a new `evidence.json` plus `report.json`. Successful `prepare`/`report` return zero for command completion, not semantic acceptance. `run` returns zero only when its selected production run is completed. Parameter errors return 2; evidence/execution errors return 1 with a static bounded diagnostic. Top-level engineering `goldReady: false` / `qualityConclusion: not_evaluated` are not overridden by an exit code; inspect the recomputed nested analysis for its independently supported scope.

## 5. Native replay, analysis and calibration

Portable replay does not trust supplied statuses or `nativeVerified`. It checks plan and original text digests, run/attempt identity, every native sidecar reference, accounting and selected projections. It reuses the frozen production decoder/checker, reconstructs host-assigned identity mappings, and compares entity/mention births and knowledge intents/grounding with the original accepted output. It does not overwrite historical scores or later revisions.

The expected host comes from the fixed installed `extractionStudyHostIdentity()` adapter: actual compiled runtime/runner bytes, resolved dependency bytes, Node version and Node binary. Different host evidence is rejected; replay without an independently supplied current host remains `outputVerified: false`. A caller-provided report cannot grant its own trust. This host identity freezes OMK and its checked runtime dependencies; it does not authenticate an external provider, the Codex binary or user configuration. The original Codex producer explicitly leaves binary/configuration/provider calls unattested. A requested model name and matching OMK bytes do not prove unchanged external model behavior. Native outcomes are executor observations, not captured raw HTTP/CLI transport or verified supplier-internal request counts.

Reports retain every planned slot, including failed, cancelled, generating, prepared, unknown and unattempted cases, and every recorded attempt. Token/cache/USD and durations come from native observations across all attempts. Missing or explicitly unreported values keep totals `null`; normalized executor zeros do not prove provider-reported zeros. Summed attempt duration is not a measured end-to-end user-task duration. OMK attempts, executor-reported attempts and additional reviewer calls are different accounting scopes.

`evaluateExtractionStudyReview` enumerates all output entities, mentions, statements, declared references/knowledge obligations, semantic checks and case targets. Critical `identity`, `provenance` or `unsupported_fact` errors always block. Missing/uncertain review and structural/capture failures remain visible. Per-variant results preserve a candidate even when baseline fails. States are `pending`, `blocked`, `exploratory_reviewed` and `accepted_within_scope`; the last requires independently reviewed references and output, complete evidence and applicable predeclared gates. It is limited to the frozen declared scope.

`analyzeExtractionStudy` reports overall and per-stratum finite-set results. Full independently reviewed entity/mention references can yield scoped matching precision/recall/F1, with one-to-one reference matching; partial or absent references do not. Repeats and correlated targets are not independent samples. Paired results use lineage groups, show incomplete pairs, known transitions and eligible candidate-minus-baseline differences; metric differences weight eligible lineage groups equally. Strata can overlap and cannot be added as independent samples. Population precision/recall/F1 and confidence intervals remain `null` because representative, exchangeable sampling is not established.

The current v1 output-receipt lower bound is each run's `finishedAt ?? startedAt`, with the explicitly supplied checking clock as the upper bound; equality is allowed. When `finishedAt` exists, a receipt after start but before completion is rejected. Without it, only review no earlier than start is checked: neither post-completion signing nor that stronger guarantee follows from the existing `accepted_within_scope` status. Future run starts and supplied future finishes are rejected. This disclosure does not change acceptance when `finishedAt` is absent or backfill old runs; a stronger guarantee requires explicit versioning. Time/independence attestations do not establish actual human reading, correct judgments or truth of source assertions.

`calibrateExtractionStudyJudge` is a shared programmatic primitive, also used by the installed CLI and Studio inspection entry points described below. It compares actual saved agent and independent human receipts bound to the same evidence, recomputes both review reports, and reports per-error-class detection counts, missing/uncertain targets and critical misses. Missing human evidence keeps calibration pending and metrics unavailable. Complete calibration coverage does not require a candidate to pass quality gates, and `ready` does not certify the judge: `judgeAcceptance` remains `not_assessed` without predeclared calibration acceptance criteria. No model or human review is synthesized.

Agent output receipts require `judgeIdentity`; human receipts forbid that field. Its `identityVersion` is `omk-extraction-study-judge-identity/v1`, with `evidenceScope: reviewer-declared;not-native-verified/v1`. It declares `executor`, `executorRevision`, `model`, `modelRevision`, `promptVersion`, exact `promptDigest` and `configurationDigest`, a `selectedAttemptId`, and all declared `attempts`. Each attempt has a unique `attemptId`, `attemptStatus` (`completed`, `failed` or `unknown`), `runEvidence: { reference, digest }`, nullable `outputEvidence: { reference, digest }`, and `usage: { durationMs, inputTokens, outputTokens, costUSD }` with explicitly nullable values. Completed attempts require output evidence; the selected attempt must be completed. These are separately scoped reviewer declarations, not extraction-generator costs. The evaluator does not follow references or authenticate the claimed versions, usage or native execution, and missing amounts are not filled with zero.

## 6. Persistence and current delivery boundary

Research directories and report directories must be explicit new absolute paths outside the checkout and selected workspace, with existing parents. Symlinks and overwrites are refused; directories use `0700`, files `0600`. The production workspace retains its existing source, entity, knowledge and run contracts. Evidence exports copy original run/outcome text; re-analysis uses another output directory. Source privacy and actual reviewer/model transmission authorization remain separate from local preparation.

A CLI installed from this build provides the same zero-model-call inspection as Studio:

```bash
omk observe knowledge study --evidence /absolute/evidence.json --json
omk observe knowledge study --evidence /absolute/evidence.json \
  --author-review /absolute/reference-author.json \
  --reference-review /absolute/reference-independent.json \
  --output-review /absolute/output-review.json \
  --judge-review /absolute/agent-judge-review.json
```

Receipts are optional; missing evidence remains pending. This operation runs before global settings and workspace resolution. It requires neither `--workspace` nor model credentials, does not follow paths declared in evidence, and cannot dispatch, resume, or revise runs. `--json` emits the shared read-only projection. Successful completion does not mean semantic acceptance. Argument errors exit 2; host or evidence validation failures exit 1.

The candidate review page offers “Inspect study evidence” in its actions menu, including without a workspace. Explicitly select `evidence.json`, optionally add author, independent-reference, output, and AI judge receipts, then inspect. Results remain only in the current drawer and are cleared on close. Changing a file immediately removes old conclusions; late responses cannot replace a newer selection. Cases show source excerpts, birth entities/mentions/statements, citations, judgment reasons, and missing targets. Portable IDs are never treated as maintainable identities in the active workspace.

The CLI and `/api/knowledge/study` share fixed-host native replay and analysis. The product returns deliberately selected source/birth content and safe statistics, excluding raw transport, complete runs, sourcePath, and producer proof. HTTP retains the same-origin guard and does not persist input in a workspace. Combined input and receipts have a 128 MiB UTF-8 JSON capacity, including request escaping. Oversized data is rejected rather than truncated; other APIs retain their existing limits.

Host identity strictly binds the actual build, validator dependencies, and Node bytes. Older studies require their frozen environment when the host differs; omitting host verification cannot establish acceptance, and re-analysis is not a new independent model validation. Freeze the final runtime before formal reference handoff rather than changing its identity during human review. Per-run start/end differences are local wall-clock elapsed time including generation, archive, writes, and waits. Unknown values remain null; active human review/correction effort is not inferred.

Existing production quality projection v3 continues to describe saved engineering admission rather than independent semantic acceptance. Synthetic/authored executor fixtures verify engineering behavior; they do not establish real-source quality, human approval, population conclusions, release eligibility, or completion of the parent quality issue. Formal semantic acceptance remains incomplete until separately arranged human review and the required real evidence are available.
