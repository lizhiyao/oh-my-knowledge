# Knowledge construction and maintenance contracts

This document specifies current ownership and consistency boundaries for content, source identity, organization, and carrier maintenance. [Knowledge principles](../../explanation/knowledge.md) alone own concept definitions; the [knowledge maintenance guide](../../guides/knowledge/extract-knowledge.md) owns user steps.

## 1. Delivered scope {#current-scope}

Within an explicitly chosen local workspace, CLI and Studio share source capture, candidate extraction, review decisions, immutable revisions, entity correction, tags, entity-library organization, and carrier saving. These entrypoints do not automatically unify identities across Agents, establish truth, or prove reuse benefits.

## 2. Objects and responsibilities {#current-objects}

| Object / record | Owner and responsibility |
|---|---|
| Source window | Selected excerpts, source identity, scope, and limits; later judgments can return to the same evidence |
| Source entity analysis | Window-local objects, mentions, and immutable analysis revisions; no cross-window unified identity |
| Knowledge content | Stable identity, immutable content revisions, and supporting/opposing/background evidence; candidate is a review state |
| Maintenance decision | Retain/discard and reason for an exact knowledge revision; retention is not truth verification |
| Library object | User-confirmed cross-window organization; references source identity without copying content |
| Tags | User-maintained topic organization with separate history; does not revise content |
| Knowledge carrier | Selected knowledge revisions organized as skill/prompt versions, saved separately from content |
| Measurement evidence | Existing Core run/report/Decision testing a specific carrier change; not a substitute for review |

One carrier may cite many items; one item may appear in multiple carriers or object entries. Each retains its identity. Names, chronology, or UI placement establish neither identical objects nor claim truth.

## 3. Knowledge and revisions {#current-revisions}

Content preserves statements, conditions, time, exceptions, unknowns, and source interpretation. Statement subject/object roles remain distinct from source entity identity. Finding an entity need not yield knowledge. Source assertions, execution facts, and extraction inferences remain distinct.

Content edits create new revisions while old content and reasons remain available. Old decisions do not automatically apply to new versions. Entity correction also does not rewrite knowledge; a user reviews and explicitly applies the exact entity revision to create a new knowledge revision.

Source matching establishes location and reference closure, not claim support. Unreadable sources leave saved records available with limits, without fabricated originals or a no-problem conclusion.

## 4. Organization and carrier maintenance {#current-maintenance}

### 4.1 Library organization {#current-library}

User-confirmed links connect window entities and library objects, binding analysis, entity, entity revision, and original mentions. Equal names do not merge identities. [Entity identity](../entities/entity-identity.md) owns component, instance, version, and unresolved-identity constraints.

Organization and content histories remain separate. A knowledge binding that disagrees with the organization's entity revision requires review and cannot enter the object's current retained set or default carrier selection. Unlinking does not delete knowledge; empty objects retain history. See the [library specification](knowledge-library.md).

### 4.2 Carrier maintenance and effects {#current-carriers}

A knowledge change goes through proposal, review, candidate formation, evaluation association, and adoption or rejection. Evaluated, written, and published states are recorded separately; no single linear order is imposed on every scenario.

Generation includes only explicitly selected retained revisions and preserves conditions and evidence classifications. Updating a carrier rebuilds its knowledge section from this selection while retaining manual content outside that section and dependent assets. Prior carrier versions remain unchanged. Knowledge changes produce reminders and review states, not background carrier rewrites.

Saving, actual use, and controlled effect verification are separate records. The [knowledge maintenance contract](knowledge-maintenance.md) and maintenance flow own versions, preview conflicts, reminders, and itemwise update checks.

## 5. Data and application boundaries {#current-implementation}

`knowledge/` owns pure content contracts, validation, and history rules. Outer observation applications and filesystem adapters own capture, model calls, and persistence; CLI/Studio share those flows. Library organization is not a second content store.

Writes carry expected versions; conflicts require rereading and review. Only allowed workspace locations receive writes. [Extraction](../entities/entity-extraction.md) and [storage layout](../shared/storage-layout-spec.md) own current formats and recovery. This page does not duplicate a schema catalog.

## 6. Acceptance and limits {#current-evidence}

Functional acceptance covers continued accumulation, knowledge revision, source/version rereading, organization links, and carrier reminders/update consistency. Usability does not establish overall extraction accuracy, truth, or task benefits; each has its own evidence.
