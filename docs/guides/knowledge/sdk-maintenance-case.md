---
description: Review accumulated knowledge, historical revisions, change notices, and precise artifact references with the existing SDK case.
---
# SDK case: review artifacts when their knowledge changes

This frozen case demonstrates maintenance behavior accepted on 2026-10-14: associate later sources, limit old statements to their historical context, revise or discard knowledge, then review and update an artifact. It uses the existing sentry-miniapp SDK materials. The OMK implementation at that time read an independent copy, and Studio opened v4 and v5 for review.

The screenshots and v4/v5 identities belong to that earlier knowledge contract. The current canonical-body reader does not read an old workspace in place. Follow the [knowledge maintenance workflow](extract-knowledge.md) to migrate explicitly into a new directory, review the new pending bodies, and make new retain decisions. Old artifact and library references are archived rather than automatically redirected. These frozen identities and screenshots do not prove that the current body workflow has been verified; a package version number alone does not establish data compatibility.

For first use, create your own workspace with the [knowledge maintenance workflow](extract-knowledge.md). This page explains concrete results; it requires neither installing the SDK nor calling a model.

## Materials and scope

- The object is this project’s `@sentry/core` component. A version is an observation condition and does not automatically become a separate component identity.
- Historical windows discuss protected overrides and Session isolation. Old statements remain historical records and cannot establish unresolved problems today.
- Later observations froze [SDK source 30ffb003](https://github.com/lizhiyao/sentry-miniapp/commit/30ffb0030376e63a943f5d69beced539c7810171), recording the `@sentry/core 11.6.0` dependency, source seams, and test source. These are manually curated static materials; no dynamic SDK tests ran.
- See [#1166](https://github.com/lizhiyao/oh-my-knowledge/issues/1166) for maintenance acceptance and [#1168](https://github.com/lizhiyao/oh-my-knowledge/issues/1168) for change notices and update review. Reading the independent copy preserved the original 27 files and made no new model calls.

## From sources to a new artifact

| Stage | Actual change in this case | What to review |
|---|---|---|
| Accumulation | After explicit human confirmation, the core object’s source-window members grew from two to three. | Sources and object meaning; matching names do not merge automatically. |
| Historical revision | Old correction requirements gained historical conditions; new revisions received new retain decisions. | Original text, conditions, unknowns, and reasons. |
| Stop carrying a statement | The historical public-interface-gap statement, with an unknown source version, was discarded. | Keep its history while excluding it from the currently used artifact. |
| Clarify a condition | Static knowledge explicitly states that it proves source presence, not dynamic test success. | Saving test source is different from running it successfully. |
| Change notice | Historical v4 still references three items; two require review. | Current revisions and retain decisions; notices do not determine truth or semantic expiry. |
| Explicit update | v5 selects two currently retained items: keep one, replace one, remove one. | Reference changes, content, exact revisions, and dependency assets. |
| Historical reading | v4 content and three references remain readable; v5 detects zero reference changes. | No reference changes does not establish correctness or effectiveness. |

## Check the exact references

The [frozen readback record](../../public/sdk-maintenance-evidence.json) records the observation time, OMK runtime commit, artifact identity, and full revision identities for v4 and v5. It also records source availability and the object's historical member counts (2 → 1 → 2 → 3); the temporary removal and re-association are retained, followed by a third source window.

| Knowledge | Historical v4 | Current v5 |
|---|---|---|
| Historical protected-override and Session review | Revision `1009571e` retained | Same exact revision kept |
| Historical public-interface-gap statement | Revision `6bce64dd` referenced | Explicitly removed after discard |
| core 11.6.0 static seam snapshot | Revision `7113ba63` referenced | Replaced with `6f23942d`, limiting the claim to source presence |

These are frozen case facts, not live SDK status. The record omits local workspace paths and raw conversations; linked acceptance issues own provenance and limitations. Use full identities from the JSON when checking the underlying material, rather than matching titles alone.

## Historical Studio review

The following steps record the 2026-10-14 acceptance under the earlier contract. They do not replay those identities in a newly migrated workspace; review new bodies and create new artifacts explicitly there.

1. Open the knowledge library, inspect an object’s source members, then follow an item back to its original text. Review candidate conditions and evidence before retaining or discarding it with a reason.
2. Open the saved artifact, choose historical v4, and open “Review changes”. Its two notices come from a knowledge revision and an item that is no longer retained.
3. Expand a change, compare “Incorporated revision” with “Current knowledge revision”, and inspect titles, statements, and conditions. Follow references to the corresponding knowledge detail.
4. Return to the current version, choose “Generate new version”, review the kept, replaced, and removed references, then save explicitly. Only the selected knowledge region is rebuilt; manual content and dependency assets remain.
5. Reload the latest artifact and inspect content and “Knowledge references”. Switch back to the historical version to verify readability. Enter evaluation from an explicit version only when task-effect evidence is needed.

![SDK v4 change review under the historical 2026-10-14 knowledge contract](../../public/sdk-maintenance-review.png)

The screenshot records the real reader used for that Chinese case, comparing its historical references with the then-current knowledge. It is neither a new model extraction result nor acceptance of the current canonical-body contract. Its versions and timestamps belong to the frozen case.

When sources are missing, reads fail, or a file changes externally, inspect the notice and reload. A failure is not evidence of no changes. Checks cover knowledge referenced by this version and exclude unreferenced new items. See the [maintenance contracts](../../specs/knowledge/knowledge-maintenance.md) for complete behavior boundaries.

## What this evidence supports

A traceable maintenance and revision path: v4 keeps its three historical references; v5 references only the two selected current revisions, with content matching the saved manifest.

It does not establish correct dynamic SDK behavior after an upgrade, time saved, automatic cross-agent reuse, or each item’s independent contribution. It uses previously exposed materials and author review; a recorded manual-curation adapter is not automatic extraction success. [Knowledge-benefit research](https://github.com/lizhiyao/oh-my-knowledge/issues/1115) continues to track actual use and benefits separately.
