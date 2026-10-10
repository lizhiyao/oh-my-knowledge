---
description: Annotation, layered checks and independent review for entity extraction.
---

# Entity extraction quality evaluation

Status: P4 checker and author-reviewed annotations. Guide `omk-entity-annotation/v3`, corpus `omk-entity-quality/v5`, checker `omk-entity-critical-checks/v3`; targets `knowledge-extraction-v5` / response Schema v4. **Independent human annotation review and new model evaluation are incomplete.** [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) tracks both.

## 1. Versions and scope

This guide follows the [identity rules](./entity-identity.md) and [extraction contract](./entity-extraction.md). Historical v2/v3/v4 corpora, reports and raw outputs remain unchanged. v5 revises the prompt for unsupported types, shared-reference attribution and negation ambiguity found in the [two v4 rounds](../explanation/entity-extraction-v4-repeat-quality.md). New annotations allow complete identity qualifiers in advance and include shared references; checker v3 exposes relation, modality and polarity without a semantic verdict. Old reports are not re-scored and counts are not directly comparable. This is `BREAKING-COMPARABILITY`: the production prompt becomes v5, response Schema remains v4, and entity/knowledge/run file formats stay unchanged.

`test/fixtures/entity-extraction-review-v5.json` is a public synthetic set: 16 development windows, eight new reserved validation windows and 84 critical mentions. All 16 windows whose v4 outputs have been inspected now serve development regression; their `val-` prefix preserves historical case identity only, with actual split development. Eight new `fresh-` windows use separate project/conversation groups; duplicate source windows cannot cross splits. New coverage includes type evidence, instances, shared properties, collective/distributive claims, negative requirements, missing members, replacement and correction/plans. It is neither a hidden blind set nor representative real logs. New validation windows must not inform prompt tuning; author knowledge of synthetic answers is not independent review. Future real data requires separate minimization, authorization, grouping and review, with no synthetic windows in its denominator. No v5 model outputs exist yet; offline checks do not prove these revisions effective.

## 2. Annotation units and allowed expressions

Freeze source messages, roles, omitted records and window limitations before annotating each item:

| Annotation | Rule |
|---|---|
| Critical mention | Names and references needed for retrieval, identity or understanding knowledge, rather than every noun. Keep message index, verbatim quote and zero-based occurrence; count overlapping matches and use UTF-16 half-open spans. |
| Allowed boundary | `alternatives` lists equivalent boundaries agreed before outputs, such as a complete code identifier with or without backticks. An arbitrary broad quotation containing the name is not a hit; broader boundaries are review candidates. |
| Identity group | Mentions with the same `entityKey` must merge; different groups must remain separate. Model IDs and labels are not gold. Align source spans before comparing mention pairs. |
| Granularity and links | Annotate allowed `referentKinds`, identity status, explicit candidates, component and collection membership/completeness. Alternatives need prior agreement; uncertain sources retain uncertainty. |
| Knowledge roles | Annotate source anchor, subject, object and interpretation first. Relations may use synonymous wording. A human checks semantics, direction, negation, conditions, time and corrections against the full window; missing keywords are not errors. |

A collective reference is one collection mention, not duplicate member mentions at the same span. Instances/versions differ from their component; environmental conditions alone do not force new identities. Distinguish tools from logs, plans from executions, replacement from rename. Matching names or paths are insufficient to merge. Truncated sources do not automatically require empty knowledge: an unresolved subject may retain a source assertion and pending investigation, without filling missing identity or generalizing conclusions. If two identity schemes are reasonable, adjudicate first or explicitly allow alternatives before outputs; this draft does not encode conflicting identity partitions, so unresolved disputes cannot be frozen.

Judge type evidence separately from identity resolution: names, calls, failures or “node” labels alone do not prove components/deployed instances. A known identity with unknown type stays proposed object with type uncertainty; explicit module roles or deployment instances must not be downgraded. Qualified descriptions and short names may be prefrozen alternatives, never widened after new outputs. Distinguish shared references from their properties: their/它们 refers to a collection; a property phrase cannot identify just one member. Read relation and polarity together without double negation; “not failed” does not mean “passed”, and “not prohibited” does not mean “required”. Per-case semantic criteria preserve these judgments without keyword classifiers.

## 3. Layered results and acceptance threshold

| Layer | Recorded checks | Limits |
|---|---|---|
| Calls and capture | Separate call failures, JSON parse failures, cancellation and unattempted items. | Internal checker exceptions stop the run instead of becoming model failures; no retries hide failures. |
| Structural admission | Envelope Schema rejection, rejected mentions/entities/proposals and itemized reasons. | Structural rejection of valid JSON is a captured output, never `capture_failures`. Rejected item counts include cascading consequences, not independent mistakes. |
| Critical mentions | Exact matches/missing/ambiguous mentions, broad-boundary candidates and critical mention recall. | Annotation is not exhaustive: precision/F1 are `null`; extra mentions need human review and are not automatically false positives. |
| Identity | Required same/different mention pairs, wrong merges/splits and granularity/candidate/component/member differences. | Unaligned mentions or missing references are `not_evaluable`, never passes. Correlated pair counts are not independent-sample accuracy. |
| Knowledge links | Statements linked to the source anchor, endpoints, relation, modality and polarity; reversed endpoints raise review prompts; no statement is `not_observed`. | Matching endpoints do not establish correct relations or truth. Other statements sharing an anchor, broad citations and synonyms require human review. |
| Independent semantics | Per-case `semanticChecks` cover conditions, time, negation, assertions/observations, plans/completion, case organization and late corrections. | `optional` permits no knowledge; omission differs from error. Knowledge under `none` requires an issue. Empty results do not establish reliable knowledge links. |

Frozen synthetic critical regression threshold: every planned call has a record; no call/parse failure, cancellation, unattempted item or structural rejection; 100% critical mention matches; all same/different mention pairs and identity links match without `not_evaluable`; independent human review approves generated knowledge roles, conditions and status with no unresolved disputes. Omitted optional knowledge supports entity-only conclusions and leaves knowledge-link coverage insufficient. This tool never automatically declares the entire threshold passed: `semanticReview` stays `pending`, with unverified scope reported.

This threshold covers specific boundaries, not overall quality. Two repeats supply at most two samples; passing both does not establish population stability or cross-Agent benefits. Real-log sampling and thresholds are separately predefined, never adjusted after seeing outcomes.

## 4. Independent review, disputes and freezing

1. The implementer/author checks semantics, source closure, positions, grouping and contracts case by case, recording rationales in `omk-entity-author-review/v1`. `authorReview: completed` and `exploratoryReady: true` support continued engineering and exploratory evaluation without requiring the user to review every case. Self-review supplies no independent human evidence; `goldReady` stays false. Missing independent review is a reported coverage limit, not a blocker for this work; the independent quality completion threshold is unchanged.
2. A person independent of the authors checks each case's guide, allowed boundaries, identity groups, roles and semantic criteria. Complete `review-template.json` with `approved` or `changes_requested` per case, rationale, reviewer, timestamp and independence declaration. An independent model judge does not equal independent human review.
3. Adjudicate disputes before seeing outputs, recording the question, resolution and independent adjudicator. Unresolved disputes use `changes_requested`. Corpus/guide/checker changes require a version change and new bundle; editing a receipt cannot approve a different digest.
4. Both author and independent records cover every case, bind the measurement identity and predate output capture. Either supplied record requesting changes makes both readiness flags false; self-review cannot override independent disagreement. The checker rejects author self-attestation, omissions, wrong digests and post-hoc approval. It checks record closure and declarations, not actual reviewer identity or judgment correctness; `attested_independent_human` is a declaration, not an effectiveness conclusion.
5. The measurement identity combines corpus, bilingual guide, compiled checker and production runtime digests, dependency manifest/lockfile digest, Node version, raw UTF-8 prompt digest and versions. Rebuilding changes identity if artifact bytes change; retain the frozen build for evaluation. The bundle preserves both original guide files and a combined reading copy. Runtime promptHash uses canonical JSON hashing rather than the raw UTF-8 digest here; do not interchange them.

## 5. Offline review tool and evidence

Update compiled artifacts, then prepare an external bundle:

```bash
yarn build:runtime
node dist-scripts/bench/entity-extraction-review.js \
  --corpus test/fixtures/entity-extraction-review-v5.json \
  --output /private/tmp/omk-entity-review-unique
```

The output must be absolute, outside the repository, with an existing parent and nonexistent destination; symlinks into the repository are rejected. It preserves raw corpus, bilingual guide, `review.html` with positions and annotations, review template, model inputs/digests and measurement manifest. Without an independent receipt, `goldReady: false` even after completed author review. The default template requests changes and has no signature; it cannot approve anything without completion.

Optional `--self-review /absolute/self-review.json` validates an author record (measurement identity, author, timestamp, per-case decisions and rationales) and saves `self-review.json`. It has no independence attestation and cannot pass as human evidence via `--review`. Optional `--review /absolute/review.json` validates an independent receipt; optional `--captures /absolute/captures.json` checks existing captures only. **No executor entry exists: this command makes zero model calls.** Preparing a bundle or signing annotations does not authorize data transmission or model execution.

Capture format `omk-entity-captures/v1` contains the same `measurementId`, one split, one or two planned repeats, start time, executor/model and records with `caseId`, repeat index, frozen input digest and result. Results are `output` (verbatim text and optional original usage), `call_failure` or `cancelled`, with optional executor-reported `durationMs` and `costUSD`; omit unknown values instead of inserting zero. Unknown, duplicate, excess and input-mismatched records are rejected. Raw captures and admission results remain intact. Unattempted records are itemized; unchecked critical mentions stay outside the matching denominator and have their own count. Aggregate only reported usage, duration and cost. Total cost is `unknown` if any recorded attempt lacks reported cost, while the reported subtotal remains visible; partial cost coverage is not the whole-run cost.

Structural rejections do not fail capture status; call/parse failures, cancellation or incomplete plans cause a nonzero exit. Successful exit only means offline inspection completed. Raw outputs, itemized admission, original usage and every failure remain available; semantic review stays pending. Captures approved only by the author are `exploratory_semantic_review_pending`, never an independent acceptance pass. P5 executes model evaluation only within concrete authorization and obtains itemized independent output review.
