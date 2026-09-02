# Codex parent/subagent observe case

[中文说明](./README.zh.md)

This executable case feeds two sanitized Codex Desktop rollout files into
`omk observe`:

- one parent task that loads the `repo-review` skill and encounters a failed
  search;
- one `review` subagent that shares the logical session, loads the same skill,
  and completes a parser check.

The event shape comes from a real Codex parent/reviewer-subagent rollout.
Session IDs, paths, commands, and business text were replaced. The fixture
contains no credentials or private repository data.

## Run against the published package

From the repository root:

```bash
npm exec --yes --package=oh-my-knowledge@latest -- \
  node examples/codex-observe-router/verify.mjs
```

After npm downloads the package, the verification is local and deterministic.
It does not call a model.

## Run against local source

Build first, then point the verifier at the local CLI:

```bash
yarn build
OMK_BIN="$PWD/dist/cli/index.js" \
OMK_PACKAGE_ROOT="$PWD" \
node examples/codex-observe-router/verify.mjs
```

Set `OMK_KEEP_OUTPUT=1` to retain the generated report directory for manual
inspection.

## What it verifies

The script exits non-zero unless all of these properties hold:

- two physical rollout files become one logical session;
- the source remains `codex`;
- the parent/subagent relation becomes one external-child edge;
- every referenced graph endpoint exists;
- the router has downstream completion evidence;
- the failed search becomes one `failed_search` inbox signal;
- the compact persisted report reloads without losing the Trace IR graph.

## Evidence boundary

This is a protocol and persistence case, not a quality benchmark. It does not
claim that every historical Codex rollout variant is covered. Using `@latest`
exercises the current published CLI; pin an explicit package version when
reproducing a historical result.
