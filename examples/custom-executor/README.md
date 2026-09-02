# Custom executor

[中文说明](./README.zh.md)

## Purpose

This example demonstrates OMK's custom-command JSON stdin/stdout contract without requiring a hosted model. It includes:

- `echo-executor.sh`: deterministic, zero-cost protocol smoke test;
- `ollama-executor.py`: local Ollama adapter.

## Run

Run the deterministic path without an LLM judge:

```bash
omk eval --control baseline --treatment echo-assistant \
  --executor ./echo-executor.sh --no-judge --report-only
```

`--no-judge` leaves only deterministic assertions. `--report-only` still writes and prints the report but does not let this deliberately tiny sample set control the process exit code.

To try a local Ollama model:

```bash
omk eval --control baseline --treatment echo-assistant \
  --executor "python ollama-executor.py" --model llama3 --no-judge --report-only
```

## Evidence boundary

The echo path verifies request transport, executor response parsing, assertions, and report production. Because it returns predetermined text and skips the judge, it does not measure model or artifact quality. The Ollama adapter is a reference implementation; review timeout, retry, model lifecycle, and data-handling requirements before production use. Hosted OpenAI-compatible services should use OMK's built-in `openai-api` executor instead of copying a credential-handling script.
