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
         │  claude -p  │              │  claude -p  │
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

### 评分策略

| 条件 | 方法 | 适用场景 |
|------|------|----------|
| `assertions` | 确定性检查 + 自定义函数 | 通用 — 快速、可靠 |
| `rubric` | LLM 评委打分（1-5 分） | 需要语义理解时 |
| `dimensions` | 多维度 LLM 评分 | 需要多角度评估时 |
| 混合 | 加权综合（默认 50/50） | 兼顾精确与语义 |

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
