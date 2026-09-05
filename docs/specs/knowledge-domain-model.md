# Knowledge construction domain model (design draft)

Status: awaiting walkthroughs with real cases. This document establishes concepts and boundaries for discussion, not implemented capabilities. Fields, storage formats, commands, and migration plans are not finalized.

## 1. Goal and scope

Following the [terminology spec](./terminology-spec.md), knowledge is a fact, case, or method that can be reused in future tasks. Each item should retain its applicability, source evidence, and current validation status.

This design describes how work logs become reviewable, revisable knowledge and then measurable carrier changes. Success means any candidate can explain its claim, scope, evidence, review history, and which concrete changes have evaluation evidence.

It covers successful experience, gaps exposed by failures, and corrections to existing knowledge. This stage designs the domain only: no automatic collection, knowledge store, retrieval service, or automatic publishing. It adds no production scoring or real-time alerts and changes no Evaluation Core, scoring, frozen prompts, or persistence contracts. Real-case walkthroughs come next; hypothetical examples are not validation evidence for this draft.

## 2. Objects and responsibilities

These names are conceptual labels, not proposed public types, fields, or enums.

| Object | Responsibility | Content and boundary |
|---|---|---|
| Entity | Identify things referenced in statements | Stable identity and description; subject/object are statement roles |
| Evidence | Preserve attributable source facts | Source identity, original location, time, visible excerpts, and coverage; evidence does not establish an extracted interpretation |
| Observation | Describe a phenomenon identified in evidence | Description, evidence references, detection method, uncertainty; may concern success, failure, correction, or conflict without asserting a root cause |
| Knowledge item | Express a reusable fact, case, or method | Stable identity, immutable revisions, content, scope, supporting and opposing evidence; candidate is a state, not a separate object |
| Knowledge carrier | Carry knowledge for future tasks | Reuse artifact concepts and version identity; represent skills, prompts, and project instructions through existing carrier or runtime context contracts |
| Knowledge change | Apply specific knowledge revisions to carriers | Rationale, target carriers, baseline and candidate versions, diff, referenced knowledge revisions, and evaluation links |

Two associated record types complete the relationships. A **review record** states who made which judgment, when, on which knowledge revision, and with what evidence. An **evaluation link** references an existing run/report/Decision and identifies the change and experimental conditions. Neither replaces existing observation reviews or evaluation reports.

Relationships:

- An observation cites one or more evidence records; evidence can be shared by observations.
- A knowledge revision can synthesize several observations, and one observation can support several items. Explicit specifications or requirements can also serve directly as source evidence without manufacturing a problem-oriented inbox entry.
- A change references one or more explicit knowledge revisions and affects one or more carrier versions.
- Knowledge and carriers have a many-to-many relationship. A path or section link does not prove complete semantic correspondence.
- An evaluation may compare candidate versions combining multiple changes; their overall effect cannot automatically be attributed to each knowledge item individually.

### 2.1 Entities, relations, and context

The shared definition, statement structure, and role explanation live in [How OMK understands knowledge](../explanation/knowledge.md). This design applies them as follows:

- `Entity` provides stable identity; `subject`/`object` reference entities and may reuse an identity across statements. Equal names do not establish identity.
- Relations express connections, actions, or states without an object. An object is optional and does not mean the evaluated artifact.
- Each statement retains its own context, modality, and evidence. Occurrence, applicability, and recording times stay separate, preventing conditions from leaking across steps or events from being promoted directly into patterns, norms, or permissions.

This is a domain representation, not a commitment to a graph database, universal relation ontology, or automatic inference engine.

## 3. Knowledge content and identity

Each revision should express:

| Information | Requirement |
|---|---|
| Form and content | Facts state scoped claims; cases preserve context, actions, and observed outcomes; methods specify conditions, steps or decision criteria, and exceptions |
| Applicability | Task type, project or subject, environment, version, validity period, and exceptions; unknowns stay explicit and omission does not mean universal applicability |
| Sources | Traceable records distinguishing source statements, observed facts, and extracted interpretations; preserve insufficient, truncated, or unavailable evidence |
| Evidence relationships | Distinguish support, opposition, and background; repeated retellings of one source are not independent corroboration |
| Revision relationships | Trace predecessors and replacement, split, or merge relationships with reasons |
| Current status | Project review and dispute records for this revision; show effectiveness evidence separately with its experimental scope |

Knowledge identity is not a file path, title, or content hash. Moving a file should not create new knowledge, and similar text should not merge knowledge from distinct projects or scopes automatically.

Clarifying a claim, correcting its conditions, or adding evidence produces a new revision. New revisions await review by default; old reviews apply only to their original revision. Splitting distinct claims or abstracting a case into a general method creates new items with derivation links. Merging preserves source and prior identity traceability rather than silently deleting history.

Unknown or conflicting claims may remain candidates. Explicit preferences and requirements retain their author and scope; authoritative statements, execution facts, and model inferences are distinct evidence sources with different strengths.

### 3.1 Draft TypeScript logical structure

These structures support the next case walkthroughs; they are not a ready-to-publish API or persistence Schema. `KnowledgeItem` aggregates a complete, directly usable view of one explicit revision. History and full review records remain linked by references; physical storage decomposition is deferred. Fields do not imply existing implementation.

```typescript
type NonEmpty<T> = readonly [T, ...T[]];
type Timestamp = string;

interface KnowledgeRevisionRef {
  knowledgeId: string;
  revisionId: string;
}

type KnowledgeActor =
  | { actorKind: 'human'; actorId: string }
  | { actorKind: 'agent'; actorId: string; executionRef: string };

interface KnowledgeItem {
  knowledgeId: string;
  revisionId: string;
  parentRevision?: KnowledgeRevisionRef;

  title: string;
  content: KnowledgeContent;
  entities: NonEmpty<Entity>;
  evidence: NonEmpty<KnowledgeEvidenceLink>;
  observationRefs: readonly string[];
  derivations: readonly KnowledgeDerivation[];
  review: KnowledgeReviewView;

  createdAt: Timestamp;
  createdBy: KnowledgeActor;
  revisedAt: Timestamp;
  revisedBy: KnowledgeActor;
  revisionReason: string;
}

interface Entity {
  entityId: string;
  label: string;
  description: string;
}

interface EntityRef {
  entityId: string;
}

type KnowledgeTime =
  | { timeKind: 'unknown' }
  | { timeKind: 'instant'; at: Timestamp }
  | { timeKind: 'interval'; start: Timestamp | null; end: Timestamp | null };

interface KnowledgeContext {
  scenario: string;
  conditions: readonly string[];
  exceptions: readonly string[];
  unknowns: readonly string[];
  occurredDuring: KnowledgeTime;
  validDuring: KnowledgeTime;
}

interface KnowledgeStatement {
  statementId: string;
  subject: EntityRef;
  relation: string;
  object?: EntityRef;
  modality: 'observed' | 'asserted' | 'generalized' | 'normative'
    | 'capability' | 'permission';
  polarity: 'positive' | 'negative';
  context: KnowledgeContext;
  evidenceRefs: NonEmpty<string>;
}

type KnowledgeContent =
  | { knowledgeKind: 'fact'; statement: KnowledgeStatement }
  | {
      knowledgeKind: 'case';
      situation: string;
      actions: NonEmpty<KnowledgeStatement>;
      observedOutcomes: NonEmpty<KnowledgeStatement>;
    }
  | {
      knowledgeKind: 'method';
      purpose: string;
      instructions: NonEmpty<KnowledgeStatement>;
    };

interface KnowledgeEvidenceLink {
  evidenceRef: string;
  relation: 'supports' | 'opposes' | 'background';
  interpretation: string;
}

interface KnowledgeDerivation {
  relation: 'derived_from' | 'split_from' | 'merged_from' | 'replaces';
  source: KnowledgeRevisionRef;
  reason: string;
}

type KnowledgeReviewVerdict =
  | 'needs_more_context'
  | 'supported'
  | 'unsupported'
  | 'disputed';

interface KnowledgeReviewRecord {
  reviewId: string;
  target: KnowledgeRevisionRef;
  reviewedAt: Timestamp;
  reviewedBy: KnowledgeActor;
  verdict: KnowledgeReviewVerdict;
  rationale: string;
  evidenceRefs: NonEmpty<string>;
  supersedesReviewIds: readonly string[];
}

interface KnowledgeReviewView {
  target: KnowledgeRevisionRef;
  reviewStatus: 'pending' | KnowledgeReviewVerdict;
  reviewRefs: readonly string[];
  unresolvedReasons: readonly string[];
}
```

### 3.2 Field semantics and constraints

- `KnowledgeItem` is the complete view of a knowledge item at an explicit revision, including identity, title, content, scope, evidence relationships, and current review status. `knowledgeId` stays stable across revisions; `revisionId` fixes the content revision. Together they identify the referenced revision. This draft adds no `latest` pointer that could be mistaken for an adopted version. Reads must name a revision or use a selection policy defined later.
- Original logs, full revision history, and complete review records are not embedded in the item; use evidence references, revision references, and `reviewRefs` respectively. Carrier changes and their effectiveness evaluations are obtained through related queries, without collapsing multiple experiments into an item-level conclusion. A complete view does not prescribe a single storage table or duplicated document.
- `entities` retains description snapshots of referenced entities for this revision, making the complete item readable. `subject`/`object` must resolve to unique `entityId` entries in that collection. Reuse identity across items; equal names do not justify merging, and role changes do not create new entities. Unresolved identity remains separate with explicit uncertainty until reviewed.
- Entity snapshots are not new global factual authorities. Renaming or updating descriptions cannot rewrite old knowledge revisions; changing referents, relations, or context requires a new revision. Mapping to an artifact remains explicit rather than inferred from names.
- `knowledgeKind` organizes content: a fact has one statement, a case has actions and observed outcomes, and a method has procedural or decision statements. `situation`/`purpose` aid reading without introducing contradictory parallel claims. Split independent facts into items; cases and methods may retain ordered statements.
- `KnowledgeStatement` expresses a relation or action, with explicit text for `relation` initially and `polarity` distinguishing affirmation from negation. Omitted `object` means none is needed. If an action has an unidentified object, retain a locally described entity and note the uncertainty in `unknowns`; unknown does not mean absent.
- `modality` expresses claim nature, not confidence: `observed` events, source `asserted` claims, `generalized` patterns, `normative` requirements or prohibitions, `capability`, and `permission`. Negation uses `polarity`; distinguish inability from lack of permission. Case actions and outcomes use only `observed`. Do not fabricate an unknown terminal outcome: state the last observable status and record the gap. Norms retain their author and authority through sources.
- Each statement owns its `context`: scenario, conditions, exceptions, unknowns, and occurrence/applicability times. Empty conditions mean no additional conditions recorded, not universal applicability. Unknown scope belongs in `unknowns`; non-calendar restrictions such as versions remain explicit condition text without an executable matching language yet.
- In `KnowledgeTime`, `unknown` means undetermined or inapplicable, explained in `unknowns`; `instant` is a time point; `interval` includes its start and excludes its end. `null` means explicitly unbounded, never unknown. A partly known interval uses `unknown` with known details retained in context for now. Item creation/revision fields record documentation time, not event or applicability time.
- `statementId` is unique within a revision; statement references must also carry the knowledge revision identity. Each statement's `evidenceRefs` is a non-empty subset of item evidence references, avoiding transferring evidence from one claim to others. Entity resolution, case modality, and interval validity require runtime validation.
- `evidenceRef` logically references an existing evidence record or its adapter, not an arbitrary file path. Resolution must preserve source identity, location, and coverage limits. Unavailable or partial evidence stays explicit; a reference alone does not establish support. `interpretation` is the author's explanation of the relationship, never a replacement for the source.
- Non-empty `evidence` gives candidates a source, but background evidence can motivate an unverified candidate without a supported judgment at extraction time. `observationRefs` can be empty for knowledge directly sourced from explicit specifications or requirements. Deduplication and independence follow source identity, not reference counts.
- `parentRevision` references the predecessor within the same item and is absent for the first revision. New claims, splits, merges, and abstractions from cases use `derivations` to reference specific old revisions with reasons. References must resolve and revision relationships must be acyclic; acceptance of concurrent branches awaits walkthroughs.
- `createdAt`/`createdBy` identify initial item creation and stay unchanged across revisions; `revisedAt`/`revisedBy` identify the current revision and its author. Both pairs match for the first revision, and `revisionReason` explains creation or revision. `reviewedBy` identifies the reviewer; none necessarily authored the original claim. Source evidence retains that author, and preferences or requirements also identify their subject in content and scope. An agent's `executionRef` should resolve available model and execution information for that invocation; a model name alone is not reviewer identity.
- Reviews cite evidence actually reviewed from their target revision: `evidenceRefs` is a non-empty subset of that revision's evidence references. New evidence requires a new revision before review. `supersedesReviewIds` only explicitly corrects prior judgments on the same target revision, with reasons and retained history. Who may correct a judgment is governed by the future review-authority policy.
- The `KnowledgeReviewView` in `KnowledgeItem.review` is derived, not a second source of judgments; its `target` must match the enclosing `knowledgeId`/`revisionId`. New reviews may update this view without changing the knowledge revision; content, scope, and evidence relationships remain immutable. No reviews means `pending`; unresolved opposing judgments mean `disputed`, never timestamp-based overwrite. New revisions inherit no reviews. Missing sources and authority to accept agent judgments appear in `unresolvedReasons` and must not silently promote status to `supported`. Full projection and authority rules must be defined before implementation.
- Supersession, expiry, and retirement belong to separate lifecycle records, not evidence review status. Effectiveness remains linked through concrete knowledge changes to existing reports, with no `validated: true` or permanent item-level benefit score.

`Timestamp`, string IDs, and references are logical placeholders. A formal Schema must validate time formats, non-empty text, unique identities, reference ownership, and the cross-record constraints above; TypeScript alone provides no runtime validation. Storage layout, Schema versions, lifecycle records, and concurrent update protocols follow the real-case walkthroughs.

## 4. State and lifecycle

### 4.1 Evidence review

Review targets a specific revision, not a title or the latest version. Proposed judgments include awaiting review, needs more context, supported, unsupported, and disputed. These are not final enum values.

Supported means supported within the stated scope and visible evidence, not universally certified as true. Counterevidence triggers renewed review; conflicting judgments remain disputed rather than silently using last-write-wins. Both model interpretations and human judgments retain their provenance; model confidence is not validation.

Old revisions remain traceable, with replacement or retirement recorded separately. Rejection, expiry, and supersession have different reasons and do not collapse into one invalid state. Reuse can trigger review, but counts alone do not change validation conclusions.

### 4.2 Carrier changes and effectiveness

Changes involve proposal, review, candidate creation, evaluation links, and adoption or rejection. Evaluation, application, and publication are recorded separately rather than forced into one linear state sequence for every scenario.

Effectiveness belongs to the tested baseline and candidate versions under their conditions: model, dataset, runtime environment, and decision design are constrained by existing evaluation evidence. Links must match actual tested versions. After a candidate changes, the old report explains only the old version and does not validate the new one automatically.

Distinguish unevaluated changes, changes with applicable evaluation evidence, and evidence inapplicable to the current change. Preserve existing Decision meanings without another acceptance standard. Supported knowledge does not imply an effective change; an effective change does not prove every included claim true. Production observation alone yields neither improvement estimates nor release conclusions.

### 4.3 Formation and maintenance

1. Read authorized logs or accept explicit feedback, preserving sources and coverage limits.
2. Identify phenomena, extract candidate facts, cases, or methods, and compare them with existing items.
3. Review content and scope, preserve gaps and disputes, and decide whether to revise or create an item.
4. Propose carrier changes where useful; not every item must become an instruction or enter a skill.
5. When effectiveness needs validation, evaluate concrete carrier versions under controlled conditions and follow existing adoption and release governance.
6. Return to review and revision when later use reveals evidence or counterexamples, preserving history.

Using a case both to derive a change and to validate it demonstrates coverage of that case, not independent generalization. Distinguish change-selection cases from independent evidence used for release decisions.

## 5. Integration with existing contracts

| Existing capability | Integration and remaining boundary |
|---|---|
| Trace IR, evidence references, and source-record archives | Reuse source, time, and correlation identity; missing archives and partial visibility stay explicit even when extraction succeeds |
| `ObservationInboxItem` | Currently emphasizes suspected problems and skill attribution. Preserve this meaning. Successful experiences and knowledge without carrier attribution need a separate entry design, not fabricated failure signals |
| `ObservationReviewState` | `real_issue` confirms a problem, not support for a knowledge revision or effectiveness of a change; it cannot stand for all three judgments |
| Artifact and runtime context | Retain existing categories and identity. Fact/case/method does not extend `ArtifactKind`; project instructions do not justify inventing a new carrier category |
| Sample drafts | Support case authoring from confirmed gaps; knowledge does not automatically become a formal sample or enter an independent validation set |
| Report, Decision, and governance | Reference existing reports and adoption workflows without duplicating scoring, creating verdicts, or bypassing publication authorization |

Mining and extraction sit at the collaboration boundary of observation and subsequent authoring/governance. They must not introduce log reading, model calls, or knowledge storage dependencies into `eval-core`. Concrete module ownership follows the case walkthroughs.

This design performs no field renaming, data migration, or Schema release. Implementation must define storage and version contracts first; persistence or public identity changes receive separate review. Existing observations must not silently acquire the semantics of the new model.

## 6. Invariants

- Evidence, interpretations, knowledge claims, and effectiveness conclusions remain distinguishable.
- Reviews bind to knowledge revisions; effectiveness links bind to tested versions and conditions, never drifting with the latest content.
- Recovery, successful completion, and repetition alone do not prove knowledge's causal contribution.
- Preserve source identities, conflicts, and coverage gaps; do not infer hidden reasoning.
- Log access, evidence persistence, model transmission, and external publication respect their respective authorization boundaries. Extraction authorization does not expand access or publication permissions. Retain necessary evidence only and explicitly degrade when sources become unavailable.
- Storage, archival, deletion, and retention policies must be decided before implementation; traceability does not justify indefinite retention of original conversations.

## 7. Next stage: real-case walkthroughs

Discuss this draft first, then select authorized work excerpts covering a new method, a correction to an existing fact, and a reusable case. For each, ask:

1. What is original evidence versus interpretation? Is context needed to determine scope missing?
2. Is the result a fact, case, or method? Does it create an item or revise an existing one?
3. What supports or contradicts the review? Can disputes, splits, and expiry preserve identity and history?
4. Which carrier should receive it, or should it remain a case? Can it produce a concrete reviewable change?
5. How much can existing observation and evaluation contracts support? Does anything force fabricated states or conflated sources?
6. Which cases informed the change, and which evidence independently validates its effect?

After walkthroughs, decide the minimum storage model, review authority and conflict resolution, successful-experience entry point, carrier-section links, and first implementation slice. Revise this draft from observed gaps rather than expanding it into a general knowledge platform upfront.
