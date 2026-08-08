# Real Codex task trajectory

[中文说明](./README.zh.md)

This example turns a redacted real Codex Desktop task into an OMK task trajectory. The user asks whether Codex Memory is enabled by default. Codex then:

1. reads the `openai-docs` skill;
2. attempts to fetch the Codex manual;
3. retries after the first command fails;
4. searches the fetched manual;
5. answers the user.

The event order, timestamps, user request, assistant messages, tool inputs, tool statuses, and tool outputs come from the captured task. Unrelated turns and system context were removed. User paths, temporary paths, session identifiers, and event identifiers were replaced. Long tool outputs were truncated after redaction.

The answer records product behavior at capture time and is demo evidence, not current Codex documentation.

## Open in Studio

From the repository root:

```bash
yarn build
node dist/cli/index.js observe ingest \
  examples/codex-task-trajectory/trace \
  --output-dir .omk/task-trajectory-demo
node dist/cli/index.js studio \
  --observations-dir .omk/task-trajectory-demo
```

Open the task trajectory from the Observe Inbox. The semantic trajectory spaces operations evenly and aligns Knowledge, action, and result cards in the same operation column. Scroll horizontally through the full sequence; intervals longer than one minute without observable events are compressed and labeled. Select an operation for related evidence, switch to **Normalized events** to inspect Trace IR, or use **Raw logs** to verify the archived JSONL input.
