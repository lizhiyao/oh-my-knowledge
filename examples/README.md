# omk examples

一组可直接跑的示例，按「由简到全」排成一条上手路径。每个目录都有自己的 `README`，写明演示什么、怎么跑、预期看到什么。

**第一次用？** 从 `code-review` 开始（omk 的核心用法）。**没有 API key / 不想接 Claude？** 先跑 `custom-executor`——用内置的 echo 执行器零成本跑通整条链路。

| # | 示例 | 演示的能力 | 一句话跑法 |
|---|------|-----------|-----------|
| 1 | [code-review](./code-review) | A/B 对比两版 skill（核心用法） | `cd examples/code-review && omk eval --control code-review-v1 --treatment code-review-v2` |
| 2 | [custom-executor](./custom-executor) | 不依赖 Claude / 离线跑通（零 API key） | `cd examples/custom-executor && omk eval --control baseline --treatment v1 --executor ./echo-executor.sh --no-judge` |
| 3 | [url-fetch](./url-fetch) | 单 skill vs 自动注入的 baseline | `cd examples/url-fetch && omk eval --control baseline --treatment v1` |
| 4 | [multi-skills](./multi-skills) | 一次评测一组 skill（`--batch`） | `cd examples/multi-skills && omk eval --batch --skill-dir skills` |
| 5 | [customer-service](./customer-service) | 自动迭代 skill（`omk evolve`） | `cd examples/customer-service && omk evolve skills/service-guide --rounds 2` |
| 6 | [agent-eval](./agent-eval) | 评测 agent / 工具调用 + 控制实验 | `cd examples/agent-eval && omk eval --control v1 --treatment v2` |
| 7 | [rag-eval](./rag-eval) | RAG 专用指标（faithfulness 等） | 见目录内 README |
| 8 | [gold-dataset](./gold-dataset) | 人工标注校准评委（Krippendorff α） | 见目录内 README |

## 约定

- skill 一律是 canonical 的目录式：一个 skill 一个目录，内含 `SKILL.md`（带 `name` / `description` frontmatter）——与 `omk init` 脚手架、Claude Skills 标准一致。
- 样本断言只做 ASCII 确定性检查（`contains` / `regex` 等）；语义判断交给 `rubric` 由评委评分。所以这些示例在默认（严格）模式下都能直接跑通。
- 大多示例需要一个执行器（默认 Claude）。想完全离线验证「装好没、跑得通」，用 `custom-executor` 的 `echo-executor.sh`。
