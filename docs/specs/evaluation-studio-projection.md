# Evaluation Core Studio projection

> Status: read-only catalog and view-model boundary for [#535](https://github.com/lizhiyao/oh-my-knowledge/issues/535). It does not switch Studio routes or renderers and does not read legacy reports.

## 1. Authority boundary

Studio is a consumer of Evaluation Core facts, never a second report model. `CoreRunArtifactStore` remains responsible for schema, digest, content-closure, and lineage validation. `createCoreStudioCatalog()` accepts that store port and adds no filesystem, server, or renderer dependency.

The catalog has three operations:

- `list()` projects validated manifest index cards and never loads full artifacts;
- `inspect(runId)` performs the same point lookup without claiming content availability;
- `get(runId)` loads the complete validated artifact set before building a detail view.

Project/global behavior comes from `createOverlayCoreRunArtifactStore()`. Identical artifact sets under one `runId` deduplicate. Different artifact sets fail with the existing stable overlay conflict code. Studio does not invent a weaker conflict policy.

## 2. Versioned views

`omk.studio-core-run-card/v1` contains only manifest facts: run/report identity, artifact-set digest, creation time, orthogonal run/evidence/conclusion status, replayability, and maximum captured classification.

`omk.studio-core-run-detail/v1` additionally projects:

- Dataset identity and sample count, never Sample inputs;
- Target, Evaluator, measurement, and Metric definitions without config;
- stage Bundle identity, direct-parent lineage, explicit status, coverage, replayability, budget aggregate, and redacted provenance;
- Execution and Evaluation coordinate identity, status, duration, safe usage, cache status, and error/reason codes;
- numeric Metric observations only; boolean, categorical, text, and ranking values remain hidden;
- Analysis identity, output schema version/digest, coverage, exclusion count, assumption status, and finite scalar numeric values only;
- registered Decision status, verdict, reason codes, and exact Analysis result references;
- all five manifest document identities and full-document digests, without filenames or paths.

Both projections are canonical JSON-safe, deeply frozen values. Undefined numeric results are omitted rather than converted to zero.

## 3. Privacy and construct validity

The detail view deliberately omits raw input, execution context, expected value, evaluation context, output, trace, evaluator evidence/metadata, Gold, arbitrary Analysis tables, Runtime capabilities/facets, provenance facets/source identifiers, usage details, extensions, and error messages.

This is a semantic allow-list. A later renderer cannot treat uncaptured evidence as an empty value or expose protected content because those fields never cross the projection boundary. New result types require an explicit schema-specific projection; generic object traversal is prohibited.

View status never derives from score thresholds. Run status, evidence status, and conclusion status remain orthogonal. Stage failures, cancellation, budget exhaustion, missing observations, inconclusive Analysis, and not-decided Decision retain their Core states and reason codes.

## 4. Migration boundary

The Core Studio modules do not import legacy `ReportStore`, `EvaluationReport`, `VariantResult`, or result rows. The current server, skill index, routes, and renderers remain unchanged in this slice. A later PR will switch those consumers to the versioned views in one direction; no legacy reader, adapter, shadow read, or dual view is introduced.

The final `omk eval` and report-wire cutover remains the separate `BREAKING-SCHEMA` step in [#450](https://github.com/lizhiyao/oh-my-knowledge/issues/450). This projection changes no evaluator, analysis formula, prompt, missing-data policy, or verdict semantics and is not `BREAKING-COMPARABILITY`.
