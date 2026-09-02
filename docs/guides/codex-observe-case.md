# Reproduce Codex parent/subagent observation

This case demonstrates the complete local path from raw Codex Desktop rollout
records to a reloadable observe inbox report:

```text
Codex JSONL → source-neutral Trace IR → parent/subagent graph
            → knowledge-gap signal → compact report → reload
```

The fixture is in
[`examples/codex-observe-router`](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/codex-observe-router).
Its protocol shape comes from a real parent/reviewer-subagent run, with all
session IDs, paths, commands, and business text replaced.

## One-command reproduction

Clone the repository, then run from its root:

```bash
npm exec --yes --package=oh-my-knowledge@latest -- \
  node examples/codex-observe-router/verify.mjs
```

Expected summary:

```json
{
  "omkVersion": "0.49.0",
  "physicalTraceFiles": 2,
  "logicalSessions": 1,
  "observedSkills": ["repo-review"],
  "sourceKind": "codex",
  "externalChildEdges": 1,
  "edgeEndpointsClosed": true,
  "routerDownstreamCompleted": 1,
  "inboxSignals": 1,
  "inboxSignalTypes": ["failed_search"],
  "compactReportRoundTrip": true
}
```

The run is deterministic and makes no model calls. Set
`OMK_KEEP_OUTPUT=1` if you want to inspect the generated
`.omk/observe/inbox` report.

## Why this case matters

Counting two files is easy. The useful boundary is whether omk can preserve
physical-trace provenance while reconstructing one logical session, attach the
child task without dangling graph references, retain the failed-search signal,
and reload the compact report with the same meaning.

The verifier asserts those properties directly. It intentionally does not
score skill quality or claim coverage of every Codex rollout version.

## Run against local changes

```bash
yarn build
OMK_BIN="$PWD/dist/cli/index.js" \
OMK_PACKAGE_ROOT="$PWD" \
node examples/codex-observe-router/verify.mjs
```

See [Observe production traces](./observe-production) for normal project
usage and the reviewer workflow.
