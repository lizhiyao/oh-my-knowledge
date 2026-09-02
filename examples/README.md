# OMK examples

[中文说明](./README.zh.md)

These examples cover specialized workflows after the first-run tutorial. To learn the core control/treatment loop, start with the scaffold instead of copying an example directory:

```bash
omk init demo
cd demo
omk eval --control code-review-v1 --treatment code-review-v2 --dry-run
```

Use `omk init demo --samples 20` when you want the first-party, difficulty-stratified starter pack instead of the default three-case workflow check.

## Choose by task

| Task | Example | What it demonstrates | First command | Model call |
|---|---|---|---|---|
| Inspect a directory skill | [skill-map-showcase](./skill-map-showcase) | Frontmatter, references, scripts, workflows, private samples, Doctor, and Skill Map | `cd examples/skill-map-showcase && omk doctor skills/release-readiness --static-only` | No |
| Evaluate grounded answers | [rag-eval](./rag-eval) | `faithfulness`, `answer_relevancy`, and `context_recall` assertions | `cd examples/rag-eval && omk eval --control context-answerer --treatment rag-answerer --dry-run` | No for dry-run; yes for evaluation |
| Evaluate repository-aware agents | [agent-runtime](./agent-runtime) | A sample-scoped working directory and file-backed task evidence | `cd examples/agent-runtime && omk eval --control repo-answerer --treatment repo-navigator --dry-run` | No for dry-run; yes for evaluation |
| Integrate an executor | [custom-executor](./custom-executor) | Current sealed JSON stdin/stdout contract, deterministic local smoke test, and an Ollama adapter | `cd examples/custom-executor && omk eval --control baseline --treatment echo-assistant --executor ./echo-executor.sh --no-judge --report-only` | No for the echo executor |
| Verify Codex trace ingestion | [codex-observe-router](./codex-observe-router) | Parent/subagent routing, Trace IR, gap signals, and compact report persistence | `yarn build && OMK_BIN="$PWD/dist/cli/index.js" OMK_PACKAGE_ROOT="$PWD" node examples/codex-observe-router/verify.mjs` | No |
| Explore a real task trajectory | [codex-task-trajectory](./codex-task-trajectory) | A redacted Codex task rendered as Knowledge, action, result, normalized-event, and raw-log evidence | `yarn build` followed by the commands in the example README | No |

## Example contract

Every directory in this catalog has a distinct user-facing purpose, English and Chinese instructions, a copyable entry command, explicit runtime requirements, and a statement of what the case cannot prove. Evaluation samples use the canonical `omk.eval-sample-set/v1` protocol. JSON and YAML are both demonstrated intentionally, but a single sample scope must not contain both formats.

Generated reports, graphs, and Doctor artifacts belong under the project-level `.omk/` directory and are ignored by Git. A directory skill may keep its versioned source samples under `skills/<name>/.omk/eval-samples.json` or `.yaml`; those files are inputs, not generated reports.

The checked-in sample sets are deliberately small enough to read and run. They validate workflows and protocol integration; they are not statistically powered release evidence. Before using an OMK verdict to ship a real artifact, build a representative domain sample set and review its construct coverage.
