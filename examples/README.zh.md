# OMK 示例

[English](./README.md)

这里收录首次教程之后的专项案例。第一次理解 control／treatment 对照流程时，应直接使用脚手架，而不是复制某个示例目录：

```bash
omk init demo
cd demo
omk eval --control code-review-v1 --treatment code-review-v2 --dry-run
```

## 按任务选择

| 任务 | 示例 | 演示内容 | 第一条命令 | 是否调用模型 |
|---|---|---|---|---|
| 检查目录式 skill | [skill-map-showcase](./skill-map-showcase/README.zh.md) | Frontmatter、references、scripts、workflows、私有用例、Doctor 与 Skill Map | `cd examples/skill-map-showcase && omk doctor skills/release-readiness --static-only` | 否 |
| 评测基于上下文的回答 | [rag-eval](./rag-eval/README.zh.md) | `faithfulness`、`answer_relevancy` 与 `context_recall` 断言 | `cd examples/rag-eval && omk eval --control context-answerer --treatment rag-answerer --dry-run` | dry-run 否；真实评测是 |
| 评测理解仓库的 agent | [agent-runtime](./agent-runtime/README.zh.md) | 用例级工作目录与基于文件的任务证据 | `cd examples/agent-runtime && omk eval --control repo-answerer --treatment repo-navigator --dry-run` | dry-run 否；真实评测是 |
| 接入执行器 | [custom-executor](./custom-executor/README.zh.md) | 当前封存的 JSON stdin／stdout 契约、确定性本地烟测与 Ollama adapter | `cd examples/custom-executor && omk eval --control baseline --treatment echo-assistant --executor ./echo-executor.sh --no-judge --report-only` | echo executor 否 |
| 验证 Codex trace 摄取 | [codex-observe-router](./codex-observe-router/README.zh.md) | 父子任务路由、Trace IR、知识缺口信号与紧凑报告持久化 | `yarn build && OMK_BIN="$PWD/dist/cli/index.js" OMK_PACKAGE_ROOT="$PWD" node examples/codex-observe-router/verify.mjs` | 否 |
| 查看真实任务轨迹 | [codex-task-trajectory](./codex-task-trajectory/README.zh.md) | 将脱敏 Codex 任务展示为 Knowledge、执行、结果、规范化事件和源记录证据 | 先运行 `yarn build`，再执行示例 README 中的命令 | 否 |

## 示例契约

索引中的每个目录都必须具备独立的用户用途、中英文说明、可复制的入口命令、明确的运行前提，以及「该案例不能证明什么」的证据边界。评测用例统一使用 `omk.eval-sample-set/v1` 协议。JSON 与 YAML 在不同示例中被有意保留，但同一用例作用域不能同时存在两种格式。

生成的报告、图谱和 Doctor 产物应写入项目级 `.omk/`，并由 Git 忽略。目录式 skill 可以在 `skills/<name>/.omk/eval-samples.json` 或 `.yaml` 保存随源码版本化的私有用例；这些文件是输入，不是运行产物。

仓库内置样本集刻意保持易读、易运行的小规模，只用于验证工作流和协议集成，不构成统计功效充分的发布证据。使用 OMK verdict 发布真实知识载体前，需要建立有代表性的领域样本集，并人工审核 construct coverage。
