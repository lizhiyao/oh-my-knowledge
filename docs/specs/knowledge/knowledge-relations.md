# Cross-knowledge relation opinions

This contract adds explicit supplement/conflict opinions between two exact bodies in one selected workspace. It does not generate relationships, merge identities, change content, or decide which claim is true. It is a current-main capability, not a released Beta.14 feature.

## Meaning and scope {#relation-meaning}

| relationType | Meaning |
| --- | --- |
| `supplements` | `from` adds content or reuse limits to `to` for the stated question and conditions. It does not assert that the other body is wrong or replaced. |
| `conflicts_with` | Claims cannot both hold under comparable subject, modality, time/version and applicability. The relation is semantically symmetric and never chooses the true endpoint. Different conditions cannot form this relation; unknown comparability may remain pending but cannot be accepted. |

Endpoints must have different knowledge IDs in the same explicit workspace. Each pins `bodyRef: {knowledgeId, revisionId, bodyDigest}` and optional nonempty `segmentIds`. Names, dates, paths and similarity never establish identity or resolve disagreement.

Existing `derived_from`, `split_from`, `merged_from`, `replaces` and revision parents remain read-only provenance/evolution. They are not new adoption decisions or independent conflict reviews. A derivation without a stored digest gets one only after its exact target resolves; otherwise the original IDs and a gap remain. `recordedIn` attributes the containing revision, not a newly invented original opinion author/time.

## Evidence and storage {#relation-storage}

`knowledge-relations/<relation-id>.json` uses `knowledge-relation-history` Schema 1. A ledger fixes the workspace namespace, relation ID and two ordered knowledge identities. New proposal revisions may explicitly rebind body versions, keeping their parent proposal revision. New proposals are pending.

A proposal records its question, conditions, declared comparison scope (`same`, `different`, `unknown`, with subject/modality/time/version details), basis (`source_assertion` or `inference`), reason and limitations. Each side needs evidence with a body segment and exact UTF-16 body selection, plus an exact source reference and original source selection. The source must belong to that endpoint's selected body segment. Source position checks do not prove semantic truth.

Proposing or accepting requires both exact bodies and all sources supporting either complete body to be readable and their evidence to match, not just the source quotes selected in the form. Rejection and author withdrawal may record limitations when historical sources are unavailable. No operation silently follows a newer body or captures a new source.

The ledger appends `relation_proposed`, `relation_reviewed` and `relation_withdrawn` events, with generation/head, actual actor/time and receipts. Each file is bounded to 4096 events and 16 MiB. Inventory is bounded to 4096 files and 64 MiB; unreadable, unsupported or redirected entries produce partial inventory rather than an empty-success claim. History is never truncated to fit a limit.

## Opinions and versions {#relation-state}

Without active reviews an opinion is `pending`; accepts alone yield `accepted`, rejects alone `rejected`, and opposing active reviews `disputed`. Explicit supersession may replace only that stable actor's active reviews of the same proposal revision. Actor kind or timestamps never rank truth.

Only the actual author of the current proposal revision may withdraw it, matched by stable `actorKind` and `actorId`; a new execution reference does not change authorship. Other actors may reject or supersede their own opinions. Withdrawal preserves all history; re-proposing requires an explicit new revision. Accepting checks all proposal evidence indices and cannot accept a conflict whose comparison scope is unknown.

Opinion status, current proposal revision, body current/stale state and source availability remain separate. Body changes leave the old relation bound to its old versions. A new explicit proposal revision starts pending and inherits no old reviews. Exact historical reads remain possible; an unavailable ledger does not establish absence.

## Operations and trusted actors {#relation-operations}

The shared application factory is `createLocalKnowledgeRelations(workspace, actor?)`. Missing actor context is read-only. CLI and Studio call the same application operations; browser input cannot supply an actor.

| Operation | Input |
| --- | --- |
| `relations` | Exact `bodyRef`; returns matching relation revisions, inventory gaps and completeness. |
| `relation` | `relationId`, optionally `relationRevisionId`; returns the exact projection and complete ledger/receipts. |
| `propose-relation` | Stable relation/request IDs, expected generation/head and complete proposal. |
| `review-relation` | The same write identity, exact relation revision, accept/reject, reason/limits, checked evidence indices and explicit own-review supersession. |
| `withdraw-relation` | The same write identity, exact current relation revision and reason/limits. |

```bash
omk observe knowledge graph --workspace ./knowledge --input ./graph-scope.json --json
omk observe knowledge relations --workspace ./knowledge --id <knowledge-id> --revision <body-revision-id> --body-digest sha256:<digest> --json
omk observe knowledge relation --workspace ./knowledge --id <relation-id> --revision <relation-revision-id> --json
omk observe knowledge propose-relation --workspace ./knowledge --input ./proposal.json --json
omk observe knowledge review-relation --workspace ./knowledge --input ./review.json --json
omk observe knowledge withdraw-relation --workspace ./knowledge --input ./withdrawal.json --json
```

Write JSON contains the complete domain input without an `operation` wrapper or `actor`. New ledgers use `expectedGeneration: 0`, `expectedHeadEventId: null` and `parentRelationRevisionId: null`; later writes use the actual read head. The CLI recognizes trusted Codex Desktop launcher context as an Agent, and never falls back to human attribution for an unknown writer. Studio injects its declared local UI actor; isolated Agent acceptance explicitly injects the actual Agent on the server.

Studio transports these operations through `POST /api/knowledge/relations` with an explicit `workspace` and `operation`. Known invalid/forbidden/unavailable requests return controlled errors; unconfirmed writes retain the original request identity. Read `relation` and its receipts before deciding whether anything committed. Do not automatically resend an unclear write.

Receipt checks precede CAS validation for identical retries. The full command and actual actor enter the digest; host time does not. Changed payloads or actors conflict. Exact endpoints and source evidence are rechecked under the shared workspace write lock before durable publication. Relation writes call neither a generation model nor a judge.

The read-only `graph` command accepts `{knowledgeIds?, includeHistory?}` in its scope JSON. Without `--input`, it reads the workspace's current graph; `knowledgeIds: []` is empty, and history is off by default. Graph responses omit the complete relation ledger and hide endpoint quotations unless both exact endpoint nodes are visible; hidden evidence is counted rather than presented as absent.

## Graph3 and activation {#relation-activation}

**BREAKING-SCHEMA(graph):** the `knowledge-graph` DTO moves from Schema 2 to Schema 3 across CLI/HTTP/Studio, without a permanent dual reader. `knowledge_relation` shows the explicit opinion projection; `knowledge_derivation` shows existing derivations. Existing `revision_parent` remains. An explicit knowledge selection does not load or add another body/source automatically; history expansion is also explicit. Missing endpoints and unreadable relation data create local gaps, retaining healthy nodes and edges.

Enable this change only in a complete independent copy after fixing the original inventory and matching old/new builds. Existing body/source/catalog/association/review/carrier references and bytes stay unchanged; only the new relation ledger is added by relation operations. Keep the original workspace with its matching Graph2/v7 build for rollback, and the new copy with its matching Graph3 build. Rollback reopens that original pair; do not downgrade the new ledger or let an old build write into the new copy. No generation profile, wire, workflow or historical measurement is changed by this feature. Release remains separately authorized.

## Acceptance limits {#relation-limits}

Saved proposals, accepted opinions, graph edges and quote matches are not truth, complete recall, independent corroboration, human Gold or task benefits. Same-source supplements retain that limitation. Authored conflict/lifecycle tests are engineering evidence; a real conflict positive example, independent human use and long-term value require their own evidence. Preserve old failures and their original measurement identities.
