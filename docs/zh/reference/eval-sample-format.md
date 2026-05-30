# 评测样本格式

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

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sample_id` | `string` | **是** | 样本唯一标识 |
| `prompt` | `string` | **是** | 发送给模型的用户提示词 |
| `context` | `string` | 否 | 附加上下文（代码片段等），会被包裹在代码块中拼接到 prompt 后。也支持 URL，运行时自动抓取内容 |
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

## URL 自动抓取

`prompt` 和 `context` 中的 URL 会在评测前自动抓取内容并内联到文本中。适用于引用在线文档、API 文档等场景：

```json
{
  "sample_id": "s001",
  "prompt": "请根据以下 PRD 文档生成评测用例：https://wiki.example.com/prd/feature-x"
}
```

运行时，URL 会被替换为实际文档内容。获取顺序：先通过 MCP Server 获取匹配的 URL（如 SSO 保护的私有文档），再通过 HTTP 获取剩余 URL。MCP 已成功的 URL 不会重复 HTTP 抓取。

**私有文档 URL**：在项目目录放一个 `.mcp.json` 配置文件，或通过 `--mcp-config` 指定路径：

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["@example/docs-mcp-server"],
      "env": { "DOCS_API_TOKEN": "xxx" },
      "urlPatterns": ["docs.example.com"],
      "fetchTool": {
        "name": "fetch_doc",
        "urlTransform": {
          "regex": "docs\\.example\\.com/([^/]+/[^/]+)/([^/?#]+)",
          "params": { "namespace": "$1", "slug": "$2" }
        },
        "contentExtract": "data.body"
      }
    }
  }
}
```

**公网 URL**：直接 HTTP 获取，如果需要认证请确保命令行环境已配置好网络访问（VPN、代理等）。

## 评分策略

### 1. 断言评分

基于规则的本地检查，每个断言产生通过/失败结果。

**计算方式：**

- 通过率 = 通过断言的权重之和 / 总权重（0~1）
- 分数 = 1 + 通过率 × 4（映射到 1~5 分）
- 示例：3 个断言（权重各 1），2 个通过 → 通过率 = 2/3 → 分数 = 1 + 0.67 × 4 = **3.67**

### 2. Rubric / Dimensions 评分

评委模型（默认 `haiku`）按标准打 1-5 分。`dimensions` 模式下各维度独立评分后取平均。

### 3. 综合分数

| 条件 | 公式 |
|------|------|
| 仅断言 | `assertionScore` |
| 仅 LLM | `llmScore` |
| 两者都有 | `(assertionScore + llmScore) / 2` |
| 都没有 | `0` |

## 断言类型

**确定性断言（30+ 种）：**

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
| `tools_called` / `tools_not_called` / `tools_count_min` / `tools_count_max` | Agent 工具调用断言 |
| `tool_output_contains` / `tool_input_contains` | 工具输入/输出内容匹配 |
| `turns_min` / `turns_max` | 多轮对话轮数限制 |
| `rouge_n_min` | ROUGE-N recall ≥ threshold（`reference` 字段填参考答案，`n` 默认 1，`threshold` 默认 0.5） |
| `levenshtein_max` | 编辑距离 ≤ value（用于「输出跟参考几乎一致」场景） |
| `bleu_min` | BLEU-4 ≥ threshold（unsmoothed，短文本会塌陷到 0） |
| `faithfulness` | 输出是否被 `sample.context` 支持（反幻觉）；LLM judge 1-5 评分，threshold 默认 3 |
| `answer_relevancy` | 输出是否切题回答 `sample.prompt`；能抓住跑题、回避、冗余；threshold 默认 3 |
| `context_recall` | `sample.context` 关键事实在输出中的覆盖率；`reference` 可显式指定 gold facts；threshold 默认 3 |
| `semantic_similarity` | LLM 语义相似度（与 reference 的整体相似度，与 RAG 三 metric 互补） |
| `custom` | 自定义 JS 函数（30s 超时） |

**通用修饰：**

任何断言加 `not: true` 即反向（替代 `not_contains` / `not_equals` 等成对类型；老类型保留作 alias）：

```yaml
- type: regex
  pattern: "TODO|FIXME"
  not: true              # 必须不含 TODO/FIXME
```

**断言组合（assert-set）：**

`assert-set` 类型让多个断言以 `any`（OR）或 `all`（AND）逻辑组合，可嵌套：

```yaml
- type: assert-set
  mode: any              # 任一通过即过 (mode: 'all' 则需全部通过)
  children:
    - { type: contains, value: "参数化" }
    - { type: contains, value: "prepared statement" }
    - { type: regex, pattern: "bind\\(.*\\?" }
```

子断言可独立带 `not: true`；嵌套 assert-set 可表达任意布尔逻辑。

## 自定义断言

```js
// my-assertion.mjs
export default function(output, { sample, assertion }) {
  return { pass: output.includes('SQL'), message: '检查了 SQL 关键字' };
}
```
