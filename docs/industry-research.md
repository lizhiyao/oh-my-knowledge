# 知识测评工具行业调研

> 调研时间：2026-03-24
> 作者：lizhiyao
> 背景：oh-my-knowledge v0.1.0 已发布，需要对标行业工具找差距、定方向

---

## 目录

1. [行业工具全景](#一行业工具全景)
2. [官方 skill-creator eval 深度拆解](#二官方-skill-creator-eval-深度拆解)
3. [Promptfoo 能力拆解](#三promptfoo-能力拆解)
4. [DeepEval 能力拆解](#四deepeval-能力拆解)
5. [Braintrust 能力拆解](#五braintrust-能力拆解)
6. [oh-my-knowledge 现状与差距分析](#六oh-my-knowledge-现状与差距分析)
7. [改进优先级建议](#七改进优先级建议)
8. [参考资料](#八参考资料)

---

## 一、行业工具全景

### 1.1 工具定位矩阵

```
                    评测对象
            ┌──────────┬──────────┐
            │  模型    │ 知识载体  │
     ┌──────┼──────────┼──────────┤
评   │ 个人 │Promptfoo │skill-    │
测   │      │DeepEval  │creator   │
规   │      │          │eval      │
模   ├──────┼──────────┼──────────┤
     │ 团队 │Braintrust│oh-my-    │
     │      │Arize AI  │knowledge │
     │      │Langfuse  │(目标位置) │
     └──────┴──────────┴──────────┘
```

### 1.2 核心工具对比

| 工具 | 语言 | 评测对象 | 断言体系 | A/B 对比 | 并行执行 | 生产监控 | 开源 |
|------|------|----------|----------|----------|----------|----------|------|
| **skill-creator eval** | Python/Agent | Claude skill | assertion + grader agent | 盲测 comparator | 多 agent 并行 | 无 | 是 |
| **Promptfoo** | JS/YAML | 任意 prompt | 50+ 断言类型 | side-by-side | 并行 provider | 无 | 是 |
| **DeepEval** | Python | LLM/Agent | 60+ 指标 | 无原生支持 | pytest 并行 | Confident AI | 是 |
| **Braintrust** | JS/Python | 任意 LLM | scoring function | experiment 对比 | 并行 trial | 全链路追踪 | 部分 |
| **oh-my-knowledge** | JS | 知识载体 | 5 种断言 + LLM | 多 variant 对比 | 串行 | 无 | 是 |

---

## 二、官方 skill-creator eval 深度拆解

### 2.1 四 Agent 流水线

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Executor │ →  │  Grader  │ →  │Comparator│ →  │ Analyzer │
│          │    │          │    │          │    │          │
│ 独立上下文│    │ assertion│    │ 盲测 A/B │    │ 模式发现 │
│ 执行 skill│    │ pass/fail│    │ 不知新旧 │    │ 改进建议 │
│ + prompt │    │ + evidence│   │ 独立判断 │    │ 统计分析 │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### 2.2 四种运行模式

| 模式 | 流程 | 用途 |
|------|------|------|
| **Eval** | 执行 → 评分 | 测试 skill 是否正常工作 |
| **Improve** | 执行 → 评分 → 盲测 A/B → 分析 → 迭代 | 改进 skill |
| **Benchmark** | 多次执行 + 方差分析 | 统计显著性衡量 |
| **Description Optimize** | 正负样本 → 优化触发描述 | 提升触发准确率 |

### 2.3 迭代闭环

```
iteration-1/
├── eval-0/
│   ├── with_skill/outputs/
│   ├── without_skill/outputs/   (baseline)
│   ├── eval_metadata.json
│   ├── grading.json
│   └── timing.json
├── benchmark.json
├── benchmark.md
└── feedback.json                ← 人工 review 反馈

iteration-2/                     ← 改进后重跑
├── ...
└── benchmark.json               ← 支持 --previous-workspace 跨版本对比
```

### 2.4 评分体系

- **确定性 assertion**：可验证、有 evidence、不依赖 LLM
- **Grader agent**：读取 `agents/grader.md` 指令，按 assertion 逐条评判
- **Comparator agent**：盲测，不知道 A/B 哪个是新版，防止确认偏差
- **Analyzer agent**：分析 benchmark 数据，发现无区分度断言、高方差用例、成本权衡

---

## 三、Promptfoo 能力拆解

### 3.1 断言类型体系（50+）

**确定性断言：**

| 类别 | 断言类型 |
|------|----------|
| 字符串 | `equals`, `contains`, `icontains`, `starts-with`, `regex` |
| 集合 | `contains-any`, `contains-all`, `icontains-any`, `icontains-all` |
| 结构 | `is-json`, `contains-json`, `is-html`, `is-sql`, `is-xml` |
| 函数调用 | `is-valid-function-call`, `is-valid-openai-tools-call` |
| 文本相似 | `rouge-n`, `bleu`, `levenshtein`, `similar`（embedding cosine） |
| 性能 | `latency`, `cost`, `perplexity` |
| Agent 轨迹 | `trajectory:tool-used`, `trajectory:tool-args-match`, `trajectory:tool-sequence`, `trajectory:step-count` |
| 安全 | `guardrails`, `is-refusal` |
| 自定义 | `javascript`, `python`, `webhook` |

**LLM 评分断言：**

| 断言类型 | 说明 |
|----------|------|
| `llm-rubric` | 按 rubric 打分 |
| `g-eval` | Chain-of-thought 评估 |
| `answer-relevance` | 查询相关性 |
| `context-faithfulness` | 上下文忠实度 |
| `context-recall` | 上下文召回率 |
| `factuality` | 事实准确性 |
| `select-best` | 多输出比较选优 |
| `trajectory:goal-success` | Agent 目标达成 |

**关键特性：**
- 所有断言支持 `not-` 前缀取反
- 支持 `weight` 权重
- 支持 `assert-set` 断言组合（阈值逻辑）
- YAML 声明式配置，非代码门槛低

### 3.2 配置示例

```yaml
prompts:
  - "Review this code: {{code}}"

providers:
  - id: anthropic:messages:claude-sonnet-4-6
    config:
      systemPrompt: file://skills/v1.md
  - id: anthropic:messages:claude-sonnet-4-6
    config:
      systemPrompt: file://skills/v2.md

tests:
  - vars:
      code: "function auth(u,p) { db.query('SELECT * FROM users WHERE name=' + u); }"
    assert:
      - type: icontains
        value: "SQL injection"
        weight: 2
      - type: icontains
        value: "parameterized"
      - type: not-icontains
        value: "looks good"
      - type: llm-rubric
        value: "Should identify SQL injection and provide a concrete fix"
      - type: cost
        threshold: 0.01
```

### 3.3 值得借鉴

1. **YAML 配置** — 非开发人员也能写评测用例
2. **50+ 断言类型** — 覆盖从简单字符串到 Agent 轨迹的全场景
3. **`assert-set`** — 断言组合，如"以下 5 条至少通过 3 条"
4. **`cost` / `latency` 断言** — 把成本和延迟作为断言，超标即失败
5. **`trajectory:*`** — Agent 行为轨迹断言，评估工具选择序列
6. **红队测试内置** — 安全评估集成

---

## 四、DeepEval 能力拆解

### 4.1 Agent 评测指标（60+）

| 指标类别 | 核心指标 | 说明 |
|----------|----------|------|
| 工具使用 | `ToolCorrectnessMetric` | 是否选对了工具 |
| 工具参数 | `ArgumentCorrectnessMetric` | 工具参数是否正确 |
| 任务完成 | `TaskCompletionMetric` | 是否完成了用户任务 |
| 推理质量 | `ReasoningMetric` | 推理链是否连贯 |
| 幻觉 | `HallucinationMetric` | 是否产生幻觉 |
| 忠实度 | `FaithfulnessMetric` | 是否忠于上下文 |
| 回答相关 | `AnswerRelevancyMetric` | 回答是否切题 |
| 毒性 | `ToxicityMetric` | 是否有害 |

### 4.2 核心特点

- **Python 原生**，基于 pytest，开发者友好
- **执行轨迹分析** — 不仅看结果，还分析每一步推理和工具调用
- **端到端 + 组件级** — 既评整体任务完成，又评单步质量
- **Confident AI 平台** — 可选云端仪表盘，团队协作

### 4.3 值得借鉴

1. **执行轨迹评估** — 分析"怎么到达结果的"，不只看最终输出
2. **工具选择正确性** — 对 Agent 场景很有价值
3. **任务完成度** — 端到端评估指标

---

## 五、Braintrust 能力拆解

### 5.1 核心架构

```
Production Traces → Datasets → Experiments → CI Gates → Deployment
       │                          │
       └── 失败 case 一键转为 ──→ eval dataset
```

### 5.2 关键能力

| 能力 | 说明 |
|------|------|
| **Scoring Functions** | 自定义评分函数（代码/LLM-as-judge） |
| **Experiment Comparison** | 多实验对比，指标 diff |
| **Production Tracing** | 全链路追踪每次 API 调用 |
| **Dataset Management** | 生产 trace 一键转为 eval 数据集 |
| **CI Integration** | 评分低于阈值则部署失败 |
| **可溯源性** | 每个评分关联到精确的 prompt 版本 + 模型版本 + 数据集版本 |

### 5.3 值得借鉴

1. **可溯源性** — 评分结果关联到 prompt/model/dataset 的精确版本
2. **生产 trace → eval 数据集** — 从真实失败中自动生成测试用例
3. **CI 集成** — 评测作为部署门禁

---

## 六、oh-my-knowledge 现状与差距分析

### 6.1 当前能力

```
✅ 控制变量实验（固定模型，变知识载体）
✅ 交叉调度（减少时间偏差）
✅ 混合评分（确定性断言 + LLM judge + 多维度）
✅ 多 variant 对比（不限 A/B）
✅ 零依赖，CLI 直接用
✅ 不需要 API Key（claude -p）
✅ HTML 报告（断言详情 + 维度拆分）
✅ JSON API
```

### 6.2 与官方 skill-creator eval 的差距

| 维度 | skill-creator eval | oh-my-knowledge | 差距 | 优先级 |
|------|-------------------|-----------------|------|--------|
| **盲测 A/B** | Comparator agent，不知新旧 | 无，对比结果不设盲 | 🔴 高 | P0 |
| **分析 agent** | Analyzer 自动发现模式 | 无自动分析 | 🔴 高 | P0 |
| **迭代管理** | iteration-N 目录 + feedback.json | 按时间戳存储，无迭代概念 | 🟡 中 | P1 |
| **并行执行** | 多 agent 并行，独立上下文 | 串行执行 | 🟡 中 | P1 |
| **方差分析** | Benchmark 模式多次运行 | 单次运行，无统计显著性 | 🟡 中 | P1 |
| **触发调优** | Description 优化循环 | 不涉及 | ⚪ 低 | P2 |
| **Eval Viewer** | 本地 HTML + 逐条反馈 | HTML 报告（无反馈表单） | 🟡 中 | P1 |

### 6.3 与 Promptfoo 的差距

| 维度 | Promptfoo | oh-my-knowledge | 差距 | 优先级 |
|------|-----------|-----------------|------|--------|
| **断言类型** | 50+ 种 | 5 种 | 🔴 高 | P0 |
| **配置方式** | YAML 声明式 | JSON 文件 | 🟡 中 | P1 |
| **结构断言** | is-json, is-html, is-sql | 无 | 🟡 中 | P1 |
| **相似度断言** | rouge, bleu, levenshtein, embedding | 无 | 🟡 中 | P1 |
| **成本/延迟断言** | cost, latency 作为断言 | 仅在报告中展示 | 🟡 中 | P1 |
| **Agent 轨迹** | trajectory:tool-used 等 | 无 | ⚪ 低 | P2 |
| **红队测试** | guardrails, is-refusal | 无 | ⚪ 低 | P2 |
| **自定义断言** | javascript, python, webhook | 无 | 🔴 高 | P0 |
| **断言取反** | not- 前缀 | 仅 not_contains | 🟡 中 | P1 |
| **断言组合** | assert-set（阈值逻辑） | 无 | 🟡 中 | P1 |

### 6.4 与 DeepEval 的差距

| 维度 | DeepEval | oh-my-knowledge | 差距 | 优先级 |
|------|----------|-----------------|------|--------|
| **执行轨迹** | 分析每步推理和工具调用 | 只看最终输出 | 🟡 中 | P1 |
| **工具正确性** | ToolCorrectnessMetric | 无 | ⚪ 低 | P2 |
| **任务完成度** | TaskCompletionMetric | 无 | 🟡 中 | P1 |
| **幻觉检测** | HallucinationMetric | 无 | ⚪ 低 | P2 |

### 6.5 与 Braintrust 的差距

| 维度 | Braintrust | oh-my-knowledge | 差距 | 优先级 |
|------|-----------|-----------------|------|--------|
| **可溯源性** | prompt/model/dataset 版本关联 | 仅 timestamp + variant | 🟡 中 | P1 |
| **CI 集成** | 评分作为部署门禁 | 无 | 🟡 中 | P1 |
| **生产 trace → eval** | 一键转为数据集 | 无 | ⚪ 低 | P2 |

---

## 七、改进优先级建议

### P0 — 核心竞争力（v0.2）

| 改进 | 理由 | 工作量 |
|------|------|--------|
| **扩展断言类型** | 5 种太少，至少加 `contains-all`, `contains-any`, `is-json`, `javascript`（自定义） | 中 |
| **盲测 A/B** | 官方核心能力，防止确认偏差，提升评测公信力 | 中 |
| **自动分析** | 发现无区分度断言、高方差样本，不需要 agent，规则引擎即可 | 小 |

### P1 — 实用性提升（v0.3）

| 改进 | 理由 | 工作量 |
|------|------|--------|
| **迭代管理** | iteration-N 目录 + 跨版本对比 | 中 |
| **并行执行** | 串行太慢，多样本并行提速 | 小 |
| **方差分析** | 多次运行 + 统计显著性（t-test），数据更可信 | 中 |
| **YAML 配置** | 降低使用门槛，非开发人员也能写用例 | 中 |
| **成本/延迟断言** | 把"v2 不能比 v1 贵 50%"写成断言 | 小 |
| **反馈表单** | 报告页面加人工 review + 反馈收集 | 中 |
| **CI 集成** | `omk bench ci` 输出 exit code，可接入 GitHub Actions | 小 |
| **可溯源性** | 报告中记录 skill 文件内容 hash + model 版本 | 小 |

### P2 — 长期能力（v0.4+）

| 改进 | 理由 |
|------|------|
| 执行轨迹分析 | 评估推理路径，不只看结果 |
| Agent 轨迹断言 | 评估工具选择序列 |
| 相似度断言（rouge, embedding） | 语义级别对比 |
| 红队测试 | 安全评估 |
| 生产 trace → eval 数据集 | 从真实失败中自动生成用例 |

### 改进路线图

```
v0.1 (当前)              v0.2                    v0.3                    v0.4+
─────────────── →  ────────────────── →  ────────────────── →  ──────────────────
5 种断言            15+ 种断言             YAML 配置              Agent 轨迹
LLM judge           盲测 A/B               迭代管理               相似度断言
串行执行            自动分析               并行执行               红队测试
HTML 报告           自定义断言             方差分析               trace → eval
                                           CI 集成
                                           反馈表单
```

---

## 八、参考资料

### 工具官方文档

- Claude Code skill-creator eval: https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills
- skill-creator SKILL.md: https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
- Promptfoo Assertions: https://www.promptfoo.dev/docs/configuration/expected-outputs/
- Promptfoo Configuration: https://www.promptfoo.dev/docs/configuration/guide/
- DeepEval Agent Evaluation: https://deepeval.com/guides/guides-ai-agent-evaluation
- DeepEval Metrics: https://deepeval.com/docs/metrics-introduction
- Braintrust Evaluate: https://www.braintrust.dev/docs/evaluate
- Braintrust How to Eval: https://www.braintrust.dev/articles/how-to-eval

### 分析文章

- Tessl — Anthropic brings evals to skill-creator: https://tessl.io/blog/anthropic-brings-evals-to-skill-creator-heres-why-thats-a-big-deal/
- Braintrust — DeepEval alternatives 2026: https://www.braintrust.dev/articles/deepeval-alternatives-2026
- Anthropic — Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

### 项目仓库

- oh-my-knowledge: https://github.com/lizhiyao/oh-my-knowledge
- Promptfoo: https://github.com/promptfoo/promptfoo
- DeepEval: https://github.com/confident-ai/deepeval
- SkillForge: https://github.com/AgriciDaniel/skill-forge

---

*最后更新：2026-03-24*
