# Effective observation review

The inbox keeps source reports and human review state separate. The effective review is a read-time view, not a replacement persisted report and not a causal evaluation of a skill.

## Shared view

`omk observe inbox --json` includes `effectiveExperienceReports`, `resolvedReviewSessions`, and `unappliedMetricAnnotations` alongside the existing `items` array. `GET /api/observe-inbox/view` exposes the same three fields; both support skill filtering. The existing `GET /api/observe-inbox` item-list response is unchanged. Studio consumes the same domain projection.

Effective session indicators, basis codes, rule findings, inference, priorities, and skill totals belong to observability, not the HTML renderer. Deterministic priority uses the domain weighted score: scores of at least three mean `review_first`, positive scores below three mean `sample_review`, and zero means `routine_sample`. Domain reviewer findings can escalate this priority. Existing explicit LLM and manual-review precedence is retained, with provenance in `resolvedReviewSessions.source`.

## Evidence and annotations

Canonical feedback attribution determines which feedback belongs to a skill, including permitted downstream feedback. Rejected feedback is excluded from the effective count. Where complete attributed event relations are available, other metric annotations are applied from that evidence rather than from the preview window.

A truncated or missing preview is not evidence of zero occurrences. When an annotation can be located but cannot be safely replayed from complete evidence, the stored count remains and the session's metric key is reported in `unappliedMetricAnnotations`. This is an evidence limitation, not confirmation that the annotation changed the total.

Raw `reports`, raw `experienceReports`, original trace evidence, and review state remain independently available in the inbox view model. Do not persist `effectiveExperienceReports` over those originals. Published measurement schemas, prompt bytes, and persisted statistical results are not changed by this projection.
