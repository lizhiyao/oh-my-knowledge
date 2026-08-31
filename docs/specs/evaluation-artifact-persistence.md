# Evaluation Core artifact persistence

> Status: host persistence contract for [#531](https://github.com/lizhiyao/oh-my-knowledge/issues/531), slice 1. It does not switch `omk eval`, read legacy reports, or make transported JSON a trusted Core capability.

## 1. Boundary

Evaluation Core remains pure and in-memory. The host persists one immutable run artifact set:

1. the versioned `RunPlan` wire document;
2. `ExecutionBundle`;
3. `EvaluationBundle`;
4. `AnalysisBundle`;
5. `EvaluationReport`.

The Plan is required because Bundle digests identify a sealed measurement contract but cannot reconstruct it. Persisting only results would force resume to trust summaries or recompile against ambient state. The host manifest is a locator and integrity projection, not a sixth measurement fact.

## 2. Authority and verification

On publication and full read, the store validates:

- every wire schema and native artifact digest;
- the Plan's recomputed dataset, stage, randomization, and run-contract digests;
- Execution → Evaluation → Analysis → Report parent digests;
- Report Bundle references, status, budget summary, Decision binding, and provenance parents;
- manifest document digests and maximum captured-content classification;
- every referenced content descriptor through an injected resolver.

This proves transport integrity and exact lineage, not provenance authenticity. A persisted `RunPlan` is returned as a wire document and is never rebranded as `SealedRunPlan`. Resume must prepare the current Definition and MeasurementPolicy, obtain a fresh sealed Plan capability, and run the Core plan-aware Bundle verifiers before reuse. Digest equality alone cannot mint source trust, cache receipts, or Runtime attestation.

## 3. Atomic publication

Each run uses an opaque directory derived from the SHA-256 of `runId`; user identifiers never become path segments. The host writes all five documents and the manifest into a private staging directory, writes the manifest last, then publishes the directory with one same-filesystem rename. Readers enumerate only published `run-<digest>` directories. Interrupted hidden staging directories are invisible and can be cleaned independently.

A `runId` is immutable. Re-publishing the exact document set is idempotent; a different set under the same ID fails. In-process writes are serialized per run, and the directory publication step also resolves cross-process races to one complete winner. Corrupt published runs fail explicitly instead of disappearing from list results.

Directories use owner-only permissions and files use owner read/write permissions because a full Plan can contain expected or evaluation-only inputs. Paths are host effects and never enter Core documents or measurement digests.

## 4. Manifest and index

`omk.core-run-artifact-manifest/v1` uses qualified discriminants (`manifestKind`, `documentKind`). Its five references have fixed relative filenames, schema identity, native identity digest, and a canonical full-document digest. It also records run/report identity, run-contract digest, orthogonal Report status, Execution/Evaluation replayability, creation time, and maximum captured-content classification.

An index card is a pure projection of a validated manifest. Listing may rebuild cards without resolving large content because it does not claim evidence availability. Loading a full run requires descriptor closure; a missing resolver or corrupt content fails instead of projecting empty evidence.

## 5. Host content store

The Node content store implements the existing Execution and Evaluation content ports. It verifies the caller-provided value digest before writing and stores a private, content-addressed envelope. Identity includes value digest, media type, and classification so the same bytes classified as `public` and `gold` cannot alias or downgrade each other. Descriptors use an opaque `omk-content:` URI and never expose a filesystem path.

Resolution revalidates envelope digest, descriptor, canonical value digest, media type, byte size, and classification. Failures use stable, redacted codes; raw filesystem paths and content do not become Core errors.

## 6. Non-goals

- legacy `EvaluationReport` readers, migration, or dual writes;
- resume admission or cache reuse;
- batch, evolve, gold compare, artifact graph, or Studio projections;
- the production CLI cutover and old pipeline deletion;
- artifact signatures or provenance attestation.

Those consumers build on this transport boundary in later #531 slices. The final CLI switch remains a separate `BREAKING-SCHEMA` change under #450.
