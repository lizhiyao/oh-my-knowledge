# Source review records

## Scope {#scope}

Source review separates a proposed inventory of reusable source meaning, an independent comparison with saved bodies, and the actual operator's decision. Both histories use Schema 1. They do not replace content reviews, segment/entity coverage or task-use feedback in `reviews/`.

Default `knowledge-body-first/v4` runs source ledger, body, source coverage and association as four explicit stages. It uses journal Schema 4 and default input `knowledge-source-generation-input/v2`. Each stage independently prepares a complete request, confirms its digest and claims once; the complete original is archived before decoding. No stage chain or approval is automatic. Body remains wire2 with prompt9; association keeps the original prompt7/profile/wire3 bytes and its stage-specific v1 envelope. This workflow does not establish raw-generation quality or task benefits.

## Identity and evidence {#identity}

The host derives a complete manifest from the explicitly selected Source3 snapshots. It binds the exact SourceSet, complete portable input digest, snapshot digests and every delivered unit. Each source has one metadata unit containing its portable source identity, attribution, selection, limitations and excerpt descriptors; each excerpt text is a separate unit. Raw envelopes, capture time and host bindings are not added to model input. Snapshot custody digests still detect changes to the complete saved snapshots.

Unit kind, key, UTF-16 length, text digest and field paths remain explicit. A metadata quote refers to serialized portable metadata, not an original excerpt. Models return literal quotes with adjacent context; the host uniquely locates them and computes offsets. Duplicate, missing or substituted units and ambiguous quotes fail validation. Request capacity is checked without silent truncation.

## Analyses {#analyses}

### Source ledger {#ledger}

`source-ledgers/<identity-digest>.json` stores `knowledge-source-ledger-history` Schema 1. Immutable analysis revisions include their manifest, complete unit dispositions, proposed items/facets, source anchors, limitations and original model reference. Every delivered unit has a retain, exclude or pending opinion with a reason; references between units and items must close. These are model opinions, not a Gold set or permission to discard source material.

### Source coverage {#coverage}

`source-coverage/<identity-digest>.json` stores `knowledge-source-coverage-history` Schema 1. Each analysis binds an exact ledger revision/digest and exact body references. It accounts for every source unit, item, facet and body paragraph, while retaining independent findings about ledger errors, omissions or unsupported body claims.

Coverage distinguishes knowledge meaning, preservation of a source-declared unknown, preservation of an inspected input limitation, and a factual value. Expressing that a value is unknown does not make the value known. A bounded-input claim binds the delivered input digest, full unit inventory and actual inspected field paths; semantic sufficiency still needs review. A zero-body analysis remains valid and records omissions instead of creating placeholder knowledge or automatic approval.

## Actual decisions {#decisions}

An explicit decision binds the exact coverage revision/digest, SourceSet, ledger reference and body references. It records the trusted actual human or Agent, limitations, reasons and a disposition for every unresolved item, exclusion, pending opinion and finding. The choices are `proceed_with_limits`, `needs_revision` and `stop`. A model analysis never creates this event automatically.

Explicit supersession and revocation preserve prior events. Conflicting active opinions are disputed; timestamps and model agreement do not rank truth. An association request must pin a particular active, nonconflicting proceed decision. New bodies or analyses do not inherit it.

A complete record_decision includes coverageRef, sourceSetId, ledgerRef, bodyRefs, decisionKind, reason, limitations, dispositions and supersedesEventIds. Each disposition is accepted_limit/resolved/blocks. Derive unresolved IDs from the actual analyses: `unit:<unitKey>` for excluded/pending units, `item:<itemId>` for excluded/pending items, `check:<checkId>` for non-covered checks, and `finding:<findingId>` for every finding. Account for each without manufacturing a pass. A sourceCoverageDecisionRef contains only coverageRef, sourceSetId, ledgerRef, bodyRefs and the committed receipt’s eventId, without decisionKind, reason or actor.

## Publication and custody {#custody}

Writes use append-only histories, shared workspace locking, CAS and actor-bound idempotent receipts. Client data cannot supply the actual actor through an untrusted payload. Without a trusted actor, reads remain possible and writes fail.

The application revalidates native output, exact prepared model input, complete sources, bodies and ledger references inside the publication lock. The trusted original reader must establish archive/request custody before returning raw output; a matching quote or supplied digest alone is insufficient. Changed model data cannot be stored as the original analysis. Read views report original verification separately from decision opinions. Exact committed commands can recover their existing receipts; dispatch eligibility still requires a fresh check.

Revocation can withdraw an earlier opinion even if its original evidence is now unavailable. Association claims must recheck the selected decision and its upstream identities inside the same shared workspace lock; a preparation-time check alone is insufficient.

## Integration boundary {#integration}

`prepare-generation` starts a ledger from the complete sources; later stages are separately confirmed through `continue-stage`. Preparing association also requires the exact `sourceCoverageDecisionRef` in the same run input. Completed analysis, all-covered checks or no findings never supply that decision. Zero bodies still proceed to source coverage without a placeholder body.

`prepare-source-review` takes the complete original `sources`, exact `bodyRefs` and optional `ledgerRef`. Without a ledger it inventories then checks coverage; a matching ledger skips inventory. It generates no body or automatic association. After revision, review the new bodyRefs and record a new decision. `prepare-rebuild-associations`/`rebuild-associations` also pin the exact decision and obtain sources from that coverage record’s full SourceSet, not only surviving body citations.

`source-ledger` and `source-coverage-status` read exact revisions. `review-source-coverage` accepts a complete `record_decision` or `revoke_decision` command: coverageId, stable requestId, expectedGeneration and expectedHeadEventId are common; recording includes the complete decision, while revocation names targetEventId and a reason. The payload cannot self-assert an actor. Association preparation and the shared-lock claim both revalidate the decision and upstream bindings. Revocation after claim preserves the sent request and original; its projection remains pending and exposes the invalidated review context. Manual entity/association maintenance does not create source-coverage approval.

Source3, body, entity, association, reviews and tags retain their identities. `migrate-workflow` copies only the six supported formats to an independent target and archives old journal3 and automatic permissions. This build provides no workflow4 scheduler or renewed automatic grant. Rollback uses the untouched old directory and matching build.
