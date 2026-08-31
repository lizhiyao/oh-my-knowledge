# Evaluation Core Studio projection

> Status: read-only catalog/view-model boundary from [#535](https://github.com/lizhiyao/oh-my-knowledge/issues/535), plus the isolated renderer/route adapter from [#537](https://github.com/lizhiyao/oh-my-knowledge/issues/537). It does not switch production Studio routes and does not read legacy reports.

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

## 4. Renderer and route adapter

`renderCoreRunList()` and `renderCoreRunDetail()` consume only the two versioned views. The list presents run, evidence, and conclusion status as three separate axes. The detail presents plan identity, stage coverage and budgets, safe records and numeric observations, Analysis, Decision, and the complete five-document lineage. It never infers an overall quality state from scores.

The renderer escapes every projected value. All navigation paths come from a caller-provided `CoreStudioRenderRoutes`; it contains no host, port, or deployment assumption. Tables use captions and scoped column headers, status groups have accessible labels, and both Chinese and English views retain the same facts.

`createCoreStudioRouteHandler()` is a pure HTTP-shaped adapter over `CoreStudioCatalog`. It returns an immutable response envelope instead of depending on Node request/response objects, so a later host can mount it without giving the catalog server authority. Separate caller-provided HTML/API base paths expose list and detail resources. Unmatched paths return `undefined`, invalid or missing identifiers return stable 404 responses, unsupported methods return 405, and source failures return a redacted `core_studio_source_unavailable` response without exception text or filesystem paths.

## 5. Migration boundary

The Core Studio modules do not import legacy `ReportStore`, `EvaluationReport`, `VariantResult`, or result rows. The current production server, skill index, routes, and legacy renderer remain unchanged in this slice. A later PR will mount the independent handler and switch consumers to the versioned views in one direction; no legacy reader, adapter, shadow read, or dual view is introduced.

The final `omk eval` and report-wire cutover remains the separate `BREAKING-SCHEMA` step in [#450](https://github.com/lizhiyao/oh-my-knowledge/issues/450). This projection changes no evaluator, analysis formula, prompt, missing-data policy, or verdict semantics and is not `BREAKING-COMPARABILITY`.
