# Diagnosis / Occurrence Mapping

This document aligns the architecture direction for GitHub issue #103.

It is intentionally a design mapping first. It does not change the current
runtime code. The target structures below refer to the post-observe-inbox
architecture where `skill-insights`, `skill-chain`, `problem-patterns`,
reviewer reports, and soft-standard extraction all exist.

## Problem

Studio and observation currently express skill diagnostics through different
models.

```text
studio / skill detail
└─ Insight[]
   ├─ audience
   ├─ severity
   ├─ evidence
   ├─ recommendations
   └─ patch

observe inbox
├─ ObservationSkillChain
├─ SkillChainAdvisory
├─ ExperienceProblemPattern
├─ ExperienceReviewerReportFinding
└─ SkillDerivedStandard
```

Both sides answer "what is wrong with this skill", but they do not share a
diagnostic abstraction. The goal is not to make the two pages look the same.
The goal is to define a shared diagnostic layer underneath them.

## Non Goals

```text
not doing
├─ moving observe inbox UI into studio
├─ making studio show every session trace
├─ making observation adopt the Insight display format
├─ replacing raw reports with Diagnosis
└─ doing a broad refactor before the mapping is validated
```

## Current Models

### Insight

`Insight` is a productized repair diagnosis for studio / skill detail.

```text
Insight
├─ id
├─ category
├─ audience: skill-author | sample-author | omk-maintainer
├─ severity: high | medium | low
├─ title / description
├─ affectedCount
├─ evidence[]
├─ recommendations[]
├─ patch?
└─ stageRefs?
```

Its inputs are doctor, eval, and observe snapshots. Its output is already close
to a user-facing diagnosis, but it mixes the aggregate diagnosis with the source
occurrence that produced it.

### ObservationSkillChain / SkillChainAdvisory

`ObservationSkillChain` is an evidence-oriented definition chain.

```text
ObservationSkillChain
├─ definition
│  ├─ found
│  ├─ path
│  └─ content
├─ healthCheck
│  ├─ hardRules declared / valid / errors / advisoryCode
│  └─ workflows declared / valid / errors / advisoryCode
└─ runtime
   ├─ hardRules: ObservationRuntimeCheck[]
   └─ workflowNodes: ObservationRuntimeCheck[]
```

`SkillChainAdvisory` is currently a small UI advisory dictionary:

```text
hardrules_not_declared
workflows_not_declared
skill_md_not_found
```

### ExperienceProblemPattern

`ExperienceProblemPattern` clusters repeated observe signals.

```text
ExperienceProblemPattern
├─ id
├─ bucket
├─ patternKey
├─ count
├─ sessionCount
├─ recentSessionIds
├─ signalTypes
├─ evidenceRefs
└─ lastSeen
```

It is already aggregated within observation, but it has no explicit audience,
severity, or action model.

### ExperienceReviewerReportFinding

Reviewer findings are session-level deterministic findings.

```text
ExperienceReviewerReportFinding
├─ id
├─ judgmentId
├─ source: deterministic_rule | llm_soft | manual
├─ level: attention | possible_false_positive | note
├─ title / body
├─ ruleSource
├─ ruleVersion
└─ evidenceRefs
```

They should not become one studio-level diagnosis per finding. They are
source occurrences that may aggregate into a diagnosis.

### SkillDerivedStandard

Soft standards are candidate standards extracted from SKILL.md and runtime
summary.

```text
SkillDerivedStandard
├─ id
├─ kind: hard_rule_candidate | workflow_candidate
├─ status: pending_review | author_confirmed | rejected | stale
├─ title / body
├─ source: llm_soft_standard
├─ confidence
└─ evidence[]
```

They are closer to a diagnosis candidate than a runtime problem: "this skill is
missing a standard declaration candidate".

## Target Abstraction

The shared layer has two levels.

```text
Diagnosis
└─ aggregate problem or candidate for a skill

DiagnosisOccurrence
└─ one source detecting or supporting that diagnosis
```

This split is required because the same issue can appear in doctor, eval, and
observe. Studio needs one aggregate row. Observation needs exact source
evidence.

### Diagnosis

First-version fields should be trimmed and explicit.

```text
Diagnosis
├─ id
├─ stableKey
├─ skillName
├─ type
├─ signal
├─ title
├─ summary?
├─ severity
├─ audience
├─ lifecycle
├─ scope
├─ occurrences[]
├─ occurrenceCount
├─ evidenceSummary?
├─ recommendation?
├─ patch?
└─ command?
```

Required fields:

```text
required
├─ stableKey
├─ skillName
├─ type
├─ signal
├─ title
├─ severity
├─ audience
├─ lifecycle
├─ scope
└─ occurrences
```

Optional fields are intentionally optional. They should not block producers
that only know facts but not repair actions.

### DiagnosisOccurrence

```text
DiagnosisOccurrence
├─ id
├─ diagnosisStableKey
├─ source
├─ sourceId
├─ sourceKind
├─ timestamp?
├─ severity?
├─ evidenceRefs[]
├─ rawRef?
├─ producer
└─ payload?
```

Occurrences are append-only source evidence. They should not own lifecycle.
Lifecycle belongs to the aggregate diagnosis.

## Field Definitions

### type

`type` is the broad diagnostic family. It replaces the ambiguous
`category / kind / signal` triple.

```text
type
├─ definition_gap
├─ runtime_issue
├─ user_feedback_pattern
├─ eval_failure
├─ sample_design_issue
├─ doctor_gap
├─ standard_candidate
└─ maintenance_issue
```

### signal

`signal` is the concrete trigger.

```text
examples
├─ hardrules_not_declared
├─ workflows_not_declared
├─ skill_md_not_found
├─ runtime_hardrule_attention
├─ runtime_workflow_attention
├─ user_correction
├─ negative_feedback
├─ user_interruption
├─ tool_failure
├─ final_delivery_absent
├─ environment_blocked_mocks
├─ failure_mode_skill
└─ soft_workflow_candidate
```

### scope

Scope should not be a flat six-way enum. Rule and workflow are not peers of
skill; they belong under a definition scope.

```text
scope
├─ primary: skill | definition | session | sample
└─ refs
   ├─ skillName
   ├─ sessionId?
   ├─ invocationId?
   ├─ sampleId?
   ├─ ruleId?
   ├─ workflowId?
   └─ sourceTrace?
```

### severity

Diagnosis severity should be normalized across sources.

```text
severity
├─ high
├─ medium
├─ low
└─ info
```

Mapping guidance:

```text
Insight.high                    -> high
Insight.medium                  -> medium
Insight.low                     -> low
runtime attention               -> medium by default
runtime manual_review           -> low by default
reviewer finding attention      -> medium by default
reviewer possible_false_positive -> low
reviewer note                   -> info
problem pattern sessionCount>=3 -> high
problem pattern sessionCount>=2 -> medium
problem pattern sessionCount=1  -> low
soft standard pending_review    -> low
soft standard author_confirmed  -> info or medium if missing frontmatter remains
```

### audience

```text
audience
├─ skill-author
├─ sample-author
├─ omk-maintainer
└─ reviewer
```

Default mappings:

```text
definition_gap                  -> skill-author
runtime_issue                   -> skill-author
user_feedback_pattern           -> skill-author
eval environment blocked mocks  -> sample-author
eval coverage gap               -> sample-author
doctor blindspot                -> omk-maintainer
manual review only              -> reviewer
```

### lifecycle

```text
lifecycle
├─ detected
├─ candidate
├─ confirmed
├─ rejected
├─ resolved
└─ stale
```

Lifecycle is attached to `stableKey`, not to source occurrence.

```text
rules
├─ new source occurrence on same stableKey inherits the current lifecycle
├─ rejected + new later occurrence should be shown as "re-detected"
├─ resolved + new later occurrence should reopen to detected unless manually pinned
└─ source occurrences remain immutable
```

## Stable Key

`stableKey` is the hardest part of the model. It decides whether multiple
sources refer to the same diagnosis.

Principle:

```text
DiagnosisOccurrence is source-local.
Diagnosis is cross-source aggregate.
```

Stable key format:

```text
skill:<skillName>
|type:<type>
|signal:<signal>
|target:<targetKey>
```

Target key examples:

```text
hardrules_not_declared
└─ target: definition:hardRules

workflows_not_declared
└─ target: definition:workflows

runtime_hardrule_attention
└─ target: rule:<ruleId>

runtime_workflow_attention
└─ target: workflow:<workflowId>

user_correction output_format
└─ target: pattern:output_format

final_delivery_absent
└─ target: session-pattern:final_delivery

environment_blocked_mocks
└─ target: eval:mock-coverage
```

Do not over-merge in version 1. Only merge sources into the same diagnosis
when the target key is explicit and stable.

## Mapping Table

### Insight -> Diagnosis / Occurrence

| Source field | Diagnosis field | Occurrence field | Notes |
| --- | --- | --- | --- |
| `Insight.id` | `signal` fallback, `stableKey` target | `sourceId` | Existing insights are already aggregate. |
| `category` | `type` + `signal` | `sourceKind` | Needs explicit mapping table. |
| `audience` | `audience` | - | Direct mapping. |
| `severity` | `severity` | `severity` | Direct mapping. |
| `title` | `title` | - | Direct mapping. |
| `description` | `summary` | - | Direct mapping. |
| `affectedCount` | `occurrenceCount` or `evidenceSummary` | - | Keep exact meaning source-specific. |
| `evidence[]` | `evidenceSummary` | `payload` | Insight evidence is not always trace-ref addressable. |
| `recommendations[]` | `recommendation` | - | Keep first/highest-priority as primary action. |
| `patch` | `patch` | - | Direct mapping if present. |
| `stageRefs` | `scope.refs` | `rawRef` | sample/rule refs become source refs. |

Granularity:

```text
one Insight
└─ one Diagnosis + one Insight occurrence
```

### SkillChainAdvisory -> Diagnosis / Occurrence

| Source | Diagnosis | Occurrence | Notes |
| --- | --- | --- | --- |
| `hardrules_not_declared` | `definition_gap / hardrules_not_declared` | source `skill_chain` | target `definition:hardRules` |
| `workflows_not_declared` | `definition_gap / workflows_not_declared` | source `skill_chain` | target `definition:workflows` |
| `skill_md_not_found` | `definition_gap / skill_md_not_found` | source `skill_chain` | target `definition:skill_md` |
| `message` | `summary` | `payload.message` | |
| `exampleYaml` | `patch` or `recommendation` | `payload.exampleYaml` | Patch target is SKILL.md frontmatter. |
| `commandTemplate` | `command` | - | |

Granularity:

```text
one advisory code per skill
└─ one Diagnosis
```

### ObservationRuntimeCheck -> Diagnosis / Occurrence

| Source field | Diagnosis field | Occurrence field | Notes |
| --- | --- | --- | --- |
| `kind=hardRule` | `type=runtime_issue` | `sourceKind=runtime_check` | Only `attention` and `manual_review` produce diagnostics. |
| `kind=workflowNode` | `type=runtime_issue` | `sourceKind=runtime_check` | Only `attention` and `manual_review` produce diagnostics. |
| `id` | `scope.refs.ruleId/workflowId` + targetKey | `sourceId` | |
| `title` | `title` | `payload.title` | |
| `expectation` | `summary` | `payload.expectation` | |
| `status` | `severity` | `severity` | passed does not create diagnosis. |
| `reason` | `summary` | `payload.reason` | |
| `evidenceSnippets` | `evidenceSummary` | `payload.evidenceSnippets` | Snippets are not enough; prefer evidenceRefs when available. |

Granularity:

```text
runtime check attention/manual_review
└─ one occurrence grouped by skill + check kind + check id
```

### ExperienceProblemPattern -> Diagnosis / Occurrence

| Source field | Diagnosis field | Occurrence field | Notes |
| --- | --- | --- | --- |
| `bucket` | `type` target family | `payload.bucket` | `output_format`, `workflow_mismatch`, etc. |
| `signalTypes[]` | `signal` primary or compound | `payload.signalTypes` | Use first/highest priority signal as primary. |
| `patternKey` | `stableKey.target` | `sourceId` | Already designed for grouping. |
| `count` | `occurrenceCount` | `payload.count` | |
| `sessionCount` | severity input | `payload.sessionCount` | |
| `recentSessionIds` | `scope.refs.sessionId[]` | `payload.recentSessionIds` | |
| `evidenceRefs` | evidence refs | `evidenceRefs` | Direct mapping. |
| `lastSeen` | - | `timestamp` | |

Granularity:

```text
one problem pattern per skill + bucket + patternKey
└─ one Diagnosis
   └─ occurrence contains recent evidence refs
```

### ExperienceReviewerReportFinding -> Diagnosis / Occurrence

Reviewer findings must not map one-to-one to studio diagnoses.

| Source field | Diagnosis field | Occurrence field | Notes |
| --- | --- | --- | --- |
| `id` | - | `sourceId` | Source-local occurrence id. |
| `judgmentId` | lifecycle review target | `payload.judgmentId` | Manual review may update aggregate lifecycle. |
| `source` | provenance | `producer` | deterministic_rule / llm_soft / manual |
| `level` | severity input | `severity` | |
| `title` | `title` fallback | `payload.title` | Aggregate title should be ruleSource-based. |
| `body` | `summary` fallback | `payload.body` | |
| `ruleSource` | `signal` | `sourceKind` | Primary grouping key. |
| `ruleVersion` | provenance | `payload.ruleVersion` | |
| `evidenceRefs` | evidence refs | `evidenceRefs` | Direct mapping. |

Granularity:

```text
one reviewer finding
└─ one DiagnosisOccurrence

aggregate Diagnosis
└─ grouped by skillName + ruleSource + targetKey
```

Grouping examples:

```text
final_delivery_absent
└─ Diagnosis: "multiple runs lack explicit final delivery"
   └─ occurrences: session-level findings

tool_error_recovery
└─ Diagnosis: "tool failure recovery needs review"
   └─ occurrences: session-level findings

no_priority_signal
└─ no Diagnosis by default
```

### SkillDerivedStandard -> Diagnosis / Occurrence

| Source field | Diagnosis field | Occurrence field | Notes |
| --- | --- | --- | --- |
| `id` | targetKey candidate id | `sourceId` | |
| `kind` | `type=standard_candidate`, `signal` | `sourceKind` | hard rule vs workflow candidate. |
| `status` | lifecycle | `payload.status` | pending_review -> candidate |
| `title` | `title` | `payload.title` | |
| `body` | `summary` | `payload.body` | |
| `source` | producer | `producer` | llm_soft_standard |
| `confidence` | confidence/evidenceSummary | `payload.confidence` | Not severity. |
| `evidence[]` | evidenceSummary | `payload.evidence` | Text evidence, not trace refs. |
| record `model/prompt` | provenance | `payload.model/promptVersion` | |

Granularity:

```text
one soft standard candidate
└─ one Diagnosis with lifecycle candidate/confirmed/rejected/stale
```

Default lifecycle decision:

```text
pending_review
└─ Diagnosis lifecycle: candidate
   └─ visible in review queues and definition-chain candidate UI

author_confirmed
└─ Diagnosis lifecycle: resolved
   ├─ not shown as an active studio problem by default
   ├─ still visible in definition-chain / standards view
   └─ feeds ResolvedSkillStandard as confirmed_soft

rejected
└─ Diagnosis lifecycle: rejected
   └─ hidden by default, preserved for audit and re-detection logic

stale
└─ Diagnosis lifecycle: stale
   └─ visible only where source freshness matters
```

Rationale:

```text
confirmed soft standard is no longer an active problem.
It is an accepted standard source.
```

If confirmed standards stay in the active Diagnosis list, studio will look like
it is still asking the author to fix something already accepted. If confirmed
standards disappear completely, users lose the explanation for why a soft
standard is now active. The split is therefore:

```text
Diagnosis list
└─ hides resolved confirmed standards by default

definition-chain / standards view
└─ shows confirmed standards as active standard sources
```

Boundary:

```text
Diagnosis
└─ owns lifecycle, provenance, and source linkage

standards view
└─ owns the product nudge to move confirmed_soft into SKILL.md frontmatter
```

The standards view should decide whether to show metrics such as unmaterialized
ratio or days since confirmation. That reminder mechanism is intentionally not
specified in the Diagnosis model.

## Conflict Table

| Existing concept | Conflict | Diagnosis decision |
| --- | --- | --- |
| Insight `category` vs problem `bucket` | Similar but not identical | Both map into `type`, original value kept in occurrence payload. |
| Insight `evidence` vs observe `evidenceRefs` | Insight evidence can be narrative only | Diagnosis supports evidence summary; occurrences keep raw payload. |
| Runtime `passed` | Not a problem | Do not emit Diagnosis. It can remain in skill-chain view. |
| Reviewer `note` | Often not actionable | Emit only if explicitly configured; default no studio diagnosis. |
| Soft standard `confidence` | Confidence is not severity | Keep confidence separate from severity. |
| Manual review state | Existing target ids differ | Lifecycle should key by diagnosis stableKey, with legacy target ids bridged during migration. |

## Migration Direction

Issue #103 completion scope:

```text
in scope for #103
├─ Phase 1: mapping and schema alignment
├─ Phase 2: observe diagnostics produce Diagnosis / Occurrence
└─ Phase 3: studio consumes Diagnosis with source coverage

follow-up after #103
└─ Phase 4: doctor / eval become native Diagnosis producers
```

Phase 1-3 are enough to resolve the issue's core mismatch: studio no longer
needs a separate diagnosis model for observation results, and observation does
not need to adopt studio's display format.

### Phase 1: Mapping Only

```text
do
├─ define this mapping
├─ validate each existing producer against Diagnosis / Occurrence
├─ identify missing fields and conflicts
└─ keep current implementation untouched

do not
├─ change report JSON
├─ change studio renderer
├─ change observe inbox renderer
└─ change CLI output
```

> **Note**: The original Phase 1 plan was to land mapping documentation alone. The actual
> first PR (this one) instead landed Phase 1 + 2 + 3 together — mapping doc, observe
> producer, and studio consumer in a single change — because (a) the mapping had already
> stabilized through earlier draft iterations, and (b) splitting into three PRs would
> double the rebase / review cost without surfacing additional schema conflicts. The
> guardrails below remain valid for any **future** mapping-only PR (e.g., if doctor or
> eval producers spawn a new mapping cycle); they do not describe the actual phasing of
> the first landing.

Phase 1 guardrails (apply only to a mapping-only PR):

```text
guardrails
├─ do not add a runtime `types.ts` for Diagnosis yet
├─ do not export a TypeScript schema yet
├─ do not write producer adapters yet
├─ do not change review-state target types yet
├─ do not add hidden dual-run output yet
└─ do not make studio or observe read Diagnosis yet
```

PR checklist for Phase 1:

```text
checklist
├─ [ ] This PR changes documentation / mapping only.
├─ [ ] This PR does not add Diagnosis runtime types.
├─ [ ] This PR does not change report JSON.
├─ [ ] This PR does not change CLI behavior.
├─ [ ] This PR does not change studio or observe UI.
└─ [ ] This PR lists unresolved mapping conflicts explicitly.
```

Reason:

```text
The mapping exercise is meant to expose schema conflicts before implementation.
Adding code in Phase 1 turns the mapping into an unvalidated commitment.
```

This guardrail applies to a Phase 1-only mapping PR. An implementation PR that
starts after the mapping is accepted should not claim to be mapping-only; it can
add runtime types and adapters, but producer selection must stay aligned with
the observe sources in this document.

### Phase 2: Observe Producer First

Observe is the best first migration candidate because it has the most
conflicting shapes.

```text
observe first
├─ skill-chain advisory -> Diagnosis
├─ runtime attention/manual_review -> DiagnosisOccurrence
├─ problem pattern -> Diagnosis
├─ reviewer finding -> DiagnosisOccurrence
└─ soft standard candidate -> Diagnosis
```

Phase 2 deliverable:

```text
observe diagnostic output
├─ emits Diagnosis[] for aggregate observe-level issues
├─ emits DiagnosisOccurrence[] for source-local evidence
├─ preserves existing observe report fields during migration
├─ does not remove skill-chain / problem-pattern / reviewer report fields
└─ records source coverage as observe=true, doctor=false, eval=false
```

Phase 2 producer boundary:

```text
allowed observe inputs
├─ skill-chain advisory
├─ runtime attention/manual_review checks
├─ problem patterns
├─ reviewer findings
└─ soft standard candidates

not allowed in this phase
├─ skill-health analysis reports
├─ eval report diagnostics
└─ doctor health diagnostics
```

Required observe mappings:

```text
required
├─ definition gaps
│  ├─ hardrules_not_declared
│  ├─ workflows_not_declared
│  └─ skill_md_not_found
│
├─ runtime checks
│  ├─ hardRule attention/manual_review
│  └─ workflowNode attention/manual_review
│
├─ repeated patterns
│  ├─ user_correction
│  ├─ negative_feedback
│  ├─ user_interruption
│  ├─ hard_rule
│  ├─ user_goal_shift
│  └─ tool_failure
│
├─ reviewer findings
│  ├─ final_delivery_absent
│  ├─ tool_error_recovery
│  ├─ user_correction
│  ├─ user_interruption
│  ├─ negative_feedback
│  └─ user_hard_rule
│
└─ soft standards
   ├─ hard_rule_candidate
   └─ workflow_candidate
```

Success criteria:

```text
success
├─ stableKey grouping works for repeated session findings
├─ reviewer findings do not explode studio rows
├─ definition gaps show as skill-level diagnostics
├─ soft standard lifecycle maps cleanly
└─ observe inbox can still show source-specific evidence
```

### Phase 3: Studio Data Projection

```text
studio
├─ shared projection groups Diagnosis by audience/source/severity
├─ projection exposes active count and source coverage
├─ Insight can later become a studio projection over Diagnosis
└─ old Insight remains as compatibility input during dual-run
```

Phase 3 deliverable:

```text
studio data consumption
├─ data layer returns observe-backed Diagnosis count
├─ data layer returns rows grouped by audience / source / severity
├─ rows keep evidence refs where available
├─ legacy Insight remains visible during dual-run
└─ source coverage is available wherever counts are later shown
```

Phase 3 UI boundary:

```text
current #103 data-layer implementation
├─ may add projection helpers and API-ready fields
├─ must not switch studio renderer yet
├─ must not change observe inbox renderer yet
└─ must label source coverage as partial while doctor/eval are not migrated
```

Studio projection rule:

```text
Diagnosis
├─ active lifecycle: detected / candidate / stale
│  └─ can appear in studio problem lists
│
├─ inactive lifecycle: resolved / rejected
│  └─ hidden by default from active problem lists
│
└─ occurrence evidence
   └─ shown as drill-down, not duplicated as separate studio rows
```

Issue #103 can be considered functionally resolved when Phase 3 is complete:

```text
done for #103
├─ observe diagnostics have a shared Diagnosis shape
├─ studio can consume those observe diagnostics
├─ studio clearly marks source coverage as partial
├─ old Insight and new Diagnosis can coexist during migration
└─ no observation UI model is directly imported into studio
```

Dual-run UI completeness risk:

```text
risk
├─ Phase 2 may migrate observe first
├─ Phase 3 may let studio consume Diagnosis
├─ Phase 4 doctor / eval may still be unmigrated
└─ studio could show Diagnosis as if it were complete
```

During dual-run, studio must show data coverage explicitly.

```text
studio completeness banner
├─ covered sources: observe
├─ not yet covered: doctor / eval
├─ diagnosis count is partial
└─ use legacy insight count until all configured sources are covered
```

Recommended display rule:

```text
if sourceCoverage is partial
├─ label counts as "partial diagnostics"
├─ show source coverage next to the count
├─ keep legacy Insight-derived counts visible or merged with provenance
└─ prevent users from reading the number as "all known problems"
```

### Phase 4: Doctor / Eval Producers Follow-up

Phase 4 is not required to close issue #103. It is the full-convergence step
after studio can already consume observe-backed Diagnosis.

```text
doctor / eval
├─ doctor rule failures produce DiagnosisOccurrences
├─ eval failure clusters produce Diagnosis
├─ mock/sample issues keep audience=sample-author
└─ omk-blindspots(internal) keep audience=omk-maintainer
```

## Open Questions

```text
open
├─ exact stableKey normalization for cross-source merge
├─ when rejected diagnostics should re-open
├─ whether reviewer note findings should ever surface in studio
└─ how much narrative evidence should be duplicated into Diagnosis vs raw payload
```

Resolved decisions from this draft:

```text
decisions
├─ confirmed soft standard
│  └─ lifecycle=resolved; active in standards view, hidden from active problem list by default
│
├─ Phase 1
│  └─ mapping-only; no runtime schema or implementation code
│
└─ dual-run UI
   └─ studio must show source coverage while Diagnosis coverage is partial
```
