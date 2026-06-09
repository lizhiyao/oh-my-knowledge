# Auto-improve a skill

`omk evolve` runs the inner loop of omk for you: **eval → diagnose → rewrite → eval again**, round after round, keeping only changes that provably help. It's the automated version of "run an eval, read the failures, edit the skill, re-run".

For every flag see the [CLI reference](../reference/cli). This guide covers the workflow and the safety mechanisms you should understand before trusting its output.

## The basic loop

```bash
omk evolve skills/my-skill.md
omk evolve skills/my-skill.md --rounds 10 --target 4.5
```

Each round: evaluate the current skill, ask a diagnostic LLM what's failing, rewrite the skill, evaluate the candidate, and **accept it only if it's actually better**. Stops when it hits `--target` (a composite score) or exhausts `--rounds` (default 5). The original is versioned at `skills/evolve/*.r0.md`. Cost scales with `rounds × samples × variants` — typically minutes to tens of minutes.

## Why it won't just "improve" the score to nonsense

Three defaults guard against the classic failure modes of auto-iteration:

- **Significance accept gate** (on by default): a candidate is accepted only when the bootstrap CI on the diff shows a **statistically significant** gain, not just a higher point estimate. A round that "looks better" by noise is rejected. Disable with `--no-significance-gate` (reverts to point-estimate accept); tune the level with `--significance-alpha` (default 0.05 = 95% CI).
- **Edit budget** (`--edit-budget`, default 0.2): a round may change at most 20% of the skill's lines. Over-budget rewrites are rejected *before* evaluation, so a runaway rewrite can't quietly replace the whole skill (and you don't pay to eval it). `--no-edit-budget` removes the cap.
- **Rejected-edit memory** (on by default): rejected rewrites are fed back into the next prompt so the improver doesn't keep proposing the same losing edit. `--no-reject-memory` turns it off.

## Guarding against train-on-test

If you iterate and accept on the *same* samples you measure on, you'll overfit to them — the score climbs while real quality doesn't. Two flags lock this down:

- **`--holdout-ratio <0..1>`** (default 0 = off): hold out a fraction of samples; accept decisions are made on the **holdout** score, and the weak samples shown to the rewriter come only from the train split. This is the main anti-overfit lever.
- **`--test-ratio <0..1>`** (default 0 = off, requires `--holdout-ratio`): carve out a **locked test set** that is *never* used for selection — it's read exactly once, at the end, for an unbiased generalization score. Use it when you need to report "how well did evolve actually generalize".

```bash
omk evolve skills/my-skill.md --rounds 8 --holdout-ratio 0.3 --test-ratio 0.2
```

## When to reach for it

- You have a real sample set and want a strong first-draft improvement to review — evolve proposes, you keep the diff or not.
- You want to **prove** an iteration helped rather than eyeballing it.

It is **not** a substitute for good samples: evolve can only improve against what you measure. Garbage samples in, overfit skill out. Start from a sample set you trust (see [sample design](../specs/sample-design-spec)).

## Related

- [The three stages](../explanation/three-stage-workflow) — evolve automates the doctor → eval → rewrite inner loop
- [Statistical rigor](../explanation/statistical-rigor) — the bootstrap CI behind the significance gate
- [CLI reference: `omk evolve`](../reference/cli) — every flag
