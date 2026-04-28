# omk 用例设计科学性指南

> **范围**:本文档面向 omk 维护者 + 高阶用户。讲 omk 怎么把"测评用例(sample)设计"从经验活对齐到学术 / 工业共识(HELM / MMLU-Pro / Construct Validity 三件套 / IRT / HF Dataset Cards / Adversarial / 自然分布抽样 / 污染防御)。是设计 spec 不是入门文档,日常用法看 [README](../README.md)。

## 一、问题:为什么用例设计需要科学性

omk 的统计严谨性栈(Bootstrap CI / Krippendorff α / length-debias / saturation curves / verdict)解决"评估**结论**算得对不对"。但**结论建立在用例集上**——用例本身科学性不够,后面所有统计严谨都是空的。

E2E 案例(2026-04-28 WCC 评测):baseline-vs-wcc 想测"WCC skill 写得好不好"(quality),实际测到的是"WCC 知识 vs 无知识"(necessity)。这种 construct 错位让 verdict PROGRESS Δ=+1.03 看起来很厉害,但回答错了原始问题。诊断不出来,因为用例没字段声明 construct 假设。

## 二、行业共识 8 条 + omk v1 映射

| # | 行业 gap | 学/工业出处 | omk v1 状态 |
|---|---|---|---|
| 1 | **IRT item discrimination**:每题给 a (discrimination) / b (difficulty) / c (guessing) 三参数,a < 0.3 是垃圾题 | [IrtNet (2510.00844)](https://arxiv.org/pdf/2510.00844),[Columbia IRT primer](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory) | **out-of-scope**(N<30 IRT 不可靠,留 follow-up;v1 启发式 `flat_scores` 已 cover 部分) |
| 2 | **Difficulty stratification**:用例分层(MMLU-Pro 用多模型多数答对过滤难度) | [MMLU-Pro](https://intuitionlabs.ai/articles/mmlu-pro-ai-benchmark-explained) | **in-scope**:`Sample.difficulty` enum + `bench diagnose` 分桶呈现 |
| 3 | **Construct validity 三件套**(structural / convergent / discriminant) | [Measuring what Matters (2511.04703)](https://arxiv.org/abs/2511.04703),[Measurement to Meaning (2505.10573)](https://arxiv.org/html/2505.10573v3) | **in-scope**:`Sample.construct` 字段(suggested:necessity / quality / capability)+ verdict 解读时 callout(CHANGELOG 已加 callout);convergent / discriminant 自动检测 follow-up |
| 4 | **Capability matrix coverage**(HELM 16×7 矩阵) | [HELM (2211.09110)](https://arxiv.org/abs/2211.09110) | **partial**:`Sample.capability` string[] 字段 + `bench diagnose` coverage 分桶 + `capability_thin` issue;详细矩阵可视化 follow-up |
| 5 | **Contamination 检测**(canary / paraphrase / timestamp-locked) | [BIG-Bench canary](https://www.lesswrong.com/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4),[LiveBench](https://livebench.ai/livebench.pdf),[contamination survey (2404.00699)](https://arxiv.org/html/2404.00699v4) | **partial**:用 `Sample.provenance` 做"声明式"contamination tracking(LLM-generated vs human vs production-trace),真正自动检测 follow-up(需要 embedding model + 训练数据访问) |
| 6 | **Sample provenance / dataset card**(annotations_creators 标准) | [HF Dataset Cards](https://huggingface.co/docs/hub/datasets-cards),[Synthetic Data survey (2503.14023)](https://arxiv.org/html/2503.14023v1) | **in-scope**:`Sample.provenance` enum + `bench gen-samples` 自动注入 `'llm-generated'` |
| 7 | **Adversarial / failure-driven mining**(Dynabench) | [Dynabench (2104.14337)](https://arxiv.org/abs/2104.14337) | **out-of-scope**:`bench evolve` 当前是单向演化;`bench adversarial-mine` follow-up |
| 8 | **Production trace 自然分布抽样** | [Chatbot Arena (2403.04132)](https://arxiv.org/pdf/2403.04132) | **out-of-scope**:依赖外部 trace 系统集成,业务层而非 omk 层 |

> archive.org 备份(防链接腐烂):本文引用的 arxiv 链接通常长期有效;LiveBench / IntuitionLabs 等独立网站若失效,在 [archive.org](https://web.archive.org) 输入原 URL 取归档版本。

## 三、Sample 元数据 schema(v0.22 起)

```yaml
# eval-samples.yaml
samples:
  - sample_id: wcc-001-line-basic
    prompt: "WCC 怎么画折线图?"
    rubric: "应识别 Line 组件 + 数据 long-format。组件嵌套 ReactCanvas > Chart > Line。"
    assertions:
      - { type: contains, value: "Line", weight: 1 }
      - { type: regex, pattern: "ReactCanvas", weight: 1 }

    # v0.22 — 4 个可选元数据字段(纯文档/诊断,不参与 grading)
    capability:
      - component-recognition          # string[],能力维度,可多个;归一时大小写/短横线/驼峰不敏感
      - api-selection
    difficulty: easy                    # 'easy' | 'medium' | 'hard'(强枚举,防错)
    construct: necessity                # 'necessity' | 'quality' | 'capability' suggested,允许自定义 string
    provenance: human                   # 'human' | 'llm-generated' | 'production-trace'
```

### 字段语义

- **capability**(string[]):该用例覆盖的能力维度。建议从 capability matrix 角度声明,让用户能看到"我覆盖了 component-recognition × 8 sample / api-selection × 6 sample / fallback × 2 sample,fallback 维度 thin"。归一规则:大小写不敏感 + 短横线 / 驼峰 / 下划线 / 空格归一,所以 `api-selection` / `apiSelection` / `API_Selection` / `api selection` 都算同一个 capability。
- **difficulty**(enum):简单分桶(easy / medium / hard)。`difficulty: 'easy?'` 这种 typo 会被 `loadSamples` reject 并报错含 sample_id 定位。
- **construct**(string):**这个 sample 测的是哪类事**。区别于 capability:capability 是"测什么具体能力"(api-selection),construct 是"测哪个 construct 类型"。三个建议值:
  - `necessity`(必要性):baseline-vs-skill,测 skill 是否必需。Δ 大不一定是 skill 写得好,可能只因为 baseline 不知道领域知识(自明结论)。
  - `quality`(质量):skill-v1 vs skill-v2,测同知识不同写法谁让模型答得更准。这才是 omk 测量学严谨真用武之地。
  - `capability`(能力):测某具体能力维度的差异。
  允许自定义 string(比如 `regression-test` / `cost-efficiency` 等),`bench diagnose` 看到自定义值不报错。
- **provenance**(enum):数据来源。`human`(人工 curated)/ `llm-generated`(omk `bench gen-samples` 自动注入)/ `production-trace`(生产 trace 抽样,需用户自己导入)。`evolved` / `mixed` 留 follow-up 跟 evolver 升级一起做。

### 字段都是 optional

老 sample 0 改动。完全没声明这 4 字段时,`bench diagnose` coverage 块会显示 "(unspecified)" 提示。

### 不参与 grading / judge / verdict

这 4 字段只用于:
- `bench diagnose` 的 coverage 块 + `rubric_clarity_low` / `capability_thin` 两个新 issue 检测
- `report.analysis.sampleQuality` 聚合数据(供工具读)

**绝对不进 judge prompt**(`buildJudgePrompt(prompt, rubric, output, traceSummary)` signature 不含 sample 对象,且有 `test/grading/judge-prompt-isolation.test.ts` 防御回归)。**绝对不影响 verdict 算法**。这是构造效度保护的硬要求 — judge 看到 "construct: necessity" 等于知道试题答案。

## 四、`bench diagnose` v0.22 新功能

### Coverage 块(报告里加在 issue 列表前)

```
$ omk bench diagnose <report-id>

  用例质量诊断 — health score 87/100
  用例总数: 20, flagged: 3 (errors=0, warnings=1, infos=2)

📋 Sample design coverage:
  capability:  componentrecognition (8) | apiselection (6) | errordiagnosis (4) | fallback (2)    [20/20 声明 = 100%]
  difficulty:  easy (5) | medium (10) | hard (5)
  construct:   necessity (18) | quality (2)
  provenance:  human (15) | llm-generated (5)
  avgRubric:   45 字符

  [warning] capability_thin: 1 sample(s)
    ⚠ wcc-019: capability "fallback" 只 2 个 sample 撑(阈值 4,N=20) — 单 sample 失败会让该维度结论不稳

  [info] rubric_clarity_low: 1 sample(s)
    ℹ wcc-007: rubric 仅 12 字且未含评分级别词 — 评委标准模糊,可能 judge 分数不稳
```

### 两个新 issue kind

- **`rubric_clarity_low`**(severity: info):rubric 字符长度 < 20 **AND** 不含任何评分级别词(中英 22 词清单:优秀/良好/合格/不合格/分数/标准/必须/应当/至少/应该/需要;excellent/good/poor/score/grade/must/should/shall/at least/expected/required)。**AND** 而非 OR,避免长 rubric 没用关键词被误报。这是**先验/static 信号**,跟现有 `ambiguous_rubric`(后验/runtime,从 judge stddev 看)互补。
- **`capability_thin`**(severity: warning):某 capability 只被 ≤ `max(2, totalSamples * 0.2)` 个 sample 声明 — 该维度 thin coverage,单 sample 失败会让结论不稳。**Small-N guard**:总 sample 数 < 10 时**完全跳过**此检测,避免小集合全报。

## 五、自检清单:我的 sample 设计够科学吗?

跑评测前过一遍,任意"否"都该停下来想想:

- [ ] **Construct 声明**:每个 sample 知道自己测的是 necessity / quality / capability 中哪一类吗?
- [ ] **Capability 覆盖**:声称要测 N 个能力维度,sample 集真覆盖了 N 个吗?(`bench diagnose` coverage 块给出真实分布)
- [ ] **Difficulty 分层**:有 easy / medium / hard 都有吗?还是全 hard 让模型 noise 主导?
- [ ] **Provenance 透明**:human-curated / LLM-generated / production-trace 比例合理吗?LLM-generated 占比 > 50% 时小心 self-instruct 风险(judge bias 自我循环)。
- [ ] **Sample 数量**:`N < 5`(探索级)/ `N < 20`(只大效应可测)/ `N ≥ 20`(中等效应可测)— omk pre-flight 已警告。
- [ ] **Rubric clarity**:rubric ≥ 20 字符,含至少一个评分级别词(优秀/良好/必须/应该等),让 judge 有可执行的级别标准。
- [ ] **Prompt 不泄露答案**:prompt 里的术语不应直接给出 rubric/assertion 期望的答案(WCC 评测中 wcc-001 prompt 含 `@alipay/wealth-chart-components` 包名,削弱 baseline construct;这是用例自然 trade-off,需要 callout)。
- [ ] **Construct 跟实验设计匹配**:你跑 baseline-vs-skill 时,`construct: necessity` 才合理。跑 skill-v1-vs-skill-v2 时,应该 `construct: quality`。
- [ ] **跨版本 sample 修改 callout**:改了 sample 的 prompt / rubric,sampleHash 变,**verdict / Δ 跨版本不可直接比**。
- [ ] **Provenance 防 contamination**:LLM-generated sample 跟模型自身训练数据可能同源(self-instruct 偏差);`bench gen-samples` 标记 `'llm-generated'` 后,人工 review 一遍是 v1 的 contamination 防御。
- [ ] **Capability_thin guard**:N≥10 时如果某 capability 只 1-2 sample 撑,该维度结论极不稳定。要么补 sample,要么删该 capability(明确不在测试范围)。

## 六、Verdict 解读如何配合 construct

omk verdict 输出 PROGRESS / NOISE / REGRESS / CAUTIOUS / UNDERPOWERED / SOLO,**verdict 不区分 construct 类型**——但解读应该:

- 如果 sample 集 `construct: necessity` 占主流 → PROGRESS 表示 "skill 是必需的",**不能解读成"skill 写得好"**。要测质量须 follow-up 跑 skill-v1-vs-skill-v2(`construct: quality`)。
- 如果 sample 集 `construct: quality` 占主流 → PROGRESS / REGRESS 才是真正的"skill 质量比较"信号。

CHANGELOG 在 v0.22 已加 [Unreleased] callout,提醒 verdict 不直接区分 construct,需要用户读 sample 元数据确认实验目的。

## 七、Follow-up(已 ack 但 v1 不做)

- IRT 风格 item discrimination(N≥30 + multi-model 数据)
- Multi-judge convergent / discriminant test(需要 ≥ 2 judge ensemble + 聚合分析)
- Adversarial mining loop(`bench adversarial-mine`)
- Production trace 自然分布抽样
- HTML renderer 显示 sample design coverage(v1 只 CLI)
- Evolve 演化策略升级(diversification signal / saturation-aware stop / health-weighted improvement)
- Gold dataset 自动生成(改成"标注流程规范化"文档)
- Coverage matrix 详细 N×D 可视化(v1 出聚合分桶 + 用户自行可视化)
- Contamination 检测算法实现(canary string / paraphrase detection)
- 用户自定义 rubric 关键词清单(`diagnostics.rubricKeywords` 配置)

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
