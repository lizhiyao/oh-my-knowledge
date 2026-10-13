# Knowledge construction and maintenance contracts {#knowledge-construction-domain-model-design-draft}

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

## 6. Acceptance and historical rationale {#current-evidence}

Functional acceptance covers continued accumulation, knowledge revision, source/version rereading, organization links, and carrier reminders/update consistency. Usability does not establish overall extraction accuracy, truth, or task benefits; each has its own evidence.

[Historical design and cases](history/knowledge-domain-model-design.md) retain the original sketches, first-release decisions, and three case walkthroughs. Their logical interfaces, draft schemas, and then-unresolved issues are not current write contracts.

<!-- Preserve old section links; the archive above owns historical content. -->
<a id="_1-goal-and-scope"></a>
<a id="_1-1-design-authority-and-decision-levels"></a>
<a id="_2-objects-and-responsibilities"></a>
<a id="_2-1-entities-relations-and-context"></a>
<a id="_2-2-aggregate-boundaries-and-dependency-direction"></a>
<a id="_2-3-carrier-association-contract"></a>
<a id="_3-knowledge-content-and-identity"></a>
<a id="_3-1-draft-typescript-logical-structure"></a>
<a id="_3-2-field-semantics-and-constraints"></a>
<a id="content-organization-and-applicability"></a>
<a id="entities-and-identity"></a>
<a id="evidence-and-review"></a>
<a id="revisions-and-complete-views"></a>
<a id="_4-state-and-lifecycle"></a>
<a id="_4-1-evidence-review"></a>
<a id="_4-2-carrier-changes-and-effectiveness"></a>
<a id="_4-3-formation-and-maintenance"></a>
<a id="_5-integration-with-existing-contracts"></a>
<a id="_6-invariants"></a>
<a id="_7-real-case-walkthroughs-and-open-decisions"></a>
<a id="_8-evolution-constraints-and-implementation-entry"></a>
<a id="_9-minimal-contracts-for-the-first-implementation"></a>
<a id="_9-1-source-resolution"></a>
<a id="_9-2-review-projection-policy-v1"></a>
<a id="_9-3-revision-storage-and-write-protocol"></a>
<a id="_9-4-internal-interface-shapes"></a>
<a id="_9-5-initial-acceptance-scope"></a>
<a id="_10-architecture-decisions-for-knowledge-extraction-from-work-logs"></a>
<a id="_10-1-domain-ownership-and-dependencies"></a>
<a id="_10-2-separate-entity-mentions-from-entity-identity"></a>
<a id="_10-3-evidence-windows-and-extraction-runs"></a>
<a id="_10-4-admission-from-model-output-to-knowledge-revisions"></a>
<a id="_10-5-human-handling-storage-and-source-retention"></a>
<a id="_10-6-initial-scope-and-architecture-acceptance"></a>
<a id="appendix-cr-feedback-walkthrough"></a>
<a id="_1-sources-and-coverage"></a>
<a id="e1-process-feedback"></a>
<a id="e2-removal-request-and-its-referent"></a>
<a id="e3-existing-repository-requirement"></a>
<a id="evidence-resolution"></a>
<a id="authoring-record"></a>
<a id="_2-complete-items"></a>
<a id="appendix-fact-correction-and-partial-review"></a>
<a id="e4-previous-type-source"></a>
<a id="e5-current-type-snapshot"></a>
<a id="authoring-and-review-attribution"></a>
<a id="appendix-successful-experience-and-method-extraction"></a>
<a id="e6-invocation-and-result"></a>
<a id="e7-procedure-source"></a>
<a id="authoring-attribution"></a>
<a id="studio-conversation-to-extraction-links"></a>

Original case entries: [CR feedback](history/knowledge-domain-model-design.md#cr-case), [fact correction](history/knowledge-domain-model-design.md#fact-correction), and [successful experience](history/knowledge-domain-model-design.md#successful-experience).
<a id="cr-case"></a>
<a id="e1"></a>
<a id="e2"></a>
<a id="e3"></a>
<a id="fact-correction"></a>
<a id="e4"></a>
<a id="e5"></a>
<a id="successful-experience"></a>
<a id="e6"></a>
<a id="e7"></a>
