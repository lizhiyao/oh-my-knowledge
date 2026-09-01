# omk 与同类工具对比

与 7 个 LLM 评测工具的事实性对比，数据截至 2026-04。欢迎 PR 修正——如果竞品新增了我们标 `✗` 的能力，请提 PR，我们会及时更新。

## 一句话总结

omk 的护城河是**[统计严谨性](../explanation/statistical-rigor)**：每条发布结论都能追溯到 sealed design、Bootstrap uncertainty、显式 Gold calibration、冻结评委 prompt 与失败关闭的 evidence coverage。

需要**托管式 SaaS 看板**？选 LangSmith / Confident AI。
要**本地快速 prompt 迭代不要统计层**？选 promptfoo。
要**学术级 benchmark 覆盖**？选 lm-evaluation-harness。
要**安全评测的 agent 沙箱**？选 inspect-ai。
**要把 skill / prompt / RAG ship 到生产，且会被问"为什么应该相信这个数字"？选 omk。**

## 参与对比的工具

| 工具 | 语言 | 定位 | License |
|---|---|---|---|
| [**omk**](https://github.com/lizhiyao/oh-my-knowledge) | TS / Node | 统计严谨的知识载体评测 + Codex / Claude 原生工作流 | MIT |
| [promptfoo](https://github.com/promptfoo/promptfoo) | TS / Node | 本地 CLI、red-team 重点、被 OpenAI 收购 | MIT |
| [DeepEval](https://github.com/confident-ai/deepeval) | Python | pytest 风格 metric 库，Confident AI 商业化引流 | Apache 2.0 |
| [RAGAS](https://github.com/explodinggradients/ragas) | Python | RAG 专用 metric，statement-decomposition 实现 | Apache 2.0 |
| [OpenAI Evals](https://github.com/openai/evals) | Python | benchmark 注册表，OpenAI 官方 | MIT |
| [LangSmith](https://docs.smith.langchain.com/) | Python (LangChain) | 托管 SaaS，tracing + eval | 商业 |
| [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) | Python | 学术黄金标准，HuggingFace Open LLM Leaderboard 后端 | MIT |
| [inspect-ai](https://github.com/UKGovernmentBEIS/inspect_ai) | Python | UK AISI 安全评测 | MIT |

## 统计严谨性

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| Bootstrap CI（变量均值 + diff） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Krippendorff α（评委 ↔ 人工锚点） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Length-debias 评委 prompt（默认开） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 保留 missing／failed evidence + coverage gate | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 配对用例显著性检验 | ✓(bootstrap) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

omk 一列以当前 Evaluation Core contract 与实现为锚。竞品列仍是本页顶部注明日期的对比快照。

→ 这些不是营销话术——每一条都有文档和代码锚定：[统计严谨性](../explanation/statistical-rigor)、[评分公式](../specs/scoring)。

## 评分架构

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 三层独立评分（事实/行为/评委） | ✓ | ✗ | 部分 | ✗ | ✗ | ✗ | ✗ | ✗ |
| layer-aware release gate + 显式 evidence coverage | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 用例隔离（per-variant skill 隔离 / construct validity） | ✓ 默认开 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 部分 |
| 用例设计元数据 + 结构锚点（`covers`） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 已注册 Decision(PROGRESS / REGRESSION / NOISE / ...) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 知识缺口信号（严重度加权） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
Layer-aware release gate 与显式 coverage 能防止正向 composite 点估计掩盖 missing evidence，或绕过 treatment layer 的已注册阈值。

**用例隔离**是一个 construct validity 维度：原生 coding-agent baseline 可能通过项目文件、skill registry、子代理或普通 cwd 读取拿到未声明的本地知识。omk 默认启用 `--strict-baseline`，为每次隐式 baseline 执行创建全新的空 cwd，并叠加 provider 控制：Codex CLI 忽略用户配置与 rules、采用 ephemeral session；Codex SDK 使用隔离 `CODEX_HOME`；Claude 阻断 skill 发现和子代理 `Skill` 工具。报告会持久化 runtime 与隔离指纹，避免不兼容运行伪装成只改变知识载体的比较。`--no-strict-baseline` 仍是显式逃生口。inspect-ai 可通过 per-sample solver wiring 达到相近隔离；promptfoo / DeepEval / OpenAI Evals 不直接处理这一维度。

## 评委

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 多评委 ensemble（跨厂商） | ✓ Pearson + MAD | ✗ | ✗ | ✗ | ✗ | 部分 | ✗ | ✗ |
| Judge-repeat 自一致性 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 评委 prompt hash 追溯 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 自动污染检测(gold annotator vs judge) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

## 专项 metric

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| RAG: faithfulness / answer_relevancy / context_recall | ✓ length-debias 默认开启，模式进入指纹 | 部分 | ✓ | ✓（多步分解） | ✗ | 部分 | ✗ | ✗ |
| ROUGE-N / Levenshtein / BLEU | ✓ 自实现零依赖 | ✓ | 部分 | ✗ | ✓ | ✗ | ✓ | ✗ |
| 语义相似度（LLM 评分） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| 工具调用 / agent 断言 | ✓ 9 种 | ✗ | 部分 | ✗ | ✗ | 部分 | ✗ | ✓ 强 |
| 自定义 JS / Python 断言 | ✓ JS | ✓ JS | ✓ Python | 部分 | ✓ Python | ✓ Python | ✓ Python | ✓ Python |

## 工作流

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 原生 agent skill 评测 | ✓ Codex / Claude Code | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 生产 session trace 解析(omk observe) | ✓ Codex / Claude Code / OpenClaw / markdown | ✗ | ✗ | ✗ | ✗ | ✓ 仅 LangChain | ✗ | ✗ |
| 自迭代(`omk evolve`) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| eval.yaml(evaluation-as-code) | ✓ | ✓ | ✗ | ✗ | 部分 | ✗ | 部分 | ✓ |
| CI/CD `omk eval` 退出码路由 | ✓ Core Decision | ✓ 基础 | ✓ | ✗ | ✗ | 部分 | ✗ | ✓ |
| 预算硬阈值（工作流级中止） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 中断恢复 | ✓ `--resume` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 独立 run 的 Series 方差 | ✓ | ✗ | ✗ | ✗ | ✗ | 部分 | ✗ | ✗ |

## 文档与社区

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 完整中文文档 | ✓ | 部分（社区） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 本地 Studio 报告视图 | ✓ EN/ZH | 部分 | ✗ | ✗ | ✗ | 部分 | ✗ | ✗ |
| GitHub stars(2026-04) | 新生 | 9k+ | 12k+ | 9k+ | 16k+ | （商业） | 7.5k+ | 2k+ |
| Cloud SaaS dashboard | ✗ | ✗ | ✓ Confident AI | ✗ | ✗ | ✓ | ✗ | ✗ |

## 什么场景选 omk

**研究 / 学术 / NIST AI 800-3 合规对齐**。统计架构用于回答结论能否经受重采样不确定性、评委校准、prompt identity 与不完整证据的检验。Core 产物保留审计所需的设计与 lineage。

**大厂 ML 平台团队**。当 skill / prompt 上线生产，组内会有人问"为什么我应该相信这个数字"，omk 的审计链（judge prompt hash + 三层得分 + bootstrap CI + gold α）给你一个能扛住事故复盘的答案。

**中文 AI 工程团队**。omk 原生维护中文 README、CLI help、Studio 视图、术语、缺口信号与 RAG metric 文档。

**Codex 与 Claude Code 用户**。omk 提供一份 agent-neutral skill，并为两类 runtime 提供原生执行器。Codex CLI 是隔离最完整的测量路径；当项目上下文或 SDK 事件流本身就是有意输入时，也可以使用 Codex SDK 或 Claude runtime。promptfoo / DeepEval 等通常需要 shim 一层自定义 executor，才能接近这种面向 artifact 的工作流。

## 什么场景**不**选 omk

**需要托管 SaaS 看板 + 团队账号 + 共享 dataset hub**。选 LangSmith 或 Confident AI。omk 刻意只做 CLI + 本地 Studio，不打算 ship SaaS。

**做 red-team，需要攻击 prompt 库**。选 promptfoo，它有 67+ 个 red-team 插件；omk 是通用评测，不专攻攻击库。

**对基础模型跑学术基准（HumanEval / MMLU 等）**。选 lm-evaluation-harness，它是事实上的 leaderboard 后端；omk 不为 benchmark 注册表场景优化。

**安全场景需要 Docker / Kubernetes / Modal 紧密沙箱**。选 inspect-ai，UK AISI 就是为这场景做的。

**只是一次性测 5 个 prompt**。写个一次性 Python 脚本就行。omk 的价值在反复跑 + 跨时间统计可比。

## 共存模式

omk 与其他工具天然兼容。常见组合：

- **omk + LangSmith** — omk 做离线评测严谨性，LangSmith 做生产 tracing
- **omk + RAGAS** — RAGAS 做细粒度 statement-decomposition faithfulness，omk 做跨版本回归 + 统计 CI
- **omk + lm-eval-harness** — lm-eval 跑基础模型 leaderboard 分，omk 在 prompt / skill / RAG 层做工程评测

## 更新与修正

本页尽力保持准确，但竞品能力变化快（2025 年内 promptfoo 加了 `assert-set`，DeepEval 加了 agentic eval suite）。如发现过时或错误，请提 PR，我们会合并。

最后核对：2026-04-25。
