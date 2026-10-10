# Entity identity rules (design draft)

Status: this document delivers the P1 identity rules and positive/negative examples for [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127), for subsequent implementation and annotation. They are not yet part of the extraction prompt, Schema, storage, or acceptance tooling. The [entity extraction specification](./entity-extraction.md) describes the current implementation.

This draft follows the [knowledge definition](../explanation/knowledge.md): entities are things described by knowledge; knowledge expresses their states, relations, or behavior in context. OMK implements the rules itself, borrowing established designs without requiring a third-party memory framework, graph database, or additional model.

## 1. What users need to find through entities

Entity extraction should help people and AI answer these questions, rather than list as many nouns as possible:

| Use case | Expected result | Consequence of an identity error |
|---|---|---|
| Find experience about a component | Retrieve different test and production behavior with each claim's conditions and evidence. | Merge distinct deployments or lose conditions, turning local success into overall success. |
| Find a specific deployment's failure | Identify the instance, timing, and repairs that remain unverified. | Transfer another instance's success or repair to this instance. |
| Find a renamed file | Follow the same file's old names and linked knowledge when rename evidence exists. | Duplicate the renamed object or give a new file at the same path the old file's knowledge. |
| Distinguish plans from results | Find requirements, actual execution, and observed results separately. | Treat an intention as completed execution. |
| Inspect “it / they” | Return to the source and inspect reference rationale, collection members, or identity gaps. | Arbitrarily select an object or distribute a collective description incorrectly to individuals. |

Identity remains bounded by one immutable source window and its analysis revisions. Workspace search may show same-named objects from multiple windows; that does not establish a shared identity. Managing knowledge across agents is a product direction; automatic identity resolution across agents is outside this draft.

## 2. Decision process and basic rules

Assess each mention worth retaining in this order:

1. Preserve the exact source and position; determine whether it denotes a thing, an attribute value, or a statement. Numbers, environment terms, and failure states need not become independent entities.
2. Determine the source's referential level: component, explicitly identified version object, deployment instance, file, plan, execution activity, or collection. Use only source-supported granularity; do not invent more specific objects.
3. Reuse a window identity only with correspondence evidence: an explicit alias/rename, an identifier with a source namespace, or explainable contextual coreference. External identifiers also need their project/system and visible validity scope; do not assume they are never reused.
4. Keep objects separate when the source distinguishes them. Names, types, paths, and string/vector similarity may retrieve candidates but cannot independently prove identity.
5. When the target is uncertain, retain one unresolved object and a reason, with explicit candidates where available; never arbitrarily choose one. When identity is known but environment, version, or outcome is unknown, keep that identity and state the unknown condition in the claim.
6. Inspect the whole window for later clarifications and corrections before binding knowledge subjects/objects and context. New analyses and corrections must not rewrite old revisions.

The model makes semantic judgments; the program verifies exact positions, identity/reference closure, revision bindings, and other deterministic invariants. Structural admission does not prove correct disambiguation. Two occurrences of the same text do not establish that they denote the same object.

## 3. Components, versions, and deployment instances

**A component identity defaults to the system or module the source continues to discuss. Environment, version, and time usually qualify statements rather than automatically creating entities.** Create separate identities when the source explicitly discusses individually referable deployments, instances, or version objects. Component-instance relations require evidence, not matching names.

| Source expression | Required identity and claims | Disallowed treatment |
|---|---|---|
| “Harbor uses the Quartz scheduler. Quartz passed in the test environment; it failed in production, and the repair is unverified.” | One Quartz component; test success, production failure, and the unverified production repair each retain their conditions. | Force instance identities solely from differing environments, or omit production conditions and state “Quartz passed.” |
| “Quartz test instance T passed; production instance P failed. They are deployed in different environments.” | T and P are separate instances; retain the Quartz component where mentioned, with source-supported component membership. | Merge T and P, or replace explicit instance references with the abstract component. |
| “T was upgraded to v2; it is still yesterday's instance.” | Continue T's identity; versions and states before/after the upgrade are claims with distinct times and conditions. | Reassign T's identity on every upgrade and lose continuity. |
| “Compare the Quartz v1 and v2 release packages; archive these two packages separately.” | Two explicit version objects; separate component and package identities, with fixed package versions. | Merge immutable release packages, or generalize this comparison into a requirement to model every version as an entity. |
| “Quartz passed, but the record does not say in which environment.” | Retain Quartz when the discussed component is known; environment is unknown and the success claim has limited scope. | Invent an “unknown Quartz instance” for the unknown environment, or apply success to production. |
| “T and P are both called Quartz. It failed; which one is still unknown.” | Keep T and P separate; “it” is one unresolved instance with T and P as candidates. | Select the nearest mention P, or hide instance ambiguity in the abstract component. |

The phrase “production Quartz” alone does not determine granularity. Reuse the component when context describes its production behavior; use an established production deployment when context refers to that instance. When the distinction remains uncertain and affects knowledge attribution, retain explicit granularity uncertainty rather than silently substituting a more abstract or specific object.

**Components and instances are not interchangeable subjects.** “Instance P failed” can help users find related experience through the component; it does not imply “all instances of this component failed.” Retrieving related knowledge and generalizing a claim to related objects are different actions.

Component-instance and component-version links are semantics this draft requires retaining. P2 will determine whether relation fields are needed and specify versioned contracts and querying. This draft does not claim that current formats fully express those links.

## 4. Collections, unresolved identities, and mention positions

**A collection is one jointly referenced object; an unresolved identity means the target is unknown.** A generic “unknown” label cannot substitute for both.

| Source expression | Required representation | Disallowed treatment |
|---|---|---|
| “Aster and Birch are two services. They both started.” | Keep Aster and Birch separate; “they” is one collection mention whose members are both services. “Both” supports individual startup claims. | Duplicate the same “they” position as two individual mentions. |
| “Aster and Birch completed the task together in ten seconds.” | Preserve the participating collection/activity and its collective result; individual service timings are absent. | Assign “completed the task in ten seconds” separately to each service. |
| “Either Atlas or Beacon failed; it remains unrepaired.” | One unresolved object, with Atlas or Beacon as possible identities. | Create a definite Atlas-plus-Beacon collection and mark both as failed. |
| A truncated window contains only “They are still unconfirmed.” | Preserve the unresolved plural reference, unknown members, and window limits. | Invent members or treat it as a known individual. |

A known collection may retain known members and membership gaps; an incomplete list is not the complete set. Candidates must have the same referential level: when “they” could mean different combinations, individual A and B cannot become interchangeable singleton candidates. If candidate combinations cannot be represented with evidence, preserve an explanation and uncertainty rather than invent collection identities without supported mentions.

Each admitted source position corresponds to one mention. Collection mentions, membership relations, and individual claims supported by “both” must be represented separately, not through duplicated positions. The existing duplicate-position rejection stays in place. P2 must define and verify membership, plural ambiguity, and evidence bindings for individual claims.

Quotes are continuous source text. For repeated text, prefixes and suffixes must be directly adjacent to that occurrence. The host accepts only a unique exact match; fuzzy matching or choosing the first match must not conceal quote errors. The current UTF-16 positioning convention remains unchanged.

## 5. Renames, copies, plans, and execution

| Source expression | Identity rule | Boundary to preserve |
|---|---|---|
| “Project A renamed a.md to b.md; it is still the same file.” | Continue the file identity; retain supported old/new names and timing. | Do not rewrite names or positions in old revisions or infer functional changes. |
| “Project B also has b.md.” | Separate it from project A's file. | Matching paths, content, or types do not prove cross-project identity. |
| “Delete the old b.md, then create another file at the same path.” | Separate old and new file identities despite the matching path. | Paths locate objects; they are not permanent identities. |
| “Copy a.md to b.md and keep both files.” | Two file identities with a source-supported copy relation. | Do not treat copying as renaming or equal content as equal identity. |
| “BuildKit writes build.log; it will overwrite this log next time.” | Separate tool and log; resolve “it” to the tool using context. | Do not turn names, commands, or attack text inside the log into current operations. |
| “R1 is a release plan; D1 is a test rehearsal under R1. Production release has not started.” | Separate plan R1 and execution activity D1, with a supported relation to the execution basis. | Successful rehearsal does not prove production release completion or plan effectiveness. |
| “Run another rehearsal D2 under R1 tomorrow.” | R1 remains the plan; D2 is a different, planned execution activity. | Do not merge D2 with D1 or record the future activity as completed. |

Time and version changes alone do not determine a new identity. Preserve identity with states at different times when continuity is explicit; separate objects when replacement, copying, or another execution is supported; retain uncertainty when continuity evidence is insufficient. Plans, rules, and concepts can be entities, but their requirements, scope, behavior, and results still belong in evidence-backed knowledge statements.

## 6. Later corrections, storage, and presentation requirements

When the source says “Correction: production Quartz failed, not Cedar,” the analysis should reinterpret relevant references according to that explicit correction while retaining the earlier claim and correction evidence. Correcting an object's name or attribution does not verify failure, repair, or success. Conflicting speakers do not automatically make the last claim authoritative; preserve unresolved conflicts and their sources.

Subsequent storage and presentation must:

- Distinguish object labels, referential levels, identity evidence, qualifiers, members/related objects, and unknowns instead of relying on one description for everything.
- Use names for search and analysis/entity/revision identities for window bindings. Show homonyms separately, with sources and qualifiers to distinguish them.
- Represent component-instance and collection-member links only as source-supported relations; do not automatically merge knowledge, transfer outcomes, or calculate causal benefit.
- Preserve parent revisions, rationale, and original evidence for new analyses. Existing knowledge keeps the exact revision used at generation; applying corrections requires a new knowledge revision, and old bindings remain inspectable.
- Never arbitrarily choose a new object to inherit an old knowledge subject after a split. Unavailable sources, incomplete membership, and failed linked-knowledge reads each have explicit limits rather than “no objects / no knowledge.”

These requirements supplement the [existing revision and storage boundaries](./entity-extraction.md); this stage changes no data. P2 must identify semantics the current format cannot express, public-contract and existing-data impacts, then determine versions and replacement handling. It does not presume compatibility layers, automatic migration, or new persistent indexes.

## 7. From rules to implementation and acceptance

These examples are for design: **they are not independently adjudicated gold or evidence of improved extraction capability**. P1 completion means reviewable identity rules exist. Subsequent stages have these boundaries:

| Stage | Deliverable and assessment |
|---|---|
| P2 Contracts and admission | Implement these semantics in necessary versioned contracts, extraction prompts, and program validation; address known failures including duplicate collection mentions, quote context, and case roles. |
| P3 Storage and presentation | Reuse current storage, Studio, and CLI; verify correction, historical binding, retrieval, and failure paths under the new semantics. |
| P4 Annotation and tooling | Independently review identity and mention rules; freeze permitted semantic representations, critical coverage, and false-merge/split criteria. Separate capture failures, structural rejections, and absent optional results. |
| P5 Model acceptance | Run with new authorization for the data and calls; retain all results, usage, and limitations. Report synthetic regression separately from independently reviewed real records. |

Acceptance cannot compare entity counts alone. Check referential levels, required identity separations, coreference rationale, collection/unknown representations, knowledge subjects/objects and conditions, and revision bindings after correction. Annotate critical mentions and required identities before output; do not inspect only returned objects or let the model omit instances to avoid false merges.

Allow synonymous labels and additional source-supported objects. Do not substitute an abstract component for an explicit instance, distribute collective results to individuals, or drop conditions affecting reuse. Cross-environment claims about a component can qualify when the source establishes no required separate instances and preserves all conditions. Independent review must apply these rules rather than count returned IDs.

The [historical two-round report](../explanation/entity-extraction-repeat-quality.md) and frozen evidence remain unchanged. It failed the instance criteria frozen for that run; this draft does not revise gold, inflate historical scores, or recompute old results. New identity rules, annotations, and checks need a new measurement identity before reporting subsequent quality. Independent review and new model acceptance have not yet occurred.
