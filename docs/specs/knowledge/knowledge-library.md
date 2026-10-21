# Entity knowledge library

## Goal and scope

The library organizes knowledge across conversations in one explicitly selected knowledge workspace. Lists, object knowledge pages, sources, and organization history support reading, maintenance, and artifact generation. The [construction design](knowledge-domain-model.md) owns the full extraction-to-evaluation chain; this page owns organization, membership revisions and knowledge projection. A graph is an optional view, not an identity mechanism.

Entities are entry points. Knowledge consists of facts, cases, or methods with scenario, conditions, time, and evidence. One item may concern several entities; extracting an entity need not produce knowledge, and retention does not verify truth.

## Identity and confirmation

Entity analysis continues to own window-local `analysisId`, `entityId`, and revisions. A library object has an independent `objectId`: a maintained organization entry that neither replaces source identities nor changes claims.

Each organization link retains `analysisId`, `entityId`, exact `entityRevisionId`, at least one `mentionIds` entry belonging to the entity, and a rationale. Creating or changing a link requires explicit identity confirmation and source review. Under the workspace write lock, the server checks readable source, matching mentions, current entity revision, equal referent level, and absence of unresolved identity. Matching names never establish a link. Semantic identity remains the confirmer's responsibility; validation is not a truth judgment.

A window entity may belong to at most one current library object; object writes share the workspace lock. Components, instances, and versions cannot be linked as one object, although their knowledge relations can connect them. Apple fruit versus Apple the company and cross-project names require separate confirmation. An object's referent level remains fixed through history; changing its meaning requires a new object and explicit removal of old links.

## Storage and maintenance

The additive `library/<object-id>.json` uses `knowledge-library-object-history`, `schemaVersion: 1`. Each object retains immutable revisions, parent, actor, time, rationale, generation, write head, and idempotency receipts. Revisions hold the label, user-maintained description, level, and complete membership. Removing the last link preserves an empty object and history.

Writes carry expected generation and head and reject stale drafts. Capacity and ownership are checked before atomic publication. An unreadable organization file fails queries and writes rather than being skipped and interpreted as unowned. Existing workspace locking and local dead-process recovery are reused, without background writes or automatic retries. Successful filesystem write acknowledgements, including exact receipt replay, require file synchronization followed by each containing directory through the explicit workspace. Existing JSON encodings and receipts are unchanged. Unknown synchronization failures preserve any visible publication and require the caller to retry the exact request; unsupported synchronization fails rather than weakening the acknowledgement. This does not establish multi-file transactions, actual power-cut survival or remote exactly-once execution.

The organization layer leaves current `items/`, `entities/`, `sources/`, `tags/`, and `artifacts/` formats and contents intact; it needs no migration. The separate [extraction-run v5 upgrade](../entities/entity-extraction.md) uses `extraction-runs/` and preserves former `runs/` files without reading or migrating them. Current entity and knowledge histories remain v2 and can still be organized in the same workspace. Organization stores no copy of knowledge bodies and changes no extraction prompt, Schema, admission, or historical scores. No compatibility reader is added.

## Knowledge projection and revisions

Object pages find current knowledge revisions through linked window entities, deduplicate by knowledge identity, and retain bodies, sources, tags, conditions, exceptions, unknowns, evidence classification, and decisions. Knowledge must bind the exact entity revision confirmed by organization. Mismatched items appear separately for association review, excluded from attributed retained knowledge and initial artifact selection.

New entity revisions never automatically upgrade organization or knowledge. Users inspect the entity, explicitly apply it to knowledge, and update the organization link with source evidence. Old knowledge, links, and evidence remain in history. Unlinked knowledge leaves the current object without being deleted.

Organization history displays the selected membership revision alongside current knowledge state, explicitly not a complete past-time knowledge snapshot. Knowledge history remains in its own detail page. Repetition, negation, varying conditions, and conflicting claims coexist; chronology does not decide truth, and collection claims do not propagate to members.

After source loss, saved content remains readable and links can be removed. Adding or changing a source link requires readable evidence. Unreadable knowledge makes counts unknown rather than zero. Derived views disclose their scope.

## Studio flow

Knowledge navigation includes a knowledge library. Users search and select an object, initially reading retained items; pending, discarded, and association-review items are separately accessible. Object pages show the user-maintained description, full knowledge and conditions, exact source links, related objects, source entities, and organization history.

Entity details can add an entity to the library or open its current owner. Organization editing selects an entity from another window, reviews description, qualifiers, mentions, and source, and records a rationale and confirmation. Removing or updating links or editing descriptions creates an organization revision without changing entity or knowledge bodies.

Users select appropriate retained items for the existing skill/prompt generation and save flow; initial selection contains only exactly matched retained items. Generation makes no additional model call, and saving, actual use, and effect verification are recorded separately. Existing artifact preview-conflict protections apply when revisions or decisions change.

Lists and details stay within the application viewport with internal scrolling, pagination, and narrow-screen switching. Errors, empty objects, no retained knowledge, missing sources, and historical revisions are explicit. Entity review is not a prerequisite for every extraction.

## Acceptance and limits

Use distinct source windows and inspect source-supported identity and knowledge. If a recorded entity needs correction before organization, correct a local revision explicitly and apply it to a new knowledge revision. This maintenance is not an automatic extraction result and never overwrites raw outputs or historical scores.

Acceptance covers cross-window linking and removal, same-name separation, level/ambiguity rejection, multi-entity entry points, exact revisions, save/reopen, sources and history, source loss, conflicts, empty results, and artifact save. Existing-output replay makes no model calls; normal, short, and narrow Studio flows are tested separately.

Library workflow evidence verifies organization functionality. Extraction and association quality follow their [extraction](../entities/entity-extraction-evaluation.md) and [entity-link](../entities/entity-link-evaluation.md) evaluation protocols. Truth, automatic cross-Agent identity, and task benefits are separate questions. Record interaction costs and limits and contribute later-use evidence to the knowledge-value research; neither counts nor completed UI establish benefits.
