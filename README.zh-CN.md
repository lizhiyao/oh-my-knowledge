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
         │  │ 确定性断言  │ │  LLM 评委    │  │
         │  │ (contains,  │ │  (rubric 或  │  │
         │  │  regex...)  │ │   dimensions)│  │
         │  └─────────────┘ └──────────────┘  │
         └──────────────────┬─────────────────┘
                            │
                     ┌──────▼──────┐
                     │    报告     │
                     │ (JSON/HTML) │
                     └─────────────┘
```

## 评测样本格式

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

### 评分策略

| 条件 | 方法 | 适用场景 |
|------|------|----------|
| `assertions` | 确定性检查（contains、regex、length） | 通用 — 快速、可靠 |
| `rubric` | LLM 评委打分（1-5 分） | 需要语义理解时 |
| `dimensions` | 多维度 LLM 评分 | 需要多角度评估时 |
| 混合 | 加权综合（默认 50/50） | 兼顾精确与语义 |

### 断言类型

| 类型 | 字段 | 说明 |
|------|------|------|
| `contains` | `value`, `weight` | 输出包含指定子串（不区分大小写） |
| `not_contains` | `value`, `weight` | 输出不包含指定子串 |
| `regex` | `pattern`, `flags`, `weight` | 输出匹配正则表达式 |
| `min_length` | `value`, `weight` | 输出长度 >= 指定值 |
| `max_length` | `value`, `weight` | 输出长度 <= 指定值 |

## CLI 参考

### `omk bench run`

```bash
omk bench run [选项]

选项：
  --samples <路径>       样本文件（默认：eval-samples.json）
  --skill-dir <路径>     skill 定义目录（默认：skills）
  --variants <v1,v2>     要对比的版本（默认：v1,v2）
  --model <名称>         被测模型（默认：sonnet）
  --judge-model <名称>   评委模型（默认：haiku）
  --output-dir <路径>    输出目录（默认：~/.oh-my-knowledge/reports/）
  --no-judge             跳过 LLM 评分
  --dry-run              仅预览，不实际执行
  --executor <名称>      执行器（默认：claude）
```

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
