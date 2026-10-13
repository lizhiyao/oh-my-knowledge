# Use an OpenAI-compatible endpoint or local model

First prepare explicit control/treatment variants and v3 samples; see the [evaluation quickstart](../../quickstart-skill-eval.md). Executors choose invocation mechanics; model IDs and endpoints come from services you can actually access. Historical model examples are not a current availability catalog.

## OpenAI-compatible HTTP endpoint

Current `openai-api` appends `/v1/chat/completions` to `OPENAI_BASE_URL` and sends text messages using a Bearer API key. The Base URL must stop before that path; do not add `/v1` twice or a trailing `/`. Only services matching this request shape work directly; non-standard routes require your adapter.

```bash
export OPENAI_API_KEY="<your-api-key>"
export OPENAI_BASE_URL="https://your-compatible-endpoint.example"
omk eval --control baseline --treatment ./skill.md   --samples ./eval-samples.json --executor openai-api   --model '<available-model>' --judge-models 'openai-api:<available-judge-model>'
```

Check actual model IDs, request routes, and access before calling the service. This command calls the selected models; connectivity alone does not establish sufficient measurement evidence. Direct APIs provide neither native Agent tool traces nor mock hooks. See [executor support](../../reference/integration/executors.md) for needs beyond text input.

## Local model example

`examples/custom-executor` supplies an Ollama adapter. Read its instructions and start your local model service before running an installed model:

```bash
cd examples/custom-executor
omk eval --control baseline --treatment echo-assistant   --executor "python ollama-executor.py" --model '<installed-model>'   --no-judge --report-only
```

These are small teaching samples. `--report-only` displays conclusions without making them control exit status; it does not establish release quality.

## About judges

`--judge-models` configures rubric judges as `executor:model[,executor:model]`; choose a model available at the endpoint explicitly. `--no-judge` skips that LLM judge. RAG assertion judge calls have separate boundaries and do not inherit rubric repeats/ensemble automatically; see the [RAG specification](../../specs/evaluation/rag-metrics-spec.md).

<a id="use-non-claude-models"></a>
<a id="about-the-judge"></a>
