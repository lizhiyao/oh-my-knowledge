# Source review records

## Scope {#scope}

Source review separates a proposed inventory of reusable source meaning, an independent comparison with saved bodies, and the actual operator's decision. Both histories use Schema 1. They do not replace content reviews, segment/entity coverage or task-use feedback in `reviews/`.

**BREAKING-SCHEMA/API/COMPARABILITY**. Current journals use Schema 11. Ordinary body requests bind the exact same-run draft and complete Source3. For Codex sources above the threshold, generation prepares all original-source windows before dispatch. The host publishes the complete batch only after every window succeeds. Source review and pending association generation remain independent. Matching older builds read older journals. `knowledge-workflow-to11` migrates only to an independent copy and archives older journals, analyses, originals and automatic permissions unchanged. Historical measurements retain their original identities.

Coverage prompt6 also requires a quote repeated within the complete source unit or body segment to use a unique continuous excerpt or genuine adjacent disambiguating context. The host still rejects ambiguous locations; failed prompt5 originals remain failed, and no historical result is repaired.

## Identity and evidence {#identity}

The host derives a complete manifest from the explicitly selected Source3 snapshots. It binds the exact SourceSet, complete portable input digest, snapshot digests and every delivered unit. Each source has one metadata unit containing its portable source identity, attribution, selection, limitations and excerpt descriptors; each excerpt text is a separate unit. Raw envelopes, capture time and host bindings are not added to model input. Snapshot custody digests still detect changes to the complete saved snapshots.

Unit kind, key, UTF-16 length, text digest and field paths remain explicit. Ledger input1 delivers each complete unit as ordered `{passageId,text}` blocks, with a host policy and index digest binding the complete SourceSet, units and exact positions. The model selects only same-unit `{startPassageId,endPassageId}` ranges and echoes passageIndexDigest; the host derives exact UTF-16 positions and quotations. Empty sources do not acquire invented passages. Coverage input2 still uses literal quotes and adjacent context, rejecting ambiguous matches. Metadata quotations refer to serialized portable metadata, not original excerpt speech. Missing, duplicate or substituted units and invalid ranges fail validation; capacity failures never truncate.

## Analyses {#analyses}

### Source ledger {#ledger}

`source-ledgers/<identity-digest>.json` stores `knowledge-source-ledger-history` Schema 1. Immutable revisions keep the manifest, every unit disposition, proposed items/facets, exact source anchors, limitations and original model reference. These are opinions, not Gold or permission to discard sources. Ledger wire3/prompt4 returns passage ranges; the host derives each unit’s itemIds in item order with complete closure checks. A long selected range is split only at existing passage boundaries into adjacent quotes of at most32,768 UTF-16 units whose ordered union equals that exact range. Expanded evidence arrays remain bounded at256 and compiled ledger JSON at16 MiB; reject without dropping content. Schema1 is unchanged, but old wire1/2 originals are not decoded or reinterpreted.

### Source coverage {#coverage}

`source-coverage/<identity-digest>.json` stores `knowledge-source-coverage-history` Schema 1. Each analysis binds an exact ledger revision/digest and exact body references. It accounts for every source unit, item, facet and body paragraph, while retaining independent findings about ledger errors, omissions or unsupported body claims.

Current coverage output is wire3/prompt6. The host enumerates the complete unit/item/facet/body-segment target catalog from this exact input; model checks return only targetKey, and the host restores the full target identity. Unknown keys and incomplete target coverage remain rejected, while different coverage aspects may check the same target. The stage request binds the derived catalog; source manifests remain unchanged.

Coverage distinguishes knowledge meaning, preservation of a source-declared unknown, preservation of an inspected input limitation, and a factual value. Expressing that a value is unknown does not make the value known; a factual-value check with `unknown` cannot be covered. For a bounded-input limitation, the model returns `boundedInput` with `inspectionKind: "complete_manifest_units"`, `inspectedUnitKeys` listing every exact manifest unitKey once, and a scope limited to that delivered input. Unknown, missing or duplicate unit keys fail validation. If the model cannot declare complete inspection, `boundedInput` is null and that limitation cannot be covered.

The host derives `sourceInputDigest`, manifest-ordered `unitKeys` and the distinct sorted union of each unit's exact `fieldPaths` from the verified complete manifest. It stores those paths as `boundedInput.inspectedFields` under the unchanged persisted Schema 1. The model supplies no field paths; descriptions are never cleaned up or guessed into valid paths. This witness records the model's claimed complete inspection scope, not proof that it actually read every unit, that input-wide absence holds globally, or that any fact is true. Exact source/body quotes, complete target checks and semantic review remain necessary. A zero-body analysis remains valid and records omissions instead of creating placeholder knowledge or automatic approval.

## Actual decisions {#decisions}

An explicit decision binds the exact coverage revision/digest, SourceSet, ledger reference and body references. It records the trusted actual human or Agent, limitations, reasons and a disposition for every unresolved item, exclusion, pending opinion and finding. The choices are `proceed_with_limits`, `needs_revision` and `stop`. A model analysis never creates this event automatically.

Explicit supersession and revocation preserve prior events. Conflicting active opinions are disputed; recency or model consensus does not establish truth. Opinions concern only the bound exact bodies and analyses, do not automatically carry to new revisions, and do not grant admission to pending association generation.

A complete record_decision includes coverageRef, sourceSetId, ledgerRef, bodyRefs, decisionKind, reason, limitations, dispositions and supersedesEventIds. Each disposition is accepted_limit/resolved/blocks. Derive unresolved IDs from the actual analyses: `unit:<unitKey>` for excluded/pending units, `item:<itemId>` for excluded/pending items, `check:<checkId>` for non-covered checks, and `finding:<findingId>` for every finding. Account for each without manufacturing a pass. A sourceCoverageDecisionRef contains only coverageRef, sourceSetId, ledgerRef, bodyRefs and the committed receipt’s eventId, without decisionKind, reason or actor.

## Publication and custody {#custody}

Writes use append-only histories, shared workspace locking, CAS and actor-bound idempotent receipts. Client data cannot supply the actual actor through an untrusted payload. Without a trusted actor, reads remain possible and writes fail.

The application revalidates native output, exact prepared model input, complete sources, bodies and ledger references inside the publication lock. The trusted original reader must establish archive/request custody before returning raw output; a matching quote or supplied digest alone is insufficient. Changed model data cannot be stored as the original analysis. Read views report original verification separately from decision opinions. Exact committed commands can recover their existing receipts; dispatch eligibility still requires a fresh check.

Existing opinions can still be revoked when original evidence is unavailable. Association claims independently revalidate complete selected sources, bodies and the prepared request under the shared workspace lock, without consuming or fabricating source-review approval.

## Integration boundary {#integration}

`prepare-generation` prepares a writing draft for ordinary generation or all original-source windows for long Codex sources. Confirm dispatch individually or through the exact window batch digest. The run finishes after body publication. `prepare-rebuild-associations`/`rebuild-associations` independently accept `{sources, bodyRefs}`. Bodies and associations remain pending, without mandatory inventory, coverage or actual-decision prerequisites. Zero bodies do not create placeholders or automatic associations.

`prepare-source-review` accepts complete original `sources`, exact `bodyRefs` and optional `ledgerRef`. Without a ledger it inventories then checks coverage; a matching ledger runs coverage only, without generating bodies or automatic associations. Reviewing new content requires analyses and actual opinions bound to the new bodyRefs. Association sources explicitly define its complete selected scope, without inferring or automatically reducing it from body quotations.

`source-ledger` and `source-coverage-status` read exact revisions. `review-source-coverage` accepts a complete `record_decision` or `revoke_decision` command with coverageId, stable requestId, expectedGeneration and expectedHeadEventId; decisions add the complete decision, revocations add targetEventId and reason, without self-reported actor. Model analysis, opinion storage, association generation and manual maintenance do not impersonate approval.

Source3, body, entity, association, reviews and tags retain their identities. `migrate-workflow` copies only the six supported formats to an independent target and archives journal10 and earlier, source-ledger/coverage analyses and automatic permissions. Window batches require explicit confirmation of their current requests. Automatic grants from the old workspace remain archived. Rollback uses the untouched old directory and matching build.

### Coverage profile boundary {#coverage-profile}

Old wire2/prompt3 and wire3/prompt4–5 coverage retains passive-read semantics with `originalVerification=not_verified`, without inheriting current source-review verification. Current coverage originals still use wire3/prompt6; there is no compatibility decoder or rewriting of old outputs. Use the preserved old workspace and matching build for old execution or rollback. Association generation independently binds explicit sources and bodyRefs, without using old coverage or its decisions as admission credentials.

Preserve the original workspace and its matching installable build to continue an old-profile execution or roll back. To use current coverage, make an explicit complete independent workspace copy and prepare a new wire3/prompt6 analysis using the complete original sources, a matching ledger and exact saved body references. Do not rerun a completed matching ledger or body merely to replace coverage. Original/request custody must still revalidate; otherwise stop. Preserve original sources, bodies, IDs, failed outcomes, measurement identities and scores. A new analysis requires its own actual decision; neither copying nor passive readability supplies one. This is a source-build boundary, not a release announcement.

For coverage-only replacement, a reused ledger must pass current journal11 original verification. Journal10 and earlier ledger/coverage histories are archive-only in a copy to workflow11 and cannot confer current execution eligibility; independently prepare source inventory for the new workflow, without rewriting or redispatching the old run.
