# oh-my-knowledge

知识载体评测工具 — 用客观数据衡量你的 skill 质量。

**固定模型，只变知识载体，数据说话。**

## 为什么需要这个工具

做知识工程的团队会产出大量 skill（系统提示词、知识包、规则集等）。当被问到"v2 比 v1 好在哪"时，需要客观数据而非主观判断。`oh-my-knowledge` 通过控制变量实验解决这个问题：相同模型、相同测试样本，只改变知识载体。

## 快速开始

```bash
# 安装
npm i oh-my-knowledge -g

# 生成评测项目脚手架
omk bench init my-eval
cd my-eval

# 把要对比的 skill 放到 skills/ 目录
# 方式一：直接放 .md 文件（skills/v1.md, skills/v2.md）
# 方式二：放完整 skill 目录（skills/my-skill-v1/SKILL.md, ...）
# 只放一个 skill 也行，会自动加 baseline 对照

# 预览评测计划
omk bench run --dry-run

# 运行评测（自动发现 skills/ 目录下的所有 skill）
omk bench run
```

## 特性

| 特性 | 说明 |
|------|------|
| **18 种断言** | 包含子串、正则、JSON Schema、语义相似度、自定义函数等 |
| **四维评估** | 质量、成本、效率、稳定性四个维度对比 |
| **多执行器** | 支持 Claude / OpenAI / Gemini CLI |
| **盲测 A/B** | `--blind` 隐藏变体名称，HTML 报告有揭晓按钮 |
| **并行执行** | `--concurrency N` 并行 N 个任务 |
| **多轮方差分析** | `--repeat N` 重复 N 次，计算均值/标准差/置信区间/t 检验 |
| **自动分析** | 检测低区分度断言、均匀分数、全通过/全失败、高成本样本 |
| **人工反馈** | HTML 报告中提交星级评分和备注 |
| **可追溯性** | 报告含 CLI 版本、Node 版本、skill 文件哈希 |
| **中英切换** | HTML 报告右上角一键切换语言 |

## 工作原理

```
eval-samples.json       skills/
                        ├── v1.md 或 v1/SKILL.md
                        └── v2.md 或 v2/SKILL.md
       │                    │
       └────────┬───────────┘
                │
    ┌───────────▼───────────┐
    │  交错调度 + 并发执行    │
    │  s1-v1 → s1-v2 → ...  │
    └───────────┬───────────┘
                │
    ┌───────────▼───────────┐
    │      执行器             │
    │  claude / openai /     │
    │  gemini               │
    └───────────┬───────────┘
                │
    ┌───────────▼───────────┐
    │        评分            │
    │  断言检查 (18 种)      │
    │  LLM 评委 (rubric /   │
    │           dimensions)  │
    └───────────┬───────────┘
                │
    ┌───────────▼───────────┐
    │  报告 + 自动分析       │
    │  四维评估：质量 / 成本  │
    │  / 效率 / 稳定性       │
    │  (JSON + HTML)         │
    └───────────────────────┘
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
      { "type": "not_contains", "value": "没有问题", "weight": 0.5 }
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
| `sample_id` | `string` | **是** | 样本唯一标识 |
| `prompt` | `string` | **是** | 发送给模型的用户提示词 |
| `context` | `string` | 否 | 附加上下文（代码片段等），会被包裹在代码块中拼接到 prompt 后 |
| `rubric` | `string` | 否 | LLM 评委的评分标准（1-5 分） |
| `assertions` | `array` | 否 | 断言检查列表，详见[断言类型](#断言类型) |
| `assertions[].type` | `string` | **是** | 断言类型 |
| `assertions[].value` | `string\|number` | 视类型 | 检查值（`contains`、`min_length`、`cost_max` 等必填） |
| `assertions[].values` | `array` | 视类型 | 字符串数组（`contains_all`、`contains_any` 必填） |
| `assertions[].pattern` | `string` | 视类型 | 正则表达式（`regex` 必填） |
| `assertions[].flags` | `string` | 否 | 正则标志（默认 `"i"`） |
| `assertions[].schema` | `object` | 视类型 | JSON Schema 对象（`json_schema` 必填，基于 [ajv](https://ajv.js.org/)） |
| `assertions[].reference` | `string` | 视类型 | 参考文本（`semantic_similarity` 必填） |
| `assertions[].threshold` | `number` | 否 | 语义相似度通过阈值（默认 3） |
| `assertions[].fn` | `string` | 视类型 | 自定义断言 JS 文件路径（`custom` 必填） |
| `assertions[].weight` | `number` | 否 | 权重（默认 1） |
| `dimensions` | `object` | 否 | 多维度评分，key 为维度名，value 为评分标准文本 |

### 评分策略

#### 1. 断言评分

基于规则的本地检查，每个断言产生通过/失败结果。

**计算方式：**
- 通过率 = 通过断言的权重之和 / 总权重（0~1）
- 分数 = 1 + 通过率 × 4（映射到 1~5 分）
- 示例：3 个断言（权重各 1），2 个通过 → 通过率 = 2/3 → 分数 = 1 + 0.67 × 4 = **3.67**

#### 2. Rubric / Dimensions 评分

评委模型（默认 `haiku`）按标准打 1-5 分。`dimensions` 模式下各维度独立评分后取平均。

#### 3. 综合分数

| 条件 | 公式 |
|------|------|
| 仅断言 | `assertionScore` |
| 仅 LLM | `llmScore` |
| 两者都有 | `(assertionScore + llmScore) / 2` |
| 都没有 | `0` |

### 断言类型

**确定性断言（18 种）：**

| 类型 | 说明 |
|------|------|
| `contains` / `not_contains` | 包含/不包含子串 |
| `regex` | 正则匹配 |
| `min_length` / `max_length` | 长度范围 |
| `json_valid` / `json_schema` | JSON 校验 |
| `starts_with` / `ends_with` | 前缀/后缀匹配 |
| `equals` / `not_equals` | 精确匹配 |
| `word_count_min` / `word_count_max` | 词数范围 |
| `contains_all` / `contains_any` | 多值匹配 |
| `cost_max` / `latency_max` | 成本/延迟限制 |
| `semantic_similarity` | LLM 语义相似度 |
| `custom` | 自定义 JS 函数（30s 超时） |

### 自定义断言

```js
// my-assertion.mjs
export default function(output, { sample, assertion }) {
  return { pass: output.includes('SQL'), message: '检查了 SQL 关键字' };
}
```

## 四维评估指标

评测报告从四个维度展示结果：

| 维度 | 指标 | 说明 |
|------|------|------|
| 📊 **质量** | 综合分数、断言分、LLM 评分、min/max | 基于断言和 LLM 评委的综合评分 |
| 💰 **成本** | 总成本、输入/输出 Token 数 | 基于 Token 消耗和模型定价的 API 费用 |
| ⚡ **效率** | 平均延迟 (ms) | 从发送请求到收到完整响应的端到端耗时 |
| 🛡️ **稳定性** | 成功率 (%) | 模型调用成功率，失败包括超时、API 错误等 |

## CLI 参考

### `omk bench run`

```bash
omk bench run [选项]

选项：
  --samples <路径>       样本文件（默认：eval-samples.json，自动检测 .yaml/.yml）
  --skill-dir <路径>     skill 目录（默认：skills）
  --variants <a,b>       变体名称，不指定时自动从 skill 目录发现
                         只有一个 skill 时自动加 baseline 对照
                         特殊值：baseline（无 skill）、git:name（git 历史版本）、
                         git:ref:name（指定 commit）、含 / 的路径（直接读取文件）
  --model <名称>         被测模型（默认：sonnet）
  --judge-model <名称>   评委模型（默认：haiku）
  --output-dir <路径>    输出目录（默认：~/.oh-my-knowledge/reports/）
  --no-judge             跳过 LLM 评分
  --dry-run              仅预览
  --blind                盲测模式
  --concurrency <n>      并行任务数（默认：1）
  --repeat <n>           重复 N 次做方差分析（默认：1）
  --executor <名称>      执行器（默认：claude）
  --each                 批量评测：每个 skill 独立和 baseline 对比
                         需要每个 skill 配对 {name}.eval-samples.json
```

### `omk bench run --each`（批量评测）

当 skills/ 下放了多个**独立的** skill 时，使用 `--each` 逐个评测，每个 skill 独立和 baseline 对比，生成一份合并报告。

```
skills/
├── asset.md                       ← skill 文件
├── asset.eval-samples.json        ← 配对的测试集
├── home.md
├── home.eval-samples.json
└── product/                       ← 目录格式也支持
    ├── SKILL.md
    └── eval-samples.json
```

配对规则：
- `{name}.md` → 查找同目录下的 `{name}.eval-samples.json`
- `{name}/SKILL.md` → 查找 `{name}/eval-samples.json`
- 没有配对 eval-samples 的 skill 会被跳过并打印警告

```bash
omk bench run --each
omk bench run --each --dry-run
```

### `omk bench gen-samples`（生成测评用例）

读取 skill 内容，通过 LLM 自动生成 eval-samples。生成后请审查编辑再跑评测。

```bash
# 为指定 skill 生成测试集（输出到 eval-samples.json）
omk bench gen-samples skills/my-skill.md

# 为 skills/ 下所有缺少测试集的 skill 批量生成
omk bench gen-samples --each

# 指定生成数量
omk bench gen-samples skills/my-skill.md --count 10
```

选项：
```
  --each                 为所有缺少 eval-samples 的 skill 批量生成
  --count <n>            每个 skill 生成的样本数（默认：5）
  --model <名称>         生成用的模型（默认：sonnet）
  --skill-dir <路径>     skill 目录（默认：skills），配合 --each 使用
```

### `omk bench evolve`（自我循环改进）

让 AI 自动迭代 skill：评测 → 分析弱点 → LLM 改进 → 再评测 → 分数涨了留、没涨扔 → 重复。

```bash
# 基本用法：迭代 5 轮
omk bench evolve skills/my-skill.md

# 指定轮数和目标分数
omk bench evolve skills/my-skill.md --rounds 10 --target 4.5
```

选项：
```
  --rounds <n>           最大迭代轮数（默认：5）
  --target <分数>        目标分数，达到即停
  --samples <路径>       样本文件（默认：eval-samples.json）
  --improve-model <名称> 改进用模型（默认：sonnet）
```

每轮产出保存在 `skills/evolve/` 目录（`my-skill.r0.md`、`my-skill.r1.md`...），可以 diff 查看 AI 改了什么。最佳版本自动写回原始文件。

### `omk bench ci`

在自动化流水线中运行评测。评分达标则退出码为 0（通过），否则为 1（失败），可直接用于卡点判断。

```bash
omk bench ci [选项]
  --threshold <数值>     达标的最低综合分数（默认：3.5）
```

### `omk bench report`

启动报告服务，浏览历史报告、提交反馈、删除报告。

```bash
omk bench report [选项]
  --port <端口号>        服务端口（默认：7799）
```

### `omk bench init`

```bash
omk bench init [目录]    # 生成评测项目脚手架
```

## 执行器

| 执行器 | 适用场景 | 说明 |
|--------|----------|------|
| `claude` | 默认 | 通过 `claude -p` 调用模型 |
| `openai` | 跨厂商对比 | 通过 `openai api` CLI 调用 |
| `gemini` | 跨厂商对比 | 通过 `gemini` CLI 调用 |

### Skill 目录结构

默认执行器（claude/openai/gemini）支持两种 skill 布局，同一次评测中可混用：

```
skills/
├── v1.md                    # 方式一：直接放 .md 文件
└── my-skill/                # 方式二：完整 skill 目录
    ├── SKILL.md             #   工具自动读取此文件作为 system prompt
    ├── config.json          #   其他文件不参与评测，仅保留完整性
    └── scripts/
```

**Variant 解析规则：**

| 格式 | 含义 |
|------|------|
| `name` | 从 skill 目录查找 `name.md` 或 `name/SKILL.md` |
| `baseline` | 无 skill 对照（不使用 system prompt） |
| `git:name` | 从 git HEAD 读取 skill 的上次提交版本 |
| `git:ref:name` | 从 git 指定 commit 读取 |
| `./path/to/file.md` | 含 `/` 的路径，直接读取文件 |

不指定 `--variants` 时，自动扫描 skill 目录下的所有 `.md` 文件和含 `SKILL.md` 的子目录。只有一个 skill 时自动加 `baseline` 作为对照。

```bash
# 自动发现 skills/ 下所有 skill
omk bench run

# 显式指定两个变体
omk bench run --variants v1,v2

# 对比无 skill 和有 skill 的效果差异
omk bench run --variants baseline,my-skill

# 对比修改前后（旧版本从 git 历史读取）
omk bench run --variants git:my-skill,my-skill

# 直接指定文件路径
omk bench run --variants ./old-skill.md,./new-skill.md
```

**前置要求：**
- **claude**：安装 [Claude Code](https://claude.ai/code) 并认证
- **openai**：`pip install openai` 并设置 `OPENAI_API_KEY`
- **gemini**：`npm i -g @google/gemini-cli` 并认证

## 环境变量

| 变量 | 说明 |
|------|------|
| `CCV_PROXY_URL` | 将请求代理到 cc-viewer，实时可视化评测流量 |
| `OMK_BENCH_PORT` | 报告服务端口（默认：7799） |

## 系统要求

- Node.js >= 20
- `claude` CLI（用于默认执行器和 LLM 评委，安装方式见 [Claude Code](https://claude.ai/code)）
  - 使用其他执行器（openai/gemini）且加 `--no-judge` 时可不装

## 安全说明

本工具设计用于**本地可信环境**（开发机、CI 流水线）。以下功能会执行本地代码，请确保输入来源可信：

| 功能 | 风险说明 | 适用范围 |
|------|----------|----------|
| **自定义断言** (`custom`) | 动态加载并执行用户指定的 `.mjs` 文件 | 仅使用自己编写或审查过的断言文件 |
| **eval-samples.json** | 断言配置中可引用外部文件路径 | 不要使用不可信来源的样本文件 |

**建议：**
- 不要在公网服务中暴露 `omk bench report` 服务（无认证）
- 不要用不可信的第三方 eval-samples 文件
- 自定义断言有 30 秒执行超时，但无沙箱隔离