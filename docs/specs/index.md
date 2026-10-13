# Domain specifications {#design-specifications}

This directory specifies required behavior, invariants, data boundaries, and acceptance. Read [principles](../explanation/index.md) for concepts or start at [documentation](../README.md) for user tasks. Choose the affected domain; there is no need to read all of Core or historical RFCs first.

## Choose a domain

| Domain | What it specifies |
|---|---|
| <a id="shared-boundaries-·-shared"></a> [Shared naming and storage](shared/index.md) | Constrains cross-domain names, storage locations, and write boundaries. |
| <a id="entity-identity-and-extraction-·-entities"></a> [Entity identity and extraction](entities/index.md) | Specifies source objects, original mentions, correction, and extraction-quality acceptance. |
| <a id="knowledge-construction-and-maintenance-·-knowledge"></a> [Knowledge construction and maintenance](knowledge/index.md) | Specifies consistency of content revisions, organization links, and carrier maintenance. |
| <a id="controlled-evaluation-·-evaluation"></a> [Controlled evaluation](evaluation/index.md) | Specifies the measurement kernel, product wiring, evidence, and conclusions. |
| <a id="observation-signals-·-observe"></a> [Observation and review](observe/index.md) | Specifies signals and effective-review semantics derived from real records. |
| <a id="studio-hosts-and-reading-·-studio"></a> [Studio hosts and data flow](studio/index.md) | Specifies page hosts, queries, caching, and refresh. |

## Reading and maintenance boundaries

- Current specifications describe implemented rules; label undelivered capabilities separately rather than infer acceptance from a field or interface.
- Independent quality review, truth, and benefits require their own evidence; functional completion is no substitute.
- Historical designs, cases, and trials belong in the domain's history/ with their original versions and conclusions; current specifications link only necessary rationale.
- explanation, guides, and reference own concepts, user steps, and complete fields respectively. Link across responsibilities instead of creating duplicates.

English and Chinese sources mirror each other. Folders organize repository reading while existing site URLs and anchors remain available. Reorganization does not turn history or frozen evidence into current capability promises.

<a id="reading-order"></a>
<a id="status-and-authority"></a>
<a id="paths-and-references"></a>
