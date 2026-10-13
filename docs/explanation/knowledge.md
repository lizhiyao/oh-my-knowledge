# How OMK understands knowledge

**Entities are the things knowledge describes; knowledge expresses their states, relationships, or actions in a specific context.**

Entity extraction first identifies the things and concepts discussed, such as apples, OMK, keyboards, insurance and Node; it then uses context to group names and references, retain ambiguity and associate knowledge. Ordinary objects and abstract concepts are in scope, beyond names of people, places, organizations or software components. Exhaustively listing nouns is not the goal.

Apple may mean a fruit or company, a keyboard may mean a category or one device, and insurance may mean a domain concept or a product. Only source context establishes meaning or associations. Semantic categories differ from the referent levels in `referentKind`: the current `description` explains source-supported meaning and `qualifiers` records owners, uses, domains or projects, without adding mandatory categories or storage fields. Component, instance, version and collection distinctions remain where the source requires them.

**How knowledge is expressed:**

> **Time scope + scenario + conditions + entity A + relation or action + entity B (if any)**

A plays the subject and B the object in this statement; their roles can switch in another statement.

- **Entities need not be physical.** People, files, and systems can be entities, as can rules, concepts, and plans.
- **Knowledge can concern multiple entities rather than belong only to A.** “Module A depends on module B” is knowledge about both A and B and can be retrieved from either entity.

This formula describes the basic structure for expressing knowledge. Factual knowledge can be expressed in a single statement, while case-based and procedural knowledge typically consist of multiple statements. Prompts, skills, agents, and workflows are knowledge carriers. Observation provides evidence for knowledge from real work, while evaluation tests whether specific changes to knowledge carriers improve task performance.

The entity catalog supports inspecting objects, source mentions, and linked knowledge within windows. The [entity knowledge library](../specs/knowledge/knowledge-library.md) organizes knowledge across windows through manually confirmed source links in one explicitly selected workspace, preserving separate object identities and organization history. Automatic cross-agent identity and actual reuse benefits remain to be implemented and validated. See the [knowledge domain model (draft)](../specs/knowledge/knowledge-domain-model.md) for relationships and structures.
