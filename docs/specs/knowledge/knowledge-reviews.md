# Content review, association coverage and task feedback

This specification describes independent review records on current main. They do not change knowledge content, retention, association acceptance, identity confirmation or historical measurements, and are not included in released Beta.14. See the [extraction and reuse guide](../../guides/knowledge/extract-knowledge.md#review-feedback) for operations.

## Exact targets and storage {#review-identity}

`reviews/<identity-digest>.json` uses `knowledge-review-history` Schema 1. The digest is the hexadecimal part of `sha256(canonicalJson([namespace, knowledgeId]))`, organizing records by workspace/knowledge identity. One ledger retains events for different body revisions.

Each event pins `bodyRef: {knowledgeId, revisionId, bodyDigest}`, the body's exact `sources: [{snapshotId, sourceVersion}]`, actual `actor`, time, event identity and explicit supersession set. The host derives the source set from the selected body and checks submitted values; it never follows the latest body or infers sources from names. Evidence keeps original UTF-16 quotation positions.

The ledger contains `generation`, `writeHeadEventId`, appended `events` and `receipts`. It allows at most 4096 events and 16 MiB per file; exceeding either limit fails explicitly without truncating history. Existing body3, association2, entity2, journal2 and originals are neither migrated nor rewritten. Reading content does not require this ledger.

## Three event types {#review-events}

| eventKind | Content and limits |
| --- | --- |
| `content_review` | `needs_revision` or `reviewed_with_limits`, with a reason, limitations and `findings`. Findings contain a type, description, related `segmentIds` and optional exact evidence; an empty segment set can describe an entirely omitted topic. Revision needed requires a finding; limited review retains its limitations. |
| `association_coverage` | Pins `projectionRevisionId`, or `null` when no matching projection exists; every body segment has exactly one decision and reason. `linked` must reference catalog/entity/mention mappings actually present in that projection; `no_reliable_object` is an explicit judgment, `gap` an observed omission and `unknown` unresolved. Empty mappings never automatically mean no reliable object exists. |
| `task_use` | Pins the actually consumed body, segments, `taskRef` and `query`; `signal` separately records `provided`, `read`, `reported_use`, `observed_help`, or `controlled_effect`. Optional `issueKind` distinguishes `content_missing`, `association_wrong`, `source_unavailable`, and `other`. The last two effect reports require nonempty task/comparison references or valid exact evidence, without system certification of causal effects. |

Content findings may cite portions of the same source that never entered the body; omission evidence is not restricted to existing body quotations. Task feedback may also cite registered sources from a later task. New inline evidence must pass exact source and quotation validation. Reporting an unavailable source or consumption of an old version does not require recovering deleted originals.

## Opinions, coverage and revisions {#review-selection}

Only missing records mean `not_reviewed`. Damaged, unsupported, redirected or unreadable ledgers are `unavailable`, with unknown generation/head rather than zero. Source availability is separate; source deletion erases neither past reviews nor content.

Multiple opinions can coexist for one body. `supersedesEventIds` explicitly replaces events of the same body and type; coverage also requires the same projection, and use records the same task and signal. Unresolved `needs_revision` remains prominent; timestamps and actor types do not decide truth. Per-segment coverage retains all active opinions: gaps dominate, while unresolved or conflicting decisions appear unknown.

A new body inherits neither content review, retention nor old coverage decisions. A new association projection invalidates only coverage tied to the old projection; content opinions on the same body remain. Feedback on a historical version always targets the actually consumed version rather than the latest revision. Recording feedback never automatically rewrites content, merges identity, accepts associations or updates carriers.

## Operations and trusted hosts {#review-operations}

Shared application operations are `review-status`, `review-content`, `review-coverage`, and `record-use`. Status is a separate projection; it does not add fields to the budgeted `retrieve` Schema 2 response or change ranking. Reads supply an exact bodyRef and optionally a coverage projection. Writes additionally carry a stable `requestId`, expected sources, `expectedGeneration`, `expectedHeadEventId`, and a decision.

The pure core owns Schemas, reference closure, history and selection. The application checks exact content, projections and new evidence under the workspace lock; the file adapter publishes durably and atomically. The full actor participates in the command digest, event IDs use stable request IDs, and host time is excluded from retryable command identity. An identical request confirms the persisted original and returns its receipt; changed payloads or actors conflict. An unclear acknowledgement requires checking the same requestId before any redispatch.

Trusted application construction supplies the actual `KnowledgeActor`. Instances without an actor are read-only, and browser/draft actor fields are rejected. Studio uses its local UI host declaration; isolated Agent automation may explicitly inject its actual Agent on the server, without inferring a browser actor from the server's Codex environment.

The three new CLI write operations recognize inherited Codex Desktop launcher context only: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop` and a valid `CODEX_THREAD_ID`. They record `agent/codex:<thread-id>` with `executionRef=codex-thread:<thread-id>`. This is launcher-provided attribution, not authentication. Unknown terminals or other hosts never fall back to a human; use Studio or an application entry that explicitly injects the actual actor. Existing commands and old actors are not relabeled.

## Evidence limits {#review-evidence}

Structural admission, retention, association acceptance, content review, use reports and independent human acceptance remain separate. Exact quotations, successful review persistence or limited review establish neither truth, completeness nor task benefits. New writes call no generation model or judge; the host Agent's reading, review and revision still incur their own costs. Real quality and long-term value require corresponding source/task evidence, without replaying frozen calls or reclassifying old failures.
