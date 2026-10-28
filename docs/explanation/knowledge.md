# How OMK understands knowledge

**Knowledge is a reusable understanding, case, method, or constraint expressed as complete natural-language body segments. Entities associate that knowledge with the things it discusses.**

The body is canonical. Each segment has a stable `segmentId` and independently preserves the conditions, attribution, negation, exceptions, time, participant stances and unknowns needed to understand it. A title, quote, entity catalog or reuse rationale cannot complete missing body meaning. `fact`, `case` and `method` organize content; they are not credibility levels.

Inline evidence preserves the exact source snapshot/version, continuous quote, host-checked UTF-16 location, and `source_assertion`, `direct_observation` or `inference` basis. A located quote proves its location, not truth or complete source fidelity. Source timestamps are not automatically fact times. Retain/discard decisions apply to exact body revisions; new revisions remain pending.

Entities can be physical objects, people, files, systems, concepts or plans. Only source context establishes their meaning: Apple may refer to a fruit or a company, and a keyboard to a category or a specific device. Names, paths and similarity do not prove identical objects. `description`, `qualifiers`, referent levels and explicit uncertainty preserve these distinctions.

Entity links and optional typed relations are **independent derived projections** bound to `{knowledgeId, revisionId, bodyDigest}`. They have their own revisions and review decisions. Generation saves a body before attempting these projections; projection failure, disagreement, correction or rebuilding does not remove or rewrite the body. Subject/object triples can describe an association, but are not the mandatory representation of all knowledge.

Task retrieval selects complete body segments and their evidence within an adjustable response budget. The default **65536 UTF-8 bytes includes the complete JSON response and newline**; explicit 8192 remains supported. This is not a definition of knowledge, a storage cap, or a model context limit. A segment that does not fit is explicitly omitted whole, without truncating its conditions. Literal retrieval is not semantic search; a larger initial budget alone does not demonstrate complete task coverage.

Prompts, skills, agents and workflows are knowledge carriers. Observation supplies evidence from real work; controlled evaluation tests whether a particular carrier change helps a task. Saving, retention and review alone do not establish that benefit. The [entity knowledge library](../specs/knowledge/knowledge-library.md) organizes window identities through explicit human confirmation, without automatic cross-Agent merging. See the [construction and maintenance contracts](../specs/knowledge/knowledge-domain-model.md) for identities, version boundaries and migration.
