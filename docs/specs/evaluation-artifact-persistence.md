# Evaluation Core artifact persistence

> Status: host persistence, reuse, and downstream projection contract for [#531](https://github.com/lizhiyao/oh-my-knowledge/issues/531), plus the pre-cutover CLI and managed-evidence projections from [#547](https://github.com/lizhiyao/oh-my-knowledge/issues/547). It does not switch `omk eval`, read legacy reports, or make transported JSON a trusted Core capability.

## 1. Boundary

Evaluation Core remains pure and in-memory. The host persists one immutable run artifact set:

1. the versioned `RunPlan` wire document;
2. `ExecutionBundle`;
3. `EvaluationBundle`;
4. `AnalysisBundle`;
5. `EvaluationReport`.

The Plan is required because Bundle digests identify a sealed measurement contract but cannot reconstruct it. Persisting only results would force resume to trust summaries or recompile against ambient state. The host manifest is a locator and integrity projection, not a sixth measurement fact.

## 2. Authority and verification

On publication and full read, the store validates:

- every wire schema and native artifact digest;
- the Plan's recomputed dataset, stage, randomization, and run-contract digests;
- Execution → Evaluation → Analysis → Report parent digests;
- Report Bundle references, status, budget summary, Decision binding, and provenance parents;
- manifest document digests and maximum captured-content classification;
- every referenced content descriptor through an injected resolver.

This proves transport integrity and exact lineage, not provenance authenticity. A persisted `RunPlan` is returned as a wire document and is never rebranded as `SealedRunPlan`. Resume must prepare the current Definition and MeasurementPolicy, obtain a fresh sealed Plan capability, and run the Core plan-aware Bundle verifiers before reuse. Digest equality alone cannot mint source trust, cache receipts, or Runtime attestation.

## 3. Atomic publication

Each run uses an opaque directory derived from the SHA-256 of `runId`; user identifiers never become path segments. The host writes all five documents and the manifest into a private staging directory, writes the manifest last, then publishes the directory with one same-filesystem rename. Readers enumerate only published `run-<digest>` directories. Interrupted hidden staging directories are invisible and can be cleaned independently.

A `runId` is immutable. Re-publishing the exact document set is idempotent; a different set under the same ID fails. In-process writes are serialized per run, and the directory publication step also resolves cross-process races to one complete winner. Corrupt published runs fail explicitly instead of disappearing from list results.

Directories use owner-only permissions and files use owner read/write permissions because a full Plan can contain expected or evaluation-only inputs. Paths are host effects and never enter Core documents or measurement digests.

## 4. Manifest and index

`omk.core-run-artifact-manifest/v1` uses qualified discriminants (`manifestKind`, `documentKind`). Its five references have fixed relative filenames, schema identity, native identity digest, and a canonical full-document digest. It also records run/report identity, run-contract digest, orthogonal Report status, Execution/Evaluation replayability, creation time, and maximum captured-content classification.

An index card is a pure projection of a validated manifest. Listing may rebuild cards without resolving large content because it does not claim evidence availability. Loading a full run requires descriptor closure; a missing resolver or corrupt content fails instead of projecting empty evidence.

## 5. Host content store

The Node content store implements the existing Execution and Evaluation content ports. It verifies the caller-provided value digest before writing and stores a private, content-addressed envelope. Identity includes value digest, media type, and classification so the same bytes classified as `public` and `gold` cannot alias or downgrade each other. Descriptors use an opaque `omk-content:` URI and never expose a filesystem path.

Resolution revalidates envelope digest, descriptor, canonical value digest, media type, byte size, and classification. Failures use stable, redacted codes; raw filesystem paths and content do not become Core errors.

## 6. Resume admission

Resume is complete-fact reuse, not record copying or cross-process checkpoint continuation. The host first prepares the current Definition and MeasurementPolicy to obtain a fresh `SealedRunPlan`. The admission adapter rejects a transported Plan that merely has the same JSON shape, then loads the located run and invokes the Core Execution, Evaluation, Analysis, Decision, and Report verifiers in order.

Only a completed run with complete evidence can be reused. A missing, corrupt, partial, contract-mismatched, under-trusted, cache-indeterminate, or budget-indeterminate source produces a stable reason code. The caller must explicitly choose `fail-closed` or `start-fresh`, a minimum source trust, and whether cache receipts and budget accounting must be verified. Rejection never copies successful rows, creates a new trial, or changes the old lineage.

Verification contexts are independent host evidence. A caller must never construct provenance attestations or cache receipts from Bundle claims. The admission digest records only artifact identities, normalized Core verification facts, and the explicit policy; it excludes raw Dataset, Gold, outputs, traces, and receipt material.

## 7. Project and global overlay

An overlay writes only to its primary store and reads primary before fallback layers. Its index card includes a rebuildable artifact-set digest over the five document references. The same `runId` may appear in multiple layers only when this digest is identical; otherwise `get`, `list`, and `exists` fail explicitly. Writes never shadow an existing fallback ID, including an identical one, so project and global stores cannot silently select different facts.

## 8. Batch child runs

`omk.core-batch-manifest/v1` is a host index, not a Core Report. Each ordered item contains a qualified `batchItemKind`, stable `itemId`, independent child `runId` locator, artifact-set and Report identities, status, and maximum captured-content classification. The child keeps its own Plan, Bundles, Report, provenance, and statistical unit.

Publication resolves and fully verifies every child before atomically publishing the private batch manifest. A missing, corrupt, duplicate, or identity-changed child fails. Full batch reads revalidate child locators; batch listing validates only the manifest and therefore does not claim child evidence availability. Interrupted staging directories remain invisible.

## 9. Core-native downstream projections

Downstream consumers read immutable Core facts through pure, side-effect-free projections. These APIs do not import the legacy Report or result-row types and are deliberately not wired into the production consumers before the final CLI cutover.

The artifact graph projection consumes one validated stored run. It emits qualified Core node kinds for Run, Target, Evaluator, Metric, Execution result, Evaluation result, Analysis result, and Decision. Node status comes only from explicit stage state. Numeric observations may appear as view metrics, but no score band or display threshold becomes a verdict. Evidence references bind exact Core document hashes and JSON pointers; raw input, expected value, output, trace, evidence, and error text are omitted.

Gold comparison requires the caller to select one sealed Target, Evaluator, and numeric Metric. Optional trial and measurement coordinates refine that identity, but must match the Plan. Gold and Metric scales must match exactly. A sample resolving to multiple observations fails instead of averaging across trials, ensemble members, or replicates; a scale transformation belongs in a preregistered Analysis. The projection binds a canonical Gold dataset digest and uses `null`, not non-JSON `NaN`, for undefined statistics. The existing Krippendorff alpha, weighted kappa, Pearson, and paired-unit bootstrap formulas remain unchanged.

Evolution evidence consumes one exact Evaluation Series Plan → SeriesAnalysisBundle → EvaluationSeriesReport chain. Series fixes `experimentalUnit = run`; the projection preserves member status, trust, comparability, analysis standards, assumptions, coverage, and registered Decision. It never ranks member runs or infers a winner from display scores. Only a `decided` Series Decision makes the view `decision-ready`; completed analysis without a Decision remains `analysis-only`.

The CLI dry-run projection accepts only the in-process `SealedRunPlan` capability returned by prepare. It exposes stage digests, Dataset／Target／Evaluator／Metric counts, experimental-unit identity, Analysis outputs, Decision policy identity, and redacted preflight records. It contains no input, expected value, evaluation context, artifact config, locator, or provider secret. A transported Plan document cannot be projected as a successful prepare result.

The CLI run projection accepts one fully validated stored artifact chain. Operational completion, evidence completeness, conclusion status, and registered Decision remain separate inputs to the gate. `report-only` may skip the release gate only for a completed run; cancellation, budget exhaustion, and failure remain non-zero operational outcomes. Batch projection verifies every manifest child against its exact artifact-set identity and projects independent child outcomes without pooling scores, Reports, or statistical units.

Managed evidence projection binds each OMK Target to the full SHA-256 artifact descriptor sealed in Target config, its exact Executor Runtime fingerprint reference, Dataset revision, all stage-plan digests, Report identity, status, and registered Decision. It deliberately omits the legacy 12-character content hash, locator heuristics, aliases, display scores, Runtime capabilities, and implementation facets. Baseline Targets remain visible for audit but are explicitly ineligible for managed evidence. The later cutover writer must consume this projection and move managed records into the same content-identity space; it must not translate the projection back into a legacy `EvaluationReport`.

## 10. Non-goals

- legacy `EvaluationReport` readers, migration, or dual writes;
- partial-record resume or a cross-process checkpoint engine;
- Studio projections;
- wiring the Core projections into production CLI, Studio, or managed-record consumers before cutover;
- the production CLI cutover and old pipeline deletion;
- artifact signatures or provenance attestation.

These Core-native projections complete the consumer inputs needed by the first #547 slice. The production switch remains a separate atomic `BREAKING-SCHEMA` change: no current command reads both legacy and Core facts.
