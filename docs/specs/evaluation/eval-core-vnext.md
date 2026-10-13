# Evaluation Core measurement contracts {#evaluation-core-vnext-rfc}

This page specifies current Core responsibilities, invariants, and stage artifacts. The [Core API](../../reference/integration/embedded-api.md) and exported Schema resolver own exact API/wire contracts. Ordinary Node callers should start with [service evaluation](../../guides/integration/eval-runtime.md).

## 1. Inputs and responsibilities {#current-input}

Core is the deterministic measurement kernel on Node.js. It depends on Node, not CLI, filesystems, networks, environment variables, Studio, or concrete executors. JSON declarations express measurement intent; hosts supply functions, clients, and resources.

Definition declares Dataset, Target, Evaluator, Metric, experiment, analysis, and Decision. MeasurementPolicy declares concurrency, retries, budgets, missing evidence, and event delivery. Runtime bindings associate declarations with actual ports, identity, and capabilities.

## 2. Sealing and four stages {#current-stages}

Preparation validates schemas, references, capabilities, actual Runtime identity, and policy, sealing a SealedRunPlan before the first external call. A host cannot bypass this boundary or fabricate another plan.

| Stage | Artifact and responsibility |
|---|---|
| Execution | Run Targets; preserve actual output, status, provenance, and declared evidence |
| Evaluation | Bound Evaluators consume permitted execution evidence and emit named Metric observations |
| Analysis | Derive statistics through the sealed analysis graph, sampling units, and missing-evidence policy |
| Decision | Registered policies consume analysis evidence to produce scoped conclusions |

Report materializes those artifacts. Events only notify lifecycle progress. Invocation failures, missing evidence, and valid negative results do not become success or zero scores.

## 3. Identity, reuse, and recomputation {#current-identity}

Complete Dataset revision and execution/evaluation/analysis projections have separate digests. Digests establish content identity, not actual provenance, reproducibility, or benefits. Stage reuse verifies plans, source trust, Runtime identity, and parent lineage; a same-name cache entry is insufficient.

Downstream changes permit recomputation only with sufficient execution evidence, an appropriate newly sealed design, and verification. Post-hoc adjustments retain identity and provenance, do not overwrite original results, and cannot masquerade as preregistered release conclusions.

## 4. Evidence and conclusions {#current-conclusions}

Gold and evaluation expectations remain isolated by projection and are not sent to Targets. Observation, statistics, diagnostics, and release decisions have separate owners; UI presentation and source records do not replace causal evidence.

One Run has no cross-independent-run stability evidence. Independent Series analysis and decisions have separate sealed designs. Scoring, frozen prompts, Schema identity, and persistence changes require explicit versioning rather than silently changing historical comparability.

## 5. Hosts and resources {#current-runtime}

Concrete calls, resource leases, evidence storage, and pages are assembled outside Core. Hosts own long-lived registries, clients, caches, and stores. Per-run stage resources close with their lifecycle; cancellation waits for cleanup without closing another run.

Product wiring follows [input compilation](cli-evaluation-input-compilation.md), [Runtime Adapter](evaluation-runtime-adapter.md), [persistence](evaluation-artifact-persistence.md), and [Studio projection](evaluation-studio-projection.md). See the [evaluation guides](../../guides/evaluation/index.md) for user steps.

## 6. Historical decisions {#current-history}

[Architecture decision history](history/eval-core-vnext-design.md) preserves the original vNext RFC, migration context, type sketches, and later ADRs. This page duplicates neither historical interfaces nor a version catalog that can drift.

<!-- Preserve old section links; the archive above owns historical content. -->
<a id="_1-summary"></a>
<a id="_2-problem"></a>
<a id="_3-goals-and-non-goals"></a>
<a id="goals"></a>
<a id="non-goals"></a>
<a id="_4-design-principles-and-measurement-invariants"></a>
<a id="_4-1-define-the-estimand-before-execution"></a>
<a id="_4-2-a-unified-interface-is-not-a-unified-score"></a>
<a id="_4-3-missing-is-not-zero"></a>
<a id="_4-4-a-cache-hit-is-not-a-new-trial"></a>
<a id="_4-5-comparability-is-an-explicit-relation"></a>
<a id="_4-6-standards-compatible-not-standards-shaped"></a>
<a id="_5-domain-model"></a>
<a id="_5-1-definition"></a>
<a id="_5-2-dataset-and-case-projections"></a>
<a id="_5-3-target-and-runtime-capabilities"></a>
<a id="_5-4-experimentdesign-and-samplingdesign"></a>
<a id="_5-5-evaluator-metric-reducer-and-decisionpolicy"></a>
<a id="_6-plans-bundles-and-reports"></a>
<a id="_6-1-sealed-runplan"></a>
<a id="_6-2-executionbundle"></a>
<a id="_6-3-evaluationbundle"></a>
<a id="_6-4-analysisbundle"></a>
<a id="_6-5-evaluationreport"></a>
<a id="_6-6-replayability"></a>
<a id="_7-identity-canonicalization-and-comparability"></a>
<a id="_7-1-adr-compare-a-declared-subject-under-an-invariant-measurement-system"></a>
<a id="_7-2-policy-and-assessment-contract"></a>
<a id="_7-3-scope-projections"></a>
<a id="_7-4-status-derivation-and-fail-closed-rules"></a>
<a id="_7-5-consequences-and-rejected-alternatives"></a>
<a id="_8-runtime-resources-and-cancellation"></a>
<a id="_9-event-semantics"></a>
<a id="_10-errors-and-failures"></a>
<a id="_11-content-security-and-privacy"></a>
<a id="_11-1-adr-keep-dataset-inputs-out-of-evidencepolicy-v1"></a>
<a id="_12-public-api-sketch"></a>
<a id="_13-conformance-and-verification"></a>
<a id="_14-rejected-alternatives"></a>
<a id="_14-1-add-more-options-to-the-current-runevaluation"></a>
<a id="_14-2-keep-one-report-and-re-score-from-it"></a>
<a id="_14-3-use-the-event-log-as-the-sole-source-of-truth"></a>
<a id="_14-4-normalize-all-metrics-to-0–1-and-average-by-default"></a>
<a id="_14-5-represent-every-target-with-one-ever-growing-capability-list"></a>
<a id="_14-6-transparently-reuse-all-execution-caches"></a>
<a id="_14-7-build-databases-queues-and-checkpoints-into-core"></a>
<a id="_15-delivery-sequence"></a>
<a id="_16-rfc-decision-record"></a>
<a id="_17-contracts-v1-implementation-baseline"></a>
<a id="_18-evaluation-runtime-v1-implementation-baseline"></a>
<a id="_19-analysis-and-decision-runtime-v1-implementation-baseline"></a>
<a id="_20-conformance-v1-implementation-baseline"></a>
<a id="_21-analysis-cohorts-evaluator-replicates-and-evaluation-series"></a>
<a id="_21-1-analysis-only-sample-projection"></a>
<a id="_21-2-evaluator-measurement-identity"></a>
<a id="_21-3-evaluation-series"></a>
<a id="_22-shared-run-budget-contract-and-authoritative-ledger"></a>
<a id="_23-sample-scoped-execution-controls"></a>
<a id="_24-adr-publish-staged-execution-through-prepared-capabilities"></a>
<a id="_25-industry-references"></a>
<a id="related-documents"></a>
