# Reproduce historical extraction-quality records


Both capture commands below are historical v3 tools and must be reproduced with the source and build frozen by the corresponding report. The current runtime rejects these historical commands before configuring a model; changing `--prompt` cannot bypass the format boundary. Preserve the original dependencies, corpus, guide, and measurement identity instead of rescoring old results with current artifacts. For today's protocol see [entity extraction evaluation](../entity-extraction-evaluation.md); use the [entity evidence index](../index.md) for historical records.

Entity coverage uses the 16-case `test/fixtures/entity-extraction-quality.json` corpus (`omk-entity-quality/v2`). Beyond the original 12 cases it covers tool/log granularity, project-scoped paths and explicit renaming, corrections across turns with environment separation, and plans versus execution. Critical positions, identity separations, uncertainty, and role checks are frozen before output; the model receives source messages and coverage limits, never these answers. These remain synthetic cases, not a real-log distribution.

```bash
yarn build:runtime
node dist-scripts/bench/entity-extraction-quality.js --model <fixed-model> --repeat 2 --output /absolute/outside/repository/new-entity-run
```

Each case defaults to one call; `--repeat 2` makes two independent samples, at most 32 calls, without automatic retries. Separate subdirectories preserve each output. `critical-checks.json` uses `omk-entity-critical-checks/v1` to distinguish exact/containing spans, identity groups, separation, ambiguity, and observed knowledge roles. Optional knowledge omissions differ from role errors; extra entities still need semantic review. Repeated sampling is not deterministic replay or population-level stability evidence. Use `--prompt /absolute/previous-run/prompt.json` for a frozen prompt using the historical v3 format; retain exact prompt bytes, corpus and input digests, and review outputs separately. Output must be a new directory outside the checkout. A successful exit means capture and structural admission succeeded, not semantic acceptance. Inspect and authorize message transmission before model calls; unreported cost remains unknown. The completed [v2/v3 report](entity-extraction-quality.md) includes original evidence and its self-review limits; v2 is historical evidence and can no longer be replayed with the current tool.

Actual results on those historical 16 cases are in the [two-round entity acceptance report](entity-extraction-repeat-quality.md): collective references, quotation location, environment identity scope, and case organization still fail. Raw outputs, rejections, and self-review are retained separately; retries have not replaced failures.

Contributors can run six fixed cases in `test/fixtures/knowledge-extraction-quality.json`: empty content, unverified success, later correction, conditional rules, insufficient evaluation evidence, and a single outcome with gaps. These are synthetic scenarios and a repository rule excerpt, with review criteria written before generation; they are not an independently reviewed gold set or a representative sample of real conversations.

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-extraction-quality.js --model <fixed-model> --output /absolute/outside/repository/new-run
```

This developer tool uses the existing Codex executor and makes one call per case without retries. Inspect the selected message text and authorize its transmission before running; costs are unknown unless reported. It includes the message-only coverage limitation and excludes review criteria from model input. It writes only to a new directory outside the checkout, preserving the prompt, corpus, digests, raw outputs, rejection reasons, and runtime metadata. Interrupting stops further calls. A successful exit means capture and structural validation succeeded; semantic review remains pending.

Review every output against its case criteria and original messages, recording omissions, misinterpretations and unnecessary candidates. Keep self-review distinct from independent human review. For a prompt comparison, preserve the first run’s `prompt.json`, use `--prompt /absolute/first-run/prompt.json` to reproduce a prompt using the historical v3 format, keep model and corpus identical, and verify matching input digests. One run per case can expose a failure; it cannot establish stable extraction quality, a population improvement, or carrier effectiveness. Keep the current prompt when no observed failure justifies changing it.
