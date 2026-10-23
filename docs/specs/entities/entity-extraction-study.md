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
| `omk-extraction-study-review/v2` / `omk-extraction-study-analysis/v2` | Recomputed gates, per-variant and finite-set analysis. |
| `omk-extraction-study-judge-calibration/v2` | Comparison of saved agent judgments with independent human judgments. |
| `omk-extraction-study-inspection/v2` | Installed CLI/Studio projection of v2 review, analysis, calibration and per-slot completion-time evidence. |

The v2 derived reports declare **BREAKING-COMPARABILITY** and **BREAKING-SCHEMA** for their completion-time acceptance and projection changes. Reference/output receipts remain v1; production run v5, plan/corpus/evidence v1 and their original bytes are not migrated. Current tools compute only the current report/projection versions, without a parallel v1 report reader. Earlier reports and their original frozen tools remain historical evidence; a new v2 report cannot retroactively certify an earlier study's review timing. New runtime bytes require a newly frozen host, rather than changing a historical host or inheriting its acceptance.

Existing synthetic corpus v13, annotation guide v11 and checker v5 retain their identities and denominators. Current defaults are prompt-json v29 and strict v30; the [temporal, referential-context, core-object and whole/part guidance corrections](./entity-extraction.md) declare **BREAKING-COMPARABILITY**, while production run v5 remains unchanged. Human sealing separately introduces quality projection v4, preserving sealed records as execution unknown rather than changing prompt/scoring semantics. Explicit study prompt profiles do not change either default; published default versions cannot label different prompt bytes. A future collection-policy or scoring change requires its own declared comparability impact. Earlier frozen studies remain bound to their original prompts, hosts and outputs; new defaults cannot recalculate them or inherit their quality conclusions.

Defaults v19/v20 present when explicit study profiles were introduced, and subsequent v21/v22, v23/v24 and v25/v26, retain their registered raw-byte digest constraints when defaults advance. A new default must explicitly register its version and digest; this neither loads historical implementations nor rewrites existing runs.

The v29/v30 changes to source-claim rules and the output self-check within the same invocation declare **BREAKING-COMPARABILITY**. Earlier v27/v28 and all registered v19–v28 digest constraints remain protected, and the eight wire demonstrations retain their bytes. Guide v11, checker v5, the 64-case/212-critical-mention denominator, public Schemas, storage, wire and single policy remain unchanged, with no new invocation stage. Changed prompt and current guide-page bytes require fresh frozen measurement identities; earlier evidence is not rescored. Seen diagnostic findings motivate the change without demonstrating model compliance, stable improvement or independent acceptance.

Preparation compares both archive producers on a common request so prompt-dependent request digests and archive bounds do not masquerade as environment drift. Each actual slot retains its complete request and archive proof, checked again per arm before running and dispatching; the common-request check does not replace actual request evidence.

### 1.1. Entity-constrained review research chain

The internal `E→R→K` research chain declares **BREAKING-COMPARABILITY**: it adds per-entity AI review and a knowledge ID usage policy, requiring newly frozen invocation, input and cost boundaries. The original `E+K-v2` remains an explicit research control, rather than a compatibility reader or automatic fallback. Production strict30, public Entity v4, existing entity/knowledge histories and the ordinary extraction wire remain unchanged.

E must be a genuinely completed, unrejected single entity-only task. R binds its persisted initial revision and complete source/catalog digests. `entity-review/v1` returns no entities, mentions, replacement types or revision patches. Every original entityId has exactly one assessment of qualification, actual referent and type, referencing that entity's complete original mentionId set. All three axes supported derive retain; any unsupported derives exclude; otherwise uncertain. The original catalog, mention UTF-16 positions, members and candidate relationships remain intact. Excluding qualification does not establish that the object does not exist.

`knowledge-entity-review-usage/v1` uses a conservative policy: unavailable componentRef, possibleEntityIds, declared collection-member or identity-evidence mention dependencies iteratively block a retained entity's host usage. This does not change the AI disposition or establish that the collection identity is wrong. The conservative policy can reduce usable coverage and must be checked separately in the study. Subsequent `reviewed-knowledge/v1` receives the complete original catalog, R assessments and eligible IDs. Its native binding additionally pins R receiptRef, nativeRef, raw-output digest, R wire and usage-policy version.

Knowledge admission reuses the existing K-v2 proposal and citation checks, then rejects an entire proposal if its entityId/mentionId or subject/object references are unavailable. It never deletes endpoints or rewrites original mentions; independent valid proposals can still be saved. Material accounting is recomputed against actually retained proposals, preserving raw rejections and unexpressed declarations. Persisted knowledge still references the real initial E entityAnalysisRef, without inventing a reviewed entity revision. Explicit replay after interruption uses the same write identities, without new calls or duplicate knowledge.

R and constrained K each have separate system/input/wire/check, receipt and native identities. Explicit private archive ports authenticate original bytes, complete requests and the current same-task producer. R cannot start before E finishes; K cannot start before R finishes. The new stages require a reported single turn and reject tools, retries, subagents or failed cleanup. Missing/corrupt evidence or conflicting bindings refuse downstream processing without falling back to an unreviewed catalog. The internal chain adds no CLI, Studio or default-host installation and migrates no old receipts.

R judgments and retain remain AI claims. `semanticStatus` stays `not_reviewed`, knowledge stays pending, and no human confirmation or gold is created. Engineering tests establish constraints, authentication, admission and recovery, rather than improved entity recognition. Real sources, pre-output obligations, invocation/cost policy, semantic review and independent human acceptance still require their respective protocols; historical results are not rescored.

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

The repository `prepare`/`run`/`report` commands execute their complete application flow in a fixed delivery worker. That worker constructs the concrete producer; the knowledge application still consumes only its port. The main thread waits asynchronously while the synchronous CPU processor stays inside the worker. Every existing `ports.identity()` check and every `beforeDispatch` rereads and hashes the actual host bytes; dispatch also rereads the frozen plan. A successful check at request start never substitutes for later checks, and hashes are not permanently cached. Changed or missing code/dependency bytes and read failures during execution must be observed and rejected at the next applicable check. Cancellation reaches the existing executor, with an additional synchronous shared cancellation checkpoint before and after the final producer gate so cancellation during synchronous hashing can prevent dispatch without waiting for a normal worker message. The main thread does not use `Atomics.wait`. The producing worker cooperatively waits for executor cancellation, archive, and temporary-resource cleanup rather than forcibly terminating its thread. Cancellation does not roll back completed publication or authorize another invocation or automatic resend.

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

`runtimeDigest` continues covering all actual compiled runtime file bytes within its existing scan rules, including the fixed workers, bridge, and processors, while excluding the `studio/web` subtree. `runnerDigest` retains its original nine-path subset: `cli/runtime/knowledge-study.js`; `knowledge/application/study-runner.js` and `knowledge/application/study-local.js`; `knowledge/extraction/study-plan.js`, `knowledge/extraction/study-corpus.js`, `knowledge/extraction/study-review.js`, and `knowledge/extraction/study-analysis.js`; and `knowledge/adapters/study-files.js` and `knowledge/adapters/study-host.js`. Its scope is not expanded to a new worker closure; `runtimeDigest` binds the added worker bytes. Byte hashing, canonicalization, and scan-scope rules remain unchanged. Dependency identity still expands the four seeds `zod`, `ajv`, `js-yaml`, and `smol-toml` into actual dependency code and assets rather than a version list. Both fixed worker entries are registered reachability roots. A source-import guard checks their validation import closure against those resolved dependency manifests, rejects opaque or uncovered loads, and keeps only the two exact concrete-executor construction imports outside that closure; it does not attest the external executor or provider. Changed code bytes produce a different frozen host, not an upgraded digest-scope algorithm or permission to mix hosts. This scheduling change introduces no host/plan/evidence Schema version and does not recompute historical studies. A historical study with a different host must be checked in its original frozen build; omitting checks or inheriting its conclusions cannot establish comparability.

Reports retain every planned slot, including failed, cancelled, generating, prepared, unknown and unattempted cases, and every recorded attempt. Token/cache/USD and durations come from native observations across all attempts. Missing or explicitly unreported values keep totals `null`; normalized executor zeros do not prove provider-reported zeros. Summed attempt duration is not a measured end-to-end user-task duration. OMK attempts, executor-reported attempts and additional reviewer calls are different accounting scopes.

`evaluateExtractionStudyReview` enumerates all output entities, mentions, statements, declared references/knowledge obligations, semantic checks and case targets. Critical `identity`, `provenance` or `unsupported_fact` errors always block. Missing/uncertain review and structural/capture failures remain visible. Per-variant results preserve a candidate even when baseline fails. States are `pending`, `blocked`, `exploratory_reviewed` and `accepted_within_scope`; the last requires independently reviewed references and output, complete evidence and applicable predeclared gates. It is limited to the frozen declared scope.

`analyzeExtractionStudy` reports overall and per-stratum finite-set results. Full independently reviewed entity/mention references can yield scoped matching precision/recall/F1, with one-to-one reference matching; partial or absent references do not. Repeats and correlated targets are not independent samples. Paired results use lineage groups, show incomplete pairs, known transitions and eligible candidate-minus-baseline differences; metric differences weight eligible lineage groups equally. Strata can overlap and cannot be added as independent samples. Population precision/recall/F1 and confidence intervals remain `null` because representative, exchangeable sampling is not established.

Review v2 requires an actual `finishedAt` for every completed run before that slot can qualify for post-completion review, scoped entity/mention matching metrics or calibration readiness. A completed run without it adds `completion_time_unverified` to global and affected-variant blockers; its slot `completionTimeStatus` and elapsed status expose the same limitation. `completionTime` retains `completedSlots`, `verifiedCompletedSlots` and every unverified slot identity in `unverifiedSlotIds`. References retain their separate `goldReady` meaning; complete reference review cannot supply missing run completion evidence. A verified opposite arm remains visible, while lineage eligibility and paired differences depending on the incomplete arm are unavailable. Calibration preserves observed saved judgment pairs and critical misses, but reports `ready: false` and null rates with the explicit time reason.

For a supplied finish, review time must satisfy `finishedAt <= reviewedAt <= now`; equality is allowed, future run timestamps and finishes before start are rejected. Missing finishes still permit checking the available start/upper time bounds, but never yield scoped acceptance or timing-qualified metrics. No current time, file mtime, guessed value or later reviewer attestation fills a missing finish. Old [bench capture/review v1](./entity-extraction-semantic-review.md) still only checks the start bound because it has no completion timestamp; its original protocol, frozen bytes and historical conclusions are not upgraded by this change. Time/independence attestations do not establish actual human reading, correct judgments or truth of source assertions.

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

The fixed study-execution and inspection services each allow at most one active worker job per process and have no waiting queue; this is neither a cross-process global lock nor a new model budget. HTTP reserves inspection capacity before consuming its study body, then receives bounded raw bytes for the worker to parse as JSON, rehash the actual host, and completely replay and analyze. The same inspection worker safely reads the regular UTF-8 files explicitly selected by CLI flags; paths declared inside evidence cannot select files or executable code. The synchronous inspection processor is only a worker and unit-test boundary; real CLI/Studio paths await the worker. The main thread still receives bytes, copies transport data, and serializes results, so this does not establish zero CPU/I/O or fewer complete identity checks.

HTTP disconnect or Studio shutdown cancels the read-only inspection and terminates its worker; CLI inspection uses the existing signal-cancellation path. Worker construction failure, errors, or exit without a result produce finite service failures. A started worker's slot and listeners are released only after its exit is confirmed. Producing workers retain the cooperative cleanup boundary above. Busy inspection returns HTTP 503 with `knowledge_study_busy`; worker unavailability or cancellation returns HTTP 503 with `knowledge_study_unavailable`, without writing to a disconnected response. The UI preserves selected files and instructs users to wait for the current inspection or retry; the CLI reports both service failures with exit 1. Finite error codes expose no raw exception, private path, or input and are not classified by the client as a definite write-rejection receipt. Existing input/capacity and evidence-error boundaries remain, and successful responses retain the current inspection projection.

Host identity strictly binds the actual build, validator dependencies, and Node bytes. Older studies require their frozen environment when the host differs; omitting host verification cannot establish acceptance, and re-analysis is not a new independent model validation. Freeze the final runtime before formal reference handoff rather than changing its identity during human review. Per-run start/end differences are local wall-clock elapsed time including generation, archive, writes, and waits. Unknown values remain null; active human review/correction effort is not inferred.

Production quality projection v4 describes saved engineering admission and explicit human-seal dispositions with execution unknown rather than independent semantic acceptance. Synthetic/authored executor fixtures verify engineering behavior; they do not establish real-source quality, human approval, population conclusions, release eligibility, or completion of the parent quality issue. Formal semantic acceptance remains incomplete until separately arranged human review and the required real evidence are available.

## 7. Independent multi-rater output panels

The separate repository-only panel tool compares saved study output reviews. It never generates model output, signs a human receipt, modifies a run/reference, changes `goldReady`, or replaces the existing single-review acceptance gates. Its `qualityAcceptance` is always `not_assessed`. Agreement describes the exact declared finite target set; agreement on an incorrect assertion is still possible.

| Identity | Bound content |
|---|---|
| `omk-extraction-study-panel/v1` | `panelId`, declaration time/mode, exact `planId`, `corpusDigest`, original portable `evidenceDigest`, `outputDigest`, ordered complete targets/`targetSetDigest`, complete roster, separate adjudicator and fixed metric/missing/uncertain policies. |
| `omk-extraction-study-panel-submission/v1` | `panelId` and complete submitted receipt inventory: `reviewerId`, `receiptFile`, original UTF-8 `receiptDigest`. Absent roster members remain missing. |
| `omk-extraction-study-panel-report/v1` | Full initial-set identity, per-person coverage, observed human agreement, pairwise results, initial disagreements, optional adjudication and explicit limits; `reportId` hashes the complete report body. |
| `omk-extraction-study-panel-adjudication/v1` | `panelId`, complete `initialSetDigest`, `disputedTargetsDigest`, third human's `reviewReceiptFile` and original `reviewReceiptDigest`. |
| `omk-extraction-study-panel-package/v1` | Output filenames/roles, original-receipt reviewer mappings, byte counts and exact UTF-8 digests. This is a local audit inventory, not a new workspace store. |

The roster contains `raters` and an `adjudicator`. Each declares `reviewer: { actorKind, actorId }`, `independentHuman`, `authorRelationship: author|non_author`, and `independenceRationale`. Identities must be distinct, case-insensitively, including the adjudicator. Author relationships are checked against the frozen corpus authors. An agent or author cannot claim independent-human status; the adjudicator must be another independent, non-author human. These are attestations, not identity authentication or proof of actual independent reading. No person or attestation is supplied by the tool.

Preparation binds an already frozen output set; prospective mode requires declaration before judgments. `prospective` requires `declaredAt` strictly earlier than every initial receipt's `reviewedAt`; a panel declared after any existing judgment must use `retrospective`. Preparation records the current checking time, with no backdating flag. The program can compare declared timestamps but cannot prove when a person began forming a judgment. Retrospective reports preserve observed comparisons and explicitly leave `fullIAA` unavailable. Current-host replay checks original corpus/configuration/run/native bytes and the fixed installed runtime; an older frozen host cannot be rebound to today's code. Use its original tools for historical evidence or freeze a new study under the current host, without rewriting the old study.

The ordered target set is exactly `extractionStudyReviewTargets`: every accepted output entity/mention/statement, reference entity/mention, knowledge obligation, semantic check and case judgment, for every slot. Reference omissions (`required_missing`) and overall case differences enter the main denominator. They cannot disappear merely because two reviewers agree on all output matches. No existing single-review receipt format changes. All receipts are revalidated by the same current v2 study review rules, including target uniqueness, reference matching, evidence identity and available completion/time bounds.

The fixed policies are `metric: exact-verdict-error-categories-reference/v1`, `missing: retain-in-planned-denominator;no-agreement`, `uncertain: retain-separately;exclude-observed-definite-agreement`, and `targetScope: all-output-reference-obligation-check-case`. An exact agreement compares verdict, the set of error categories, and matching `referenceId`; rationale wording is preserved but is not an agreement score. Error-category results compare presence/absence of each category on the same common definite targets. Category accounting uses an incorrect judgment’s declared error codes and maps `required_missing` to `coverage`, matching the existing study analysis; the original receipt’s empty error-code array remains unchanged. Verdict-only agreement is also reported separately. Reference-match results are separate for entity, mention and statement targets, including each slot/reference’s match-presence agreement and per-reviewer match counts; a null match is an explicit unmatched result, with positive all-matched coverage reported separately. Non-output targets are not counted as reference matches. These are agreement statistics, not accuracy, error detection effectiveness, kappa, confidence intervals or population estimates.

Only submitted independent, non-author human raters enter IAA. Reports retain planned/submitted people, human/agent/non-independent-human counts, each rater's missing/uncertain/required-missing targets, the actually submitted eligible humans’ common definite coverage, per-item-kind results, pairwise coverage and per-category/reference agreement. AI judgments and non-independent human judgments remain in the raw inventory and initial-disagreement records. `observed` and `pairwise` preserve their actually comparable definite subsets. Missing or uncertain judgments never count as agreement; no comparable targets gives a null rate. `fullIAA` is the exact unanimous agreement rate only when at least two eligible humans exist, every declared rater submitted complete definite coverage, native/completion evidence is verified, and the declaration is prospective. Otherwise it is `null` with `fullIAAUnavailableReasons`, even if the observed subset agrees perfectly. This conservative complete-inventory condition also retains missing/uncertain agent entries; adding an agent never creates an additional human. A numerical full IAA still establishes no semantic quality acceptance.

The submission lists every submitted original receipt; there is no rater-selection or best-receipt option. Unknown/duplicate raters, duplicate physical receipt aliases, unknown/duplicate targets, wrong versions and byte/evidence substitutions fail closed. `initialSetDigest` binds the panel, the exact original submission bytes, and every roster member's original receipt digest or missing value in roster order. Altering a rationale, replacing a receipt, or changing the submission produces a new set identity. The program cannot prove that undeclared external receipts were not concealed; authors and reviewers must audit the complete declared inventory.

Adjudication is optional and requires all roster receipts to be present first. The predeclared third human supplies a normal original single-output receipt, signed no earlier than `panel.declaredAt`, strictly after all initial receipt times, and no later than the checking clock. Retrospective mode relaxes only the initial judgments’ relationship to the declaration; an earlier third-person judgment cannot be retroactively treated as a preappointed adjudication. Its envelope binds the complete initial set and exact dispute list. Only disputed targets are counted as adjudications; any non-disputed entries in that normal receipt provide validation context and never replace the initial judgments. Missing/uncertain dispute decisions remain unresolved. Each adjudicated target has a canonical parsed-decision digest plus the original raw receipt digest; a canonical digest is not described as the hash of a raw JSON substring. The raw envelope and raw third-person receipt are preserved. Initial disagreements, coverage and IAA never change after adjudication.

Build the current repository runtime/scripts using the normal contributing workflow, then use the following zero-model commands. Paths and real reviewer identities must be supplied explicitly; the examples are templates, not signed reviews:

```sh
node dist-scripts/bench/knowledge-study-panel.js prepare \
  --evidence /ABS/STUDY-REPORT/evidence.json --roster /ABS/roster.json \
  --mode prospective --output /ABS/NEW-PANEL
node dist-scripts/bench/knowledge-study-panel.js report \
  --evidence /ABS/STUDY-REPORT/evidence.json --panel /ABS/NEW-PANEL/panel.json \
  --submission /ABS/submission.json --output /ABS/NEW-PANEL-REPORT
# After the predeclared third human supplies their original receipt and envelope:
node dist-scripts/bench/knowledge-study-panel.js report \
  --evidence /ABS/STUDY-REPORT/evidence.json --panel /ABS/NEW-PANEL/panel.json \
  --submission /ABS/submission.json --adjudication /ABS/adjudication.json \
  --output /ABS/NEW-ADJUDICATED-REPORT
```

A submission body is `{ "submissionVersion": "omk-extraction-study-panel-submission/v1", "panelId": "sha256:…", "receipts": [{ "reviewerId": "REAL_DECLARED_REVIEWER_ID", "receiptFile": "original-review.json", "receiptDigest": "sha256:…" }] }`. Receipt paths are resolved relative to the explicitly selected submission file; the adjudicator's path is relative to the explicitly selected adjudication file. Obtain the exact original UTF-8 hash with `extractionStudyPanelBytesDigest(readFileSync(path, 'utf8'))` from `dist/knowledge/extraction/study-panel.js`, without reserializing the original. Copy `initialSetDigest` and `disputedTargetsDigest` from the initial panel report into the adjudication envelope; a different initial set must be reviewed and bound anew.

`prepare` writes original evidence/roster, `panel.json`, `targets.json` and `package-manifest.json`. `report` writes original evidence/panel/submission, all original receipts as `initial-NNN.json` in submission order, the full targets/report and the inventory; an adjudicated report additionally retains `adjudication.json` and `adjudication-review.json`. The inventory maps each copied initial receipt to its declared reviewer; original manifests retain their original path strings for audit, so moving the package does not silently rewrite paths or set identity. All loaded inputs are bounded regular UTF-8 files. The exclusive new output directory is outside the checkout (`0700`, files `0600`); existing directories are never overwritten, and an interrupted/failed publication may leave a partial directory requiring explicit inspection. Only the explicitly selected new output directory is written. Source paths inside portable evidence are not scanned; original source/run/user-configuration records are not modified, and no model service is called.

Argument errors exit 2; invalid data/identity/I/O exits 1 with a finite diagnostic that omits private source/receipt text. Successful prepare/report exits 0 and emits JSON with `modelCallsByThisCommand: 0` and `qualityAcceptance: not_assessed`, including incomplete reports with null IAA. Exit 0 means the requested offline accounting was saved, never human approval or quality acceptance. A changed raw inventory, declaration or report receives a new derived identity. Existing prompts, guide/checker, run v5 and single-person receipts retain their bytes and versions; this independent panel protocol neither rescales historical measurements nor retroactively makes a development fixture a real independent validation set.
