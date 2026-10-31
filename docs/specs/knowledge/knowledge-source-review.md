# Source review records

## Scope {#scope}

Source review separates a proposed inventory of reusable source meaning, an independent comparison with saved bodies, and the actual operator's decision. Both histories use Schema 1. They do not replace content reviews, segment/entity coverage or task-use feedback in `reviews/`.

Default `knowledge-body-first/v4` runs source ledger, body, source coverage and association as four explicit stages. It uses journal Schema 4 and default input `knowledge-source-generation-input/v2`. Each stage independently prepares a complete request, confirms its digest and claims once; the complete original is archived before decoding. No stage chain or approval is automatic. Ledger remains wire2/prompt3, body wire2/prompt9 and association wire3/prompt8 with its stage-specific v1 envelope. Coverage wire3/prompt4 replaces coverage wire2/prompt3 (**BREAKING-WIRE**, **BREAKING-COMPARABILITY**); source-review input2 and both persisted history Schemas remain unchanged. This workflow does not establish raw-generation quality or task benefits.

## Identity and evidence {#identity}

The host derives a complete manifest from the explicitly selected Source3 snapshots. It binds the exact SourceSet, complete portable input digest, snapshot digests and every delivered unit. Each source has one metadata unit containing its portable source identity, attribution, selection, limitations and excerpt descriptors; each excerpt text is a separate unit. Raw envelopes, capture time and host bindings are not added to model input. Snapshot custody digests still detect changes to the complete saved snapshots.

Unit kind, key, UTF-16 length, text digest and field paths remain explicit. A metadata quote refers to serialized portable metadata, not an original excerpt. Models return literal quotes with adjacent context; the host uniquely locates them and computes offsets. Duplicate, missing or substituted units and ambiguous quotes fail validation. Request capacity is checked without silent truncation.

## Analyses {#analyses}

### Source ledger {#ledger}

`source-ledgers/<identity-digest>.json` stores `knowledge-source-ledger-history` Schema 1. Immutable analysis revisions include their manifest, complete unit dispositions, proposed items/facets, source anchors, limitations and original model reference. Every delivered unit has a retain, exclude or pending opinion with a reason; references between units and items must close. These are model opinions, not a Gold set or permission to discard source material. The current model output is ledger wire2/prompt3: models provide unit dispositions and reasons, while the host derives each unit’s itemIds from all strictly located item/facet evidence, in item order with duplicates removed. The redundant reverse index is not model-supplied. Domain/history Schema 1 and every closure check remain unchanged; old wire1 originals are not reinterpreted.

### Source coverage {#coverage}

`source-coverage/<identity-digest>.json` stores `knowledge-source-coverage-history` Schema 1. Each analysis binds an exact ledger revision/digest and exact body references. It accounts for every source unit, item, facet and body paragraph, while retaining independent findings about ledger errors, omissions or unsupported body claims.

Current coverage output is wire3/prompt4. The host enumerates the complete unit/item/facet/body-segment target catalog from this exact input; model checks return only targetKey, and the host restores the full target identity. Unknown keys and incomplete target coverage remain rejected, while different coverage aspects may check the same target. The stage request binds the derived catalog; source manifests remain unchanged.

Coverage distinguishes knowledge meaning, preservation of a source-declared unknown, preservation of an inspected input limitation, and a factual value. Expressing that a value is unknown does not make the value known; a factual-value check with `unknown` cannot be covered. For a bounded-input limitation, the model returns `boundedInput` with `inspectionKind: "complete_manifest_units"`, `inspectedUnitKeys` listing every exact manifest unitKey once, and a scope limited to that delivered input. Unknown, missing or duplicate unit keys fail validation. If the model cannot declare complete inspection, `boundedInput` is null and that limitation cannot be covered.

The host derives `sourceInputDigest`, manifest-ordered `unitKeys` and the distinct sorted union of each unit's exact `fieldPaths` from the verified complete manifest. It stores those paths as `boundedInput.inspectedFields` under the unchanged persisted Schema 1. The model supplies no field paths; descriptions are never cleaned up or guessed into valid paths. This witness records the model's claimed complete inspection scope, not proof that it actually read every unit, that input-wide absence holds globally, or that any fact is true. Exact source/body quotes, complete target checks and semantic review remain necessary. A zero-body analysis remains valid and records omissions instead of creating placeholder knowledge or automatic approval.

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

### Coverage profile boundary {#coverage-profile}

Stored Schema 1 coverage produced with wire2/prompt3 remains available for passive reads with `originalVerification=not_verified`. That does not qualify its original or decisions for current execution. Current original revalidation accepts only wire3/prompt4; new decisions, association preparation and the shared-lock claim cannot inherit eligibility from old wire2/prompt3 coverage. There is no legacy generation-wire decoder or automatic migration, and old native output is not reinterpreted or repaired.

Preserve the original workspace and its matching installable build to continue an old-profile execution or roll back. To use current coverage, make an explicit complete independent workspace copy and prepare a new wire3/prompt4 analysis using the complete original sources, a matching ledger and exact saved body references. Do not rerun a completed matching ledger or body merely to replace coverage. Original/request custody must still revalidate; otherwise stop. Preserve original sources, bodies, IDs, failed outcomes, measurement identities and scores. A new analysis requires its own actual decision; neither copying nor passive readability supplies one. This is a source-build boundary, not a release announcement.
