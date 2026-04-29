# omk 与同类工具对比

与 7 个 LLM 评测工具的事实性对比,数据截至 2026-04。欢迎 PR 修正——如果竞品新增了我们标 `✗` 的能力,请提 PR,我们会及时更新。

[English](../comparison.md)

## 一句话总结

omk 的护城河是**统计严谨性**:每条结论都能被研究者审计。Bootstrap CI、Krippendorff α 对人工锚点、length-debias 评委 prompt、饱和曲线——同类工具中**没有一个把这四件全做了**。

需要**托管式 SaaS 看板**?选 LangSmith / Confident AI。
要**本地快速 prompt 迭代不要统计层**?选 promptfoo。
要**学术级 benchmark 覆盖**?选 lm-evaluation-harness。
要**安全评测的 agent 沙箱**?选 inspect-ai。
**要把 skill / prompt / RAG ship 到生产,且会被问"为什么应该相信这个数字"?选 omk。**

## 参与对比的工具

| 工具 | 语言 | 定位 | License |
|---|---|---|---|
| [**omk**](https://github.com/lizhiyao/oh-my-knowledge) | TS / Node | 统计严谨性 + Claude Code 原生的 LLM 评测 | MIT |
| [promptfoo](https://github.com/promptfoo/promptfoo) | TS / Node | 本地 CLI、red-team 重点、被 OpenAI 收购 | MIT |
| [DeepEval](https://github.com/confident-ai/deepeval) | Python | pytest 风格 metric 库,Confident AI 商业化引流 | Apache 2.0 |
| [RAGAS](https://github.com/explodinggradients/ragas) | Python | RAG 专用 metric,statement-decomposition 实现 | Apache 2.0 |
| [OpenAI Evals](https://github.com/openai/evals) | Python | benchmark 注册表,OpenAI 官方 | MIT |
| [LangSmith](https://docs.smith.langchain.com/) | Python (LangChain) | 托管 SaaS,tracing + eval | 商业 |
| [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) | Python | 学术黄金标准,HuggingFace Open LLM Leaderboard 后端 | MIT |
| [inspect-ai](https://github.com/UKGovernmentBEIS/inspect_ai) | Python | UK AISI 安全评测 | MIT |

## 统计严谨性

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| Bootstrap CI(变量均值 + diff) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Krippendorff α(评委 ↔ 人工锚点) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Length-debias 评委 prompt(默认开) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 饱和曲线 / 用例数诊断 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 配对用例显著性检验 | ✓(bootstrap) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

omk 是参与对比中**唯一**把这五件事全做了的工具。最接近的 lm-evaluation-harness 重学术复现,统计层只到点估计。

## 评分架构

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 三层独立评分(事实/行为/评委) | ✓ | ✗ | 部分 | ✗ | ✗ | ✗ | ✗ | ✗ |
| 三层 all-pass CI gate | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 用例隔离(per-variant skill 隔离 / construct validity) | ✓ 默认开 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 部分 |
| 用例设计元数据(capability / difficulty / construct / provenance) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 一行 verdict(PROGRESS / REGRESS / NOISE / ...) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 知识缺口信号(严重度加权) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 用例质量诊断(7 类 issue) | ✓ | 仅低区分度 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 失败 case LLM 聚类 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

三层独立评分能挡住"复合分掩盖单层崩盘":`fact 4.5→2.5 + judge 3→5` 在复合均值看着无伤,但三层 all-pass gate 能立刻抓出来。

**用例隔离**是一个 construct validity 维度:跑 `baseline` vs skill variant 时,三条 channel 都可能让 `baseline` 静默拿到用户 `~/.claude/skills/` 里被测的那个 skill。omk 默认 `--strict-baseline` 把三条都堵掉:(1) SDK skill auto-discovery,通过 `options.skills:[]`;(2) subagent Skill 工具,通过 `options.disallowedTools:['Skill']`;(3) cwd 文件系统访问 — baseline 默认 cwd 是用户评测工作目录,那里通常有 `skills/<name>/` symlink 给 treatment 用,baseline 用 `Glob` + `Read` 顺 symlink 直读 `SKILL.md` 就完全绕过 SDK 隔离。omk 在用户没显式指定 cwd 时把 baseline cwd 切到 `~/.oh-my-knowledge/isolated-cwd/`(空目录)。`--no-strict-baseline` 是逃生口,eval.yaml 支持 per-variant `allowedSkills` 白名单。inspect-ai 的 per-sample solver 模式能达到类似效果但需要显式逐题 wiring;promptfoo / DeepEval / OpenAI Evals 都不处理这维度。

## 评委

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 多评委 ensemble(跨厂商) | ✓ Pearson + MAD | ✗ | ✗ | ✗ | ✗ | 部分 | ✗ | ✗ |
| Judge-repeat 自一致性 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 评委 prompt hash 追溯 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Length-bias 实测验证 | ✓ `debias-validate` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 自动污染检测(gold annotator vs judge) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

## 专项 metric

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| RAG: faithfulness / answer_relevancy / context_recall | ✓ 自动继承 length-debias | 部分 | ✓ | ✓(多步分解) | ✗ | 部分 | ✗ | ✗ |
| ROUGE-N / Levenshtein / BLEU | ✓ 自实现零依赖 | ✓ | 部分 | ✗ | ✓ | ✗ | ✓ | ✗ |
| 语义相似度(LLM 评分) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| 工具调用 / agent 断言 | ✓ 9 种 | ✗ | 部分 | ✗ | ✗ | 部分 | ✗ | ✓ 强 |
| 自定义 JS / Python 断言 | ✓ JS | ✓ JS | ✓ Python | 部分 | ✓ Python | ✓ Python | ✓ Python | ✓ Python |

## 工作流

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 原生 Claude Code skill 评测 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 生产 session JSONL 解析(omk analyze) | ✓ Claude Code | ✗ | ✗ | ✗ | ✗ | ✓ 仅 LangChain | ✗ | ✗ |
| 自迭代(`omk bench evolve`) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| eval.yaml(evaluation-as-code) | ✓ | ✓ | ✗ | ✗ | 部分 | ✗ | 部分 | ✓ |
| CI/CD `omk bench gate` 退出码路由 | ✓ 三层 | ✓ 基础 | ✓ | ✗ | ✗ | 部分 | ✗ | ✓ |
| 预算硬阈值(工作流级中止) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 中断恢复 | ✓ `--resume` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 盲测 A/B + 揭晓 | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ pairwise | ✗ | ✗ |
| 多轮方差 + t 检验 | ✓ + bootstrap | ✗ | ✗ | ✗ | ✗ | 部分 | ✗ | ✗ |

## 文档与社区

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| 完整中文文档 | ✓ | 部分(社区) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| HTML 报告 i18n 切换 | ✓ EN/ZH | 部分 | ✗ | ✗ | ✗ | 部分 | ✗ | ✗ |
| GitHub stars(2026-04) | 新生 | 9k+ | 12k+ | 9k+ | 16k+ | (商业) | 7.5k+ | 2k+ |
| Cloud SaaS dashboard | ✗ | ✗ | ✓ Confident AI | ✗ | ✗ | ✓ | ✗ | ✗ |

## 什么场景选 omk

**研究 / 学术 / NIST AI 800-3 合规对齐**。统计严谨性四件套就是为了回答"这个结论在小 N / 非正态数据 / 评委偏差下是否还稳健"。要发表或审计,bootstrap CI + α + length-debias 三件套是当前唯一现成可用的组合。

**大厂 ML 平台团队**。当 skill / prompt 上线生产,组内会有人问"为什么我应该相信这个数字",omk 的审计链(judge prompt hash + 三层得分 + bootstrap CI + gold α)给你一个能扛住事故复盘的答案。

**中文 AI 工程团队**。omk 是参与对比工具中**唯一**有完整中文文档的——README、CLI help、HTML 报告、术语规范、缺口信号规范、RAG metric 规范全部原生中文(非机翻)。

**Claude Code 用户**。omk 原生跑 Claude Code skill —— `/omk eval` 自动识别你的 `skills/` 目录。promptfoo / DeepEval 等需要 shim 自定义 executor。

## 什么场景**不**选 omk

**需要托管 SaaS 看板 + 团队账号 + 共享 dataset hub**。选 LangSmith 或 Confident AI。omk 刻意只做 CLI + 本地 HTML,不打算 ship SaaS。

**做 red-team,需要攻击 prompt 库**。选 promptfoo,它有 67+ 个 red-team 插件;omk 是通用评测,不专攻攻击库。

**对基础模型跑学术基准(HumanEval / MMLU 等)**。选 lm-evaluation-harness,它是事实上的 leaderboard 后端;omk 不为 benchmark 注册表场景优化。

**安全场景需要 Docker / Kubernetes / Modal 紧密沙箱**。选 inspect-ai,UK AISI 就是为这场景做的。

**只是一次性测 5 个 prompt**。写个一次性 Python 脚本就行。omk 的价值在反复跑 + 跨时间统计可比。

## 共存模式

omk 与其他工具天然兼容。常见组合:

- **omk + LangSmith** — omk 做离线评测严谨性,LangSmith 做生产 tracing
- **omk + RAGAS** — RAGAS 做细粒度 statement-decomposition faithfulness,omk 做跨版本回归 + 统计 CI
- **omk + lm-eval-harness** — lm-eval 跑基础模型 leaderboard 分,omk 在 prompt / skill / RAG 层做工程评测

## 更新与修正

本页尽力保持准确,但竞品能力变化快(2025 年内 promptfoo 加了 `assert-set`,DeepEval 加了 agentic eval suite)。如发现过时或错误,请提 PR,我们会合并。

最后核对:2026-04-25。
