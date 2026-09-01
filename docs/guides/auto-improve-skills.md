# Auto-improve a skill

`omk evolve` runs the inner loop of omk for you: **eval → diagnose → rewrite → eval again**, round after round, keeping only changes that provably help. It's the automated version of "run an eval, read the failures, edit the skill, re-run".

For every flag see the [CLI reference](../reference/cli). This guide covers the workflow and the safety mechanisms you should understand before trusting its output.

## The basic loop

```bash
omk evolve skills/my-skill.md
omk evolve skills/my-skill.md --rounds 10 --target 4.5
```

Each round: evaluate the current skill, ask a diagnostic LLM what's failing, rewrite the skill, evaluate the candidate, and **accept it only if it's actually better**. Stops when it hits `--target` (a composite score) or exhausts `--rounds` (default 5). The original is versioned at `skills/evolve/*.r0.md`. Cost scales with `rounds × samples × variants` — typically minutes to tens of minutes.

Every retained round must keep the same sample hashes, model, executor, judge configuration, runtime fingerprint, execution strategy, and skill-isolation state. If any of these drift, Evaluation Core refuses to treat the comparison as a knowledge-only improvement. Measurement artifacts remain immutable Core runs; end-to-end evolve cost is reported separately by the authoring loop.

## Why it won't just "improve" the score to nonsense

Three defaults guard against the classic failure modes of auto-iteration:

- **Evaluation Core decision gate**: every candidate is measured as a fresh control／treatment A/B run and accepted only when Core returns `PROGRESS` with `release-gates-passed` and the candidate score exceeds the current score. Runtime, evidence, comparability, uncertainty, and release-policy failures therefore fail closed; the authoring loop cannot replace that decision with a private score heuristic.
- **Edit budget** (`--edit-budget`, default 0.2): a round may change at most 20% of the skill's lines. Over-budget rewrites are rejected *before* evaluation, so a runaway rewrite can't quietly replace the whole skill (and you don't pay to eval it). `--no-edit-budget` removes the cap.
- **Rejected-edit memory** (on by default): rejected rewrites are fed back into the next prompt so the improver doesn't keep proposing the same losing edit. `--no-reject-memory` turns it off.
- **Final write-back gate**: before changing the source, evolve re-evaluates the untouched original against the selected snapshot. A failed final Core decision leaves the source unchanged. Use `--snapshot-only` to keep candidates under `evolve/` without writing the source.

## Guarding against train-on-test

If you iterate and accept on the *same* samples you measure on, you'll overfit to them — the score climbs while real quality doesn't. `omk evolve` deliberately does not claim an unbiased generalization estimate from its selection dataset. Keep a separate, preregistered validation dataset outside the authoring loop and run a fresh release evaluation after evolve:

```bash
omk evolve skills/my-skill.md --rounds 8
omk eval --control original-skill --treatment skills/my-skill.md --samples release-validation.json
```

Do not feed failures from `release-validation.json` back into the same evolve session; doing so turns it into another selection set. For a human approval step, run evolve with `--snapshot-only`, inspect the candidate, then evaluate and promote it separately.

## When to reach for it

- You have a real sample set and want a strong first-draft improvement to review — evolve proposes, you keep the diff or not.
- You want to **prove** an iteration helped rather than eyeballing it.

It is **not** a substitute for good samples: evolve can only improve against what you measure. Garbage samples in, overfit skill out. Start from a sample set you trust (see [sample design](../specs/sample-design-spec)).

## Related

- [The three stages](../explanation/three-stage-workflow) — evolve automates the doctor → eval → rewrite inner loop
- [Statistical rigor](../explanation/statistical-rigor) — uncertainty and comparability in Core release decisions
- [CLI reference: `omk evolve`](../reference/cli) — every flag
