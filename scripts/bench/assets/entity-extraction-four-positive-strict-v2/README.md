# Four-positive strict-wire candidate assets: revision 2

[简体中文](./README.zh.md)

Inactive prompt demonstrations for Issue #1236 P2-A. Itemwise AI author review found and corrected two source-boundary issues; `author-review.json` records the review. Human and independent human review remain pending, Gold is none, and model quality is not evaluated. The production prompt and registry are unchanged.

## Revision

- The capacity example now says the source states the capacity, without implying an executed measurement.
- The release-gate example keeps its prohibition citation and adds the exact sentence stating that the window contains no release execution record, directly locating the statement's unknown limitation.
- The two revised example IDs advance to v2. All four inputs and the other two outputs are preserved.

All files in [revision 1](../entity-extraction-four-positive-strict-v1/README.md) retain their original bytes. `manifest.json` binds the old manifest/example/candidate digests and seven new data files. `source-manifest.json` remains the historical index of the original 29-file temporary bundle, not a source of new output digests. This revision's manifest records new per-example input, wire-output and domain-output digests.

## Frozen contrast

| Arm | Raw UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| `v14-derived-strict` | 31884 | `d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d` |
| `v15-candidate-strict` | 41158 | `097bf49208e596afdd8df67c1d4091dfeb730ad92d00f30e880df64463913254` |

Both arms share the original rule prefix, strict-wire instructions, final output rule and Schema. The sole difference remains four complete examples and one LF, now 9274 bytes. Token overhead is not measured. The repository runtime uses Zod 4.6.5 / Ajv 8.20.0 and wire ID `sha256:9a9985e1806f0ab2225fb6e86b944382fcb3f47624a35d1211f4d6973679859a`; this revision preserves that wire identity.

## Reproduce the offline check

Ensure `dist` is current using the repository build workflow, then run:

```sh
node scripts/bench/assets/entity-extraction-four-positive-strict-v2/verify.mjs
node scripts/bench/assets/entity-extraction-four-positive-strict-v2/verify.mjs \
  --out /tmp/new-four-positive-v2-verification.json
```

The verifier uses fixed repository-relative paths, checks the preserved parent bindings, new data hashes, author-record closure and exact example-block bytes, then invokes the actual production decoder, domain admission and KnowledgeDraftSchema. Totals remain 7 entities, 9 mentions, 2 accepted drafts and zero rejections. The host computes exact positions for the new citation; structural success does not establish semantic correctness.

The command imports no executor, reads no real source or evaluation split and sends zero model requests. Its default writes nothing. An optional report must be a new file outside the checkout under an OS temporary directory. `verificationId` binds the new manifest, verifier, actual validator/wire, Node and listed compiled modules, not a full model measurement or all transitive dependencies. Validator/wire drift fails closed; never silently reset the baseline.

## Later experiment boundaries

These demonstrations already put their answers in the prompt and must not be reused as unseen quality-evaluation cases. Completed AI author review establishes neither independent human approval, Gold nor a few-shot improvement.

Changed candidate prompt bytes are **BREAKING-COMPARABILITY** relative to revision 1. Old plans, permissions and results retain their old identities and cannot be transferred. A later experiment using the [capture tools](../../README.md) needs newly frozen sources, actual runtime/wire, both requests and budgets, new plans, and the corresponding execution permission. This bundle provides no permission and executes no experiment. Record repository and isolated installed-runtime validator identities separately; evidence for one cannot certify the other.
