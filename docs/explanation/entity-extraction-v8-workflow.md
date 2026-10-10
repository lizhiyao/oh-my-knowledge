# Entity extraction v8: recorded-output workflow acceptance

**Five recorded outputs pass storage, search, provenance, correction and knowledge-association acceptance, with zero new model calls.** Acceptance found that negative polarity was folded by default, allowing a heading to suggest the opposite meaning. A visible heading label fixes this and passes checks on the updated production build. The real pilot is prepared only, without sending messages to a model.

## Scope and evidence

Acceptance reuses verbatim outputs from the [five-window diagnostic](./entity-extraction-v8-diagnostic.md), the runtime build at source `19d5ac2d5032b6d16bd47f07ebd8533f6fbca97e`, an isolated temporary knowledge directory and installed Google Chrome. Final candidate display additionally includes this run's negative-label fix, whose source digest is recorded. The model adapter only returns recorded text, without external executors. Original messages, roles, indices and output bytes remain; only `evidenceRef` values bind bijectively to new snapshots. The application normally allocates new persistent entity/mention/run identities, with mappings recorded separately rather than impersonating original measurements.

[Download sanitized workflow summary](/entity-extraction-v8-workflow.json): case counts, input/output digests and identity mappings, Chrome checks, negative visibility before/after the fix, local artifact digests and real-pilot preparation status. Real text, detailed annotations, native paths and historical outputs stay local.

## Complete recorded-output workflow

Generation/persistence runs through the production application, then file stores are reopened to check every payload: 13 entities, 23 mentions, six knowledge candidates and 16 statements. Descriptions/qualifiers, positions, subjects/objects, statements and citations survive, including values, waiting periods, formulas, polarity and unknowns. All entities are searchable, with knowledge bound to explicit initial entity revisions.

| Path | Observed result |
|---|---|
| Capture → application → file storage → search | Five windows complete; reopened entities, mentions, statements and citations match original admitted payloads, with 13 searchable entities. |
| Meaning, folded identity and source | All 13 entities inspected at both 1280×800 and 1280×500, totaling 26 views; default-folded identity can expand, 46 source expansions/highlights, no document-root overflow. |
| Entity → conversation → task → raw record | Five source navigations/raw reads at each height, totaling ten; synthetic logs reconstruct the same messages, with missing original timestamps and explicit limited-trajectory notices. |
| Correction and historical revisions | One description per analysis changes in five saves; histories, mention identities and positions survive. Knowledge/source/run bytes stay unchanged before explicit application. |
| Explicit latest-revision application | All six candidates save new association revisions, preserving old knowledge histories, statements and evidence, without automatic following. |
| Candidate content and negative visibility | Updated production build passes 12 candidate views/32 statement views; relations, conditions and unknowns remain readable, with negative labels visible in default headings. |
| Missing source | Deleting one isolated snapshot leaves stored entities/mentions readable; correction becomes read-only and cannot save. |

Entity/source/correction checks precede the heading-only fix; unchanged paths and backend bytes allow reuse. All candidate content and default negative visibility are rechecked on the final production build. Chrome reports no page-script errors. Eight additional checks cover Observe, the empty Measure list, Knowledge artifacts and a missing-report endpoint at both heights, without document-root overflow. The missing report returns `core_run_not_found`; populated four-lane reports are not validated here. Merge/split, color, screenshots, native windows, mobile and screen readers are not revalidated here.

## Display problem found and fixed

A Session statement stores `relation: 在状态更新时新增计数` and `polarity: negative`, meaning state updates do not increment counts. Previously the negative label lived inside default-closed classification/time details, while the default heading read as state updates incrementing counts. Both viewport heights reproduced this without screenshots.

The fix reads stored polarity directly and renders “否定陈述” (`Negative claim`) in the statement heading, retaining expandable classification details. It neither guesses negation from strings nor rewrites relations, outputs, storage or prompts. Rendering regressions cover both languages, optional objects, escaping and positive counterexamples; Chrome confirms default negative visibility. The two previously recorded distinction-wording follow-ups remain without rewriting knowledge.

## Preparing the real pilot

Only three previously redacted software-conversation windows are reused: 12 window messages, nine unique messages, one source group, with three deliberately shared before/after Session messages. The v8 prompt/Schema is frozen, retaining exact input bytes, timestamps, indices, digests and coverage limits. Itemwise author review covers 17 knowledge-relevant entity expectations and example anchors.

| Window | Review criteria before outputs |
|---|---|
| `real-session-before-resolution` | Preserve central Session and initialization/update counting boundaries; unresolved differences are not prematurely declared successful, and numeric values do not establish instances. |
| `real-session-after-resolution` | Preserve earlier/later sources and time, distinguish backend/overview scope, master/released versions and remaining gaps; later explanations do not leak into before. |
| `real-protected-correction` | Retain independently discussed methods/fields, permitting supported object/component levels; concrete regressions narrow earlier judgments, while configuration values, planned fixes and execution results remain separate. |

Example anchors are non-exhaustive. Counts may be Session property statements or explicitly source-addressed metric objects, preserving central concepts, values, rules and limits. Level alternatives are adjudicated before outputs, not changed afterward. All material was used in v6 and is development regression only, neither blind nor representative; overall precision/F1 is not computed. Chrome DOM confirms three cards and 12 readable messages.

Preparation is local only, with zero model calls. The proposed future plan is at most three existing Codex `gpt-6.1-sol` calls, one round, no automatic retries and unknown USD cost. Only sources, timestamps/indices/limits and frozen prompt/Schema would be sent; annotations, guides, native paths and historical outputs are excluded. This concrete v8 plan is neither authorized nor executed and does not reuse old quotas.

## Conclusion and limits

Recorded outputs remain complete and traceable through the current application, with negative meaning distinguishable by default. This is engineering workflow acceptance, with no new model score or improvement to the original 21/21. The reviewer is the implementer/corpus author, without independent human evidence. Forty-three synthetic windows, v8 real-model performance and overall quality remain untested; comprehensive extraction quality is not established. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) retains these boundaries.
