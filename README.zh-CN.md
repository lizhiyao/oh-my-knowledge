# oh-my-knowledge

知识载体评测工具 — 用客观数据衡量你的 skill 质量。

**固定模型，只变知识载体，数据说话。**

[English](./README.md) | 中文

## 为什么需要这个工具

做知识工程的团队会产出大量 skill（系统提示词、知识包、规则集等）。当被问到"v2 比 v1 好在哪"时，需要客观数据而非主观判断。`oh-my-knowledge` 通过控制变量实验解决这个问题：相同模型、相同测试样本，只改变知识载体。

## 快速开始

```bash
# 全局安装
npm i -g oh-my-knowledge

# 生成评测项目脚手架
omk bench init my-eval
cd my-eval

# 预览评测计划
omk bench run --dry-run

# 运行评测
omk bench run --variants v1,v2

# 查看报告
omk bench report
# 浏览器打开 http://127.0.0.1:7799
```

## 工作原理

```
eval-samples.json     skills/v1.md     skills/v2.md
       │                    │                │
       └────────┬───────────┘                │
                │                            │
         ┌──────▼──────┐              ┌──────▼──────┐
         │  样本 +     │              │  样本 +     │
         │  skill v1   │              │  skill v2   │
         └──────┬──────┘              └──────┬──────┘
                │                            │
         ┌──────▼──────┐              ┌──────▼──────┐
         │  Executor   │              │  Executor   │
         │ claude      │              │ claude      │
         │ openai      │              │ openai      │
         │ gemini      │              │ gemini      │
         └──────┬──────┘              └──────┬──────┘
                │                            │
         ┌──────▼──────────────────────▼──────┐
         │            评分                     │
         │  ┌─────────────┐ ┌──────────────┐  │
         │  │  断言检查   │ │  LLM 评委    │  │
         │  │  (18 种)    │ │  (rubric 或  │  │
         │  │             │ │   dimensions)│  │
         │  └─────────────┘ └──────────────┘  │
         └──────────────────┬─────────────────┘
                            │
                  ┌─────────▼─────────┐
                  │  报告 + 自动分析   │
                  │  (JSON/HTML)       │
                  └───────────────────┘
```

## 评测样本格式

支持 JSON 和 YAML（`eval-samples.json`、`eval-samples.yaml`、`eval-samples.yml`）。

文件内容是一个样本对象数组。每个样本代表一个用于评估 skill 的测试用例。

```json
[
  {
    "sample_id": "s001",
    "prompt": "审查这段代码的安全性",
    "context": "function auth(u, p) { db.query('SELECT * FROM users WHERE name=' + u); }",
    "rubric": "应识别 SQL 注入风险并建议参数化查询",
    "assertions": [
      { "type": "contains", "value": "SQL 注入", "weight": 1 },
      { "type": "contains", "value": "参数化", "weight": 1 },
      { "type": "not_contains", "value": "没有问题", "weight": 0.5 },
      { "type": "json_valid" },
      { "type": "cost_max", "value": 0.01 },
      { "type": "custom", "fn": "my-assertion.mjs", "weight": 1 }
    ],
    "dimensions": {
      "security": "是否识别出注入漏洞",
      "actionability": "是否给出可直接使用的修复代码"
    }
  }
]
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sample_id` | `string` | **是** | 样本唯一标识（如 `"s001"`）。在报告和分析中用于引用该测试用例。 |
| `prompt` | `string` | **是** | 发送给模型的用户提示词。即模型需要回答的任务或问题。 |
| `context` | `string` | 否 | 附加到 prompt 的上下文信息（如代码片段、文档文本）。如果提供，会被包裹在代码块中拼接到 `prompt` 后面。 |
| `rubric` | `string` | 否 | 供 LLM 评委使用的自然语言评分标准。评委模型根据此标准对输出打 1-5 分。适用于需要语义/定性评估的场景。 |
| `assertions` | `array` | 否 | 应用于模型输出的确定性和异步检查列表。每个断言是一个包含 `type` 字段的对象（参见[断言类型](#断言类型)）。 |
| `assertions[].type` | `string` | **是** | 断言类型（如 `"contains"`、`"json_valid"`、`"custom"`）。完整列表见下文。 |
| `assertions[].value` | `string\|number` | 视类型 | 用于检查的值。`contains`、`starts_with`、`equals`、`min_length`、`cost_max` 等类型必填。 |
| `assertions[].values` | `array` | 视类型 | 字符串数组。`contains_all` 和 `contains_any` 类型必填。 |
| `assertions[].pattern` | `string` | 视类型 | 正则表达式模式。`regex` 类型必填。 |
| `assertions[].flags` | `string` | 否 | 正则表达式标志（默认：`"i"`）。仅用于 `regex` 类型。 |
| `assertions[].schema` | `object` | 视类型 | JSON Schema 对象。`json_schema` 类型必填。通过 [ajv](https://ajv.js.org/) 验证（支持完整 JSON Schema 规范）。 |
| `assertions[].reference` | `string` | 视类型 | 用于语义比较的参考文本。`semantic_similarity` 类型必填。 |
| `assertions[].threshold` | `number` | 否 | 语义相似度匹配通过的最低分数（1-5）。默认：`3`。 |
| `assertions[].fn` | `string` | 视类型 | 导出检查函数的 `.mjs` 文件路径。`custom` 类型必填。相对于样本文件所在目录解析。 |
| `assertions[].weight` | `number` | 否 | 该断言在综合分数中的权重。默认：`1`。权重越高，对最终断言分数的影响越大。 |
| `dimensions` | `object` | 否 | 多维度 LLM 评分的键值映射。每个 key 是维度名称（如 `"security"`），value 是 LLM 评委对该维度打分（1-5）所依据的评分标准文本。各维度分数取平均值作为 LLM 分数。 |

**评分优先级：** 如果同时存在 `assertions` 和 `rubric`/`dimensions`，综合分数为两者的 50/50 加权平均。如果只有其一，直接使用该分数。如果都没有，分数为 0。

**Prompt 拼接规则：** 发送给模型的最终 prompt 为：无 `context` 时只发 `prompt`；有 `context` 时为 `prompt + "\n\n```\n" + context + "\n```"`。

### 评分策略

每个样本最多可以使用三种评分方法，可以单独使用，也可以组合使用。

#### 1. 断言评分（确定性评分）

断言是基于规则的本地检查，不需要 LLM 调用（`semantic_similarity` 和 `custom` 除外）。每个断言产生 **通过/失败** 结果。

**断言分数计算方式：**

1. 每个断言有一个 `weight`（默认：1）
2. 将所有通过的断言权重求和 → `passedWeight`
3. 将所有断言权重求和 → `totalWeight`
4. 计算比率：`passedWeight / totalWeight`（0.0 ~ 1.0）
5. 归一化到 1-5 分制：**`score = 1 + ratio × 4`**

示例：3 个断言（权重各 1），2 个通过 → 比率 = 2/3 → 分数 = 1 + 2.67 = **3.67**

#### 2. Rubric 评分（单维度 LLM 评委）

评委模型（默认：`haiku`，可通过 `--judge-model` 配置）阅读模型输出，按照 rubric 文本进行评分。返回 **1**（不达标）到 **5**（优秀）的整数分数及简短理由。

每个样本只应使用 `rubric` 或 `dimensions` 之一。如果两者都存在，`dimensions` 优先。

#### 3. Dimensions 评分（多维度 LLM 评委）

每个维度由评委模型独立评分（1-5）。各维度分数取**平均值**作为 LLM 分数。

示例：`security: 5`、`actionability: 3` → LLM 分数 = **(5 + 3) / 2 = 4.0**

#### 综合分数

| 存在的评分条件 | 综合分数计算公式 |
|---------------|----------------|
| 仅有断言 | `assertionScore` |
| 仅有 LLM（rubric 或 dimensions） | `llmScore` |
| 两者都有 | `(assertionScore + llmScore) / 2` |
| 都没有 | `0` |

所有分数均采用 **1-5 分制**。分数为 0 表示未定义任何评分条件。

### 断言类型

**确定性断言（同步，无 LLM 调用）：**

| 类型 | 字段 | 说明 |
|------|------|------|
| `contains` | `value`, `weight` | 输出包含指定子串（不区分大小写） |
| `not_contains` | `value`, `weight` | 输出不包含指定子串 |
| `regex` | `pattern`, `flags`, `weight` | 输出匹配正则表达式 |
| `min_length` | `value`, `weight` | 输出长度 >= 指定值 |
| `max_length` | `value`, `weight` | 输出长度 <= 指定值 |
| `json_valid` | `weight` | 输出是合法 JSON |
| `json_schema` | `schema`, `weight` | 输出符合 JSON Schema（完整规范，基于 ajv） |
| `starts_with` | `value`, `weight` | 输出以指定字符串开头（不区分大小写） |
| `ends_with` | `value`, `weight` | 输出以指定字符串结尾（不区分大小写） |
| `equals` | `value`, `weight` | 输出完全等于指定值（trim 后比较） |
| `not_equals` | `value`, `weight` | 输出不等于指定值（trim 后比较） |
| `word_count_min` | `value`, `weight` | 词数 >= 指定值 |
| `word_count_max` | `value`, `weight` | 词数 <= 指定值 |
| `contains_all` | `values`, `weight` | 输出包含所有指定子串 |
| `contains_any` | `values`, `weight` | 输出包含至少一个指定子串 |
| `cost_max` | `value`, `weight` | 执行成本 (USD) <= 指定值 |
| `latency_max` | `value`, `weight` | 执行延迟 (ms) <= 指定值 |

**异步断言（需要 LLM 或外部调用）：**

| 类型 | 字段 | 说明 |
|------|------|------|
| `semantic_similarity` | `reference`, `threshold`, `weight` | LLM 判断与参考文本的语义相似度（threshold 默认 3） |
| `custom` | `fn`, `weight` | 加载外部 JS 函数（见下文） |

### 自定义断言

创建一个 `.mjs` 文件并导出函数：

```js
// my-assertion.mjs
export default function(output, { sample, assertion }) {
  const hasKeyword = output.includes('SQL');
  return { pass: hasKeyword, message: '检查了 SQL 关键字' };
}
```

在样本中引用：`{ "type": "custom", "fn": "my-assertion.mjs" }`。`fn` 路径相对于样本文件所在目录解析。

## CLI 参考

### `omk bench run`

```bash
omk bench run [选项]

选项：
  --samples <路径>       样本文件（默认：eval-samples.json，自动检测 .yaml/.yml）
  --skill-dir <路径>     skill 定义目录（默认：skills）
  --variants <v1,v2>     要对比的版本（默认：v1,v2）
  --model <名称>         被测模型（默认：sonnet）
  --judge-model <名称>   评委模型（默认：haiku）
  --output-dir <路径>    输出目录（默认：~/.oh-my-knowledge/reports/）
  --no-judge             跳过 LLM 评分
  --dry-run              仅预览，不实际执行
  --blind                盲测模式：隐藏变体名称
  --concurrency <n>      并行任务数（默认：1）
  --repeat <n>           重复运行 N 次做方差分析（默认：1）
  --executor <名称>      执行器（默认：claude）
```

### `omk bench ci`

在 CI 中运行评测，以退出码表示通过/失败。

```bash
omk bench ci [选项]

选项：
  （与 bench run 相同，另加：）
  --threshold <数值>     通过的最低综合分数（默认：3.5）
```

退出码 0 = 所有变体通过，1 = 至少一个变体低于阈值。

### `omk bench report`

```bash
omk bench report [选项]

选项：
  --port <端口号>        服务端口（默认：7799）
  --reports-dir <路径>   报告目录（默认：~/.oh-my-knowledge/reports/）
```

### `omk bench init`

```bash
omk bench init [目录]    # 生成评测项目脚手架
```

## 特性

### 盲测 A/B

使用 `--blind` 隐藏报告中的变体名称。变体被随机标记为"Variant A"、"Variant B"等。HTML 报告中有揭晓按钮可显示真实映射。

### 并行执行

使用 `--concurrency N` 并行执行 N 个任务。任务保持交错调度顺序以减少时间偏差。

### 多轮方差分析

使用 `--repeat N` 重复运行评测 N 次。报告包含：
- 每个变体的均值、标准差、95% 置信区间
- 变体间的 Welch t 检验（p < 0.05 显著性判定）

### 自动分析

每次评测后自动检测：
- **低区分度断言**：所有变体结果完全相同的断言
- **均匀分数**：变体间分差 < 0.5 的样本
- **全通过 / 全失败**：可能过于宽松或严格的断言
- **高成本样本**：成本显著高于平均值的样本

洞察和建议会显示在 HTML 报告中。

### 人工反馈

HTML 报告中每个样本-变体对提供星级评分（1-5）和备注表单。反馈通过 `POST /api/run/:id/feedback` 持久化到报告 JSON。

### 可追溯性

报告元数据中包含 `cliVersion`、`nodeVersion` 和 `skillHashes`（每个 skill 文件的 SHA-256），确保可复现。

## 执行器

通过 `--executor` 选择模型提供商。

| 执行器 | CLI 工具 | 默认模型 | 认证方式 |
|--------|----------|----------|----------|
| `claude` | `claude -p` | `sonnet` | Claude Max plan 或 API Key |
| `openai` | `openai api chat.completions.create` | `gpt-4o` | `OPENAI_API_KEY` 环境变量 |
| `gemini` | `gemini`（stdin 管道） | Gemini 默认模型 | Google 账号或 `GOOGLE_API_KEY` |

```bash
# 使用 OpenAI
omk bench run --executor openai --model gpt-4o --variants v1,v2

# 使用 Gemini
omk bench run --executor gemini --model gemini-2.5-pro --variants v1,v2

# 跨提供商对比同一 skill（分别运行，对比报告）
omk bench run --executor claude --model sonnet --variants v1,v2
omk bench run --executor openai --model gpt-4o --variants v1,v2
```

**前置要求：**
- **claude**：安装 [Claude Code](https://claude.ai/code) 并完成认证
- **openai**：`pip install openai` 并设置 `OPENAI_API_KEY`
- **gemini**：`npm i -g @google/gemini-cli` 并完成 Google 账号认证

## 环境变量

| 变量 | 说明 |
|------|------|
| `CCV_PROXY_URL` | 将请求代理到 cc-viewer，实时可视化评测流量 |
| `OMK_BENCH_PORT` | 报告服务端口（默认：7799） |

## 系统要求

- Node.js >= 20
- 已安装并登录 `claude` CLI（Max plan 即可，无需 API Key）

## 许可证

MIT
