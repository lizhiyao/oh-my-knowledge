---
description: Review knowledge against selected sources and separate semantic, entity, association and admission problems.
---

# Review knowledge quality

Use this guide when deciding whether generated knowledge should be retained, revised or used in a later task. See [accumulate, maintain, and use knowledge](extract-knowledge.md) for source selection and commands, and check its capability/version boundaries first. The `quality` projection's `semanticQuality: not_assessed` means the system has not performed semantic acceptance for you. Saving, quote matching and retention do not establish truth.

## 1. Fix the source and review scope {#scope}

Before generation, preserve the selected source snapshot, version, message or record range, and any missing, truncated or excluded material. Declare which insights, methods, conditions and reasons must be retained, what is optional, which equivalent expressions are allowed and which ambiguities must remain unknown. Set acceptable errors, omissions and correction burden for the intended use in advance.

For a comparison, also fix model, prompt/profile/wire identities, runtime configuration, invocation budget and stopping rules. Record whether windows share a conversation and whether reviewers have seen the sources or outputs. Keep checks discovered after output separate; do not change the original denominator or rescore old runs to manufacture improvement.

Information absent from the input is a source-coverage gap. Information present in the input but omitted from the generated body is an extraction omission. Do not ask the model to supply execution results or project facts that the source does not provide.

## 2. Review complete meaning, segment by segment {#body}

Read the complete body before returning to exact source evidence. Each segment should state the meaning needed for use independently. Titles, attached quotes, reuse rationale and entity catalogs cannot supply meaning missing from its text.

| Review area | Questions to answer |
|---|---|
| Insights, methods and reasons | Are the actual judgment and its basis retained? Are steps, adoption prerequisites and stopping conditions complete? |
| Conditions, exceptions and negation | Has scope expanded, a counterexample disappeared, or a statement of no necessity, no prohibition or no failure yet become a stronger claim? |
| Attribution, positions and state | Who proposed, opposed or accepted what? Are suggestions, plans, temporary handling and completed results distinct? |
| Time and change | Has source-message time become an unsupported fact time? Do corrections preserve relevant history, and are contradictions left unresolved without evidence? |
| Unknowns and evidence | Is a missing final result still unknown? Are source assertions, direct observations and inferences distinguished? |
| Subject and exact quotes | Does evidence support this claim and its subject rather than merely match the same name? Are important qualifications supported by actual sources? |

An assistant's success claim is not automatically a direct observation; source fidelity does not establish external truth. Record the exact knowledge revision/segment, source location, judgment and reason for each review. Leave unresolved judgments visible rather than counting them as passed.

## 3. Separate failure layers {#failure-layers}

| Layer | What to record and do |
|---|---|
| Body | Separate omissions, misunderstandings, unsupported additions and attribution/condition errors. Compare the native result with saved body content to identify the affected step. |
| Entities and associations | Review referents, mentions, catalog revisions and segment links. Equal names do not confirm identity, and a correct body does not validate an incorrect association. |
| Source location | Check the exact source version, contiguous quote and position. A matched location does not prove correct meaning; unavailable sources are not empty material. |
| Host admission | Inspect phases, rejection reasons and derived projection states. Workflow completion does not mean all projections succeeded. Count catalog rejection separately from semantic errors; cascading effects are not multiple independent causes. |

Saved bodies remain independently readable and maintainable when derived associations fail. A structurally available association can still be semantically wrong. Preserve empty output, non-generation, rejection, failure and unattempted records instead of counting only successful outputs.

## 4. Correct, save and reopen {#maintenance}

Body revision and entity/association correction use separate operations. Follow the [maintenance steps](extract-knowledge.md), read current heads and generations, preserve exact evidence and stable segment identities, and append revisions. Do not overwrite native results or historical decisions.

A new body revision returns to pending and does not inherit retention. After review, record a retain or discard decision for that exact revision with a reason. `reviewStatus` is separate from the maintenance decision; retention remains no truth certification. Associations for the old body digest become `stale` and require separate review or rebuilding rather than silently following the new body.

For entity or segment-association changes, check the source, exact catalog revision and projection generation before appending the relevant revisions. Reopen current results and history, confirming association operations did not rewrite the body. Accepting a projection does not confirm cross-window identity or external truth.

Bodies can cite multiple exact sources and remain maintainable. Current automatic association generation/rebuilding requires one exact readable source window. When a multi-source body cannot be rebuilt automatically, preserve its readable content and explicit association state; this does not deliver a multi-source graph. Distinguish actual support for tool traces, direct project files and other source inputs.

## 5. Record actual effort and review scope {#cost-and-review}

Preserve actual dispatch attempts, archived outcomes, phase durations, tokens and executor-reported cost. State whether input counts include caching. Keep missing dollar cost unknown rather than zero, and do not infer provider-internal request counts. Account separately for reading, source lookup, edits, review and coordination, recording actual actions and timing boundaries; leave unmeasured human effort explicitly unknown.

Identify reviewers, whether they are Agents, their role in generation or fixes, and what materials they have seen. Agent review and operations by developers familiar with the material do not replace independent human acceptance or new-user evaluation. Without the corresponding evidence, do not declare human Gold, blind-test acceptance or general accuracy.

Share source text, complete knowledge, native outcomes and private paths only with authorized reviewers. Public discussions should contain necessary sanitized problems, mechanisms, dispositions and evidence indexes without identifiable private material.

## 6. Decide whether to use, continue or stop {#decision}

| Decision | Evidence and next step |
|---|---|
| Use within the declared scope | Required knowledge has been reviewed, decision-relevant errors addressed and remaining correction burden meets the agreed limit. Preserve conditions, unknowns and missing independent acceptance. |
| Continue fixing | A traceable omission or error mechanism is identified. Preserve the failure, revise knowledge or propose an implementation change, then verify with a new identity and proportionate scope. Manually corrected content is not an original extraction success. |
| Stop expansion | Sources are insufficient, critical disagreement unresolved, execution or result state unknown, or errors and correction cost exceed the intended use's limits. Add evidence or record a disposition first. Inspect and recover existing unknown dispatch state rather than blindly resending. |

These decisions concern selected material and its current use; they do not automatically establish overall quality or task benefits. [#1388](https://github.com/lizhiyao/oh-my-knowledge/issues/1388) carries real-material development review and improvement records. Use the [study evidence inspection guide](verify-extraction-study.md) for historical frozen studies, preserving their original measurement identities and limits.
