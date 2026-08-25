# ChatGPT observation trigger validation

`eval-samples.json` defines the behavior contract for direct, indirect, and negative observation prompts.

Run the suite only with an agent executor that is connected to the OMK MCP server and reports normalized MCP tool names in its trace. The executor must expose at least `capture_observation`, `record_observation_review`, and `draft_sample_from_observation`. A text-only executor cannot prove that a tool was or was not called.

The suite separates two constructs:

- Trigger behavior: an explicit request records immediately; an indirect correction asks for confirmation; a negative or hypothetical prompt does not record.
- Lifecycle safety: capture never skips human review, a draft requires `real_issue`, and no ChatGPT-side action writes directly to the formal evaluation set.

Before comparing prompt or skill versions, keep the model, tool schemas, MCP server version, and executor policy fixed. Otherwise the result is not a controlled knowledge-only comparison.
