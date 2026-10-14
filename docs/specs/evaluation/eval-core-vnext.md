# Evaluation Core measurement contracts

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
