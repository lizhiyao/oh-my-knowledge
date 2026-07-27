# 评测用例格式

**eval-samples** 文件是 `omk eval` / `omk doctor` 跑的用例集 —— 一组用例，每条一个 `prompt`，外加可选的 `rubric`、`assertions` 和元数据。支持 JSON 和 YAML（`eval-samples.json`、`eval-samples.yaml`、`eval-samples.yml`），YAML 手写更省事。

想知道怎么**设计**一套严谨用例（测什么、测几条、元数据字段），见[用例设计](../specs/sample-design-spec)；本页是逐字段的格式参考。

## 存放位置

推荐把项目共享用例和 skill 私有用例分开：

- 项目共享用例：放在项目根目录的 `eval-samples.json`、`eval-samples.yaml` 或 `eval-samples.yml`。适合多个 variant 做 A/B 对比，保证它们跑同一套测试集。
- skill 私有用例：放在 `<skill>/.omk/samples.json`、`<skill>/.omk/samples.yaml` 或 `<skill>/.omk/samples.yml`。目录模式也支持在同一个 `.omk/` 下拆成多个 sample 文件。

`omk eval` 只会在单 treatment 且能明确定位到某个 skill 时自动发现 skill 私有用例。多版本对比建议使用项目共享用例，或显式传 `--samples`。

兼容说明：omk 仍支持扁平 skill 的 `skills/<name>.eval-samples.json` 这类 sidecar 文件。目录 skill 不再读取 `<skill>/eval-samples.*`；skill 私有用例统一放在 `<skill>/.omk/samples.json`。

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
| `sample_id` | `string` | **是** | 用例唯一标识 |
| `prompt` | `string` | **是** | 发送给模型的用户提示词 |
| `context` | `string` | 否 | 附加上下文（代码片段等），会被包裹在代码块中拼接到 prompt 后。也支持 URL，运行时自动抓取内容 |
| `cwd` | `string` | 否 | 单用例工作目录覆盖（这一条的 runtime context） |
| `rubric` | `string` | 否 | LLM 评委的评分标准（1-5 分） |
| `assertions` | `array` | 否 | 断言检查列表，详见[断言类型](#断言类型) |
| `assertions[].type` | `string` | **是** | 断言类型 |
| `assertions[].value` | `string\|number` | 视类型 | 检查值（`contains`、`min_length`、`cost_max` 等必填） |
| `assertions[].values` | `array` | 视类型 | 字符串数组（`contains_all`、`contains_any` 必填） |
| `assertions[].pattern` | `string` | 视类型 | 正则表达式（`regex` 必填） |
| `assertions[].flags` | `string` | 否 | 正则标志（默认 `"i"`） |
| `assertions[].schema` | `object` | 视类型 | JSON Schema 对象（`json_schema` 必填，基于 [ajv](https://ajv.js.org/)） |
| `assertions[].reference` | `string` | 视类型 | 参考文本（`semantic_similarity` 必填） |
| `assertions[].threshold` | `number` | 否 | 通过阈值；默认值随类型而定 —— LLM 打分类为 `3`，`rouge_n_min` / `bleu_min` 为 `0.5`，`mock_hit` 为 `1` |
| `assertions[].fn` | `string` | 视类型 | 自定义断言 JS 文件路径（`custom` 必填） |
| `assertions[].weight` | `number` | 否 | 权重（默认 1） |
| `assertions[].not` | `boolean` | 否 | 反转该断言的通过/失败，适用于任意类型 |
| `assertions[].n` | `number` | 否 | `rouge_n_min` 的 n-gram 阶数（默认 1） |
| `dimensions` | `object` | 否 | 多维度评分，key 为维度名，value 为评分标准文本 |

loader 会在任何模型调用前校验完整契约。不支持的断言类型、缺失的类型专属字段、非法正则、非正权重和格式错误的沙箱字段都会作为配置错误失败，绝不会计入模型失败。

## 元数据与沙箱字段

用例还能带**元数据**（纯文档 / 诊断用，不参与 grading / judge / verdict）和**沙箱**字段（用于脱离真实环境评测）。完整指引见[用例设计](../specs/sample-design-spec)，这里给字段索引：

| 字段 | 类型 | 用途 |
|------|------|------|
| `capability` | `string[]` | 该用例覆盖的能力维度（驱动 coverage 诊断） |
| `difficulty` | `'easy' \| 'medium' \| 'hard'` | 难度分桶（强枚举） |
| `construct` | `string` | 测什么：`necessity` / `quality` / `capability`（允许自定义） |
| `provenance` | `'human' \| 'llm-generated' \| 'production-trace'` | 数据来源 |
| `covers` | `{ targetKind, ref }[]` | 可选声明的 skill 结构锚点，建议先用于关键用例；仅用于 Skill Map |
| `mocks` | `object[]` | 工具调用拦截列表 —— 返回假数据而非真调工具 |
| `mocksStrict` | `boolean` | 未命中任何 mock 的工具调用直接 deny（默认 `false`） |
| `tripwire` | `boolean` | 诱错样本：LLM **应当** fail（默认 `false`） |
| `environment` | `object` | 声明性「已就绪」前置：`cli_available` / `files_available` / `notes` |

`covers` 是可选的显式声明字段，不从 prompt 文本里推断。建议先给关键用例、关键 reference / workflow / hard rule 声明它，让 Studio 能画出已声明的结构边，而不是要求每条用例都变成维护负担。不写只表示 Skill Map 暂无这条声明边，不代表该结构一定没被测到：

Studio 的 Skill Map 节点详情也会读取这个声明：选中图中的节点时，会显示该结构关系是否由 `sample.covers` 显式声明。

```yaml
- sample_id: release-risk-summary
  prompt: "总结发布风险和回滚方案。"
  covers:
    - targetKind: reference
      ref: references/release-policy.md
    - targetKind: workflow
      ref: release
    - targetKind: workflow_node
      ref: release.check
```

`targetKind` 支持 `skill`、`skill_file`、`frontmatter`、`reference`、`script`、`hard_rule`、`workflow`、`workflow_node`。`reference` / `script` 的 `ref` 是相对 skill 根目录的路径；`hard_rule` / `workflow` 使用规则或 workflow id；`workflow_node` 使用 `workflowId.nodeId`。这个字段不进入 grading、评委 prompt、verdict，也不进入 sample 指纹。

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

算综合分时，断言会拆成两个独立层 —— **factScore**（事实类检查）和 **behaviorScore**（行为类检查），各自用上面的公式在自己那批断言上打分。

### 2. Rubric / Dimensions 评分

评委模型（默认 `haiku`）按标准打 1-5 分，产出 **judgeScore**。`dimensions` 模式下各维度独立评分后取平均。

### 3. 综合分数

综合分是**所有存在的层分数的平均** —— 共三层：

| 层 | 来源 |
|------|------|
| `factScore` | 事实类断言（`contains` / `regex` / `json_*` / `equals` / `semantic_similarity` / `tool_*_contains` …） |
| `behaviorScore` | 行为类断言（长度 / 词数 / `cost_max` / `latency_max` / `turns_*` / `tools_*` / `custom` …） |
| `judgeScore` | LLM 评委（rubric / dimensions） |

`composite = mean(存在的层)`。某层没有断言（或没配评委）时**从平均里剔除**，不当作 0 分；断言和评委都没有时综合分为 `0`。

完整推导、等权重 caveat、以及多层 verdict gate 与综合分的关系见[评分公式](../specs/scoring)。

## 断言类型

30+ 种，分两类。**确定性**断言本地校验（不调模型）；**LLM 打分**断言会调评委、返回 1-5 分，按 `threshold` 判通过。

**确定性**（本地，不调 LLM）：

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
| `tool_output_contains` / `tool_input_contains` / `tool_input_not_contains` | 工具输入/输出内容匹配（`_not_` 为「不得包含」） |
| `mock_hit` | 声明的沙箱 mock 实际被某次工具调用命中（见[用例设计](../specs/sample-design-spec)） |
| `turns_min` / `turns_max` | 多轮对话轮数限制 |
| `rouge_n_min` | ROUGE-N recall ≥ threshold（`reference` 填参考答案，`n` 默认 1，`threshold` 默认 0.5） |
| `levenshtein_max` | 编辑距离 ≤ value（用于「输出跟参考几乎一致」场景） |
| `bleu_min` | BLEU-4 ≥ threshold（unsmoothed，短文本会塌陷到 0） |
| `custom` | 自定义 JS 函数（30s 超时） |

**LLM 打分**（调评委，1-5 分，`threshold` 默认 3）：

| 类型 | 说明 |
|------|------|
| `faithfulness` | 输出是否被 `sample.context` 支持（反幻觉） |
| `answer_relevancy` | 输出是否切题回答 `sample.prompt`；能抓住跑题、回避、冗余 |
| `context_recall` | `sample.context` 关键事实在输出中的覆盖率（`reference` 可显式列 gold facts） |
| `semantic_similarity` | 与 `reference` 的整体语义相似度 |

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

子断言可独立带 `not: true`；嵌套 `assert-set` 可在**确定性断言**上表达任意布尔逻辑。异步评委断言（`semantic_similarity`、`faithfulness`、`answer_relevancy`、`context_recall`、`custom`）必须保留在顶层，因为 `assert-set` 走同步求值；嵌套这类断言会在执行前被拒绝。

> **分层评分提示。** `assert-set` 只在叶子子断言**同层**（全是事实层 / 全是行为层）时才计入 fact / behavior 分层 composite。**混层** `assert-set`（如一条 `contains` + 一条 `max_length`）没有单一可诚实归属的层，故不计入分层 composite（仍计入扁平的断言通过 / 失败）。若想让某条用例的信号落进分层 composite，优先用叶子断言，或让每个 `assert-set` 保持在同一层内。

## 自定义断言

```js
// my-assertion.mjs
export default function(output, { sample, assertion }) {
  return { pass: output.includes('SQL'), message: '检查了 SQL 关键字' };
}
```
