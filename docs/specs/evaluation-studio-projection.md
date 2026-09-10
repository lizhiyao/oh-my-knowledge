# Evaluation Core Studio projection

> Status: implemented. The catalog/view-model boundary from [#535](https://github.com/lizhiyao/oh-my-knowledge/issues/535) and renderer/route adapter from [#537](https://github.com/lizhiyao/oh-my-knowledge/issues/537) are now the production Evaluation view. It reads authenticated Core runs only.

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

`createCoreStudioRouteHandler()` is a pure HTTP-shaped adapter over `CoreStudioCatalog`. It returns an immutable response envelope instead of depending on Node request/response objects, so the production host mounts it without giving the catalog server authority. Separate caller-provided HTML/API base paths expose list and detail resources. Unmatched paths return `undefined`, invalid or missing identifiers return stable 404 responses, unsupported methods return 405, and source failures return a redacted `core_studio_source_unavailable` response without exception text or filesystem paths.

## 5. Migration boundary

The Core Studio modules do not import the deleted legacy `ReportStore`, legacy `EvaluationReport`, `VariantResult`, or result rows. The production server mounts the Core handler directly; the skill index consumes Core cards, and the legacy evaluation routes and renderer no longer exist. There is no legacy reader, adapter, shadow read, or dual view.

This one-way removal is `BREAKING-SCHEMA`: old report files are not migrated or read. It changes no evaluator, analysis formula, prompt, missing-data policy, or verdict semantics and is not `BREAKING-COMPARABILITY`.

## Studio application framework

Studio uses Next.js App Router, TypeScript, and Ant Design as its target application stack. The first migration slice replaces the CLI-hosted `/measure` list and detail pages with React components. Observe conversation lists, details, and live task trajectories also use React; Knowledge lists and details share the same StudioShell and Ant Design components; report-specific pages retain their existing routes; a migrated page has one active implementation, without a fallback to its old HTML renderer.

The Node listener owns Next's preparation and shutdown. Server components receive the existing `CoreStudioCatalog` through request-scoped context, so simultaneous Studio instances cannot read each other's catalogs. The catalog is resolved before HTML streaming to preserve 404/503 responses. The existing JSON API and standalone Core rendering exports retain their contracts; this migration changes neither Core artifacts nor measurement semantics.

`yarn build` builds the application and copies its production assets into `dist/studio/web`. The published package includes the prebuilt UI and its runtime dependencies. `omk studio` uses the same port and directory flags and never builds a UI during user startup. Framework telemetry is disabled during the build. Framework migration must be verified through an isolated package installation, deep-link refresh, real artifact rendering, and listener/SSE cleanup.

The fullscreen application rule covers Observe, Measure, Knowledge, report details, and loading/error pages. Measure details separate scope, analysis, and evidence into tabs. Knowledge and report details keep navigation and summaries fixed, with long content confined to named panels. Independently mounted reports retain their document layout. Studio fills the viewport with fixed primary navigation and no horizontal or vertical document scrolling; long lists, details, and timelines scroll within their content regions. Compact task headers leave the remaining height for four adaptive swimlanes, with cards and connections laid out together. Tables reserve explicit widths for actions and counts; long titles and paths truncate while retaining access to their full content.

The three status axes remain separate. Ant Design provides interaction and visual primitives; domain code continues to own status, evidence availability, and conclusions. Observe keeps conversation, action, result, and knowledge swimlanes as its default semantic view, including the time axis, connections, card details, and live following. It reuses the existing swimlane projection and obstacle-aware routing rather than substituting a list. Observe reuses the conversation and task trajectory projections, sending only the selected task data rather than serializing its full source session. Lists refresh through lightweight activity revisions; tasks refresh through the existing SSE notifications, with subscriptions and requests released on unmount. Source records load on demand, and knowledge access evidence does not establish causation. Report-specific pages and managed decision history retain their existing renderers.
