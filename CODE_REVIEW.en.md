# OMK Autonomous Code Review Playbook

> 中文原文：[CODE_REVIEW.md](./CODE_REVIEW.md)。本文件逐节对照维护，内容有出入时以中文版为准。

This playbook treats code review as part of delivery, not as an extra action that waits for the user to ask for it. It is written for every Agent and human contributor working on OMK, and it does not depend on a specific model, tool, or multi-agent capability.

## Core principles

- The goal of review is to find problems that demonstrably affect users, measurement credibility, system boundaries, or long-term evolution - not to produce the longest possible list of issues.
- Passing tests only prove that the assertions they cover hold. On their own they cannot prove that requirements are complete, the architecture is sound, public contracts are stable, or that a real install works.
- Review depth matches risk. Low-risk changes get a quick re-check; high-risk changes cover the full matrix and verify real boundaries.
- Implementation and review use different perspectives. When implementation is done, stop editing, rebuild your understanding of the change from the full diff, its callers, and its public results, and only then record findings.
- Investigate issues you are unsure about but cannot prove. If evidence still does not appear, write them up in the risk notes instead of dressing them up as confirmed findings.

Verification triggers, exceptions, and evidence reuse all follow [AGENTS.md](./AGENTS.md#开发反馈与验证); the table below describes review depth and does not define a duplicate gate.

## Risk tiers

| Tier | Typical change | Minimum review depth |
|---|---|---|
| High | Evaluation Core, scoring/statistics/prompts, public Schema/API, persistence and migration, executors/subprocesses, security boundaries, concurrency/locks/cleanup, npm releases | Full review matrix, layered tests, and the matching real paths; clean-room runs per the root rules |
| Medium | CLI behavior, error handling, filesystem/network boundaries, non-trivial domain refactors, report UI, cross-module contracts | All relevant dimensions, targeted unit/integration tests; add real acceptance at the boundary where needed |
| Low | Local docs, test descriptions, type-only changes or mechanical renames with no behavior change | Quick pass over the full diff, links/formatting/affected checks; repository gates still apply before delivery |

Whenever any single high-risk factor appears, handle the whole change as high risk. A small diff never downgrades the tier of a public-contract or measurement change.

## Workflow

### 1. Build the risk map before starting

Briefly state four things up front; for a low-risk change these can collapse into one or two sentences, and no separate plan file is needed:

1. The problem the user wants solved and the observable successful outcome.
2. The explicit non-goals, above all commands, compatibility layers, or abstractions that must not be added in passing.
3. The affected domains, public entry points, persisted data, and measurement invariants.
4. The risk tier, and which real boundaries have to be proven.

When requirements are unclear, investigate first. Stop and ask only when a user decision is missing and that decision would materially change the outcome.

### 2. Keep the work reviewable while implementing

- A PR is organized around one complete goal, bounded by whether the change can be verified together and reverted together. Keep unrelated cleanup out; do not fracture a single verifiable loop in pursuit of minimalism, and do not cram changes that cannot be reverted together into one PR just to close a loop.
- Choose targeted tests, quick checks, or the full gate per the root rules; batch related fixes, then verify and push.
- When you add a failure branch, design an actionable diagnostic and a regression test at the same time.
- Tests must be hermetic: use explicit temporary directories and environment isolation, and they must leave repository-managed files and user state untouched afterwards.

### 3. Run a fresh-pass CR after implementing

First do a read-only pass over `git diff`, added/deleted files, public exports, Schema/snapshot changes, and callers; then review against the matrix below. In this stage do not merely restate implementation intent - start from the failure mechanism and verify how the code actually behaves.

When an independent reviewer is available, have them review a clearly scoped area read-only. When one is not available, the current Agent drops its implementation assumptions and completes the same fresh-pass. Whether you have multi-agent capability does not change the acceptance bar.

CR tool artifacts must stay isolated from the source working tree. Only when the tool you use genuinely needs to write to disk, create a run directory outside the repository with `mktemp -d` and put material snapshots, verification evidence, graphs, context, orchestration results, and reports in it. A review that only reads the diff, the call chain, and existing test evidence creates no scratch directory and no report file. Never generate `artifacts/cr/` or `knowledge/cr/` inside the repository, and never use `.gitignore` to hide what a tool wrote. PRs, CI, and external reports the user has explicitly authorized are what carry persistent records; only documents that pass normal review and genuinely are project assets enter the repository.

### 4. Fixes and final re-review

- Fix every P0-P2 in priority order first, then run the affected tests in batches.
- If a fix changes architecture, public behavior, or the risk map, run the full CR again.
- Other fixes only re-check the affected dimensions and the final diff; avoid pointless from-scratch loops.
- Verification evidence must cover the final change set. For a local fix made after the first-round gate at the risk tier you selected, repair the affected verification per the root rules; never pass pre-fix results off as post-fix evidence.
- When CR ends, re-check `git status --short` to confirm the tooling left no materials, caches, reports, or other off-target files behind.

## Multi-dimension review matrix

| Dimension | Questions that must be checked | Typical evidence |
|---|---|---|
| Requirements and scope | Does it solve the original problem? Are the success criteria observable? Does it introduce unauthorized capability or over-abstraction? | issue, non-goals, final diff, user path |
| Architecture and dependencies | Does the code sit in the right domain? Are dependencies one-directional? Does Core stay host-agnostic? Are the public entry points minimal? | Directory structure, import graph, exports, boundary guards |
| Correctness and failure paths | Are happy path, empty input, invalid input, partial failure, retry, and exception propagation consistent? | Branch matrix, call chain, negative tests, error envelope |
| Measurement | Does it change construct, sample selection, five-layer scoring, statistical formulas, prompts, missing evidence, or comparability? | frozen hash, Schema diff, report fields, statistical tests |
| API/Schema/storage | Are public identity and physical path conflated? Are the read/write protocol, versioning, and migration/incompatibility decisions explicit? | package exports, JSON Schema `$id`, persisted fixture, migration notes |
| Security and privacy | Do external input, paths, URLs, env, credentials, subprocesses, or report output cross trust boundaries? Does failure stay fail-closed? | Input validation, escaping, redaction, permission-failure tests |
| State/concurrency/resources | Is it idempotent, atomic, and recoverable? Are locks, caches, temporary files, sessions, and processes released correctly after success, failure, and interruption? | Concurrency tests, cleanup paths, atomic rename, resource counts |
| User experience and i18n | Is copy accurate, actionable, and leak-free? Are help text, exit codes, Chinese/English, and report presentation consistent? | Command integration tests, real stderr/stdout, screenshots, bilingual docs |
| Test credibility | Do tests hit real branches rather than mock illusions? Do they cover both the domain layer and the wiring layer? Do they pollute the repository or depend on execution order? | Targeted tests, hermetic guard, repeated/parallel runs |
| Packaging and delivery | Does "works from source" equal "works from dist/tarball"? Are subpaths, type declarations, generated files, the Node matrix, and release notes correct? | clean build, npm pack, isolated install, remote gates |

## Finding conventions

Severity:

- **P0**: Causes wrong measurement conclusions, severe security problems, unrecoverable data corruption, or overall system unavailability; must block immediately.
- **P1**: Wrong behavior on common paths, public-contract breakage, a critical gate going dead, or a high-probability production failure; must be fixed before delivery.
- **P2**: Boundary errors with realistic triggers, diagnostic defects, resource leaks, or design debt that keeps compounding; fix in the current PR by default.
- **P3**: Local improvements that do not block the goal; fix them or register an explicit follow-up, and never use P3 to hide an unresolved correctness problem.

Every finding uses the following minimal structure. The template block is kept verbatim from the authoritative original; its lines carry severity, title and a file:line locator, then Evidence, Mechanism, Impact, Fix, and Verification:

```text
[P1] Short title — path/to/file.ts:line
Evidence: which code/contract, combined with which input, triggers it.
Mechanism: why it fails, not just what the symptom looks like.
Impact: how user behaviour, data, the API or measurement credibility is harmed.
Fix: the minimal fix direction that stays consistent with the architecture.
Verification: the test or real acceptance that keeps it from coming back.
```

A finding must point at actionable code or an actionable contract. Style preferences, worries with no triggering mechanism, and pre-existing issues unrelated to this PR are not blocking findings; open a separate issue for them when they matter.

## Verification ladder

Combine tiers from low to high risk as needed; no change runs every tier mechanically:

1. Static checks: full diff, `git diff --check`, types, lint, generated files, and snapshot diff.
2. Domain tests: directly cover the success, failure, and boundary branches of the logic you changed.
3. Wiring tests: cover CLI/API arguments through to domain behavior, and behavior through to the output envelope.
4. Full gate: run `yarn ci` on the final change set.
5. Real paths: verify the stdout, stderr, files, or UI that users actually see, using production entry points.
6. Clean-room: for public packages, exports, Schema distribution, install/initialization, module-loading environment, or release changes, verify with a tarball or isolated directory.

Real acceptance must stay low-cost, repeatable, and isolated. Do not substitute real user repositories, global state, or remote CI for the local feedback loop.

## Completion and stopping criteria

You may declare completion only when:

- Goals and non-goals have not drifted.
- All P0-P2 are resolved; P3 is resolved or has an explicit follow-up.
- The final diff has been re-reviewed and holds no new P0-P2.
- The targeted verification, full gate, and real acceptance required by the root rules have passed, and the evidence plus its valid reuse scope covers the final code.
- Measurement implications, compatibility/migration decisions, and remaining risk are stated explicitly in the PR description.

Once done, do not repeat CR endlessly because you "could probably look one more time". Only the following events trigger a new full review:

- Substantial change to architecture, public API, Schema, storage, or user behavior.
- CI or real acceptance exposes a new failure mechanism.
- A rebase or conflict resolution changes critical code.
- An external reviewer raises a new high-risk direction.

## Review output

When there are findings, sort them by severity and lead with the problems, then the overall assessment. When there are none, write `No findings` explicitly, followed by a brief account of the high-risk surfaces you checked, the verification evidence, and residual risk. Do not use a test checklist to cover up architecture or measurement questions you have not analyzed.

Autonomous CR conclusions go into the PR description; when the user explicitly asks for a `cr`/`review` of an existing PR, publish the review comments directly to that PR as `AGENTS.md` requires.

## Instruction-discovery smoke

When you change `AGENTS.md`, nested domain rules, or Agent onboarding configuration, run one low-cost manual check in addition to the static governance tests:

1. From the repository root, launch an Agent available on this machine and ask it to list the current repository's rule sources; confirm it discovers the root `AGENTS.md` and `CODE_REVIEW.md`.
2. Launch an Agent with a directory that has nested rules as its working directory; confirm the root rules and the domain `AGENTS.md` nearest that directory are both in effect.
3. Codex uses native agents.md discovery, Claude Code uses the `CLAUDE.md` import. Add onboarding configuration for other tools only when the repository actually uses them, and accept against each tool's official discovery mechanism.

CI only verifies that configuration exists, that its syntax is valid, and that the key rule anchors are present. It does not launch third-party Agents in tests, and static checks are not proof that instructions actually loaded.
