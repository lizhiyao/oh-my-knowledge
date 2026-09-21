# OMK Product Positioning

> 中文原文：[OMK 产品定位](./PRODUCT.md)。本文件逐节对照维护，内容有出入时以中文版为准。

<!-- impeccable:product-schema 1 -->

## Platform

web

OMK's visualization surface is Studio in the browser; the product also provides a CLI, Node.js integration and agent integration, and runs mainly in local trusted development environments and CI.

## Users

Primary users are AI application developers and agent users, including authors and maintainers of prompts, RAG, skills, agents and workflows. They need to understand how their work performs on real tasks, organize work experience into reusable knowledge, and decide whether a knowledge change is worth adopting.

## Product Purpose

OMK (Observe. Measure. Know.) is a knowledge-building tool: it accumulates sourced knowledge from real work, then verifies through controlled evaluation whether a knowledge change is effective, so experience keeps converting into reliable task capability.

The product must help users answer:

- What happened in real tasks, and which successes, corrections and knowledge gaps does it show?
- Which facts, cases or methods are worth reusing, under what conditions, and on what basis?
- After that knowledge becomes a concrete change to a knowledge artifact, did task performance improve, and is the evidence strong enough to support adoption or release?

Success means users can trace a knowledge claim back to its source and a version change back to measurement evidence, and on that basis decide to maintain, revise, adopt, or keep verifying.

## Positioning

OMK connects real-work observation, knowledge maintenance and controlled measurement. Knowledge is reusable facts, cases or methods; prompts, RAG context, skills, agents and workflows are knowledge artifacts. Knowledge content, artifact version and task effect each keep their own identity, basis and validation scope.

A controlled comparison holds the model and the evaluation samples fixed and states explicitly which artifact and runtime context change. Observation provides evidence of problems and experience; evaluation tests the effect of a specific change; together they support knowledge building.

## Operating Context

- **Observe: see real work clearly.** Read agent sessions, tasks and execution records to identify successes, user corrections and knowledge gaps, keeping the original basis and source-coverage limits.
- **Know: organize and maintain knowledge.** Extract facts, cases and methods from explicitly selected records, check applicability conditions, entities, sources and uncertainty, and revise, keep or drop each item one by one.
- **Measure: verify specific changes.** Check whether an artifact is measurable, run a controlled version comparison, then decide from the result to adopt, keep revising, or gather more evidence.

These stages serve continuous iteration and do not require users to start from the same entry point every time. The controlled pre-release judgement is currently supported by doctor → eval; real-work observation and knowledge extraction feed later improvement.

Studio is the operating surface for knowledge work: users read sessions, trace executions, start knowledge extraction, check and maintain candidates, and view evaluation results with the raw evidence. The CLI and programmatic entry points support scripts, CI and agent workflows.

## Capabilities and Constraints

### Existing Capabilities

- Local session and task observation, execution trace reading, raw record tracing, and knowledge-use and gap-signal analysis; concrete sources and coverage follow the corresponding adapter and entry point.
- Extract candidate knowledge from selected work records and maintain candidate revisions, source references, and keep or drop records; the CLI and Studio reuse the related application flows.
- Knowledge artifact health checks, controlled evaluation, version comparison, results and uncertainty presentation, and evidence-gated version acceptance and candidate iteration.

### Design Direction and Unfinished Boundaries

- Entity knowledge retrieval, the full linkage from a knowledge revision to multiple artifact changes, and an automatic loop across observation, knowledge maintenance, artifact change and verification still have design and implementation work outstanding.
- Existing knowledge extraction never modifies AGENTS.md, a skill or any other effective artifact on its own. Keeping a candidate means willingness to maintain it, not that the content is proven.
- The overall measured gain of several changes cannot be auto-attributed as the independent contribution of each knowledge item; a knowledge item being read or injected into context proves neither that it was adopted nor that it caused the task result.
- Generated samples and candidates must be reviewed and cannot serve directly as independent release-verification evidence. Conclusions are bounded by samples, scoring standards, model and execution environment, and insufficient evidence must be shown explicitly.
- Raw evidence, source, time, linked identity and revision history must be preserved; missing, truncated and unreadable content and insufficient source coverage must be presented explicitly.
- Reading locally and sending selected content to a model are different operations; the content boundary and cost of model calls must be visible to users. The report service targets local trusted environments.

## Brand Commitments

- The name is **OMK**, expanded as **Observe. Measure. Know.**; the core statement is "knowledge changes in AI applications, backed by evidence".
- User-visible copy prefers Chinese, keeping existing English entry points and technical identifiers; an LLM judge is always called a judge.
- Product copy is accurate and verifiable, and explicitly separates sourced facts, claims made by others, model inference and verified effects; design direction is never written up as an existing capability.

## Evidence on Hand

- [Product guide](README.zh.md): product entry points, controlled comparison principles, runtime environment and evidence limits.
- [Knowledge definition](docs/zh/explanation/knowledge.md): conceptual relations among entities, knowledge, context and knowledge artifacts.
- [Knowledge extraction guide](docs/zh/guides/extract-knowledge.md): existing capabilities for candidate generation, checking, revision, maintenance and source management.
- [Observation and task traces](docs/zh/guides/observe-production.md): session reading, execution tracing, observation signals and integrity boundaries.
- [Three-stage workflow](docs/zh/explanation/three-stage-workflow.md): the controlled doctor → eval release judgement and observe's feedback role.
- [Knowledge-building domain model](docs/zh/specs/knowledge-domain-model.md): domain design and worked cases; a design draft is not a published contract or a complete implementation.
- [Example gallery](examples/README.zh.md): runnable scenarios; examples and generated samples do not replace independent verification evidence in the real domain.

These materials support the product description and workflow documentation; they are not proof of general performance improvement, customer adoption or business gain.

## Product Principles

1. **Build knowledge from real work.** Attend to successes, corrections and the gaps that failures expose at the same time, and organize them into facts, cases or methods with stated scope.
2. **Preserve sources and uncertainty.** Users must be able to trace a knowledge item's basis, review history and evidence limits, and derived views must not overwrite raw evidence.
3. **Keep knowledge, artifact and effect separate.** Candidate maintenance, artifact adoption and effect verification are expressed separately; one stage's status never substitutes for another stage's conclusion.
4. **Support decisions with comparable measurement.** State experiment conditions, version identity and conclusion scope, protect measurement comparability, and do not read observational correlation as causation.
5. **Protect user data and control.** Make the boundaries of source selection, model calls and effective changes explicit, so knowledge building stays checkable, revisable and traceable.
