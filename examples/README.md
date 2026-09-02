# omk examples

这是一组更少、更聚焦的示例。每个目录都对应一个清晰场景：看 skill 结构、做 A/B、测 RAG、测 agent 运行上下文，或不用 Claude 跑通自定义 executor。

| 示例 | 演示能力 | 第一条命令 |
|---|---|---|
| [skill-map-showcase](./skill-map-showcase) | 目录式 skill 结构、doctor 体检、Skill Map 图谱输入结构 | `cd examples/skill-map-showcase && omk doctor skills/release-readiness --static-only` |
| [code-review-ab](./code-review-ab) | 两版 skill 的经典 A/B 对比 | `cd examples/code-review-ab && omk eval --control code-review-v1 --treatment code-review-v2 --dry-run` |
| [rag-eval](./rag-eval) | RAG 断言：`faithfulness`、`answer_relevancy`、`context_recall` | `cd examples/rag-eval && omk eval --control baseline --treatment rag-answerer --dry-run` |
| [agent-runtime](./agent-runtime) | 依赖项目目录的 agent 任务评测 | `cd examples/agent-runtime && omk eval --control baseline --treatment repo-navigator --dry-run` |
| [custom-executor](./custom-executor) | 不依赖 Claude，用自定义 executor 跑通链路 | `cd examples/custom-executor && omk eval --control baseline --treatment echo-assistant --executor ./echo-executor.sh --no-judge --report-only` |
| [codex-observe-router](./codex-observe-router/README.zh.md) | Codex 父子任务 Trace IR、知识缺口信号与紧凑报告回读 | `npm exec --yes --package=oh-my-knowledge@0.49.0 -- node examples/codex-observe-router/verify.mjs` |
| [codex-task-trajectory](./codex-task-trajectory/README.zh.md) | 脱敏真实 Codex 任务、Skill/工具证据与一屏任务轨迹 | `node dist/cli/index.js observe ingest examples/codex-task-trajectory/trace --output-dir .omk/task-trajectory-demo` |

## 怎么选

- 想理解「知识图谱」需要哪些输入，从 `skill-map-showcase` 开始。当前 main 会先展示 doctor 体检产物；启用 Skill Information Graph 的构建里，同一条 doctor 命令还会生成图谱 sidecar 和 Markdown 图谱摘要。
- 只想确认本机 CLI、样本加载、executor 协议、报告写入都正常，先跑 `custom-executor`。
- 要向同事解释 omk 的「固定模型，只改知识载体」对照实验模型，用 `code-review-ab`。
- 你的 artifact 负责基于检索上下文回答问题，用 `rag-eval`。
- 你的 prompt 必须读取仓库或项目目录，用 `agent-runtime`。
- 想验证真实 Codex 父子任务能否还原为 source-neutral Trace IR，用 `codex-observe-router`。
- 想直接查看真实 Codex 任务在输入与回答之间发生了什么，用 `codex-task-trajectory`。

生成的报告和图谱 sidecar 会进入 `.omk/`，该目录已被 git 忽略。

例外是示例 skill 自带的 `.omk/eval-samples.json`：它是可入库的评测用例源数据，不是运行生成物。

这些示例样本集刻意保持很小，方便阅读和传播。它们适合上手、协议检查和演示；真正要把 eval verdict 当作发布证据前，请扩展成更大的领域样本集。
