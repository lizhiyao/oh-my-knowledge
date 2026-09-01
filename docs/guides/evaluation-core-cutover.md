# Evaluation Core cutover

> **BREAKING-SCHEMA:** `omk eval` now writes and reads only Evaluation Core artifacts.

There is no legacy reader, dual write, shadow run, schema migration, or automatic conversion. Evaluation reports created before this cutover cannot be opened in Studio, resumed, compared with Gold, or used by `omk evolve`. Keep the old OMK version if you need to inspect those files.

New runs are directories addressed by a Core `runId`. Each directory publishes a manifest plus the exact sealed Run Plan, Execution Bundle, Evaluation Bundle, Analysis Bundle, and Evaluation Report. A missing document, digest mismatch, broken lineage, or unresolved content reference fails closed.

Operational changes:

- pass a Core `runId`, not a report path, to `omk eval --resume`;
- pass a Core `runId` to `omk eval gold compare`, with explicit `--target`, `--evaluator`, and `--metric` selectors;
- Studio lists only Core evaluation runs; doctor and observe documents remain independent;
- managed evidence and evolve acceptance are admitted only from authenticated Core projections;
- diagnostic post-processing projects only authenticated Core failures, missing evidence, exclusions, and stable reason codes; it does not read legacy result rows or invent recommendations;
- independent `--repeat` runs publish run-level variance as Series analysis; without a preregistered Series decision, the release gate fails closed and member runs are not admitted as managed evidence;
- `--dry-run` assembles Runtime and prepares a sealed plan without opening a Target or Evaluator.

This cutover changes the storage and application schema, not the measurement construct. Frozen evaluator prompts, the five scoring layers, Bootstrap confidence intervals, Krippendorff alpha, and length-debias semantics are unchanged.
