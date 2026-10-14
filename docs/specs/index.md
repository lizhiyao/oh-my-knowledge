# Domain specifications

This directory specifies required behavior, invariants, data boundaries, and acceptance. Read [principles](../explanation/index.md) for concepts or start at [documentation](../README.md) for user tasks. Choose the affected domain; there is no need to read all of Core or historical RFCs first.

## Choose a domain

| Domain | What it specifies |
|---|---|
| [Shared naming and storage](shared/index.md) | Constrains cross-domain names, storage locations, and write boundaries. |
| [Entity identity and extraction](entities/index.md) | Specifies source objects, original mentions, correction, and extraction-quality acceptance. |
| [Knowledge construction and maintenance](knowledge/index.md) | Specifies consistency of content revisions, organization links, and carrier maintenance. |
| [Controlled evaluation](evaluation/index.md) | Specifies the measurement kernel, product wiring, evidence, and conclusions. |
| [Observation and review](observe/index.md) | Specifies signals and effective-review semantics derived from real records. |
| [Studio hosts and data flow](studio/index.md) | Specifies page hosts, queries, caching, and refresh. |

## Reading and maintenance boundaries

- Current specifications describe implemented rules; label undelivered capabilities separately rather than infer acceptance from a field or interface.
- Independent quality review, truth, and benefits require their own evidence; functional completion is no substitute.
- Current documentation retains only latest valid rules and necessary limits. Superseded proposals, designs and per-version trial diaries leave the site; necessary original evidence is traced through fixed Git revisions, issues or PRs.
- explanation, guides, and reference own concepts, user steps, and complete fields respectively. Link across responsibilities instead of creating duplicates.

English and Chinese sources mirror each other. Folders organize repository reading while current page URLs remain available. Reorganization does not turn history or frozen evidence into current capability promises.
