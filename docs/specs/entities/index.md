# Entity extraction: evidence and limits

Entities organize the objects described by knowledge; identifying an entity does not verify a knowledge claim. Start with [How OMK understands knowledge](../../explanation/knowledge.md) for the concept definitions. This page separates current reading paths from historical extraction reports.

## Read the current boundaries first

| Question | Read |
|---|---|
| What are entities, knowledge, and carriers? | [Concept definitions](../../explanation/knowledge.md) |
| How are identity, granularity, and ambiguity handled? | [Entity identity](./entity-identity.md) |
| What is implemented, and which formats are supported? | [Entity extraction](./entity-extraction.md) |
| How do I review, correct, retain, and reuse knowledge? | [Knowledge guide](../../guides/extract-knowledge.md) · [Entity knowledge library](../knowledge/knowledge-library.md) |
| How are annotations, checks, and quality acceptance defined? | [Extraction evaluation protocol](./entity-extraction-evaluation.md) |

The current specification records the user-approved beta scope and one previously viewed development-window regression of prompt v14, with itemwise author review. Independent review and overall quality acceptance remain incomplete. Structural admission, recorded-output workflow acceptance, and retaining knowledge are separate from extraction accuracy, truth, stability, or reuse benefit; see the current specification and protocol for their exact limits.

## How to read the historical records

The following 15 reports live in `history/`. Their statements describe the recorded batch and date, not today's implementation. Report names may refer to different version axes: the v12 follow-up used corpus v12 with prompt v11; it is distinct from the prompt-v12 targeted regression.

Each batch retains its own inputs, prompt, corpus, annotation guide, checker, runtime, and review scope. Results from different identities are not a progress leaderboard or a causal old/new comparison. Later annotations, authored corrections, or interface fixes do not turn earlier failures into passes. Public synthetic evidence and sanitized real-window summaries also provide different reproduction boundaries.

### Quality baselines and repeated runs

| Record | Evidence boundary |
|---|---|
| [v2/v3 comparison](./history/entity-extraction-quality.md) | Initial 12-window synthetic comparison; limited author review, not a release-quality certificate. |
| [v3 two-round acceptance](./history/entity-extraction-repeat-quality.md) | Repeated mention and identity failures remain under the frozen acceptance rules. |
| [v4 two-round results](./history/entity-extraction-v4-repeat-quality.md) | Outputs were admitted, but the frozen regression gate was not passed. |

### Synthetic diagnostics

| Record | Evidence boundary |
|---|---|
| [v6 eleven-window diagnostic](./history/entity-extraction-v6-diagnostic.md) | Broad-domain objects and mention boundaries; selected diagnostic coverage. |
| [v7 six-case diagnostic](./history/entity-extraction-v7-diagnostic.md) | Concept/property distinctions, ambiguity, and positive/negative claims. |
| [v8 five-window diagnostic](./history/entity-extraction-v8-diagnostic.md) | Granularity and selected retention; passing selected checks does not establish overall quality. |
| [v10 five-case diagnostic](./history/entity-extraction-v10-diagnostic.md) | Knowledge retention and mention boundaries; strict regression remains unmet. |
| [v11 boundary diagnostic](./history/entity-extraction-v11-boundary-diagnostic.md) | Stopped after the first case because of annotation coverage; two cases were not called. |
| [Corpus-v12 two-case follow-up](./history/entity-extraction-v12-followup-diagnostic.md) | Prompt stayed at v11; selected checks and knowledge review do not certify overall quality. |

### Real windows and application workflows

| Record | Evidence boundary |
|---|---|
| [v6 real-conversation diagnostic](./history/entity-extraction-v6-real-pilot.md) | Seven windows; structural admission does not erase semantic failures. |
| [v8 recorded-output workflow](./history/entity-extraction-v8-workflow.md) | Storage, search, source tracing, correction, and knowledge binding; zero new model calls. |
| [v8 real-conversation diagnostic](./history/entity-extraction-v8-real-pilot.md) | Three windows; found expected objects do not equal overall recall. |
| [v11 two-window real regression](./history/entity-extraction-v11-real-regression.md) | Knowledge targets and entity/source-binding errors are assessed separately. |
| [Prompt-v12 targeted regression](./history/entity-extraction-v12-target-regression.md) | Stopped after one real window with missing mentions; the synthetic control was not run. |

### Annotation coverage audit

| Record | Evidence boundary |
|---|---|
| [Complete-name coverage audit](./history/entity-name-annotation-coverage.md) | Source-based corpus-v12 annotation revision; zero model calls and no new extraction-quality score. |

## Sources and reproduction

Each report links its original evidence bundle, frozen identity, review scope, and unavailable material. Keep those records when citing results; real source text and full outputs may remain local. The [knowledge guide](../../guides/extract-knowledge.md#reproduce-extraction-quality-checks) identifies the historical v3 tool boundary, while the current evaluation protocol owns today's checks.

English and Chinese reports mirror each other. Repository links use the organized source paths; the documentation site retains the original `/explanation/entity-…` report URLs and anchors. Moving a report does not change its measurement result. Relinking a live annotation guide changes its byte digest, so new review packages retain their own identities; frozen guides and public evidence are unchanged.
