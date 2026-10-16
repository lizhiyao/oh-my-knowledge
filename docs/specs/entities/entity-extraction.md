# Entity extraction from selected records

Status (2026-10-12): [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) is closed under the user-approved beta completion scope. Identity rules, storage, searchable interfaces, source tracing, corrections and explicit knowledge bindings are delivered; the complete workflow and a minimal real regression of the then-current v14 prompt have completed itemwise author review. The real regression covers one previously viewed development window, not overall accuracy or stability. Independent review and full quality acceptance remain pending; beta closure does not change the strict gates of the [evaluation guide and offline checker](./entity-extraction-evaluation.md).

See the [identity rules](./entity-identity.md) for components/instances, collections/unresolved identities, renames/versions and later corrections. Section 6 defines current contracts; only current data structures are supported, without legacy readers, recovery or migration. Canonical identity across logs/agents and reuse benefits remain to be implemented and verified. Research, structural validation and functional completion do not establish overall model performance.

## 1. User outcome and scope

Users inspect which objects selected records discuss, which mentions refer to the same object, and which remain uncertain. Multiple knowledge candidates reference the same analysis. People, files, systems, rules, concepts, and plans can be entities; subject and object are statement roles. See [How OMK understands knowledge](../../explanation/knowledge.md).

Current scope covers one immutable source window. Matching names, paths, types, or similar wording do not establish identity. It does not automatically merge across logs, build a global entity database, or infer a graph. Identifying an object does not verify statements about it.

Users keep the select-records → extract entry point. Results and history provide optional entity inspection and correction, including runs with no knowledge candidates. Entity review is not a mandatory extra step.

The workspace entity catalog is a query projection of existing window analyses, not a canonical cross-log identity registry. Studio and CLI search current entities, mentions, qualifiers, and origins while preserving analysis/entity/revision identities; exact revisions support history inspection. Linked knowledge counts only current knowledge revisions and exposes their actual entity bindings and subject/object roles. Older bindings, discard choices, and unavailable sources remain visible without implying verification.

Knowledge principles own object meaning and semantic-category concepts; this page specifies current window, identity, and reference rules.

Studio presents meaning, qualifiers, ambiguity, source mentions and linked knowledge first. Referent levels and component/collection links remain in expandable details; existing special levels or links are initially expanded in correction forms.

## 2. Research and decisions

| Primary source | Relevant practice | OMK decision |
|---|---|---|
| [End-to-end Neural Coreference Resolution](https://aclanthology.org/D17-1018/) (2017) | Spans and context support mention and antecedent decisions. | Retain mention positions and correspondence rationale; do not resolve pronouns mechanically to the nearest name. |
| [GLiNER](https://aclanthology.org/2024.naacl-long.300/) (2024) | Open entity types in named entity recognition. | Keep open types; evaluate recognition separately from identity. Do not introduce another Python model dependency initially. |
| [Joint entity-level relation extraction](https://aclanthology.org/2021.eacl-main.319/) (2021) | Joint use of local mentions, coreference, and entity relations. | Prefer one invocation with independent results and a shared window catalog referenced by candidates. Logical boundaries do not require two invocations. |
| [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) | TextUnit provenance; joint entity/relation extraction; default merging by name and type. | Retain provenance; name/type merging violates OMK's homonym boundary, so do not adopt it or full graph indexing. |
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/#text-quote-selector) | Quotes with surrounding text distinguish repeated passages. | Use exact quote occurrences selected explicitly by the model; the host computes positions and never chooses the first ambiguous match. This is OMK's selector, not complete protocol compatibility. |
| [LLM coreference evaluation](https://aclanthology.org/2024.lrec-main.145/) (2024) | Automatic and manual analysis examines prompts and failures. | Report structural admission separately from semantic errors against cases frozen before output. |
| [LEA coreference evaluation research](https://aclanthology.org/P16-1060/) (2016) | Entity links inform coreference evaluation. | Check required links and separations independently; do not substitute entity counts or name matches. Do not claim a full LEA implementation. |

These sources inform decisions; they do not demonstrate performance on OMK logs. Single invocation remains the default. The separately identified bounded retry policy permits explicitly authorized additional attempts, without claiming benefit. Measuring their benefit, cost, and failure behavior still requires fixed inputs, model, policy, and review criteria.

## 3. Contracts and identity

An independent entity analysis contains entities, mentions, identity ambiguity, and source limitations. Model identifiers are local to the window. The host assigns UUIDs once for the analysis, shared across candidates.

- Mentions retain exact quotes, references, UTF-16 positions, explicit/inferred basis, and correspondence rationale.
- Descriptions identify objects; qualifiers describe project, version, and environment. Substantive knowledge belongs in contextual statements with evidence.
- An unresolved mention refers to a local unknown object with possible targets and uncertainty, never an arbitrarily chosen target.
- Every entity has an admitted mention; mentions, possible targets, and statements have closed references. Empty entity and knowledge results are valid.
- Model quotes use `evidenceRef`, exact continuous `quote`, and optional zero-based `occurrence`, counting overlapping matches. Multiple matches require an explicit occurrence; missing or out-of-range indices are rejected. The host computes UTF-16 offsets without normalization, fuzzy matching, or model-supplied offsets. Old prefix/suffix selectors are rejected.
- Required `referentKind` distinguishes object, component, instance, version, collection, plan, and activity. `componentRef` is null or a source-backed link from an instance/version to a proposed component; `collection` is null except for collections and records known members, completeness, supporting mention IDs, and rationale. References remain within this analysis. Unknown membership differs from unresolved identity; candidates must have the same referent level. Duplicate, missing, or cyclic members are rejected.
- Link evidence must include an own-entity mention. A collective phrase has one mention, without copied spans for its members. Cases use only descriptive statements as actions/outcomes. Structural admission does not verify any identity judgment or statement.
- Partial rejection records individual reasons. Invalid mentions cannot support entities; invalid entities cannot support statements. Admission does not silently repair results or drop ambiguity.

### 3.1 Critical sources and ordinary repeated mentions

Object identity and knowledge evidence have separate coverage obligations. Mentions select object names or actual referring expressions. The evidence links of extracted statements and their exact `citations` directly locate purposes, conditions, constraints, exceptions, corrections and unverified limits. Cite separate locations separately, retaining context needed to understand each judgment. An earlier name, background in the same message, access to the complete message or a `rationale` alone does not demonstrate directly located critical evidence.

Add a mention when that occurrence needs identity inspection. Ordinary repetitions of the same object can be omitted; repeated names already covered by accurate knowledge citations do not require additional mentions. Without knowledge candidates, retain mentions needed to recognize objects and assess identity. Explicitly adding a mention can repair an existing result's navigation, but does not establish automatic model coverage or let entity existence substitute for knowledge conditions or sources.

These are generation and itemwise review requirements. Admission continues to validate structure, references and exact positions, without guessing critical evidence from keywords or completing outputs. See [evaluation section 2.2](./entity-extraction-evaluation.md) for the targeted diagnostic.

## 4. Corrections and knowledge revisions

Entity analysis has immutable revisions, parent revisions, authors, timestamps, and reasons, with generation/head checks and idempotent write identities. Users can reassign mentions, split/merge local objects, add omitted mentions, remove false mentions, and retain ambiguity. A mention identity cannot move to different source text; relocation creates another mention. Studio explicitly corrects level, component links, collection members/completeness and evidence. Field changes do not silently remove other information; inconsistent drafts must be corrected. Before merging/removing entities or reassigning mentions, explicitly correct dependent component, membership, candidate and evidence references. The UI lists dependent entities for inspection; it does not drop references or infer membership completeness. Before merging, explicitly remove the original entity's own link information and inspect the target; removal deletes its own information but does not rewrite other entities. Original revisions and source snapshots remain preserved.

Knowledge grounding binds an exact analysis revision. Later corrections do not overwrite old knowledge. Applying a correction requires checking statement roles and evidence, and produces another knowledge revision. Splitting an old object does not let the workflow pick one replacement subject arbitrarily.

Corrections remain human or agent judgments, not automatic truth verification, and do not inherit retention decisions. Deleted or unreadable sources remain explicitly unavailable; saved quotes alone do not establish that original text was checked again.

Applying entities preserves prior additional identity uncertainty notes by default; users may explicitly review and change them, while historical notes remain in old revisions. Current catalog uncertainties are mandatory and cannot be erased with empty input. Inspect statement conditions, exceptions, and unknowns separately; renaming or merging entities does not delete them automatically.

## 5. Domain and runtime boundaries

`knowledge` owns pure contracts, references, and revision invariants. `observability/knowledge-extraction` owns selected windows, model transport, admission, and application workflows; file adapters implement storage. Studio and CLI share the workflow. Evaluation Core does not own observed entities or filesystem effects.

Entity domain code lives in `src/knowledge/entities/`: `contracts.ts` defines entity analyses and storage ports, `identity.ts` defines identity and link rules, `validation.ts` checks analysis references and mentions, and `history.ts` handles immutable revisions and deterministic write rules. Consumers import by responsibility directly; this module does not invoke models, read or write files, or depend on Studio. Model-output admission and joint entity/knowledge extraction remain orchestrated by `observability/knowledge-extraction`, whose adapters still implement entity file storage. Directory boundaries add no model invocations or user steps.

Each v5 run defaults to `knowledge-generation-single/v1`: one OMK invocation. The explicit `knowledge-generation-bounded/v1` policy permits at most three invocations, including at most two validation reasks, without fallback. Before every dispatch, persist exact system/input digests, source bindings, prompt/wire/pipeline identities, producer reservation and, for bounded policy, its non-refundable token reservation and trigger. The API producer proof additionally binds the actual rendered body digest and endpoint; this is not a complete request-byte archive or a record of unseen Codex global context. Archive the complete returned executor JSON or a bounded exception observation in an immutable outcome sidecar before structural decoding, admission and preparation of entity/knowledge write intents. Failed partial output, the separate refusal channel, usage/cache fields and their reported flags, internal attemptCount and stop/failure diagnostics remain original evidence; they are not replaced by a display error. This does not capture raw provider HTTP or CLI transport, establish provider-request counts, or prove that a normalized zero was explicitly reported. Authored model-port projections retain their narrower declared evidence scope.

Recovery archives an outcome still held by the same application instance, reads an already persisted sidecar, or finishes allocated idempotent write intents without invoking the model again. Commit entities before knowledge. A started invocation without saved outcome bytes remains unknown after process loss; it does not authorize a resend or refund. Repeating generate with the same run identity also only recovers; it does not restart the retry scheduler.

The bounded policy freezes `maxInvocations`, `maxReasks`, `profileId`, `maxTotalTokens`, `maxOutputTokens`, retry/backoff, feedback and selection rules. Validation reasks consume the same invocation limit. Only classified rate-limit/server/network/timeout failures and parse/wire/envelope or zero-admission results can lead to another attempt; any admitted sibling selects the partial result. Archive and commit failures cannot trigger a new model call. Each attempt reserves the full verified input/output upper bound, without refund for lower or unknown reported usage; standardized input, cache-read, cache-creation and output buckets are observed separately. Unsupported budget profiles fail before dispatch. The production profile requires the exact official API endpoint and snapshot, while Codex remains supported by the default single policy. This introduces a separate policy/measurement identity, not a new prompt or response Schema, model-quality evidence, or automatic provider fallback.

Only selected excerpts and scope limitations are sent. Native paths stay local; instructions in logs cannot expand reading or invoke tools. Unreported cost is unknown, not zero.

## 6. Current storage contracts

`entities/<analysis-id>.json` uses `entity-analysis-history` v2 with immutable entity revisions, source bindings, and write receipts. `items/<identity-digest>.json` uses `knowledge-item-history` v2; knowledge generated by this extraction workflow binds grounding to an exact entity analysis revision.

`extraction-runs/<run-id>.json` uses `knowledge-extraction-run` v5. Immutable native outcomes live at `extraction-runs/outcomes/<run-id>/<attempt-id>.json`; run metadata binds their identities/digests, admission facts and stable entity/knowledge write intents. Both metadata and outcome capacity must be admitted before dispatch. The existing response guard uses JavaScript string length with a ceiling of 2 × 1024² code units; it limits admission after complete outcome archival rather than truncating native evidence. New readers validate the current format and exact references instead of accepting a v4 file placed in the new directory.

Automatic extraction keeps existing permission fields at Schema v1. A missing policy explicitly means the existing single-invocation authorization. New permissions may record the selected policy and `conversation-invocations/v1` ledger identity; immutable per-attempt receipts bind permission/run/attempt/request identities and any full token reservation before dispatch. Mutable call/token counters reconcile from those receipts without refunds. The conversation's `maxCalls` and bounded token allowance accumulate across windows; every retry/reask consumes another slot. A new policy requires fresh user approval, without widening or rewriting an old grant.

Default configured generation uses `knowledge-extraction-v15`: a no-few-shot strict rendering of the original v14 instructions, replacing the embedded domain Schema with the single wire Schema. It explicitly requests strict output and decodes nullable placeholders before existing host admission checks; the domain response remains Schema v4. The original prompt-json v14 bytes remain unchanged for authored model ports. Storage v5, prompt versions, wire identity, rendered request and pipeline policy have separate provenance. Unsupported capabilities fail before dispatch, without silent prompt-only fallback. Different content or configuration cannot reuse a runId.

Quality acceptance uses the [current guide, corpus and checker identity](./entity-extraction-evaluation.md). Changes to prompt, annotation or tool bytes require a new measurement identity; old reports, raw outputs and scores are not recalculated. Reproduce other versions only at their corresponding frozen revisions, without combining them with the current runtime.

Former `runs/` v4 files remain untouched and are not read, migrated, rewritten or deleted. Their run details, resume, conversation/project batches and quality statistics are unavailable in the new reader. Current `sources/`, entity history v2 and knowledge history v2 remain readable in the same workspace, including their bindings; a new empty workspace is not required. Entity history v1 remains unsupported independently of this run upgrade. New extractions never automatically take over old knowledge bindings.

The full strict v15 system has frozen raw UTF-8 digest `sha256:d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d`; run metadata binds the actual full system digest rather than the old v14 digest. Original prompt-json v14 retains `sha256:e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399`. This activates no four-demonstration few-shot candidate and includes no new real-model measurement. Historical prompt-json v14 evidence, inactive experiment arms and this strict production identity cannot be pooled as one measurement or inherit quality/Gold conclusions. Historical runs are not automatically upgraded or rescored.

Writes serialize through the workspace's `.knowledge-write.lock`. Only a local PID proven exited by SIG0 returning ESRCH permits recovery; lock age and run status are insufficient. Recoverers serialize by the original owner identity to avoid deleting a later live lock. Interrupted recovery guards follow the same rule.

The entity catalog reads current `entities` histories without writing duplicate entities or a persistent index. Corrupt, unsupported, and symlink files count as unreadable analyses; healthy analyses remain searchable with an explicit incomplete-result notice. One scan allows at most 4,096 JSON files and 64 MiB total file size, then fails rather than silently truncating. Queries default to 20 entities per page, allow at most 100, and sort by revision time and stable identities. Unreadable linked knowledge makes counts unknown, not zero. Unavailable sources prevent correction.

## 7. Quality and completion evidence

Before model runs, freeze important mentions, allowed correspondences, mandatory separations, unresolved referents, and statement subject/object roles. Synthetic cases do not establish coverage of real users. Reports identify authorship and review limitations.

Report important omissions, false mentions, wrong links/merges, unjustified resolution, and downstream role errors separately. Exact quote matching proves location; reference closure proves structure; neither alone proves semantics. Comparisons retain per-case output, input/prompt digests, actual usage, and failures.

Completion requires independent results, usable inspection/correction, shared knowledge identities and revision binding, empty/partial/interrupted behavior, current-format and unsupported-version rejection evidence, semantic quality reporting, real entry acceptance, bilingual documentation, autonomous review, and delivery gates. Cross-log and cross-agent value is not inferred from this work.

See the [evaluation guide](./entity-extraction-evaluation.md) for the latest real regression, author-review scope, missing independent evidence and unknown cost. Current evidence covers one previously viewed development window, not overall quality or cross-agent reuse benefit.
