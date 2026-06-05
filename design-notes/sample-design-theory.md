# 用例设计科学性：学术对齐与 schema 决策（维护者内部）

> 本文是 [docs/specs/sample-design-spec.md](../docs/specs/sample-design-spec.md) 的维护者内部伴档，记录 sample 元数据 schema 背后的学术对齐（HELM / IRT / Construct Validity / 污染防御等）与 v2 扩展决策。**面向 omk 维护者**，不进公开文档站、不双语。用户面的字段语义 / 沙箱字段 / 自检清单看 spec 正文即可。

## 一、行业共识 8 条 + omk v1 映射

omk 的统计严谨性栈（Bootstrap CI / Krippendorff α / length-debias / saturation curves / verdict）解决「评估**结论**算得对不对」，但结论建立在用例集上——用例本身科学性不够，后面所有统计严谨都是空的。下表把测评用例设计对齐到学术 / 工业共识，并标 omk v1 的覆盖状态。

| # | 行业 gap | 学/工业出处 | omk v1 状态 |
|---|---|---|---|
| 1 | **IRT item discrimination**：每题给 a (discrimination) / b (difficulty) / c (guessing) 三参数，a < 0.3 是垃圾题 | [IrtNet (2510.00844)](https://arxiv.org/pdf/2510.00844)，[Columbia IRT primer](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory) | **out-of-scope**（N<30 IRT 不可靠，留 follow-up；v1 启发式 `flat_scores` 已 cover 部分） |
| 2 | **Difficulty stratification**：用例分层（MMLU-Pro 用多模型多数答对过滤难度） | [MMLU-Pro](https://intuitionlabs.ai/articles/mmlu-pro-ai-benchmark-explained) | **in-scope**：`Sample.difficulty` enum + studio 分桶呈现 |
| 3 | **Construct validity 三件套**（structural / convergent / discriminant） | [Measuring what Matters (2511.04703)](https://arxiv.org/abs/2511.04703)，[Measurement to Meaning (2505.10573)](https://arxiv.org/html/2505.10573v3) | **in-scope**：`Sample.construct` 字段（suggested：necessity / quality / capability）+ verdict 解读 callout；convergent / discriminant 自动检测 follow-up |
| 4 | **Capability matrix coverage**（HELM 16×7 矩阵） | [HELM (2211.09110)](https://arxiv.org/abs/2211.09110) | **partial**：`Sample.capability` string[] 字段 + studio coverage 分桶 + `capability_thin` issue；详细矩阵可视化 follow-up |
| 5 | **Contamination 检测**（canary / paraphrase / timestamp-locked） | [BIG-Bench canary](https://www.lesswrong.com/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4)，[LiveBench](https://livebench.ai/livebench.pdf)，[contamination survey (2404.00699)](https://arxiv.org/html/2404.00699v4) | **partial**：`Sample.provenance` 做「声明式」contamination tracking，真正自动检测 follow-up（需要 embedding model 或训练数据访问） |
| 6 | **Sample provenance / dataset card**（annotations_creators 标准） | [HF Dataset Cards](https://huggingface.co/docs/hub/datasets-cards)，[Synthetic Data survey (2503.14023)](https://arxiv.org/html/2503.14023v1) | **in-scope**：`Sample.provenance` enum + `omk sample` 自动注入 `'llm-generated'` |
| 7 | **Adversarial / failure-driven mining**（Dynabench） | [Dynabench (2104.14337)](https://arxiv.org/abs/2104.14337) | **out-of-scope**：`omk evolve` 当前是单向演化；adversarial mining follow-up |
| 8 | **Production trace 自然分布抽样** | [Chatbot Arena (2403.04132)](https://arxiv.org/pdf/2403.04132) | **out-of-scope**：依赖外部 trace 系统集成 |

## 二、Follow-up（已 ack 但 v1 不做）

- IRT 风格 item discrimination（N≥30 + multi-model 数据）
- Multi-judge convergent / discriminant test（需要 ≥ 2 judge ensemble + 聚合分析）
- Adversarial mining loop（对抗 sample 挖掘）
- Production trace 自然分布抽样
- HTML renderer 显示 sample design coverage（v1 只 CLI）
- Evolve 演化策略升级（diversification signal / saturation-aware stop / health-weighted improvement）
- Gold dataset 自动生成（改成「标注流程规范化」文档）
- Coverage matrix 详细 N×D 可视化（v1 出聚合分桶 + 用户自行可视化）
- Contamination 检测算法实现（canary string / paraphrase detection）
- 用户自定义 rubric 关键词清单（`diagnostics.rubricKeywords` 配置）

## 三、Schema 扩展候选（v2 路线）

v1 schema 只有 4 字段（capability / difficulty / construct / provenance），都属于「测量学正确性」（measurement validity）轴 —— 回答**这条用例测的事是它声称要测的事吗**。社区另一类常见建议走的是「资产治理」（asset governance）轴：tags / risk_level / expected_facts / source_ids / owner —— 回答**这条用例归谁、来自哪里、有多重要**。两轴正交不冲突，但治理假设测量学先稳固；v1 选了先解测量学。本节记录 v2 候选字段及拒绝清单，供后续 PR 决策时不重新讨论一遍。

### v2 候选（高价值低风险，等真实用户需求触发再加）

- **`source_ids?: string[]`**：具体来源标识（`issue-123` / `doc:react-charts.md#line-chart` / `slack-thread-...`）。补足 `provenance` enum 太粗的问题 —— provenance 答「机器/人/线上」，source_ids 答「具体哪个 issue / doc 段落」。debug 价值高（可追溯 sample 出处），纯文档不进 grading。代价：链接腐烂需用户自己治理。
- **`status?: 'active' | 'deprecated' | 'superseded'`**：lifecycle 字段。sample 集长期演化时，知道一条 sample 是「主力」还是「淘汰中」对 verdict 解读至关重要 —— `deprecated` sample 仍在跑但 Δ 不该计入主结论。比 `owner` 更要紧。

### 已拒绝（列出理由防止反复讨论）

- **`tags?: string[]`**：跟 `capability` 语义混。capability 是「测什么具体能力」，tags 想加的「regression / p0 / edge-case」要么属于 `capability`（能力维度）要么属于 `status`（lifecycle）。free-form string 没 enum 约束极易腐化为 mess。**Verdict**：不加，逼用户用 capability + status 表达。
- **`expected_facts?: string[]`**：跟 `rubric` + `assertions: contains` 大量重叠。omk 的 judge 已经在做语义评分，expected_facts 是同一抽象的另一个 alias。**Verdict**：不加，引入会让 sample 设计时有两个地方写期望，易漂移。
- **`owner?: string`**：治理字段，跟 omk 测量学使命错配。omk 不消费 owner 做 routing / notify；放在 git blame / CODEOWNERS 更合适。**Verdict**：不加。
- **`risk_level?: 'p0' | 'p1' | 'p2'`**：提了一个真问题（aggregate 应不应该按 risk 加权样本），但解这个会动 verdict 公式，**测量学不变量**。当前 verdict / Δ 都是 sample-uniform，加权进 verdict 会破跨版本可比性。无 consumer 时纯噪音，有 consumer 时破不变量 —— 两难。**Verdict**：不加；真要做，得单独立项跟 verdict v2 一起设计加权 aggregator。

### 不加新字段的硬约束

加任何字段前先确认：

- 不进 `buildJudgePrompt` signature（`test/grading/judge-prompt-isolation.test.ts` 防御回归）
- 不进 `sampleHash` 计算（否则破 cache key 跨版本可比性）
- 不进 verdict / Δ 算法
- 跟现有 4 字段 + `rubric` / `assertions` 语义不重叠

## Sources

- [Holistic Evaluation of Language Models (HELM, 2211.09110)](https://arxiv.org/abs/2211.09110)
- [Measuring what Matters: Construct Validity in LLM Benchmarks (2511.04703)](https://arxiv.org/abs/2511.04703)
- [Measurement to Meaning: A Validity-Centered Framework (2505.10573)](https://arxiv.org/html/2505.10573v3)
- [Position: Medical LLM Benchmarks Should Prioritize Construct Validity](https://openreview.net/pdf?id=YuMEUNNpeb)
- [Learning Compact Representations of LLM Abilities via Item Response Theory (IrtNet, 2510.00844)](https://arxiv.org/pdf/2510.00844)
- [IRT primer — Columbia Mailman](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory)
- [MMLU-Pro Benchmark methodology](https://intuitionlabs.ai/articles/mmlu-pro-ai-benchmark-explained)
- [Synthetic Data Generation Survey (2503.14023)](https://arxiv.org/html/2503.14023v1)
- [Auto Evol-Instruct (2406.00770)](https://arxiv.org/html/2406.00770v1)
- [Dynabench (2104.14337)](https://arxiv.org/abs/2104.14337)
- [Comprehensive Survey of Contamination Detection (2404.00699)](https://arxiv.org/html/2404.00699v4)
- [LiveBench: Contamination-Free Benchmark](https://livebench.ai/livebench.pdf)
- [BIG-Bench Canary in GPT-4](https://www.lesswrong.com/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4)
- [How to Publish Benchmarks Without True Answers (2505.18102)](https://arxiv.org/html/2505.18102v1)
- [Hugging Face Dataset Cards](https://huggingface.co/docs/hub/datasets-cards)
- [Judging LLM-as-a-Judge with MT-Bench / Chatbot Arena (2306.05685)](https://arxiv.org/abs/2306.05685)
- [Chatbot Arena Open Platform (2403.04132)](https://arxiv.org/pdf/2403.04132)
