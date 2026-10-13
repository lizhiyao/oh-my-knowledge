# Design specifications

Specifications are organized by domain. Start with [How OMK understands knowledge](../explanation/knowledge.md) for the definitions of entities, knowledge, context, and knowledge carriers; this index organizes their contracts and designs without redefining them. For a user workflow, read the [knowledge guide](../guides/extract-knowledge.md) or [evaluation quickstart](../quickstart-skill-eval.md).

## Reading order

1. Read the concept definitions, then **shared** terminology and storage boundaries.
2. For knowledge construction, follow **entities → knowledge**: identify source objects, review candidates, organize retained knowledge, then maintain knowledge and carriers. Entity identity organizes access; it does not establish the truth of a knowledge claim.
3. For a controlled comparison, follow **evaluation**: Core → input compilation → Runtime → persistence and Studio projection, then scoring and sample design.
4. Use **observe** to understand signals from real task records. These signals can inform the next comparison, but do not prove knowledge completeness or causal benefit.

## Status and authority

- **Current contract** describes the implemented boundary identified by the document. A historical RFC title or rollout checklist may remain; this does not make every historical proposal current.
- **Partly delivered design** includes approved, implemented sections and unfinished quality or product goals. Follow the implementation specification and its explicit limits.
- **Design draft** records a proposed model or algorithm; its presence here does not certify implementation or acceptance.
- **Historical proposal** preserves a superseded discussion. Use the linked current reference for today's contract.

Status labels summarize the existing documents, not a new implementation acceptance. Historical outputs, scores, frozen guides, and measurement identities remain unchanged. Relinking a live annotation guide changes its byte digest; a new review package records its own identity and cannot reuse an old one.

## Shared boundaries · `shared/`

| Document | Role and status |
|---|---|
| [Terminology](shared/terminology-spec.md) | Current naming conventions and maintainer decision archive; implementation remains the authority for concrete names. |
| [Storage layout](shared/storage-layout-spec.md) | Current project, machine, and explicit knowledge-workspace storage summary; extraction and library specs own detailed domain formats and recovery boundaries. |

## Entity identity and extraction · `entities/`

| Document | Role and status |
|---|---|
| [Entity identity](entities/entity-identity.md) | Partly delivered design: approved identity/storage/UI sections are delivered within the beta scope; independent review and overall quality gates remain incomplete. |
| [Entity extraction](entities/entity-extraction.md) | Current extraction, revision, source, and binding contracts, with explicit beta and quality limits. |
| [Entity extraction evaluation](entities/entity-extraction-evaluation.md) | Annotation and acceptance protocol with frozen evidence boundaries; author review and offline replay do not complete independent acceptance. |

## Knowledge construction and maintenance · `knowledge/`

| Document | Role and status |
|---|---|
| [Knowledge domain model](knowledge/knowledge-domain-model.md) | Design draft and case walkthroughs; not the authority for settled fields, storage, commands, or a fully delivered product loop. |
| [Entity knowledge library](knowledge/knowledge-library.md) | Current organization and maintenance contract: explicit workspace, confirmed source links, exact revisions, and carrier selection. |

Read the domain model for responsibilities and consistency goals, then the library and extraction specs for implemented boundaries. Knowledge content, source identity, organization history, and carrier versions have separate owners; keeping an item is a maintenance decision, not a truth judgment.

## Controlled evaluation · `evaluation/`

| Document | Role and status |
|---|---|
| [Evaluation Core vNext](evaluation/eval-core-vnext.md) | Accepted architecture RFC; current Core contracts with historical migration rationale. |
| [CLI input compilation](evaluation/cli-evaluation-input-compilation.md) | Current parse, resolve, compile, and host assembly boundary. |
| [Evaluation Runtime Adapter](evaluation/evaluation-runtime-adapter.md) | Current production binding, resource lease, execution, and host composition boundary. |
| [Artifact persistence](evaluation/evaluation-artifact-persistence.md) | Current artifact persistence, catalog, and authenticated consumption boundary. |
| [Studio projection](evaluation/evaluation-studio-projection.md) | Current Core catalog, view-model, rendering, and route boundary. |
| [Scoring equivalence](evaluation/evaluation-scoring-equivalence.md) | Implemented scoring migration; historical rollout wording remains as rationale. |
| [Scoring pipeline](evaluation/scoring.md) | Current evidence graph, scoring layers, and decision boundaries. |
| [RAG metrics](evaluation/rag-metrics-spec.md) | RAG metric definitions and judge instruments; read alongside scoring equivalence. |
| [Sample design](evaluation/sample-design-spec.md) | Current v3 envelope and measurement design guidance; [sample format](../reference/eval-sample-format.md) owns the complete schema and adapter contract. |
| [General sample proposal](evaluation/general-sample-proposal.md) | Historical proposal; its compatibility window and migration-tool suggestions are superseded by the current v3-only contract. |

## Observation signals · `observe/`

| Document | Role and status |
|---|---|
| [Knowledge-gap signals](observe/knowledge-gap-signal-spec.md) | v0.1 design draft for gap signals and aggregation; [observation guide](../guides/observe-production.md) describes the current user workflow and its limits. |

## Paths and references

English and Chinese source folders mirror each other under `docs/specs/` and `docs/zh/specs/`. Each spec has one source per language. Domain folders organize repository reading; the documentation site retains its existing `/specs/<name>` and `/zh/specs/<name>` URLs through route mappings, including anchors. Update live repository links to the new source paths. Paths inside frozen commits or evidence packages describe their original snapshot and stay unchanged.
