---
description: Metadata-only registration and zero-request replay of the historical v14 real development capture.
---

# Historical v14 real-window baseline

## Scope and provenance

[Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) records one authorized 2026-10-12 Codex invocation using requested model `gpt-6.1-sol`, original `knowledge-extraction-v14`, response Schema v4 and prompt-only JSON. This previously viewed real software-work development window is not a held-out or representative sample. The subsequent author review was performed by Codex; independent human review was not performed and `goldReady=false` remains unchanged.

The metadata registration is `scripts/bench/assets/entity-extraction-real-v14-baseline-v1/manifest.json`. It binds 18 explicitly listed original files without publishing their contents. It is a benchmark metadata asset, not a new production storage format, a current collector capture, or a grant. This replay verifies exactly the listed 18-file subset. The earlier one-time audit of seven capture files, 21 preparation files and 11 receipt-listed result files is separate; this command does not re-verify that whole set or the old sealed build. The original measurement identity is `sha256:49723bd1c77f619a3b8384c5a344e6405c1ec50f4a093098f62997cb6397b218`.

| Original evidence | Bytes | SHA-256 |
| --- | ---: | --- |
| Input JSON file | 4962 | `ccf08332531aebfadfc7051b6fe4229fd01c2107cc6aaf333d4f4b3ca80563a0` |
| Raw UTF-8 prompt | 35784 | `e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399` |
| Raw UTF-8 assistant output | 32951 | `115fb80e2f4ddabba8c894035c271c0b0c2003665b5ef59f0ecaee6b1434ceb2` |
| Serialized returned executor result | 72449 | `62bb1158cf876262e97e22aeb800e6b16de996e66dce48ce331ca6fd616fcab4` |

The raw output digest hashes `capture/output.json.result.output` encoded as UTF-8, also exactly equal to `capture/runtime.json.output`; it is not the containing JSON file digest. The five-field `output.json.result` projection is not the full executor result. `runtime.json` preserves the serialized returned `ExecResult`, including its returned trace fields, not the raw provider HTTP response or raw CLI transport. The input-file digest binds those JSON file bytes; it does not claim that the full executor task string, Codex wrapper/context, effective system instructions or provider request bytes were captured.

## What stays outside

The complete source, input, prompt, output, runtime, old authorization and local review files remain in the original external directory. `--capture-dir` means the whole original bundle root containing `capture/`, `results/` and `authorization.json`, not its `capture/` child. No parent directories are read. Supply it explicitly; the verifier never searches a home directory, discovers captures, reads credentials, imports the old scripts or executes `sealed-build`. Metadata review does not clear raw runtime text for publication. Full-text publication or a redacted derivative needs a separate data-scope decision; a derivative must retain the original digest and have its own identity.

The metadata preserves the count and JSON-array digest of the four original input limitations plus this non-sensitive summary: selected messages only, omitted tools/system/surrounding context, consistent replacement of URLs/native paths/opaque identifiers, historical claims not verified as current behavior, and 24 unparsed outside records making overall source completeness unknown. They describe evidence scope, not instructions to the verifier. The old storage replay used new wrapper/reference identities; those wrappers are not the original model request. This verifier uses the original frozen input and output directly and never substitutes the wrapper; it checks the original limitation arrays for equality locally without emitting their strings.

## Replay without requests

Use an already built checkout and a clean Node process without loaders, preloads or inherited runtime options. Replace both absolute paths explicitly; the original directory location is recorded in the linked Issue.

```sh
env -i PATH=/usr/bin:/bin TMPDIR=/tmp \
  /absolute/path/to/node scripts/bench/assets/entity-extraction-real-v14-baseline-v1/verify.mjs \
  --capture-dir /absolute/external/frozen-bundle
```

An optional `--out /tmp/new-replay-report.json` writes one new private report, outside both the checkout and capture directory. Existing files are never overwritten. By default only metadata is printed: hashes, identities, counts and states; no original text, entity labels, local capture paths or native parser errors. Missing, modified or symlinked fixed files fail closed before production imports. Node runtime options are refused. Network/listen/subprocess entry points are guarded before deterministic production imports. Their attempt counts are observed; the absence of executor imports and credential access is a source-code scope statement, not an instrumented global counter.

Imports are fixed literal repository `dist` decoder/domain/checker/prompt paths. The verifier does not build, fetch, dispatch, import an executor, run an old `.mjs`, import `sealed-build`, or load a benchmark corpus. It reads each original through a fixed-length-plus-one-byte cap and verifies the closed file list, original raw hashes, historical measurement identity and exhausted authorization bindings first. The original transport follows the same `JSON.parse` and production admission path used for prompt-only responses. A separate strict-wire decoder diagnostic does not add nulls, repair the output or change this transport.

## Observed result and limits

The 2026-10-16 local offline replay admitted 19 entities, 19 mentions and 3 proposals, containing 10 statements, 9 citations and 9 evidence links; entity/proposal rejections were zero and all 3 drafts passed the current domain Schema. Two runs of admission within the verifier produced the same digest. Fetch/socket/listen/HTTP/TLS/datagram/subprocess attempts and new model dispatches were zero. Original files were unchanged.

The newer strict-wire diagnostic was `decoded` / `item_failures` with 18 failing items. This is retained as a format diagnostic, not a failed historical prompt-only result or a strict-wire success. The verifier emits `diagnostic_mismatch` and exits 1 if current structural counts or domain validity differ from the frozen history; it does not update the expected history to pass. A current checker exception retains the new replay identity and reports unknown counts as null without exposing its native error.

Each new offline verification identity binds the registration, verifier, original input/output digests, current prompt/wire identity, eight compiled components, actual Zod/Ajv versions and Node binary/version. The current active prompt hash/match is observational metadata, not a requirement that production remain on v14. It is separate from the old measurement identity, and is not a complete transitive dependency-byte closure. It proves integrity and deterministic structure/location/reference replay, not semantic accuracy, stability, causality, independent review or successful new generation. See the [evaluation protocol](./entity-extraction-evaluation.md).

## Authorization and comparison

The old authorization allowed only the exact frozen four redacted messages plus v14/Schema v4 to one Codex `gpt-6.1-sol` invocation, with no automatic retry. That allowance was consumed and closed: remaining calls are zero. It authorizes no new dispatch, new experiment or publication of raw text. One OMK invocation and the returned turn count do not establish the number of internal provider requests or billed calls.

`gpt-6.1-sol` is the requested model, not a provider-attested snapshot. Provider-reported model/snapshot/endpoint and provider request count were not recorded and remain unknown. Executor metrics recorded 12,681 input and 8,493 output tokens; missing per-bucket usage provenance must not be filled from today's executor semantics. Cached numeric values do not establish provider reporting; the executor's zero cost placeholder with `costReportedByExecutor=false` means unknown USD cost. Zero API duration likewise does not establish actual provider latency.

This original prompt-only v14 baseline is separate from both `v14-derived-strict` and `v15-candidate-strict`. It cannot be pooled into their matching conditions, repeats or improvement estimates. The existing two-arm proposal remains pending separate authorization and independent human evidence; this registration supplies neither and activates no production prompt.
