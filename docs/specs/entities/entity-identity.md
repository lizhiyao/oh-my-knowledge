# Entity identity rules

This specification owns source-supported identity rules and examples. The [entity extraction specification](./entity-extraction.md) owns current execution and storage contracts; the [evaluation protocol](./entity-extraction-evaluation.md) alone owns quality versions, measured scope and readiness. The [construction design](../knowledge/knowledge-domain-model.md) connects window identities to cross-window review and knowledge maintenance.

This specification follows the [knowledge definition](../../explanation/knowledge.md): entities are things described by knowledge; knowledge expresses their states, relations, or behavior in context. OMK implements the rules itself, borrowing established designs without requiring a third-party memory framework, graph database, or additional model.

The linked knowledge principles own object meaning, entities, and statement roles. This page concentrates on source-supported granularity, coreference, ambiguity, and reference rules.

## 1. What users need to find through entities

Entity extraction should help people and AI answer these questions, rather than list as many nouns as possible:

| Use case | Expected result | Consequence of an identity error |
|---|---|---|
| Find experience about a component | Retrieve different test and production behavior with each claim's conditions and evidence. | Merge distinct deployments or lose conditions, turning local success into overall success. |
| Find a specific deployment's failure | Identify the instance, timing, and repairs that remain unverified. | Transfer another instance's success or repair to this instance. |
| Find a renamed file | Follow the same file's old names and linked knowledge when rename evidence exists. | Duplicate the renamed object or give a new file at the same path the old file's knowledge. |
| Distinguish plans from results | Find requirements, actual execution, and observed results separately. | Treat an intention as completed execution. |
| Inspect “it / they” | Return to the source and inspect reference rationale, collection members, or identity gaps. | Arbitrarily select an object or distribute a collective description incorrectly to individuals. |

Identity remains bounded by one immutable source window and its analysis revisions. Workspace search may show same-named objects from multiple windows; that does not establish a shared identity. Human-confirmed [library organization](../knowledge/knowledge-library.md) references those identities without replacing them. Automatic cross-Agent disambiguation is outside this specification.

## 2. Decision process and basic rules

Assess each mention worth retaining in this order:

1. Preserve the exact source and position; determine whether it denotes a thing, an attribute value, or a statement. Numbers, environment terms, and failure states need not become independent entities.
2. Determine the source's referential level: component, explicitly identified version object, deployment instance, file, plan, execution activity, or collection. Use only source-supported granularity; do not invent more specific objects.
3. Reuse a window identity only with correspondence evidence: an explicit alias/rename, an identifier with a source namespace, or explainable contextual coreference. External identifiers also need their project/system and visible validity scope; do not assume they are never reused.
4. Keep objects separate when the source distinguishes them. Names, types, paths, and string/vector similarity may retrieve candidates but cannot independently prove identity.
5. When the target is uncertain, retain one unresolved object and a reason, with explicit candidates where available; never arbitrarily choose one. When identity is known but environment, version, or outcome is unknown, keep that identity and state the unknown condition in the claim.
6. Inspect the whole window for later clarifications and corrections before binding knowledge subjects/objects and context. New analyses and corrections must not rewrite old revisions.

The model makes semantic judgments; the program verifies exact positions, identity/reference closure, revision bindings, and other deterministic invariants. Structural admission does not prove correct disambiguation. Two occurrences of the same text do not establish that they denote the same object.

### 2.1 Granularity of things, properties, and processes

**First preserve the things knowledge discusses; properties, states, and behavior default to knowledge statements about those things.** A property or process can also be an entity when the source discusses it as an independently referable object to define, compare, or associate with knowledge. A noun, compound phrase, value, or verb alone does not establish an independent identity.

Use how the source discusses the object: whether it provides the object's own definition, distinctions, relations, rules, or activity boundaries, and whether different mentions continue to refer to it. Proper names, identifiers, repetition, and existing knowledge candidates are not required; ordinary concepts can qualify. A possible need to search for a term does not justify inventing an object absent from the source. Finding properties or behavior through knowledge statements does not require an entity for each.

| Source expression | Objects and knowledge to retain | Disallowed treatment |
|---|---|---|
| “Session is an attribution concept across asynchronous events. Session counts increase only on initialization; Session state updates do not add counts.” | Retain the Session concept; express counting rules and update behavior as separate statements about Session, preserving polarity. Separate count and state-update identities are not required here. | Extract only counts/updates and omit Session, or force three entities from three nouns. |
| “The total-session metric S_total differs from the active-session metric S_active. S_total is calculated from initialization records, and alert rule R uses it.” | The source independently defines and distinguishes two metrics; retain the metrics and rule R, with the source-supported relation between rule and metric. | Collapse the metrics into one Session property and lose their definitions or rule attribution. |
| “State update is an operation in the lifecycle; it differs from initialization and can recur.” | The source discusses state update as an independent operation concept; retain it and the initialization concept. Statements still express their differences and behavior. | Exclude abstract concepts without proper names, or represent a general operation concept as one completed activity. |
| “Yesterday's update activity U1 failed; U2 is planned for today.” | U1 and U2 are separately referenced activities; express failure and planned status separately. | Merge the activities or mark U2 as executed. |
| “This keyboard weighs 800 grams; the apple costs 5 yuan.” | Retain the keyboard and the apple in source context; weight, price, and values are statements rather than independent objects on that basis. | Create entities for every property value, or infer an apple brand/variety from price. |
| “This round checks only Session attribution adaptation; the result remains unconfirmed.” | The source explicitly scopes a check object; retain Session attribution adaptation and the discussed Session concept. Check scope and unconfirmed outcome are statements. | Treat the check object's existence as successful adaptation, or mechanically split every product name containing Session. |

This rule determines the need for independent identities; it does not remove source text, conditions, or knowledge statements. Source-supported objects may remain without knowledge candidates. Preserve uncertainty when attribution is unclear, rather than hide ambiguity to reduce entity counts. A specific activity can have identity before execution; source-backed statements distinguish plans from occurrences.

These rules do not establish model quality acceptance. Freeze new annotations before outputs; viewed output windows serve only as development regressions. Rule changes never rewrite original outputs, annotations or scores.

### 2.2 Configuration points and associated knowledge retention

**Configuration values normally belong in knowledge about an object; strings, booleans, and numbers do not automatically become entities.** A field independently discussed for its purpose, value, or suitability may retain an identity. Background configuration does not require an entity or knowledge candidate for every item. A value independently defined, compared, or repeatedly discussed as a state concept is assessed under section 2.1.

When selecting knowledge about a configuration point, retain any value or qualifier whose removal would change the source judgment or prevent reuse of the setting in the corresponding knowledge statements:

- The object or field, exact value, and source-supported owner/environment/version scope; do not change code literal case or type.
- Source purpose, constraints, or reasoning, plus conditions, exceptions, and unknowns affecting reuse; do not invent mechanisms where reasoning is absent.
- Original evidence and the limits of the source assertion; a judgment of suitability does not establish tool verification or universal validity.

A field subject can state “configuration value is `unhandled`,” with its client and scope in context. Without a separate field identity, an existing owner can be the subject with the field name and value stated explicitly. Do not invent an entity when ownership is unknown. `description` and `qualifiers` aid identification but do not replace substantive knowledge statements; locating the field name or returning to the source does not establish retention of the configuration fact in derived knowledge.

These are synthetic examples, not new frozen annotation answers:

| Source expression | Objects and knowledge to retain | Handling to reject |
|---|---|---|
| “Client L's `errorStatus = 'unhandled'` is appropriate because unhandled exceptions in this host do not imply process crashes.” | When selecting this judgment, retain the field, exact value, owner, host scope, and source reasoning; without tool evidence it remains a source assertion. | Only stating “configuration is appropriate” or retaining the field entity alone; inventing other hosts' behavior from the field name. |
| “Client L's `errorStatus` is `'unhandled'`; client M's same-named field is `'fatal'`.” | Associate each field/value with its owner; independently discussed field identities cannot be merged. | Merging by name and assigning one client's value to the other. |
| “The same service's `enabled` is boolean `false` in test and string `'false'` in production.” | Retain types and environments; environment differences do not automatically split the field identity. | Rewriting both as “disabled” or inferring runtime effects absent from the source. |
| Background configuration lists several fields; this window only discusses deployment failure and requires no complete configuration summary. | Deployment knowledge may suffice; unselected configuration knowledge is not observed. | Creating entities for every key/value or inferring complete configuration knowledge from entity coverage. |
| Before output, “cover L's configuration value and reasoning” was frozen as mandatory; output contains only the field entity and no related knowledge candidate. | Entity extraction succeeded, but mandatory knowledge coverage is unmet. | Treating structurally allowed empty knowledge as coverage success or adding mandatory facts after seeing output. |

Distinguish three outcomes: related generated knowledge missing a critical value is information loss; unselected optional configuration knowledge is not observed; an absent predeclared mandatory fact is a knowledge coverage gap. None automatically means entity omission. Freeze mandatory facts, equivalent expressions, and scope before output; programs do not complete facts through field-keyword rules.

Evaluate configuration knowledge completeness separately from entity existence; these synthetic examples do not establish model quality acceptance.

### 2.3 Mention boundaries: complete names and property ownership

**A mention must denote its bound thing; minimizing character count is not the goal.** Complete names or qualified descriptions that independently denote the same object can remain. Properties, results or whole statements do not become aliases merely by containing the object's name.

| Source expression | Allowed mention boundary | Avoid |
|---|---|---|
| “当前 main 的被测代码与已发布 r2 均通过。” | The current code state can use “当前 main” or “当前 main 的被测代码”; identity still depends on the whole source. | Rejecting a complete description for being longer, or treating the entire sentence as a version name. |
| “服务 S 的 enabled 字段在测试环境为布尔值 false。” | The field can use “enabled” or “enabled 字段”; value, type and environment belong in knowledge statements. | Stripping every “字段” suffix mechanically, or using the entire assignment statement as a field name. |
| “main 上的改造还未发布。” | Select “main” for the code-state mention; the change and unreleased status form knowledge about that state. | Treating the whole property phrase “main 上的改造” as a code-state alias. |
| “这把键盘的重量为 800 克。” | Select “这把键盘” for the keyboard; weight and value belong in its statement. | Binding the whole weight phrase as the keyboard's name. |

Distinguish complete descriptions from property ownership semantically, without mechanically cutting at “的” or “上的”. Properties meeting section 2.1's independent-discussion criteria may have their own identities; qualifiers may also be essential parts of names. Inspect source location, bound identity and statement scope separately. When narrowing to a repeated short name, recompute occurrence instead of copying the unique longer phrase's index.

**Matching characters inside an identifier do not establish a mention of that concept.** In “_pendingTaskStatus；固定 Task；迟到事件不影响新 Task”, concept mentions have occurrence 1 and 2; occurrence 0 is inside the field. Indices still count every exact match, without skipping fields, renumbering or moving to the next match. The field may use its full identifier; statement citations may include it. Each `rationale` explains the selected occurrence, not another same-named occurrence such as the final sentence instead of a table row. Two occurrences require separate mentions.

New generation and correction reject `mention_identifier_fragment` when a mention cuts an ASCII letter/digit identifier, which may contain internal `_`/`$`. Standalone Markdown wrappers, adjacent Chinese text and punctuation are not rejected for that reason; whole identifiers remain admissible. This lexical check does not verify Chinese segmentation, same-name meanings, rationales or every language's identifier syntax. Position `matched` still means exact source text only. Existing revisions are not rechecked or rewritten; statement citations do not use this mention constraint.

Evaluation exactly matches equivalent boundaries declared before outputs. A longer quotation containing a short name supplies review cues, never automatic trimming, completion or keyword/regex-based meaning judgments. Offline replay demonstrates matching/admission, not improved model choices.

### 2.4 Issue/PR concepts and individual work records

**Issue and PR can be entities when the source independently discusses their concepts or mechanisms; individual numbered Issues and PRs remain source-side work records and do not receive standalone entity identities.** A record's number, link, title, or status is not a reason to create an entity. Retain relevant identifiers, links, and states in source citations or case context, preserving who reported them and whether they were verified.

| Source expression | Objects and knowledge to retain | Disallowed treatment |
|---|---|---|
| “An Issue tracks a problem; a PR submits changes for review. These mechanisms have different responsibilities.” | Retain Issue and PR concepts when the source independently discusses them; express their responsibilities as knowledge. | Exclude those concepts merely because individual numbered work records are outside entity scope. |
| “Issue #42 was created; PR #73 was merged.” | Retain the record identifiers and reported states in source evidence or case context; bind useful knowledge to an existing source-supported subject where appropriate. | Create standalone Issue #42 / PR #73 entities, or strip their numbers and invent Issue / PR concepts that the source did not independently discuss. |

This is a narrow output-scope rule for these work records, not a ban on specific objects or all instances. Source-supported files, deployments, version artifacts, plans, and activities continue to follow their respective identity rules. Do not generalize a work-record title into a new concept merely to replace an excluded record; if the source provides no supported knowledge subject, do not invent one.

## 3. Components, versions, and deployment instances

**A component identity defaults to the system or module the source continues to discuss. Environment, version, and time usually qualify statements rather than automatically creating entities.** Create separate identities when the source explicitly discusses individually referable deployments, instances, or version objects. Component-instance relations require evidence, not matching names.

Architectural responsibilities in the source can support component identity without the literal words “persistent system/module”: a library continuously overridden/upgraded, or a class implementing client adaptation through inheritance and method overrides, can have `component` evidence. A class name, function name, single call or failure alone is insufficient. Retain a persistent library separately from independently discussed version objects. Where a component name independently denotes that library within a version phrase, its short span may overlap the complete version span without copying an identical position. `componentRef` uses an existing component and source mentions; do not infer an undiscussed library from a version name or create objects for ordinary version conditions.

| Source expression | Required identity and claims | Disallowed treatment |
|---|---|---|
| “Harbor uses the Quartz scheduler. Quartz passed in the test environment; it failed in production, and the repair is unverified.” | One Quartz component; test success, production failure, and the unverified production repair each retain their conditions. | Force instance identities solely from differing environments, or omit production conditions and state “Quartz passed.” |
| “Quartz test instance T passed; production instance P failed. They are deployed in different environments.” | T and P are separate instances; retain the Quartz component where mentioned, with source-supported component membership. | Merge T and P, or replace explicit instance references with the abstract component. |
| “T was upgraded to v2; it is still yesterday's instance.” | Continue T's identity; versions and states before/after the upgrade are claims with distinct times and conditions. | Reassign T's identity on every upgrade and lose continuity. |
| “Compare the Quartz v1 and v2 release packages; archive these two packages separately.” | Two explicit version objects; separate component and package identities, with fixed package versions. | Merge immutable release packages, or generalize this comparison into a requirement to model every version as an entity. |
| “Quartz passed, but the record does not say in which environment.” | Retain Quartz when the discussed component is known; environment is unknown and the success claim has limited scope. | Invent an “unknown Quartz instance” for the unknown environment, or apply success to production. |
| “T and P are both called Quartz. It failed; which one is still unknown.” | Keep T and P separate; “it” is one unresolved instance with T and P as candidates. | Select the nearest mention P, or hide instance ambiguity in the abstract component. |

**A function or method, a fixed state of its implementation, and one execution are distinct referents.** Apply the independent-discussion test in §2.1 first. A function or method discussed through its general purpose, interface or behavior can be `object`; displaying its definition, a code block or an example does not by itself establish `version`. A separately referable implementation state can be `version`, and an independently identified execution can be `activity`. A known function with an unknown version does not automatically become an `unresolved` identity.

The following are synthetic contrasts, not annotations for a research source:

| Source expression | Identity to use | Handling to reject |
|---|---|---|
| “Function F groups entries by key; this example shows how to call it.” | F as an ordinary `object`, with its source-supported purpose and example context. | Treating the displayed definition or example alone as a fixed version. |
| “Compare the implementations of F before and after the change; archive each separately.” | Two source-distinguished implementation states as `version`; preserve unknown identifiers or release status. | Merging the states because both are named F, or inventing commit or release facts. |
| “Execution C of F has started; no result is available yet.” | C as an `activity`; retain F separately only when it has independent discussion grounds. | Turning every call expression into an activity entity, or attributing C's eventual result to every execution of F. |

Judge each mention by its actual referent in context. An anchor interval supporting an implementation's identity does not by itself establish that a function identifier inside it denotes that whole implementation state; the same name cannot substitute for a source-supported correspondence. Preserve genuine referential ambiguity rather than changing the type to force a binding. These distinctions clarify existing meanings without adding types, link fields or a storage migration.

**Frozen, archived artifacts are version objects too, not only code states.** A dataset, corpus, schema or build that the source freezes, archives or registers with a version identifier and digest takes `version` identity, and its version may appear in its name; the continuing specification, prompt or tool it belongs to stays `object`/`component`, with the current version only in qualifiers or statements. Do not type an archived artifact as a plain `object` merely because it is not code, and do not split a living thing into version identities merely because a current version is mentioned.

| Source expression | Required identity and claims | Disallowed treatment |
|---|---|---|
| “回归语料已冻结为 omk-entity-quality/v12，摘要已登记，此后只读。提取提示词继续迭代，当前是 v14。” | The frozen v12 corpus as `version`; the extraction prompt as one continuing `object`, with v14 only as a qualifier. | Typing the archived corpus as `object`, or creating a version entity for the living prompt. |

The phrase “production Quartz” alone does not determine granularity. Reuse the component when context describes its production behavior; use an established production deployment when context refers to that instance. When the distinction remains uncertain and affects knowledge attribution, retain explicit granularity uncertainty rather than silently substituting a more abstract or specific object.

**Components and instances are not interchangeable subjects.** “Instance P failed” can help users find related experience through the component; it does not imply “all instances of this component failed.” Retrieving related knowledge and generalizing a claim to related objects are different actions.

Component-instance and component-version links use the versioned fields in section 8. Studio supports explicit correction, and catalog retrieval retains source and analysis-revision bindings; see the [extraction specification](./entity-extraction.md) for behavior.

### 3.1 Branch names and tested code states

**Names such as `master`/`main` do not determine referent level; the object discussed in the source does.** A branch is a continuing moving code pointer, retained as `object`. An individually compared, tested, or archived code state may be `version`, without requiring a commit SHA or formal version number. The source must support separately referable states; preserve unknown reproduction identifiers rather than inventing SHAs, release numbers, or release facts.

| Source expression | Identity and statements to use | Handling to reject |
|---|---|---|
| “The fix merged into master; later development continues on this branch.” | A continuing master branch object; the merge is a separate statement. | Treating a moving branch as a fixed commit or release package. |
| “Compare master commits a1 and a2, each running the same test.” | Two separately referable version states; retain a branch identity when the source also discusses it. | Merging tested versions because their branch names match. |
| “The current tested master code and released beta.2 both pass; master's changes remain unreleased, and no commit identifier is recorded.” | The tested state may be `version`, with unknown commit and unreleased status; a branch `object` model must qualify statements by this tested state and source time. | Rejecting a version solely because its name is master; inventing a SHA, declaring a release, or generalizing success to all future master states. |
| “Yesterday's and today's master builds differ; compare their results separately.” | One continuing branch and two source-distinguished code states; retain only identities actually mentioned. | Merging explicitly distinct tested states or splitting branches merely by date. |
| “master passed,” without specifying whether the window discusses a branch or a build. | Retain the known object with unknown granularity/test scope; unresolved identity requires the referent itself to be unknown. | Declaring unresolved identity just because a SHA is absent or inventing a deployment/version. |

Branch and code state do not substitute for each other, and one source position cannot be duplicated into two mentions. `componentRef` still requires a continuing component and an association supported by the source; a branch name cannot create a component. A version identity does not establish reproducible build evidence, and a branch identity cannot turn a single result into a persistent property.

Frozen annotations may allow `object`/`version` where both models are source-supported, while still requiring itemwise state qualifications and knowledge attribution checks rather than blanket name-based tolerance. Determine allowed expressions before output; new adjudication cannot raise old scores.

### 3.2 Release packages and the build under test

**A shared name or topic does not establish the same artifact; identity qualifications cannot transfer between objects.** Discussing a released package and later testing a real build does not establish that the tested build is that release. Matching version strings or a test after publication also do not establish this association. Retain only source-supported release status, version, environment, and test scope.

| Source expression | Identity and statements to use | Handling to reject |
|---|---|---|
| “The released beta still awaits backend acceptance; this test used a real beta build.” | The known tested build may be `version`; its release status, precise build, and correspondence with the earlier package remain unknown. If both are independently identified, keep separate records without claiming confirmed difference. | Describing the tested build as released beta or attributing its results to the release package. |
| “R is the release package and T is a local build; they are different artifacts.” | Two source-distinguished objects with their own qualifications and results. | Merging because names or version strings match. |
| “The test used the previously mentioned release package R, the same artifact.” | Merge mentions using that explicit association, retaining the source basis in their rationales; results still have this test's conditions. | Forcing a new version for every test or generalizing one result to every environment. |

When release status or artifact correspondence is unknown, the known tested object may remain `proposed`; a missing SHA does not make it `unresolved`. Retain unknowns in entity `uncertainties` and affected statement `context.unknowns`, without inventing qualifications in `description`/`qualifiers`. A statement's “version unknown” cannot repair a subject entity incorrectly qualified as released; review the entity and knowledge references together.

Current extraction prompts implement this rule. Structural admission checks references and positions, not artifact identity; beta keywords do not trigger automatic splitting, merging, or output rewriting. Explicit correction of recorded output verifies representation, persistence, and knowledge revisions, not automatic extraction improvements. The [extraction specification](./entity-extraction.md) owns prompt and response versions.

### 3.1 Standard interfaces, implementations, and entry points

**Implementing an interface, matching its behavior, or providing an alternative entry point does not establish identity with the interface or another implementation.** Retain separate interfaces and implementations when the source independently discusses them; bind aliases or entry-point mentions to one implementation only with source-supported correspondence. Do not mechanically create interface, implementation, and entry-point layers for every name, or invent canonical names, authorship, or self-written attribution.

For example, a source explicitly stating “RouteLedger defines the reading contract, module PebbleLedger implements it, and ./ledger-entry is only another import entry for PebbleLedger” supports separate interface and implementation identities; the path mention follows the explicit correspondence without inventing another implementation. A source comparing ClayReader and ./route-reader separately without establishing correspondence or entry-point authorship does not support binding the path to the former or calling it self-written. Do not infer an independently undiscussed interface from the path.

Assess each actual referent rather than substitute a standard interface for an explicit implementation or count an implementation's name as the interface concept. Keep known objects with specific unknown authorship, type, or correspondence; when a particular mention's target is genuinely unresolved, retain a local `unresolved` identity and supported candidates. Existing source and same-level constraints still apply to types and candidates; `componentRef` does not express “implements an interface.” Models and semantic reviewers make these judgments; programs do not classify or repair outputs using API names, paths, or words such as “self-written.”

## 4. Collections, unresolved identities, and mention positions

**A collection is one jointly referenced object; an unresolved identity means the target is unknown.** A generic “unknown” label cannot substitute for both.

| Source expression | Required representation | Disallowed treatment |
|---|---|---|
| “Aster and Birch are two services. They both started.” | Keep Aster and Birch separate; “they” is one collection mention whose members are both services. “Both” supports individual startup claims. | Duplicate the same “they” position as two individual mentions. |
| “Aster and Birch completed the task together in ten seconds.” | Preserve the participating collection/activity and its collective result; individual service timings are absent. | Assign “completed the task in ten seconds” separately to each service. |
| “Either Atlas or Beacon failed; it remains unrepaired.” | One unresolved object, with Atlas or Beacon as possible identities. | Create a definite Atlas-plus-Beacon collection and mark both as failed. |
| A truncated window contains only “They are still unconfirmed.” | Preserve the unresolved plural reference, unknown members, and window limits. | Invent members or treat it as a known individual. |

A known collection may retain known members and membership gaps; an incomplete list is not the complete set. Candidates must have the same referential level: when “they” could mean different combinations, individual A and B cannot become interchangeable singleton candidates. If candidate combinations cannot be represented with evidence, preserve an explanation and uncertainty rather than invent collection identities without supported mentions.

**Assess collection identity separately from membership completeness.** When the source independently identifies a group but does not enumerate its members, retain a `proposed` collection with `completeness=unknown`, empty `memberEntityIds`, and a membership-gap reason. Unknown members do not justify changing it to `object`, deleting it, or inventing members from a count. Use `partial` for only the source-supported known members; an unresolved collection means that the group itself cannot be identified.

For example, “The seven specimen cards sealed in this batch are checked as one group; individual card identifiers were not recorded” supports a known collection with unknown members. “Specimen cards are a category of record carrier; only its definition is discussed” describes an abstract category that may be `object`. “Sandgrain Register is one register whose cover instructions are being checked” describes a single artifact that may also be `object`. A category's possible instances or an artifact's multiple pages do not automatically form a collection; plural forms, counts, and type words cannot replace source evidence of a shared scope.

Each admitted source position corresponds to one mention. Collection mentions, membership relations, and individual claims supported by “both” must be represented separately, not through duplicated positions. The existing duplicate-position rejection stays in place. Section 8 defines membership, plural ambiguity and evidence bindings. Structural tests do not establish their model extraction quality.

Quotes are continuous source text. Repeated text requires an explicit zero-based occurrence, including overlapping matches; unique matches may omit it. The host rejects ambiguous positions without fuzzy matching or choosing the first. UTF-16 positions remain host computed. Section 8 replaces the old adjacent-context selector.

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

**Unconfirmed identity candidates differ from explicitly withdrawn guesses.** `possibleEntityIds` expresses supported possible correspondences; lack of confirmation does not mean exclusion. Shared names, co-occurrence, or the assistant's choice of an answer target do not automatically establish correspondence. Inspect each candidate's whole-window basis and the scope of any withdrawal. If its only correspondence evidence is explicitly withdrawn and no support remains, retain the original ambiguous object as `unresolved` with the gap reason instead of retaining an unsupported candidate link. A guessed object that still meets entity-scope rules may retain its explicit name mention and speculative context without restoring that link.

For example, an initially ambiguous “Lampbridge” guessed as “Lampbridge Retriever” solely from its name, followed by an explicit withdrawal with no other evidence, retains an empty candidate list and the withdrawal reason. If the source explicitly limits it to “Lampbridge Retriever or Lampbridge Indexer” and later only says it is still unconfirmed, retain both supported candidates. Withdrawing a guess that selected one of them leaves the independent two-candidate scope intact, rather than clearing all candidates. Conflicting speakers asserting those two correspondences without adjudicating evidence leave a conflict and unresolved identity; neither time nor role automatically decides it. Programs verify candidate references and levels, not whether a source supports or withdraws a semantic correspondence.

Subsequent storage and presentation must:

- Distinguish object labels, referential levels, identity evidence, qualifiers, members/related objects, and unknowns instead of relying on one description for everything.
- Use names for search and analysis/entity/revision identities for window bindings. Show homonyms separately, with sources and qualifiers to distinguish them.
- Represent component-instance and collection-member links only as source-supported relations; do not automatically merge knowledge, transfer outcomes, or calculate causal benefit.
- Preserve parent revisions, rationale, and original evidence for new analyses. Existing knowledge keeps the exact revision used at generation; applying corrections requires a new knowledge revision, and old bindings remain inspectable.
- Never arbitrarily choose a new object to inherit an old knowledge subject after a split. Unavailable sources, incomplete membership, and failed linked-knowledge reads each have explicit limits rather than “no objects / no knowledge.”

These requirements supplement the [revision and storage boundaries](./entity-extraction.md). Section 8 defines the approved versioned replacement and existing-data impacts, without compatibility readers, automatic migration, or persistent indexes.

## 7. From rules to implementation and acceptance

These examples specify rules; they are neither independently adjudicated gold nor evidence of improved extraction. The [evaluation protocol](./entity-extraction-evaluation.md) owns annotation, regression and independent-review gates and their current evidence.

Clarifications about collection identity and correspondence evidence are first validated through a separate research candidate; they do not switch the production default or change wire, Schema, admission, or storage contracts. Freeze the actual candidate prompt bytes before a controlled comparison on real conversations. Passing rules and synthetic regressions does not establish model compliance or rewrite old candidates and historical research conclusions.

Acceptance cannot compare entity counts alone. Check referential levels, required identity separations, coreference rationale, collection/unknown representations, knowledge subjects/objects and conditions, and revision bindings after correction. Annotate critical mentions and required identities before output; do not inspect only returned objects or let the model omit instances to avoid false merges.

Allow synonymous labels and additional source-supported objects. Do not substitute an abstract component for an explicit instance, distribute collective results to individuals, or drop conditions affecting reuse. Cross-environment claims about a component can qualify when the source establishes no required separate instances and preserves all conditions. Independent review must apply these rules rather than count returned IDs.

New identity rules, annotations and checks need a new measurement identity before subsequent quality can be reported, without revising gold or recomputing old results.

## 8. Current identity contracts

Current identity, link and quote contracts are implemented in prompts, admission, host identity mapping, storage/recovery, corrections and searchable presentation. Structural and workflow success do not replace independent quality acceptance.

### 8.1 Minimal identity structure

Existing entities have three required fields without creating another global registry:

| Field | Semantics and validation |
|---|---|
| `referentKind` | `object`, `component`, `instance`, `version`, `collection`, `plan`, or `activity`. Ordinary people, files, tools, rules, and concepts may use `object`. This is a referential level, not a confidence rating. |
| `componentRef` | `null`, or a link containing `entityId`, `mentionIds`, and `rationale`. Only an instance/version may link to one proposed component. Target and mentions must belong to this analysis, including at least one mention of the instance/version. Use `null` when component identity is absent; never invent it from matching names. |
| `collection` | `null` for other levels; a collection contains `memberEntityIds`, `completeness`, `mentionIds`, and `rationale`. Completeness is `complete`, `partial`, or `unknown`. At least one supporting mention belongs to the collection. Member references must be unique and closed, without direct or indirect self-containment. |

Membership completeness and identity resolution are distinct. A known collection may have membership gaps and remain `proposed`. `partial` needs at least one known member; `unknown` lists no definite members. Both require uncertainty reasons. An unresolved collection must use unknown membership, never substitute candidate identities for members; its `possibleEntityIds` can reference only proposed collections. Other unresolved objects also require candidates at the same `referentKind`.

Links are judgments proposed by a model or user; structural admission does not prove them true. Exact mentions, `basis`, `rationale`, and uncertainty retain identity evidence. Plans and executions remain separate; knowledge statements express their specific relations without extending a general graph relation vocabulary.

### 8.2 Quotes and admission

New model locators contain only `evidenceRef`, a continuous source `quote`, and optional zero-based `occurrence`. The host enumerates every exact occurrence in the message, including overlaps. An index may be omitted for a unique match; multiple matches require one. Reject missing indexes, out-of-range indexes, and source mismatches separately. Do not trust generated character offsets, retain legacy context selectors, or select the first occurrence by default.

This reduces the burden of constructing long adjacent context; it does not prove correct semantic positioning. Duplicate source-span assignment is still rejected. A collection produces one assigned mention. Individual claims must reference each member's own mention and source evidence supporting the claim; never duplicate a collection span to satisfy member coverage. Case actions/outcomes may reference only `descriptive` statements; plan requirements keep their actual modality.

An invalid link makes its containing entity inadmissible. Dependent mentions, collections, unresolved candidates, and knowledge continue through reference-closure rejection with explicit reasons. Dropping invalid links or members must not silently produce “complete” data. Corrections must preserve or explicitly edit these fields; merging must not automatically transfer outcomes.

### 8.3 Versions and existing-data impact

The [extraction specification](./entity-extraction.md) owns the current prompt, wire/domain response, run and entity/knowledge history versions, frozen prompt identities, unsupported-version behavior and existing-data impact. The [library](../knowledge/knowledge-library.md) and [entity-link journal](./entity-links.md) own their separate organization and review formats. A prompt version is not a storage or measurement version; changing the frozen request requires a new run identity and does not inherit an old experiment's execution permission.

Preserve old files, outputs and evidence without automatic rewriting, deletion, conversion, migration, compatibility readers or rescoring. Unsupported entity histories remain visibly unreadable; available knowledge retains its original binding and limits. New same-named entities do not inherit old knowledge. Corrections require new immutable revisions, and only supported run formats can resume with their original idempotent identities.

### 8.4 Delivery boundary

Current implementation covers identity/link validation, model quotes, prompts, host identity mapping, write/recovery, corrections, and membership/component presentation and retrieval. The [extraction specification](./entity-extraction.md) owns interactions and failure boundaries.

Functional regressions cover empty results, homonym isolation, collections/unresolved identities, cascaded invalid-link rejection, duplicate quotes, case roles, idempotent recovery and unsupported-version rejection. Quality evidence and its limitations remain in the evaluation protocol; acceptance tools must not silently combine current prompts with criteria from a different measurement identity.
