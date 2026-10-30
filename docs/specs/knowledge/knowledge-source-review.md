# Source review records

## Scope {#scope}

Source review separates a proposed inventory of reusable source meaning, an independent comparison with saved bodies, and the actual operator's decision. Both histories use Schema 1. They do not replace content reviews, segment/entity coverage or task-use feedback in `reviews/`.

This foundation exposes internal host contracts and deterministic wire validation. Default generation still uses workflow3, journal3, body8 and association7. The complete workflow4 integration and separate-copy migration are a subsequent, coordinated change; these records alone do not improve or certify generation quality.

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

## Publication and custody {#custody}

Writes use append-only histories, shared workspace locking, CAS and actor-bound idempotent receipts. Client data cannot supply the actual actor through an untrusted payload. Without a trusted actor, reads remain possible and writes fail.

The application revalidates native output, exact prepared model input, complete sources, bodies and ledger references inside the publication lock. The trusted original reader must establish archive/request custody before returning raw output; a matching quote or supplied digest alone is insufficient. Changed model data cannot be stored as the original analysis. Read views report original verification separately from decision opinions. Exact committed commands can recover their existing receipts; dispatch eligibility still requires a fresh check.

Revocation can withdraw an earlier opinion even if its original evidence is now unavailable. Association claims must recheck the selected decision and its upstream identities inside the same shared workspace lock; a preparation-time check alone is insufficient.

## Integration boundary {#integration}

The new ledger/coverage profiles are independently identified and do not reinterpret old body or association outputs. Current body, entity, association, source, review and tag histories remain unchanged. Workflow4 must integrate request confirmation, claim-time gating, old-automation refusal and separate-copy migration together before becoming the default. Old workspaces and matching builds remain the rollback boundary; no old dispatch claim is resumed by a new reader.
