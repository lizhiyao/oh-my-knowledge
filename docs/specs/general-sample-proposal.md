# General sample proposal (#842)

Status: design review draft with offline feasibility evidence; public-contract implementation is not approved. This document does not publish a new sample schema or change `omk.eval-sample-set/v2`, prompt bytes, scoring, or persisted identities. See [issue #842](https://github.com/lizhiyao/oh-my-knowledge/issues/842).

## Research and direction

Research date: 2026-09-13. Primary sources show recurring principles, not a single industry-wide sample standard:

- [LangSmith evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts): keep application inputs separate from reference outputs consumed by evaluators.
- [Inspect datasets](https://inspect.aisi.org.uk/datasets.html): distinguish text/messages, targets, metadata, sandbox resources, and setup. Environment descriptions must not imply materialized fixtures.
- [Ragas schemas](https://docs.ragas.io/en/latest/references/evaluation_schema/): distinguish retrieved and reference contexts/IDs; preserve conversation messages and reference tool calls.
- [Anthropic agent evaluation practice](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): distinguish transcripts from actual environmental outcomes.
- [LangSmith trajectory evaluation](https://docs.langchain.com/langsmith/trajectory-evals): evaluate trajectories separately from final answers.
- [Promptfoo test cases](https://www.promptfoo.dev/docs/configuration/test-cases/): separate input variables from assertions.

Use one common envelope with versioned input/evidence contracts, rather than separate prompt/RAG/agent/workflow protocols. An unconstrained JSON container alone is not a sufficient user contract. History replay, interactive sessions, and internal multi-step execution are distinct capabilities.

## Current evidence

Baseline: `03eb64d1954a510b3931434ed232d79f4421ea2d`.

The v2 user contract in `src/eval-workflows/inputs/contracts/sample.ts` requires a string prompt. `measurement-design.ts` renders context in a code fence and prepends prompt-only environment descriptions. Core's `EvaluationSampleSchema` already separates arbitrary JSON input, executionContext, expected, and evaluationContext. The custom-command adapter accepts JSON input/output/trace and excludes expected/evaluationContext from execution requests; it advertises invoke, not interactive session support.

Baseline verification: `yarn vitest run test/eval-core/conformance/targets.test.ts test/eval-workflows/hosts/adapters/custom/command.test.ts test/eval-workflows/input-compilation/compile.test.ts` passed 68 tests across three files on 2026-09-13 in an isolated worktree, without model calls. Existing conformance fixtures prove lifecycle contracts, not representative application capabilities.

## Representative probes to implement

| Scenario | Execution input/environment | Evaluation-only expectations | Required evidence |
| --- | --- | --- | --- |
| Prompt: classify a support ticket | Structured title/body, permitted categories, deterministic local rules | Correct category | Type preservation, exact rendering, no reference leakage |
| RAG: query a policy corpus | Query, frozen offline corpus, retrieval parameters | Relevant IDs/grades and citation references | Actual ranking/citations distinct from labels; missing evidence |
| Agent: clarify then check inventory | Role-aware message history and isolated inventory fixture | Query arguments, answer, necessary tool constraints | Actual local tool results; replay distinct from simulation |
| Workflow: validate and approve an order | Order, initial state, deterministic nodes | Final state and node postconditions | Actual state transitions, rejection branch, false success text |

Initial probes pass `yarn vitest run test/eval-workflows/general-sample-proposal.test.ts` (eight tests); `tsc --noEmit` also passes. They exercise actual offline classification, corpus ranking, inventory file reads, and persisted state transitions through Core execution, grading, analysis, and verified reports. Corrupted outcomes fail grading; trial directories are isolated and cleaned; execution contexts exclude gold/evaluation-only markers.

This proves test-adapter feasibility, not v2 loading, native message conversion, interactive sessions, or production workflow integration. Exact matching of fixture outcomes is not a general RAG or agent quality metric. Additional probes cover negative-amount rejection, large-order manual review, missing output remaining nonconclusive, and rejection of the proposed envelope by the actual v2 loader. The final matrix must independently cover the user entrypoint, executor, evaluator, evidence, and report.

## Proposed boundaries

Keep stable sample IDs, execution input, execution context/resources, expected results, evaluation context, and annotations/analysis separate, mapping to existing Core concepts. Use a qualified `inputKind` for text, structured tasks, or message history; register application schemas with explicit identities. Specify roles and message/tool-call correlation. Reuse existing resource leases and execution controls instead of duplicating retry/cache/isolation machinery.

Only explicitly bound evaluators consume expected results and grading references. Execution produces output, trace, and state evidence with provenance and completeness. Missing required evidence is not success. Interactive user simulators and third-party retrieval services are not automatically implemented by this proposal.

## Migration and comparability

Publish a new schema identity only after approval. Preserve original v2 bytes; never silently migrate on read. Preview mappings and blockers before writing a new file. Freeze the exact old compiled prompt, including context fences/environment rendering. Do not reinterpret context as retrieval gold or prompt assumptions as physical fixtures. Do not turn diagnostic `covers` into workflow assertions.

Retain assertion/rubric content, weights, bindings, and implementation identities. Record old/new source digests, mapper version, execution-input digest, and grading-binding digest. Verify Core digest/cache effects rather than assuming a rename is identity-neutral. Changed roles, ordering, corpus, or state semantics require a new comparison series; score bridging requires proven equivalence of inputs, environment, runtime, grading, and sampling design.

## Minimum input and evidence contracts

The recommended next version is `omk.eval-sample-set/v3`, not yet published. Retain dataset dependency declarations. Each sample has sampleId, input, optional executionContext, expected, evaluationContext, and annotations. Application payloads do not require separate object-specific envelopes.

| inputKind | Required data | Compilation/capability rule |
| --- | --- | --- |
| text | `text: string` | Preserve exact bytes; no implicit trimming or reference concatenation |
| json | `value: JsonValue` and application `schema` identity | Validate registered schema; retain numbers/booleans/null; text rendering requires a renderer identity |
| messages | ordered messages and `interactionMode: history` | Explicit history adapter preserving roles/order; stringifying JSON is not native message support |

Reuse Core schemaVersion/schemaUri/schemaDigest for schema identity. The input adapter version must state whether Core receives the envelope or its value projection; never alternate within one identity. Reuse Core execution controls/resource leases instead of duplicating orchestration.

Messages minimally contain messageId, role, and content. Roles are system/user/assistant/tool; initial content support is text. Tool requests carry toolCallId, name, and JSON arguments. Results must reference an earlier outstanding call; duplicate consumption, missing references, unknown roles, or invalid ordering are rejected before execution. The prototype proves text-history replay only, not these future validations. Interactive driving needs a separate session adapter/simulator identity, stopping rule, turn budget, and cancellation contract.

RAG expected.retrieval minimally contains corpusDigest and document IDs with nonnegative relevance grades. Evaluation context freezes k, relevance threshold, tie/deduplication/empty-gold policy, and metric implementation version. Actual retrieval evidence contains ranked IDs, corpus identity, and citable passages. Citation annotations relate answer spans to source IDs/spans. Score retrieval, citation correctness, and answer quality separately. This prototype proves exact ranking/citation matching on a frozen corpus, not graded nDCG, semantic faithfulness, or citation-span scoring.

Workflow executionContext defines initial state and isolated resources; expected defines terminal state and node postconditions. Evidence records node IDs, start/end states, failure codes, and state snapshot digests. Use necessary precedence constraints, not exact trajectory equality by default. A correct terminal state does not necessarily satisfy node constraints; alternative valid paths should not fail just for differing order. `covers` remains diagnostic. The prototype grades actual persisted approved/rejected/pending-review states.

Future adapters must reject unsupported inputKind/interactionMode with sampleId and field location, without silent stringification. Structural validity, capability qualification, and evidence consumption remain independent checks.

## Verified support matrix

Native means the layer already has a direct contract. Adapted means a test-local offline adapter actually ran. Unsupported/unverified is not advertised as completed capability.

| Capability | v2 entrypoint | Core/offline execution | Scoring/report evidence |
| --- | --- | --- | --- |
| Text prompt | Native string | Native Core input; existing compilation tests | Existing conformance chain |
| Structured ticket | Actual v2 loader rejects new envelope; explicit text encoding required | Native JSON carriage, adapted deterministic classification | Separate expected exact scoring; positive/corrupted outcomes in verified report |
| RAG ranking/citations | No structured graded relevance/citation fields; context is text | Adapted retrieval over frozen corpus; actual ranking | Exact fixture ranking/citation scoring, not semantic RAG validity |
| History and inventory tool | No native message input field | Adapted history interpretation and file-backed lookup | Actual arguments/results scored; not online conversation simulation |
| Workflow states | No node-state expectations; covers is not an assertion | Adapted file-backed state transitions | Approved/rejected/manual-review and corrupted outcomes; absent output stays nonconclusive |
| Gold isolation | Existing assertion/rubric compilation | Four executor contexts exclude expected/evaluationContext and gold markers | Expected is evaluator-bound; baseline custom-command tests cover process request boundary |
| Interactive sessions, multimodality, production databases | No support inferred here | Not validated in this work | Require dedicated adapters/evidence, not schema acceptance |

Reproduce with `yarn vitest run test/eval-workflows/general-sample-proposal.test.ts`. The four minimal samples and executable logic are colocated in that test file, using existing Core samples rather than an unpublished v3 loader. Runs are local/offline, with isolated per-trial directories and no network, credentials, or model calls. Actual Core analysis/report materialization runs; complete results are serialized and revalidated. Runtime identities and analysis policies belong to the conformance fixture, not registered production instruments. Its verdict is not evidence of model improvement or release eligibility.

## Migration example and implementation decision

For v2 prompt `Q`, context `C`, and no environment, preserve the existing compiled string—including fences—in v3 text mode:

```json
{
  "sampleId": "s1",
  "input": { "inputKind": "text", "text": "Q\n\n```\nC\n```" }
}
```

This is a sample sketch, not a runnable v3 document. Independently preserve rubric/assertion content and bindings; omission from this illustration is not migration permission to discard grading. Turning files_available into readable resources, splitting text into role messages, or reinterpreting context as retrieval gold changes semantics and requires an explicit choice in the preview.

Recommend two reviews: approve the common envelope, explicit adapters, and conservative migration direction first; then implement v3 loading, adapters, capability rejection, migration tooling, and real user-entrypoint acceptance in a separate PR. Continue reading old reports with their original schemas and never reuse old cache identities for changed behavior. Confirm the v2 writer retirement schedule/support window in that implementation PR. This work only delivers design and feasibility evidence; it does not implement migration, change public contracts, or release a version.
