# Four-positive strict-wire candidate assets

[简体中文](./README.zh.md)

This inactive experiment bundle preserves four newly authored synthetic **prompt demonstrations** for Issue #1236 P2-A. It changes no production prompt, central registry, collector, persisted run, or default. No model experiment has run; author/human review and independent human review remain pending, with no Gold or quality conclusion. The examples are not an evaluation split. Case names do not establish negative-sibling or partial-admission failure coverage.

## Frozen data and contrast

| Arm | Raw UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| `v14-derived-strict` | 31884 | `d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d` |
| `v15-candidate-strict` | 41017 | `7bf5c9fbf5e181346c76f84963911adf5b25a52db954d1e80495327b476f0dd6` |

The control is **derived** from original v14, whose raw hash is `e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399`. Both arms share its rule prefix, the same strict-wire instructions, final output rule and wire Schema. Their only byte difference is the four complete input→wire-output demonstrations plus one LF: 9133 bytes. This is not a comparison of original prompt-only v14 with strict-wire. No token overhead has been measured.

`manifest.json` binds the six data files. `source-manifest.json` is the untouched provenance index of the original 29-file temporary bundle (digest `sha256:4179285127f38cd561cfe1169ec3e7cf4970b41f3a88249ed1c2660351faeaef`), not an entry point requiring all 29 files here. Duplicate raw-v14/raw-v15 snapshots, per-example files and machine-specific preparers are deliberately omitted. Combined examples plus the original index preserve the expected input, wire-output and domain-output hashes.

The frozen wire ID is `sha256:9a9985e1806f0ab2225fb6e86b944382fcb3f47624a35d1211f4d6973679859a`; raw wire Schema digest is `sha256:a11c474841b5f73a681794e25725ba77d35e2570fc9939757206d366f0d71b69`. Domain Schema is v4, Zod is 4.6.5 and Ajv is 8.20.0. Equal Schema bytes alone do not establish the same wire identity. Exactly two missing statement `object` fields were represented as null; existing integer occurrences, including 0 and 2, and domain-semantic nulls stay unchanged.

## Reproduce the offline author check

Use a checkout whose runtime has already been built. If `dist` is absent or stale, build it once using the repository workflow; this verifier never builds it automatically. From the repository root:

```sh
node scripts/bench/assets/entity-extraction-four-positive-strict-v1/verify.mjs
node scripts/bench/assets/entity-extraction-four-positive-strict-v1/verify.mjs \
  --out /tmp/new-four-positive-verification.json
```

The runtime is fixed to repository-relative `dist`, independent of the current directory. Imports are literal and cannot be selected by an input manifest or argument; another runtime needs a separate checkout of these assets. The command reads only these assets, fixed deterministic production wire/domain/checker/prompt modules, validator metadata and Node bytes. It imports no executor, benchmark corpus, held-out cases or real source. The default writes nothing; optional output must be a new file outside the checkout under an OS temporary directory. Existing reports are never overwritten.

The verifier checks every frozen data hash and the exact byte insertion, then uses the actual production decoder, domain Schema, admission checker and KnowledgeDraftSchema. Each mapped domain output must retain its original authored serialization hash; current checker counts must match all four author expectations (7 entities, 9 mentions, 2 accepted drafts in total, no rejections). This is structural/location/reference evidence, not independent semantic validation. Validator or wire identity drift fails closed; preserve this bundle and create a separately reviewed new identity rather than silently updating it.

The emitted `verificationId` binds the asset manifest, verifier, actual wire identity, Zod/Ajv versions, Node binary/version and eight listed compiled components. It is an offline verification identity, **not** a complete model measurement or a byte closure of transitive dependencies. Production v14 is read; the registry is untouched.

## What the existing collector can and cannot replay

The existing collector supports `v14-derived` / `v15-candidate`, `json-schema` and the exact `--wire-schema`; see [capture tools](../../README.md). It does not consume this bundle manifest as `--source` or `--review-bundle`. This bundle is neither `omk-entity-capture-source/v1` nor a frozen review corpus/measurement bundle.

Do not feed these four demonstrations back as quality-evaluation cases: the candidate already contains their answers. Their `frost-1` / `cup-1` / `heron-*` / `beacon-1` references are also not the collector's required `caseId:recordIndex`, and three inputs have empty limitations, while capture-source/v1 requires a nonempty list. Do not rewrite those frozen inputs merely to satisfy admission. A source transformation would have a new identity and still be demonstration resubstitution, not unseen validation.

A later experiment needs separately authored, reviewed, unseen development inputs in capture-source/v1, explicit case/group isolation, a supported exact model/endpoint/budget profile, and new external plans. Only then can the existing **zero-request** preparation path bind the two prompts, for example:

```sh
node dist-scripts/bench/entity-extraction-capture.js prepare \
  --source /absolute/unseen-development-source.json \
  --prompt scripts/bench/assets/entity-extraction-four-positive-strict-v1/v14-derived-strict.prompt.txt \
  --wire-schema scripts/bench/assets/entity-extraction-four-positive-strict-v1/wire-schema.json \
  --config /absolute/reviewed-control-config.json --out /tmp/new-control-plan
```

The other arm uses the candidate prompt and `promptVariant: "v15-candidate"`; the control label is `"v14-derived"`, never `"v14-original"`. Both configurations must otherwise match: selected source/cases/split, repeats, executor/model/endpoint/profile, `outputMode: "json-schema"`, schemaName, timeout, output ceiling, call/token limits and retry policy. Each generated `planId` newly binds input/request bytes and actual host/checker/collector/dependency/guide/validator/Node identities; this asset manifest cannot substitute for it. Prepare grants no permission.

`check`, `replay` and `compare` also send zero requests. Empty plans or matching conditions are not a completed experiment. Actual execution requires separate user permission and a reviewed grant for each plan; this bundle provides neither. The current comparison reports pairing order as not attested and semantic/human review as pending: balanced order, cache/order controls, aggregate two-arm budget, independent adjudication and a decision rule remain additional work. Neither the old prompt-only v14 results nor these demonstrations establish a few-shot improvement, generalization, precision/recall or release readiness.
