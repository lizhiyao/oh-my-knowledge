# Entity extraction from selected records

Status: implemented for #1119. Only current data structures are supported, without legacy readers, recovery, or migration. The [v2/v3 comparison report](../explanation/entity-extraction-quality.md) preserves historical results and one pending object-granularity adjudication. Research and structural validation do not prove model performance.

See the [entity identity rules (design draft)](./entity-identity.md) for subsequent rules and examples covering components/instances, collections/unresolved identities, renames/versions, and later corrections. They are not part of the current implementation and do not change this specification's current contracts or historical acceptance results.

## 1. User outcome and scope

Users inspect which objects selected records discuss, which mentions refer to the same object, and which remain uncertain. Multiple knowledge candidates reference the same analysis. People, files, systems, rules, concepts, and plans can be entities; subject and object are statement roles. See [How OMK understands knowledge](../explanation/knowledge.md).

The first release covers one immutable source window. Matching names, paths, types, or similar wording do not establish identity. It does not automatically merge across logs, build a global entity database, or infer a graph. Identifying an object does not verify statements about it.

Users keep the select-records → extract entry point. Results and history provide optional entity inspection and correction, including runs with no knowledge candidates. Entity review is not a mandatory extra step.

The workspace entity catalog is a query projection of existing window analyses, not a canonical cross-log identity registry. Studio and CLI search current entities, mentions, qualifiers, and origins while preserving analysis/entity/revision identities; exact revisions support history inspection. Linked knowledge counts only current knowledge revisions and exposes their actual entity bindings and subject/object roles. Older bindings, discard choices, and unavailable sources remain visible without implying verification.

## 2. Research and decisions

| Primary source | Relevant practice | OMK decision |
|---|---|---|
| [End-to-end Neural Coreference Resolution](https://aclanthology.org/D17-1018/) (2017) | Spans and context support mention and antecedent decisions. | Retain mention positions and correspondence rationale; do not resolve pronouns mechanically to the nearest name. |
| [GLiNER](https://aclanthology.org/2024.naacl-long.300/) (2024) | Open entity types in named entity recognition. | Keep open types; evaluate recognition separately from identity. Do not introduce another Python model dependency initially. |
| [Joint entity-level relation extraction](https://aclanthology.org/2021.eacl-main.319/) (2021) | Joint use of local mentions, coreference, and entity relations. | Prefer one invocation with independent results and a shared window catalog referenced by candidates. Logical boundaries do not require two invocations. |
| [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) | TextUnit provenance; joint entity/relation extraction; default merging by name and type. | Retain provenance; name/type merging violates OMK's homonym boundary, so do not adopt it or full graph indexing. |
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/#text-quote-selector) | Quotes with surrounding text distinguish repeated passages. | Have the host verify a unique position; reject remaining multiple matches rather than choosing the first. |
| [LLM coreference evaluation](https://aclanthology.org/2024.lrec-main.145/) (2024) | Automatic and manual analysis examines prompts and failures. | Report structural admission separately from semantic errors against cases frozen before output. |
| [LEA coreference evaluation research](https://aclanthology.org/P16-1060/) (2016) | Entity links inform coreference evaluation. | Check required links and separations independently; do not substitute entity counts or name matches. Do not claim a full LEA implementation. |

These sources inform decisions; they do not demonstrate performance on OMK logs. A single invocation is the current architecture choice. Adding another invocation requires controlled evidence of benefit, cost, and failure behavior with fixed inputs, model, and review criteria.

## 3. Contracts and identity

An independent entity analysis contains entities, mentions, identity ambiguity, and source limitations. Model identifiers are local to the window. The host assigns UUIDs once for the analysis, shared across candidates.

- Mentions retain exact quotes, references, UTF-16 positions, explicit/inferred basis, and correspondence rationale.
- Descriptions identify objects; qualifiers describe project, version, and environment. Substantive knowledge belongs in contextual statements with evidence.
- An unresolved mention refers to a local unknown object with possible targets and uncertainty, never an arbitrarily chosen target.
- Every entity has an admitted mention; mentions, possible targets, and statements have closed references. Empty entity and knowledge results are valid.
- Quotes may include immediately adjacent context. The host does not fuzzy-match, normalize source text, or trust model-supplied numerical positions. OMK retains UTF-16 offsets and does not claim the complete W3C selector protocol.
- Partial rejection records individual reasons. Invalid mentions cannot support entities; invalid entities cannot support statements. Admission does not silently repair results or drop ambiguity.

## 4. Corrections and knowledge revisions

Entity analysis has immutable revisions, parent revisions, authors, timestamps, and reasons, with generation/head checks and idempotent write identities. Users can reassign mentions, split/merge local objects, add omitted mentions, remove false mentions, and retain ambiguity. A mention identity cannot move to different source text; relocation creates another mention.

Knowledge grounding binds an exact analysis revision. Later corrections do not overwrite old knowledge. Applying a correction requires checking statement roles and evidence, and produces another knowledge revision. Splitting an old object does not let the workflow pick one replacement subject arbitrarily.

Corrections remain human or agent judgments, not automatic truth verification, and do not inherit retention decisions. Deleted or unreadable sources remain explicitly unavailable; saved quotes alone do not establish that original text was checked again.

Applying entities preserves prior additional identity uncertainty notes by default; users may explicitly review and change them, while historical notes remain in old revisions. Current catalog uncertainties are mandatory and cannot be erased with empty input. Inspect statement conditions, exceptions, and unknowns separately; renaming or merging entities does not delete them automatically.

## 5. Domain and runtime boundaries

`knowledge` owns pure contracts, references, and revision invariants. `observability/knowledge-extraction` owns selected windows, model transport, admission, and application workflows; file adapters implement storage. Studio and CLI share the workflow. Evaluation Core does not own observed entities or filesystem effects.

Persist a reservation before invoking the model, and raw output/reported usage before preparing entity and knowledge write intents. Recovery uses allocated identities, the current prompt identity, and idempotent commands without invoking the model again. Commit entities before knowledge; interrupted knowledge intents remain resumable.

Only selected excerpts and scope limitations are sent. Native paths stay local; instructions in logs cannot expand reading or invoke tools. Unreported cost is unknown, not zero.

## 6. Current storage contracts

`entities/<analysis-id>.json` uses `entity-analysis-history` v1 with immutable entity revisions, source bindings, and write receipts. `items/<identity-digest>.json` uses `knowledge-item-history` v2; knowledge generated by this extraction workflow binds grounding to an exact entity analysis revision.

`runs/<run-id>.json` uses `knowledge-extraction-run` v3 and supports only `knowledge-extraction-v3`, preserving the current prompt identity, raw output, prepared entity/knowledge intents, and runtime metadata. Current-run recovery reuses assigned identities and idempotent commands without calling the model again.

This is a `BREAKING-SCHEMA` reduction in supported formats: old envelopes, prompt runs, and model output are no longer read, resumed, or converted. There is no migration command, automatic rewrite, or deletion; old files remain untouched. Choose a new empty knowledge directory and extract again from the original logs. Run storage explicitly changes from v2 to v3. Older runs are unsupported, including v2 runs using the v3 prompt; knowledge histories remain v2. Prompt bytes and admission semantics are unchanged, and historical quality evidence is not recalculated.

Writes serialize through the workspace's `.knowledge-write.lock`. Only a local PID proven exited by SIG0 returning ESRCH permits recovery; lock age and run status are insufficient. Recoverers serialize by the original owner identity to avoid deleting a later live lock. Interrupted recovery guards follow the same rule.

The entity catalog reads current `entities` histories without writing duplicate entities or a persistent index; storage versions stay unchanged. Corrupt, unsupported, and symlink files count as unreadable analyses; healthy analyses remain searchable with an explicit incomplete-result notice. One scan allows at most 4,096 JSON files and 64 MiB total file size, then fails rather than silently truncating. Queries default to 20 entities per page, allow at most 100, and sort by revision time and stable identities. Unreadable linked knowledge makes counts unknown, not zero. Unavailable sources prevent correction.

## 7. Quality and completion evidence

Before model runs, freeze important mentions, allowed correspondences, mandatory separations, unresolved referents, and statement subject/object roles. Synthetic cases do not establish coverage of real users. Reports identify authorship and review limitations.

Report important omissions, false mentions, wrong links/merges, unjustified resolution, and downstream role errors separately. Exact quote matching proves location; reference closure proves structure; neither alone proves semantics. Comparisons retain per-case output, input/prompt digests, actual usage, and failures.

Completion requires independent results, usable inspection/correction, shared knowledge identities and revision binding, empty/partial/interrupted behavior, current-format and unsupported-version rejection evidence, semantic quality reporting, real entry acceptance, bilingual documentation, autonomous review, and delivery gates. Cross-log and cross-agent value is not inferred from this work.

The completed [quality report and original evidence](../explanation/entity-extraction-quality.md) separate structural results, exact positions, Agent semantic review, and unknown cost. It supports independent entity coverage on the frozen synthetic cases; it does not establish fewer object errors in knowledge or independently reviewed real-log quality.
