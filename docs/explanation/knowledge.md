# How OMK understands knowledge

**Entities are the things knowledge describes; knowledge expresses their states, relationships, or actions in a specific context.**

**How knowledge is expressed:**

> **Time scope + scenario + conditions + entity A + relation or action + entity B (if any)**

A plays the subject and B the object in this statement; their roles can switch in another statement.

- **Entities need not be physical.** People, files, and systems can be entities, as can rules, concepts, and plans.
- **Knowledge can concern multiple entities rather than belong only to A.** “Module A depends on module B” is knowledge about both A and B and can be retrieved from either entity.

This formula describes the basic structure for expressing knowledge. Factual knowledge can be expressed in a single statement, while case-based and procedural knowledge typically consist of multiple statements. Prompts, skills, agents, and workflows are knowledge carriers. Observation provides evidence for knowledge from real work, while evaluation tests whether specific changes to knowledge carriers improve task performance.

Entity relationships and retrieval above describe a design direction, not an existing entity knowledge store or search interface. See the [knowledge construction domain model (draft)](../specs/knowledge-domain-model.md) for relationships and data structures.
