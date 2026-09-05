# Knowledge construction domain model (design draft)

Status: documentation walkthroughs for [CR feedback](#cr-case), [fact correction](#fact-correction), and [successful experience](#successful-experience) are complete; implementation boundaries remain unvalidated. This document establishes concepts and boundaries for discussion, not implemented capabilities. Fields, storage formats, commands, and migration plans are not finalized.

## 1. Goal and scope

Following the [terminology spec](./terminology-spec.md), knowledge is a fact, case, or method that can be reused in future tasks. Each item should retain its applicability, source evidence, and current validation status.

This design describes how work logs become reviewable, revisable knowledge and then measurable carrier changes. Success means any candidate can explain its claim, scope, evidence, review history, and which concrete changes have evaluation evidence.

It covers successful experience, gaps exposed by failures, and corrections to existing knowledge. This stage designs the domain only: no automatic collection, knowledge store, retrieval service, or automatic publishing. It adds no production scoring or real-time alerts and changes no Evaluation Core, scoring, frozen prompts, or persistence contracts. Walkthrough progress appears in section 7; hypothetical examples are not validation evidence for this draft.

### 1.1 Design authority and decision levels

[How OMK understands knowledge](../explanation/knowledge.md) is the sole authority for conceptual definitions. This document translates them into responsibilities, structures, and consistency constraints. Resolve conflicts by correcting this design rather than letting fields redefine the concepts.

| Level | Decisions here | Evolution |
|---|---|---|
| Conceptual constraints | Entities differ from roles; statements carry context; knowledge can involve multiple entities; knowledge differs from carriers; observation supplies evidence and evaluation tests carrier changes | Discuss and update the conceptual definition first |
| Domain decisions | Separate identity from revision, statements from organization, statement-specific evidence, and version-bound reviews from effectiveness | Validate through cases; explain semantic and historical impact of changes |
| Working design | Field names, enums, case organization, time boundaries, and status projection | Revisable, not published contracts |
| Implementation choices | Database, indexes, APIs, collection scheduling, and Schema versions | Decide with the first implementation slice |

This iteration only refines documentation. Risks concern conceptual fidelity and future contract ambiguity; runtime code, public Schemas, and measurement behavior remain unchanged. Long-term stability means preserving semantics and traceability while allowing storage, extraction policies, and carriers to evolve independently.

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

### 2.2 Aggregate boundaries and dependency direction

`KnowledgeItem` is a complete read view. The write consistency boundary is one knowledge revision, not a transaction spanning entities, logs, every review, and evaluation reports.

| Boundary | Owned data and decisions | Reference-based collaboration |
|---|---|---|
| Evidence and observation | Source snapshots, coverage limits, observed phenomena | Sources exist independently; knowledge references stable source identity |
| Knowledge content | Revisions, statements, context, entity snapshots, evidence links | References sources and derivations; performs no model calls or log reads |
| Entity identity | Identity allocation and evidenced identity mappings | Does not own knowledge content; discovery uses rebuildable indexes |
| Review and lifecycle | Review records, authority policy, recommendation and retirement decisions | References immutable revisions without rewriting history |
| Carrier changes and evaluation links | Knowledge used, changed versions, experiments, adoption records | Reuses Artifact, Report, and Decision without redefining knowledge truth |

These are logical responsibilities, not mandatory services, packages, or databases. Pure validation and deterministic projection remain host-independent. Source reads, extraction model calls, and persistence use adapters and must not enter `eval-core`. Read views expose unresolved references and incomplete projections instead of treating temporary absence as nonexistence.

### 2.3 Carrier association contract

One revision may inform multiple carriers, and one carrier version may contain multiple knowledge items. A knowledge change must resolve its explicit knowledge revision set, target artifact identity, baseline and candidate versions, diff, and rationale. Section locations aid navigation but do not replace content-version identity; version changes require renewed association checks.

Evaluation links reference existing reports and the actual tested version set and conditions. Aggregate benefits are not allocated to individual knowledge items. Partial application, multi-carrier failures, evaluation, adoption, and publication retain separate states. Reference types and recovery rules must be settled before initial implementation, without inventing parallel Artifact or Report Schemas here.

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

These structures support case walkthroughs; they are not a ready-to-publish API or persistence Schema. `KnowledgeItem` aggregates a complete, directly usable view of one explicit revision. History and full review records remain linked by references; physical storage decomposition is deferred. Fields do not imply existing implementation.

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

type KnowledgeTimeBound =
  | { boundKind: 'known'; at: Timestamp }
  | { boundKind: 'unbounded' }
  | { boundKind: 'unknown'; reason: string };

type KnowledgeTime =
  | { timeKind: 'unknown'; reason: string }
  | { timeKind: 'not_applicable'; reason: string }
  | { timeKind: 'instant'; at: Timestamp }
  | {
      timeKind: 'interval';
      start: KnowledgeTimeBound;
      end: KnowledgeTimeBound;
    };

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
  modality: 'descriptive' | 'normative' | 'capability' | 'permission';
  polarity: 'positive' | 'negative';
  context: KnowledgeContext;
}

interface KnowledgeContent {
  statements: NonEmpty<KnowledgeStatement>;
  organization: KnowledgeOrganization;
}

type KnowledgeOrganization =
  | { knowledgeKind: 'fact' }
  | {
      knowledgeKind: 'case';
      situation: string;
      actionStatementIds: readonly string[];
      outcomeStatementIds: readonly string[];
      gaps: readonly string[];
    }
  | {
      knowledgeKind: 'method';
      purpose: string;
      instructionStatementIds: NonEmpty<string>;
    };

interface KnowledgeEvidenceLink {
  evidenceLinkId: string;
  evidenceRef: string;
  statementIds: NonEmpty<string>;
  relation: 'supports' | 'opposes' | 'background';
  basis: 'direct_observation' | 'source_assertion' | 'inference';
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
  statementIds: NonEmpty<string>;
  reviewedAt: Timestamp;
  reviewedBy: KnowledgeActor;
  verdict: KnowledgeReviewVerdict;
  rationale: string;
  evidenceLinkIds: NonEmpty<string>;
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

#### Content, organization, and applicability

- `KnowledgeItem` is a complete view of an explicit revision. `content.statements` is its sole statement collection; `organization` describes how to read and reuse it, without duplicating statements inside cases, methods, or evidence. Facts may contain one or several closely related statements. Choose item boundaries by shared reuse and independent maintenance, not sentence count.
- Statement IDs are unique within a revision. Case actions/outcomes and method instructions reference local statement IDs. References must resolve and be unique within each group. Arrays express narrative or instructional order, not causality, exact event order, or executable control flow. Other statements may supply background or decision rationale. `situation`/`purpose` are reading summaries; substantive content belongs in statements and context.
- A case needs at least one action or outcome statement. Missing actions, pending outcomes, and unavailable sources belong in `gaps`, never fabricated statements. Cases can use logs or retrospective participant reports, distinguished by evidence relationships. Hypothetical consequences are not recorded outcomes. Generalizing a method from a case creates a separate item with derivation links.
- Methods contain at least one instruction or decision statement and may include descriptive rationale. Facts may describe states, relations, capabilities, or permissions; case action/outcome statements use `descriptive`. “The user requested X” is descriptive; the requirement itself is normative and may form a method instruction or decision criterion. Fact/case/method organizes reuse, not credibility, and does not extend `ArtifactKind`.
- `KnowledgeStatement` expresses a state, relation, or action. `relation` initially uses explicit text such as “is under maintenance”, “depends on”, or “executes”. Objectless states need no invented entity. Omitted `object` means none is needed; an unidentified object gets a local entity and an explicit identity gap in `unknowns`. Values and units remain explicit text for now; not every value must become an entity, and structured numeric queries are not promised.
- `modality` distinguishes description, norms, capability, and permission; `polarity` records affirmation or negation. Distinguish inability from lack of permission. These provisional enums can change through walkthroughs; they do not mix source acquisition or credibility into modality. Observation, retelling, and inference belong to evidence-link `basis`; one statement may have evidence obtained in several ways.
- Each statement owns its `context`. Time, scenario, conditions, and exceptions express applicability without a second item-level scope. Empty conditions mean no additional conditions recorded, not universal applicability; unknown scope belongs in `unknowns`. Versions and environments remain explicit condition text without an executable matching language. Common method preconditions must be explicit in affected steps. Any future shared-context abstraction must define expansion rules preserving the expanded semantics.
- Occurrence time, applicability time, and documentation time remain separate. Unknown and inapplicable times have distinct types and reasons. Intervals include their start and exclude their end; known endpoints must be ordered. An unknown endpoint does not discard the known endpoint; unboundedness must be explicit. Formal Schema design must define date precision, timezone, and natural-language conversion without inventing precise timestamps from vague evidence.

#### Entities and identity

- `entities` contains description snapshots of referenced entities. Subject and object share `EntityRef`; references resolve uniquely within the collection. Role changes create no new identity, and identities are reusable across items. Entity indexes must derive from both subjects and objects of all statements, allowing discovery from either participant. They are rebuildable read models, not independent factual authorities.
- Entity IDs must be unique within an explicit identity namespace. Names, paths, and similar descriptions do not justify automatic merges. Unresolved identities retain separate IDs and uncertainty. Future merge/alias decisions need provenance and history; reversing a decision must not damage old revisions. Labels and descriptions aid identification; substantive knowledge belongs in statements.
- Entity identity differs from carrier-version identity. A skill may be both a described entity and a carrier of other knowledge, with an explicit mapping rather than name-based inference. Renaming cannot rewrite old snapshots; changing a statement's referent or context creates a revision.

#### Evidence and review

- Each evidence relationship has a revision-local unique `evidenceLinkId`, identifying one source and a set of statements. One source may support one statement while opposing another; different relationships require separate links. `basis` describes how this interpretation uses the source, not its reliability or a permanent source property. `interpretation` never replaces original content.
- `evidenceRef` logically references existing evidence or an adapter. Resolution retains source identity, version or snapshot identity, location, author, and coverage limits. Source changes must not silently alter historical evidence meaning. Unavailable sources retain logical references and reasons; traceability does not promise indefinite log retention.
- Every statement needs at least one evidence link. Inferences motivated only by background sources may remain pending candidates, never automatically supported. Ideas without any referenceable source stay in the extraction workspace rather than acquiring fabricated evidence. `observationRefs` may be empty for directly sourced requirements. Repeated retellings are not independent corroboration; deduplicate by original source identity.
- Reviews bind to a revision and the actual statement set examined. Cited evidence links must belong to that revision, cover examined statements, and supply at least one link per examined statement. A verdict applies to every listed statement; different verdicts require separate records. Reviewers address known counterevidence in scope and explain excluded evidence instead of selecting only supporting sources.
- `KnowledgeReviewView` is derived and must target the enclosing revision. Partial review cannot promote the whole item: no review means `pending`; partial coverage with unreviewed remainder means `needs_more_context`. Aggregate `supported` requires authorized support for every statement and no unresolved counterevidence or coverage gaps. Conflicts yield `disputed`; insufficiency or opposition remains traceable to individual statements. Status is a summary; consumers still need details.
- New revisions await new review. `supersedesReviewIds` only corrects judgments for the same revision and statement set, preserving history and reasons rather than timestamp overwrite. Reviewers differ from source authors; agent reviews require resolvable execution identity. Section 9.2 defines initial authority, aggregate-state precedence, and projection rules independently of database write order.

#### Revisions and complete views

- `knowledgeId` identifies a unit maintained and reused together; `revisionId` fixes content, entity snapshots, context, and evidence links. Neither is replaced by a title, path, or content hash. External statement references also carry knowledge revision identity. Statement IDs may persist across semantically continuous revisions but never transfer old reviews automatically.
- `parentRevision` identifies a predecessor in the same item. Corrected conditions or new evidence create revisions; independent conclusions, splits, merges, and case-derived methods use `derivations` to link specific revisions of other items. Predecessor and derivation graphs must be acyclic. Derivation implies neither evidential support nor effectiveness, and replacement links do not automatically retire old items. Distinguish correcting an error from updating the applicable source version; changed descriptions in a new version do not automatically contradict facts within their original scope.
- `createdAt`/`createdBy` remain stable; `revisedAt`/`revisedBy` identify the current revision. Both pairs match initially, and `revisionReason` explains changes. Full logs, history, reviews, carrier changes, and reports remain referenced; a complete view does not embed all history.
- New reviews can update the derived view without changing the content revision. Supersession, expiry, and retirement belong to independent lifecycle records. Evidence support differs from current reuse recommendations. Effectiveness remains linked through concrete carrier changes, with no permanent `validated: true` or item-level benefit score.

String IDs and `Timestamp` are logical placeholders. Formal Schema validation must cover non-empty text, unique identities, reference ownership, valid times, and cross-record constraints. TypeScript supplies no runtime validation; this document selects no database, serialization format, or general query language.

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

## 7. Real-case walkthroughs and open decisions

[The first CR feedback walkthrough](#cr-case) instantiates a case and a method candidate without inventing outcomes or effectiveness; it required no new fields. [Fact correction](#fact-correction) further examines version scope and partial review; [successful experience](#successful-experience) examines the distinction between one successful run and method extraction. These validate document expression, not runtime behavior. For each, ask:

1. What is original evidence versus interpretation? Is context needed to determine scope missing?
2. Is the result a fact, case, or method? Does it create an item or revise an existing one?
3. What supports or contradicts the review? Can disputes, splits, and expiry preserve identity and history?
4. Which carrier should receive it, or should it remain a case? Can it produce a concrete reviewable change?
5. How much can existing observation and evaluation contracts support? Does anything force fabricated states or conflated sources?
6. Which cases informed the change, and which evidence independently validates its effect?

The first three cases required no new fields. Section 9 now specifies initial source-resolution, review-projection, persistence, and concurrency decisions; section 9.5 describes the first slice. Role reversal, same-source counterevidence, deletion, and concurrency belong in implementation acceptance, not assumed covered by documentation walkthroughs.

## 8. Evolution constraints and implementation entry

- **Consistent writes before indexes.** Validate and atomically write a revision's content, entity references, and evidence links; validate the target before appending reviews. The initial write protocol needs idempotency keys and expected-predecessor checks so retries do not silently duplicate revisions and concurrent edits cannot overwrite one another. Cross-boundary operations retain retryable records rather than requiring universal transactions.
- **Stable historical interpretation.** Schema, extractor, and review-policy versions have separate responsibilities; none substitutes for `revisionId`. Persistence explicitly identifies Schema versions. Semantic migrations preserve historical interpretability without silently promoting old states under new rules. Derived views should identify their policy version and input records for recomputation and explanation.
- **Retrieval is not adoption.** Finding an item, new revision, or entity alias does not imply recommended reuse. Retrieval returns explicit revisions, scope, source availability, review status, and lifecycle state. Automated reuse applies an explicit selection policy; top ranking or latest write is not authorization.
- **Traceable deletion and correction.** Evidence retention is independent of knowledge revisions. Deleted source material may leave permitted minimal locators and unavailability reasons while current availability views degrade. Historical reviews retain their original basis without claiming current reproducibility. Deleted item content resolves to an explicit deletion state; its identity cannot be reassigned.
- **Extend expression for actual needs.** Multi-party actions can initially use an event entity connecting participants. Introduce qualified roles, typed values, or step graphs when real multi-party, numeric, or branching-method requirements justify them. New structure needs a verifiable retrieval or reuse benefit, not a generic property bag collecting arbitrary fields.

The next deliverable is a set of source-verifiable real cases and resulting model decisions. These are acceptance criteria for walkthroughs, not completed validation:

| Scenario | Required preservation |
|---|---|
| One entity switches subject/object roles across items | Stable identity, local roles, discovery from either entity |
| A state fact contains two related statements | No invented object or sentence-count split; individual scope and evidence |
| One log supports an action but opposes a successful outcome | Same source, distinct links; outcome dispute does not contaminate the action judgment |
| A case has participant reports and an unknown result | Source-assertion basis, known actions, outcome gaps; no invented direct observation |
| A case yields a method and a skill change | Derivation, unverified method status, explicit carrier versions, independent effectiveness evidence |
| Fact correction, partial review, and concurrent revisions | Interpretable historical identities and judgments; no whole-item support hiding unreviewed statements |

The first product slice closes “real work log → candidate knowledge → inspect each source”. Use real tasks to check reuse value, missing conditions, and inferences mistaken for facts. Validation and review states support this loop; complete storage, entity indexes, and carrier-change associations follow demonstrated needs. General graph reasoning and automatic publication are not prerequisites.

## 9. Minimal contracts for the first implementation

This section resolves section 7 decisions as acceptance criteria for supporting capabilities when implemented, without requiring all infrastructure before validating log-mining value. Section 3.1 continues to describe domain content; these read/write boundaries do not add storage metadata to statements. Start with a local-file adapter, without a new database dependency, CLI/MCP release, public Schema, or migration of existing observations.

### 9.1 Source resolution

Initial inputs are explicitly registered excerpts and existing observation-archive references. Register `KnowledgeEvidenceBinding` before referencing `evidenceRef`; each reference identifies one immutable source version and selection. Identical registration is retryable; changed bindings require new references. Unused registered sources are neither automatically deleted nor authorized for indefinite retention.

| Result | Exact meaning | Consumption |
|---|---|---|
| `available` | Identity/version match and the selected excerpt is fully readable | Inspect the excerpt; this does not establish a complete conversation or correct interpretation |
| `partial` | Identity/version match but the selected excerpt is truncated or partly missing | Return visible content and limitations without inventing missing facts |
| `unavailable` | Unregistered, missing, deleted, denied, mismatched, or unreadable source | Explain why; never substitute the latest file, adjacent excerpt, or same-named source |

`sourceId` identifies the source, `sourceVersion` fixes content, and `selector` is bounded adapter-defined location information, not arbitrary path-read permission. Explicit excerpt import retains declared provenance, collector, recording time, and missing original message identities. Assign stable excerpt-content versions without fabricating platform message IDs. Code evidence can use fixed commits and locations; archives require fixed content identity and record ranges.

Reuse trace/message/call locators in `ExperienceEvidenceRef` and the availability/coverage behavior of `loadObservationSourceRecordArchive`. Existing references do not always fix content versions; adapters must supply bindings rather than assuming a path or snippet preserves history. Resolve within authorized source roots and retain existing path/size constraints. Initial resolution performs no automatic network retrieval or execution of addresses found in knowledge text.

Availability is relative to the registered selection. Fully reading a snippet does not remove missing surrounding context; retain such limitations. Expanding review scope requires a new source registration and knowledge revision. Return exactly one result for each distinct evidence reference in the requested revision. Missing/duplicate results or mismatched bindings are resolver protocol errors. Pass results to a pure projection function with no file or clock access.

### 9.2 Review projection policy v1

Inputs are an explicit revision, all its review records, current source resolutions, and an acceptance policy with immutable `policyRevision`. The policy explicitly lists accepted actual actor identities; the default list is empty. Neither a human label nor an agent's self-reported identity is sufficient. The host derives and checks identity from the actual invocation, never from source text.

Agent records may remain advisory until the policy explicitly accepts their actor. Excluded records and reasons remain in `excludedReviews`. Missing references, invalid fields, or cross-revision records are data errors, not pending review. Missing or unrecognized policies produce explicit projection errors rather than implicit defaults.

Apply this order:

1. Validate revision, evidence links, and review scope; identify authorized records. Initially, only the same actual reviewer can correct their own prior record for the same revision and statement set. Targets must already exist; self-reference and cycles are invalid. Administrator correction on behalf of others is outside v1.
2. Apply supersession among accepted records while preserving history. Unaccepted corrections cannot hide accepted judgments. Concurrent corrections remain visible and become disputed when contradictory.
3. Aggregate active judgments per statement using the table below. Source content does not automatically become a verdict, and timestamps do not select winners.
4. Check current source coverage. A would-be `supported` statement becomes `needs_more_context` if any source actually cited by its supporting judgments is partial/unavailable, or its corresponding links only provide background/opposition. Conservatively require each accepted supporting judgment to cite at least one `supports` link for that statement. Preserve original reviews and explain degradation.
5. Aggregate item status and return statement details, input IDs, exclusion reasons, source states, and policy identity. The host supplies `projectedAt`; identical inputs produce identical outputs, ordered by stable IDs rather than arrival order.

| Active judgments | Statement status |
|---|---|
| Explicit dispute, or both support and opposition verdicts | `disputed` |
| Otherwise any `unsupported` | `unsupported` |
| Otherwise any `needs_more_context` | `needs_more_context` |
| Only `supported` | Provisionally supported, then apply source checks |
| No accepted judgments | `pending`, retaining exclusion reasons |

Item precedence is: any disputed statement → disputed; otherwise any unsupported → unsupported; otherwise all supported → supported; otherwise all pending → pending; every other combination → needs more context. Partial review cannot approve the whole item. One unsupported statement prevents treating the whole item as supported, without rewriting other supported statements as false.

Reviewers must address known counterevidence in scope. Counting opposing links cannot decide truth; v1 validates references and coverage but cannot mechanically establish sufficient rationale. This remains a human or explicitly authorized judge responsibility. Source loss preserves historical judgments while degrading current support views as specified. Review status is neither reuse authorization nor a carrier-effectiveness conclusion.

### 9.3 Revision storage and write protocol

Start with one versioned history file per knowledge item, containing immutable revisions, appended reviews, write receipts, and an internal write head. `KnowledgeItem` still returns only the requested revision's complete view. `KnowledgeStoreEnvelope` owns history; new review projections do not rewrite old revisions. Later adapters may change storage while preserving identities and read semantics.

The host supplies an explicit storage root, with no implicit user-directory writes or scanning. Derive filenames from the specified deterministic JSON and SHA-256 of `[namespace, knowledgeId]`, verify the embedded namespace and knowledge identity, and never concatenate raw IDs into paths. Indexes are rebuildable projections. A separate source adapter durably registers bindings under an explicit source root. Initially, explicit excerpts store binding, content, and collection provenance in one immutable record; duplicate record IDs compare complete content instead of overwriting, and reads verify versions. Existing archives use registered descriptors without copying all logs. Registration precedes knowledge writes; an item transaction excludes source collection, model calls, and updates to other items.

Only `append_revision` and `append_review` are allowed. Initial creation requires no existing file, generation zero, and a null expected head. Later revisions must name the current write head as parent. Reviews may target any saved revision of the item. The write head coordinates editing and never selects adopted knowledge by default.

For every call, including retries, the host first verifies actual identity and access/write permission for the target item. Unauthorized callers cannot read or receive historical receipts. New revision `revisedBy` and review `reviewedBy` must match the verified actor. Initial revisions also check `createdBy`; later revisions preserve the original creator, allowing other authorized authors to revise the item. Reject impersonated payload identities. Under the item's file lock:

1. Read and validate the existing envelope. Corruption or unknown Schema rejects writes rather than becoming an empty store.
2. Check the request receipt first. Identical request ID and command digest return the original receipt even if generation has advanced. Reusing an ID with different content returns `idempotency_conflict`. Idempotency is per item; retries retain original IDs, timestamps, and payload.
3. Check expected generation and expected head. Mismatches return conflict without automatic overwrites, merges, or rebasing. The caller reads current state and submits a new decision with a new request ID.
4. Validate immutable identities, references, times, ancestry, and supersession. Append records, increment generation, and include the receipt in the same write. Generations are safe integers; overflow rejects the write.
5. Write the complete envelope to a unique same-directory temporary file, atomically replace the destination, then release the lock. Failed derived-index updates do not roll back committed facts; reads can rebuild by scanning. Failure without a commit receipt is not success; retries recover receipts after lost responses.

Command digests use deterministic JSON: sorted object keys, preserved array order, UTF-8, and JSON-only values. Reject undefined, non-finite numbers, and non-JSON types. V1 fixes `canonical-json-v1` plus SHA-256: keys sort by Unicode UTF-16 code units, strings/numbers use JSON serialization, and whitespace is omitted. Include verified stable actor identity (identity namespace, actorKind, actorId), command type, target, expected versions, and full payload, excluding host-generated response times. A retry may come from a new invocation of the same actor: retain the original payload execution reference and exclude the retry invocation ID from the digest. Changes require a version upgrade rather than reinterpretation of old receipts.

Prefer existing `withFileLock` and `writeJsonFileAtomic`, while testing this transaction's concurrency and interruption paths. Existing atomic writes use rename to prevent partial JSON reads, without file/directory durability synchronization. V1 promises atomic visibility across process interruption, not guaranteed retention of the latest commit after sudden power loss. Lock timeout, unverifiable orphan ownership, or storage failure must fail explicitly rather than unconditionally stealing a lock. The existing helper includes stale-lock recovery; verify recovery races and ownership checks against this contract before reuse, adding a conservative mode if needed. Its existence does not establish concurrency acceptance.

The initial adapter limits each UTF-8 serialized envelope to 16 MiB. Exceeding the limit returns `capacity_exceeded`, never truncated history, references, or receipts. This is an adapter limit, not a semantic knowledge constraint. History compaction, storage replacement, and retention changes require explicit migration. V1 supplies no deletion or cross-item merge transaction.

### 9.4 Internal interface shapes

These are logical interfaces, not published serialization contracts. Appendices preserve their original sources and review records; references to undecided policy describe their authoring-time state and do not override the initial policy now defined here. Schema version 1 belongs only to new knowledge storage, never existing observation files. Register sources first; writes reference their logical identities. Reads explicitly name `KnowledgeRevisionRef`; missing targets, corruption, or projection failures return errors rather than fabricated empty knowledge.

```typescript
// Logical contracts for the first internal implementation; not published Schemas.
type KnowledgeRevisionData = Omit<KnowledgeItem, 'review'>;

interface KnowledgeEvidenceBinding {
  evidenceRef: string;
  adapterId: string;
  sourceId: string;
  sourceVersion: string;
  selector: string;
}

type KnowledgeEvidenceResolution = {
  evidenceRef: string;
  checkedAt: Timestamp;
} & (
  | {
      resolutionStatus: 'available' | 'partial';
      binding: KnowledgeEvidenceBinding;
      excerpt: string;
      limitations: readonly string[];
    }
  | {
      resolutionStatus: 'unavailable';
      reason: 'unregistered' | 'missing' | 'deleted' | 'access_denied'
        | 'version_mismatch' | 'invalid_source' | 'unsupported_adapter' | 'read_failed';
      detail: string;
    }
);

interface KnowledgeStatementReviewView {
  statementId: string;
  reviewStatus: KnowledgeReviewView['reviewStatus'];
  activeReviewRefs: readonly string[];
  unresolvedReasons: readonly string[];
}

interface KnowledgeReadView {
  item: KnowledgeItem;
  statementReviews: NonEmpty<KnowledgeStatementReviewView>;
  evidenceResolutions: NonEmpty<KnowledgeEvidenceResolution>;
  projection: {
    policyId: 'knowledge-review-v1';
    policyRevision: string;
    storeGeneration: number;
    inputReviewRefs: readonly string[];
    excludedReviews: readonly { reviewId: string; reason: string }[];
    projectedAt: Timestamp;
  };
}

interface KnowledgeWriteReceipt {
  requestId: string;
  commandDigest: string;
  committedGeneration: number;
  target: KnowledgeRevisionRef;
  reviewId?: string;
}

interface KnowledgeStoreEnvelope {
  storeKind: 'knowledge-item-history';
  schemaVersion: 1;
  namespace: string;
  knowledgeId: string;
  generation: number;
  writeHeadRevisionId: string;
  revisions: NonEmpty<KnowledgeRevisionData>;
  reviews: readonly KnowledgeReviewRecord[];
  receipts: NonEmpty<KnowledgeWriteReceipt>;
}

type KnowledgeWriteCommand = {
  requestId: string;
  expectedGeneration: number;
} & (
  | {
      commandKind: 'append_revision';
      expectedHeadRevisionId: string | null;
      revision: KnowledgeRevisionData;
    }
  | { commandKind: 'append_review'; review: KnowledgeReviewRecord }
);

type KnowledgeWriteResult =
  | { resultKind: 'committed' | 'replayed'; receipt: KnowledgeWriteReceipt }
  | {
      resultKind: 'rejected';
      reason: 'conflict' | 'idempotency_conflict' | 'invalid_record'
        | 'unauthorized' | 'unsupported_schema' | 'capacity_exceeded'
        | 'store_unavailable';
      detail: string;
    };
```

### 9.5 Initial acceptance scope

| Boundary | Required behavior |
|---|---|
| Resolution | Explain complete, partial, missing, denied, and mismatched sources; never substitute latest content |
| Projection | Unaccepted actors produce no support; partial coverage cannot promote the item; conflicts, corrections, missing sources, and input reordering have deterministic results |
| Writes | Retry returns the original receipt; competing requests for one generation yield one commit; failures preserve old content |
| History and reads | Explicit revisions remain readable; reviews do not mutate revisions; head is not adoption; missing indexes can be rebuilt |
| Capacity and interruption | Reject oversized/corrupt data without truncation; temporary files and lock failures cannot masquerade as commits |
| Host boundary | Pure validation/projection has no fs, network, CLI, or model dependencies; tests use explicit temporary roots |

Prioritize extracting candidate knowledge from one real work log and letting the user inspect each source. Implement the necessary source locators, candidate generation, and structural checks first; examine usefulness, scope completeness, and source fidelity. Introduce review projection and file transactions as usage requires, rather than making complete infrastructure a prerequisite. Specific CLI/Studio entry points, entity search, carrier changes, and evaluation integration remain subsequent decisions. The appendices supply seed examples; supporting implementations must still satisfy the authority, concurrency, and failure acceptance criteria above.

<a id="cr-case"></a>

## Appendix: CR feedback walkthrough

This case examines model expression, not an independent specification. It uses feedback from the knowledge-design conversation questioning review overhead and requesting skill removal. These support conversational facts, not objective excessive overhead or improved effectiveness from lighter review.

| Actual difficulty | Representation | Model decision |
|---|---|---|
| Missing message timestamps | Unknown occurrence time; separate authoring time | Preserve time distinctions without invented dates |
| A request is visible but no result snapshot is included | Non-empty actions, empty outcomes, explicit coverage gap | Incomplete cases are necessary; missing does not mean failed |
| User judgment can be confused with process facts | Record questioning, not objectively excessive overhead | Explain exactly what each source supports |
| Feedback and a rule jointly inform the method | Background motivation plus normative support | Separate evidence basis from relationship; requirements do not establish benefits |
| A reusable method cannot target only a past CR execution | Case references an occurrence; method references a repeatable activity and actor role | Similar names do not establish identity; distinguish occurrences from concepts |
| Execution/source references lack production resolvers | Local resolver table and authoring record with gaps | Before implementation, define available, partial, and unavailable resolution results |
| A useful method already appears in repository rules | Keep the candidate without duplicating instructions | Knowledge formation need not produce a carrier change; check existing coverage |

The walkthrough corrected entity references that conflated a specific CR execution with a reusable activity. No additional domain fields were required. The structures accommodate a sourced but incomplete case and a normatively grounded method with unknown effectiveness. Persistence, indexes, review projection, and the full knowledge lifecycle remain unvalidated.

The candidate method is proportional review depth. Existing repository rules already express it, so no synonymous carrier instruction is added. Effectiveness still requires explicit version binding, a fixed model, and independent tasks. This example creates no evaluation links or benefit conclusions. Fact correction appears in the next appendix; role reversal, same-source counterevidence, and concurrent revisions remain pending.

<details>
<summary>Expand source excerpts and complete KnowledgeItem examples</summary>

### 1. Sources and coverage

This case selects user messages from the OMK knowledge-design conversation in their visible order. The excerpts below are its evidence snapshots. Platform message IDs, original timestamps, and the full execution trace are unavailable here, so elapsed time, call counts, and review cost cannot be calculated. Local IDs are assigned for this walkthrough, not presented as platform IDs. Original Chinese excerpts are retained verbatim.

<a id="e1"></a>

#### E1: Process feedback

Source: the user questioning the CR process after discussing the documentation commit:

```text
你的 cr 流程是不是有点重啊
```

This directly supports the conversational fact that the user questioned the process overhead. It does not establish objective excessive overhead or justify less review for all tasks.

<a id="e2"></a>

#### E2: Removal request and its referent

Source: two selected user messages from the same conversation, in order, with intervening discussion omitted:

```text
为什么会启动`cr-code-review` skill？
给我移除这个 cr skill
```

The first identifies the skill; the second requests removal. A request is not execution evidence. The historical removal result is outside this case's execution-evidence snapshot; original tool records could later support a new revision. “Not included” must not become “not executed”.

<a id="e3"></a>

#### E3: Existing repository requirement

Source: the worktree's `AGENTS.md`, autonomous-review section, Git blob `c2f1c908d6ea2be0c5cc032222a5d5dc5ce49d8c`. Original excerpt:

> 任何会改变行为、契约、打包、文档承诺或仓库规则的改动，在首次 push／交付前都必须由当前 Agent 自主完成一次 CR；不要等待用户再问「CR 了吗」。纯机械改动也要快速复核，但审查深度应与风险匹配。

The existing rule requires review before delivery and depth proportional to risk. Agreement with user feedback is not independent effectiveness evidence; this case does not claim the feedback originally created the rule.

#### Evidence resolution

| Logical reference | Snapshot | Identity and limits |
|---|---|---|
| `walkthrough:cr:e1` | [E1](#e1) | User message; original message ID and timestamp unavailable |
| `walkthrough:cr:e2` | [E2](#e2) | Two messages used together to resolve a referent, not independent corroboration |
| `walkthrough:cr:e3` | [E3](#e3) | Repository requirement with blob identity, not execution or effect data |

This is a document-level resolver table, not an implemented evidence service. Corrections need new evidence versions and knowledge revisions rather than silent replacement under existing identities. Production import still needs a source-adapter protocol.

<a id="authoring-record"></a>

#### Authoring record

`walkthrough:cr:authoring-01` identifies the current agent's work writing this file after the user approved the walkthrough. Its recording time is `2026-09-05T15:09:12Z`, not the historical messages' occurrence time. Actor: `walkthrough:cr:author`; host: Codex. Platform run ID, exact model version, and parameters were not obtained and remain unknown. This identifies document authorship, not a replayable model invocation archive.

### 2. Complete items

Combine this TypeScript with domain draft section 3.1 for type checking. Both items supply every required field; initial revisions omit `parentRevision`. Shared `context` reduces code repetition only: each expanded statement owns its complete context, without a new inheritance rule. Entity identities are local to this case. The same Chinese data appears in both language editions to preserve one example.

The case records two visible user actions; the method is a separate item. Both remain `pending`: reviewing this document is not a domain knowledge review or user adoption decision.

```typescript
// Types are defined in section 3.1 above.
const recordedAt: Timestamp = "2026-09-05T15:09:12Z";
const author: KnowledgeActor = {
  actorKind: 'agent',
  actorId: 'walkthrough:cr:author',
  executionRef: 'walkthrough:cr:authoring-01',
};
const context: KnowledgeContext = {
  scenario: 'OMK 知识设计文档工作的 CR 流程反馈',
  conditions: ['本次对话中的文档任务与 CR 经历'],
  exceptions: [],
  unknowns: ['未归档完整执行 trace，无法计算审查耗时与成本'],
  occurredDuring: { timeKind: 'unknown', reason: '所选消息没有可核对的时间戳' },
  validDuring: {
    timeKind: 'not_applicable',
    reason: '陈述记录特定对话行为，不声称具有持续适用期',
  },
};

const crCase: KnowledgeItem = {
  knowledgeId: 'walkthrough:cr:case',
  revisionId: 'r1',
  title: '用户质疑文档审查流程偏重，随后要求移除 CR skill',
  content: {
    statements: [
      {
        statementId: 'question-process',
        subject: { entityId: 'walkthrough:cr:user' },
        relation: '以疑问方式提出流程是否偏重',
        object: { entityId: 'walkthrough:cr:process' },
        modality: 'descriptive',
        polarity: 'positive',
        context,
      },
      {
        statementId: 'request-removal',
        subject: { entityId: 'walkthrough:cr:user' },
        relation: '要求移除',
        object: { entityId: 'walkthrough:cr:skill' },
        modality: 'descriptive',
        polarity: 'positive',
        context,
      },
    ],
    organization: {
      knowledgeKind: 'case',
      situation: '记录用户对 CR 流程的反馈与随后提出的操作要求。',
      actionStatementIds: ['question-process', 'request-removal'],
      outcomeStatementIds: [],
      gaps: ['本条目选取的来源不包含移除操作的执行证据及改动后的效果数据'],
    },
  },
  entities: [
    { entityId: 'walkthrough:cr:user', label: '本次对话用户', description: '仅在本案例中识别，不推断真实身份。' },
    { entityId: 'walkthrough:cr:process', label: '本次 CR 流程', description: '被用户反馈指向的审查过程，不代表所有 CR。' },
    { entityId: 'walkthrough:cr:skill', label: 'cr-code-review', description: '由同段对话明确名称的 skill，不绑定未知的安装版本。' },
  ],
  evidence: [
    {
      evidenceLinkId: 'question-evidence',
      evidenceRef: 'walkthrough:cr:e1',
      statementIds: ['question-process'],
      relation: 'supports',
      basis: 'direct_observation',
      interpretation: '可见文字支持用户提出了这个疑问，不证明流程客观上过重。',
    },
    {
      evidenceLinkId: 'removal-evidence',
      evidenceRef: 'walkthrough:cr:e2',
      statementIds: ['request-removal'],
      relation: 'supports',
      basis: 'direct_observation',
      interpretation: '结合前文名称可识别被要求移除的 skill；要求不等于已执行。',
    },
  ],
  observationRefs: [],
  derivations: [],
  review: {
    target: { knowledgeId: 'walkthrough:cr:case', revisionId: 'r1' },
    reviewStatus: 'pending',
    reviewRefs: [],
    unresolvedReasons: ['已选取来源片段，但尚未按领域复核策略形成复核记录'],
  },
  createdAt: recordedAt,
  createdBy: author,
  revisedAt: recordedAt,
  revisedBy: author,
  revisionReason: '首次将可见对话片段整理为领域推演案例',
};

const reviewMethod: KnowledgeItem = {
  knowledgeId: 'walkthrough:cr:method',
  revisionId: 'r1',
  title: '按改动风险选择审查深度',
  content: {
    statements: [{
      statementId: 'choose-review-depth',
      subject: { entityId: 'walkthrough:cr:reviewer-role' },
      relation: '应依据改动风险选择审查深度，并完成项目要求的验证',
      object: { entityId: 'walkthrough:cr:review-activity' },
      modality: 'normative',
      polarity: 'positive',
      context: {
        scenario: 'OMK 文档改动交付前的自主审查',
        conditions: ['先检查是否涉及行为、契约、打包、生成链接或仓库规则'],
        exceptions: ['涉及高风险边界时不能仅因文件是 Markdown 就采用轻量审查'],
        unknowns: ['相对现有流程的效率和质量影响尚未受控验证'],
        occurredDuring: { timeKind: 'not_applicable', reason: '这是方法指令，不是已执行事件' },
        validDuring: { timeKind: 'unknown', reason: '候选方法的采用时间与终止时间未确定' },
      },
    }],
    organization: {
      knowledgeKind: 'method',
      purpose: '使审查投入匹配风险，同时保留项目要求的交付检查。',
      instructionStatementIds: ['choose-review-depth'],
    },
  },
  entities: [
    { entityId: 'walkthrough:cr:reviewer-role', label: 'OMK 文档审查 Agent 角色', description: '未来任务中执行该方法的角色，不等于条目编写者的执行身份。' },
    { entityId: 'walkthrough:cr:review-activity', label: 'OMK 文档审查活动', description: '可重复开展的活动概念，不等于案例中的那一次 CR。' },
  ],
  evidence: [
    {
      evidenceLinkId: 'method-motivation',
      evidenceRef: 'walkthrough:cr:e1',
      statementIds: ['choose-review-depth'],
      relation: 'background',
      basis: 'inference',
      interpretation: '用户反馈促使寻找更匹配任务的流程，不证明候选方法有效。',
    },
    {
      evidenceLinkId: 'repository-requirement',
      evidenceRef: 'walkthrough:cr:e3',
      statementIds: ['choose-review-depth'],
      relation: 'supports',
      basis: 'source_assertion',
      interpretation: '项目规则直接要求审查深度与风险匹配；支持规范依据，不证明收益。',
    },
  ],
  observationRefs: [],
  derivations: [{
    relation: 'derived_from',
    source: { knowledgeId: crCase.knowledgeId, revisionId: crCase.revisionId },
    reason: '由反馈案例提出方法候选，并以现有项目规则约束适用范围。',
  }],
  review: {
    target: { knowledgeId: 'walkthrough:cr:method', revisionId: 'r1' },
    reviewStatus: 'pending',
    reviewRefs: [],
    unresolvedReasons: ['尚未形成正式复核记录；规范来源不等于效果证据'],
  },
  createdAt: recordedAt,
  createdBy: author,
  revisedAt: recordedAt,
  revisedBy: author,
  revisionReason: '由案例形成独立的方法候选，不将其收益写成事实',
};
```

</details>

<a id="fact-correction"></a>

## Appendix: fact correction and partial review

This case uses an actual draft change: commit `7b671d85` stored a fact in `statement`; current section 3.1 uses a `statements` collection and `organization`. Reusing the old description for the current draft would produce a stale answer. Preserve knowledge identity, create a revision, and update the source version and description.

**The old fact did not become false.** It remains valid within its original version scope; new source code is not counterevidence to that historical scope. This updates the knowledge version for current reuse rather than removing scope and declaring the old fact disproven.

| Check | Result and decision |
|---|---|
| Knowledge and entity identities | Both revisions reuse one knowledge ID and two type-entity IDs; source and context identify versions |
| Changed content | `fact-content` changes; `entity-reference` retains its wording but updates source and scope |
| Revision or new item | The same draft contract evolves, so use `parentRevision`, not method derivation |
| Historical preservation | `r1` binds to the old commit; `r2` binds to a specific type snapshot, not a mutable worktree path |
| Review inheritance for unchanged wording | None; identical text does not establish review of the new scope and source |
| One source covers multiple statements | A source link can cover both, while a review listing only one produces only a partial judgment |
| New review versus new revision | `factR2View` updates the derived view while its content revision remains `r2` |

The current agent compared `fact-content` with source code and records that scoped check. The other statement is not covered by that review record. The aggregate view is `needs_more_context`, not production-policy acceptance. No fields were added, and actual storage or concurrency protocols were not validated.

<details>
<summary>Expand versioned evidence and complete revision examples</summary>

<a id="e4"></a>

### E4: Previous type source

`walkthrough:revision:e4` resolves to section 3.1 of `docs/zh/specs/knowledge-domain-model.md` at commit `7b671d85dc840bd5ed4d37a2f0bbf0b09dec6b18`. These are noncontiguous excerpts; the Git commit fixes the complete document.

```text
type KnowledgeContent =
  | { knowledgeKind: 'fact'; statement: KnowledgeStatement }

interface EntityRef {
  entityId: string;
}

interface KnowledgeStatement {
  statementId: string;
  subject: EntityRef;
  relation: string;
  object?: EntityRef;
```

<a id="e5"></a>

### E5: Current type snapshot

`walkthrough:revision:e5` resolves to the full TypeScript block in section 3.1 of this document. Its SHA-256 is `68c170dfbd04ea468778c01fad76016fd12ba20e3f35317fe1d535a178434b59`, computed over the UTF-8 block content with LF line endings, excluding fences and the trailing newline. This identifies source content, not knowledge identity or Schema version. Later changes must preserve this snapshot or explicitly report it unavailable, never silently resolve the reference to new code. Noncontiguous excerpts:

```text
interface KnowledgeContent {
  statements: NonEmpty<KnowledgeStatement>;
  organization: KnowledgeOrganization;
}

interface EntityRef {
  entityId: string;
}

interface KnowledgeStatement {
  statementId: string;
  subject: EntityRef;
  relation: string;
  object?: EntityRef;
```

### Authoring and review attribution

`walkthrough:revision:authoring-01` identifies the current agent's source comparison and item reconstruction in Codex at `2026-09-05T15:20:00Z`. Platform run ID, exact model version, and parameters were not obtained. Both knowledge revisions are reconstructed now; this does not invent a historical creation event. Recording time is not source-change or policy-effective time.

The following uses section 3.1 types. The factory only reduces repetition; both expanded revisions contain complete fields. The current knowledge model describes an older source without claiming that the old source implemented the current Schema. Chinese values are identical across language editions.

```typescript
// Both revisions are reconstructed now from versioned sources.
const correctionRecordedAt: Timestamp = '2026-09-05T15:20:00Z';
const correctionAuthor: KnowledgeActor = {
  actorKind: 'agent', actorId: 'walkthrough:revision:author',
  executionRef: 'walkthrough:revision:authoring-01',
};
function draftFactRevision(
  revisionId: string, evidenceRef: string, sourceScope: string,
  contentDescription: string, parentRevision?: KnowledgeRevisionRef,
): KnowledgeItem {
  const scopedContext: KnowledgeContext = {
    scenario: '查询 OMK 知识领域模型草案的事实表达结构',
    conditions: [sourceScope, '仅描述讨论草案，不表示已发布 API 或运行时能力'],
    exceptions: [],
    unknowns: ['所描述设计的起止适用时间未记录，以来源版本限定范围'],
    occurredDuring: { timeKind: 'not_applicable', reason: '描述版本中的静态契约，不是执行事件' },
    validDuring: { timeKind: 'unknown', reason: '不能把编写时间充当设计生效时间' },
  };
  return {
    knowledgeId: 'walkthrough:revision:fact-contract', revisionId,
    ...(parentRevision ? { parentRevision } : {}),
    title: '知识草案的事实表达结构及实体引用',
    content: {
      statements: [
        {
          statementId: 'fact-content',
          subject: { entityId: 'walkthrough:revision:knowledge-content' },
          relation: contentDescription,
          modality: 'descriptive', polarity: 'positive', context: scopedContext,
        },
        {
          statementId: 'entity-reference',
          subject: { entityId: 'walkthrough:revision:knowledge-statement' },
          relation: '通过 EntityRef 表达主体及可选对象的实体身份',
          modality: 'descriptive', polarity: 'positive', context: scopedContext,
        },
      ],
      organization: { knowledgeKind: 'fact' },
    },
    entities: [
      { entityId: 'walkthrough:revision:knowledge-content', label: 'KnowledgeContent', description: '同一草案中跨版本演进的内容结构。' },
      { entityId: 'walkthrough:revision:knowledge-statement', label: 'KnowledgeStatement', description: '上述内容使用的陈述结构。' },
    ],
    evidence: [{
      evidenceLinkId: 'source-fragments', evidenceRef,
      statementIds: ['fact-content', 'entity-reference'],
      relation: 'supports', basis: 'direct_observation',
      interpretation: '仅依据指定版本中可见的类型声明解释草案结构。',
    }],
    observationRefs: [], derivations: [],
    review: {
      target: { knowledgeId: 'walkthrough:revision:fact-contract', revisionId },
      reviewStatus: 'pending', reviewRefs: [],
      unresolvedReasons: ['尚未对本修订记录逐陈述复核'],
    },
    createdAt: correctionRecordedAt, createdBy: correctionAuthor,
    revisedAt: correctionRecordedAt, revisedBy: correctionAuthor,
    revisionReason: parentRevision ? '更新来源版本及事实内容结构描述' : '依据旧版来源重建首个知识修订',
  };
}
const factR1 = draftFactRevision(
  'r1', 'walkthrough:revision:e4',
  '来源为提交 7b671d85 的知识领域模型草案',
  '事实形式通过 statement 字段包含一条 KnowledgeStatement',
);
const factR2 = draftFactRevision(
  'r2', 'walkthrough:revision:e5',
  '来源为本附录 E5 标识的 §3.1 类型代码快照',
  '通过非空 statements 集合保存陈述，并以 organization 区分事实等组织形式',
  { knowledgeId: factR1.knowledgeId, revisionId: factR1.revisionId },
);

// A source comparison made during this walkthrough; no production acceptance implied.
const partialRevisionCheck: KnowledgeReviewRecord = {
  reviewId: 'walkthrough:revision:check-01',
  target: { knowledgeId: factR2.knowledgeId, revisionId: factR2.revisionId },
  statementIds: ['fact-content'],
  reviewedAt: correctionRecordedAt, reviewedBy: correctionAuthor,
  verdict: 'supported',
  rationale: '本次源码对照确认 E5 的非空集合与 organization；本记录只覆盖 fact-content。',
  evidenceLinkIds: ['source-fragments'], supersedesReviewIds: [],
};
const factR2View: KnowledgeItem = {
  ...factR2,
  review: {
    target: partialRevisionCheck.target,
    reviewStatus: 'needs_more_context',
    reviewRefs: [partialRevisionCheck.reviewId],
    unresolvedReasons: [
      'entity-reference 尚无本修订的复核记录；不能沿用旧版判断',
      '本条 Agent 源码检查属于文档推演，生产采信策略尚未确定',
    ],
  },
};
```

</details>

<a id="successful-experience"></a>

## Appendix: successful experience and method extraction

This case uses the actual validation run from the preceding fact-correction iteration: the script ran type/reference checks and a VitePress build in a temporary directory and exited with code `0`. This is one successful execution, not proof that shared dependencies are faster or more reliable than independent installation, nor a complete installation acceptance check.

| Check | Result and decision |
|---|---|
| Entry for success | Preserve success evidence directly; do not fabricate a failure-oriented inbox signal |
| Actions and outcomes | The execution event has action and completion statements tied to actual sources |
| Method extraction | Create a conditional candidate with `derived_from`; do not promote success into universal capability |
| Shared dependencies versus full isolation | Temporary inputs and outputs are isolated, dependencies remain shared; this is not clean-room acceptance |
| Replay coverage | Invocation, script excerpts, and output exist, but complete input snapshots do not; full replay is unavailable |
| Immediate carrier change | Add no skill or rule yet; establish independent reuse needs before binding carrier versions |

No fields were added. Expressing one execution does not establish domain acceptance or method effectiveness. The three walkthroughs now cover feedback, version-scoped fact updates, and extraction from success. Source resolution, review policy, and storage will be implemented and validated against section 9.

<details>
<summary>Expand success evidence and complete item examples</summary>

<a id="e6"></a>

### E6: Invocation and result

`walkthrough:success:e6` identifies the preceding conversation turn's tool invocation of `python3 /private/tmp/check_revision_case.py`. It checked the worktree at that time, before this appendix existed; later builds cannot rewrite this historical run. Output excerpts:

```text
vitepress v1.6.4
✓ building client + server bundles...
✓ rendering pages...
build complete in 5.48s.
PASS: bilingual types match, local links resolve, strict TypeScript and VitePress build
```

The tool returned exit code `0`. `5.48s` is VitePress's reported build time, not total validation time or comparative benefit. These excerpts lack original timestamps, a complete environment inventory, and independent quality scores.

<a id="e7"></a>

### E7: Procedure source

`walkthrough:success:e7` identifies selected script excerpts. The script read in this turn has SHA-256 `f69637d93a77d2903c42392ff9e115dba5bb894ec805a00f1ffb6ba1346226ca`. Its temporary location is not promised to persist; the noncontiguous excerpts below preserve minimal evidence, not the complete script. Paths are actual locations from that execution, not product storage contracts or future defaults.

```python
with tempfile.TemporaryDirectory(prefix='omk-model-check-',dir='/private/tmp') as tmp:
 deps=Path('/Users/lizhiyao/Documents/oh-my-knowledge/node_modules');(t/'node_modules').symlink_to(deps,target_is_directory=True)
 subprocess.run(['node',str(deps/'typescript/bin/tsc'),'-p',str(t/'tsconfig.json')],check=True)
 subprocess.run(['node',str(t/'model.js')],check=True)
 shutil.copytree(root/'docs',t/'docs',ignore=shutil.ignore_patterns('cache','dist','node_modules'))
 shutil.copy(root/'package.json',t/'package.json')
 subprocess.run(['node',str(deps/'vitepress/bin/vitepress.js'),'build',str(t/'docs')],cwd=t,check=True)
```

No separate post-cleanup directory snapshot was captured. The case records use of a temporary-directory context manager, not successful cleanup across every environment.

### Authoring attribution

`walkthrough:success:authoring-01` identifies this turn's agent activity in Codex, organizing existing execution evidence at `2026-09-05T15:23:11Z`. Exact model version, parameters, and platform run ID were not obtained. This time does not replace E6's occurrence time. The following uses section 3.1 types; the helper reduces repetition while producing two complete items. Chinese data is identical across editions.

```typescript
const successRecordedAt: Timestamp = '2026-09-05T15:23:11Z';
const successAuthor: KnowledgeActor = {
  actorKind: 'agent', actorId: 'walkthrough:success:author',
  executionRef: 'walkthrough:success:authoring-01',
};
function successItem(
  knowledgeId: string, title: string, content: KnowledgeContent,
  entities: NonEmpty<Entity>, evidence: NonEmpty<KnowledgeEvidenceLink>,
  derivations: readonly KnowledgeDerivation[] = [],
): KnowledgeItem {
  return {
    knowledgeId, revisionId: 'r1', title, content, entities, evidence,
    observationRefs: [], derivations,
    review: {
      target: { knowledgeId, revisionId: 'r1' },
      reviewStatus: 'pending', reviewRefs: [],
      unresolvedReasons: ['运行成功是来源事实，知识条目尚无领域复核记录'],
    },
    createdAt: successRecordedAt, createdBy: successAuthor,
    revisedAt: successRecordedAt, revisedBy: successAuthor,
    revisionReason: '依据真实验证记录提炼首个修订',
  };
}
const buildContext: KnowledgeContext = {
  scenario: 'OMK 知识文档在隔离临时目录中的验证',
  conditions: ['E6 所记录的一次执行', '依赖通过符号链接复用本机现有 node_modules'],
  exceptions: [],
  unknowns: ['未保存全部输入文件的不可变快照；不能完整重放该次构建'],
  occurredDuring: { timeKind: 'unknown', reason: '输出片段未记录原执行时间戳' },
  validDuring: { timeKind: 'not_applicable', reason: '只描述这一次执行结果' },
};
const successfulBuildCase = successItem(
  'walkthrough:success:case', '临时目录中的一次文档验证成功',
  {
    statements: [
      {
        statementId: 'execute-checks',
        subject: { entityId: 'walkthrough:success:run' },
        relation: '执行临时目录中的类型、引用检查及 VitePress 构建',
        modality: 'descriptive', polarity: 'positive', context: buildContext,
      },
      {
        statementId: 'checks-completed',
        subject: { entityId: 'walkthrough:success:run' },
        relation: '检查与构建完成，进程以退出码 0 结束',
        modality: 'descriptive', polarity: 'positive', context: buildContext,
      },
    ],
    organization: {
      knowledgeKind: 'case', situation: '验证文档草案与修订示例。',
      actionStatementIds: ['execute-checks'], outcomeStatementIds: ['checks-completed'],
      gaps: ['没有依赖全新安装、清理后目录快照或其它方案的对照实验'],
    },
  },
  [{ entityId: 'walkthrough:success:run', label: '本次文档验证执行', description: 'E6 对应的具体执行事件，不代表所有构建。' }],
  [
    {
      evidenceLinkId: 'execution-source', evidenceRef: 'walkthrough:success:e6',
      statementIds: ['execute-checks', 'checks-completed'], relation: 'supports',
      basis: 'direct_observation', interpretation: '工具调用、构建输出和退出码支持这次执行成功。',
    },
    {
      evidenceLinkId: 'procedure-source', evidenceRef: 'walkthrough:success:e7',
      statementIds: ['execute-checks'], relation: 'supports',
      basis: 'direct_observation', interpretation: '脚本片段说明临时目录、依赖链接与校验的组织方式。',
    },
  ],
);
const isolatedCheckMethod = successItem(
  'walkthrough:success:method', '在临时目录中复用已有依赖验证文档',
  {
    statements: [{
      statementId: 'isolate-doc-checks',
      subject: { entityId: 'walkthrough:success:reviewer-role' },
      relation: '可将文档和校验输入复制到临时目录，链接可用依赖，执行检查并清理临时产物',
      object: { entityId: 'walkthrough:success:doc-validation' },
      modality: 'normative', polarity: 'positive',
      context: {
        scenario: '已有可用依赖环境下的局部文档验证',
        conditions: ['校验器可在显式临时根运行', '已确认依赖适用于目标输入且不会被校验过程修改'],
        exceptions: ['打包、安装契约或 clean-room 验收不能用共享依赖验证替代'],
        unknowns: ['跨环境适用性、速度收益和检查覆盖程度尚未独立验证'],
        occurredDuring: { timeKind: 'not_applicable', reason: '候选操作方法，不是新的执行记录' },
        validDuring: { timeKind: 'unknown', reason: '适用版本与采用周期未定' },
      },
    }],
    organization: {
      knowledgeKind: 'method', purpose: '将文档验证的临时输入和产物放在显式临时目录中。',
      instructionStatementIds: ['isolate-doc-checks'],
    },
  },
  [
    { entityId: 'walkthrough:success:reviewer-role', label: '文档验证执行者', description: '未来执行方法的角色，不等于本次编写者。' },
    { entityId: 'walkthrough:success:doc-validation', label: '局部文档验证活动', description: '可重复执行的活动概念，不等于 E6 的执行事件。' },
  ],
  [{
    evidenceLinkId: 'method-source', evidenceRef: 'walkthrough:success:e7',
    statementIds: ['isolate-doc-checks'], relation: 'background', basis: 'inference',
    interpretation: '从这次执行方案提出候选方法；成功结果不证明可跨任务泛化。',
  }],
  [{
    relation: 'derived_from',
    source: { knowledgeId: successfulBuildCase.knowledgeId, revisionId: successfulBuildCase.revisionId },
    reason: '将具体执行方案抽象为有条件的复用方法，保留未经验证的适用性。',
  }],
);
```

</details>
