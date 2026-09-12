# 评测样本格式

OMK 用同一个 `omk.eval-sample-set/v3` 封套表达 prompt、RAG、skill、agent 和 workflow 的样本。共同骨架分开执行输入、运行条件、预期结果、评分声明和注释；应用专用 JSON Schema 描述任务数据，不再另建多套样本协议。

## 存放位置

自动发现只识别当前作用域的 `.omk/eval-samples.json` 或 `.omk/eval-samples.yaml`，同时存在两者会报歧义错误。其他 JSON／YAML 文件或分片目录使用 `--samples <path>` 显式指定。所有加载文件中的 ID 必须唯一。根级 `requires` 可包含 `tools`、`files`、`env` 和 `preflight` 字符串数组。

Beta 阶段**只支持 v3**。v2 和未版本化输入明确报错，不保留兼容 reader，不提供迁移工具。读取不会改写旧文件；请重新编写新文档，或通过 `omk init`／`omk sample` 生成后审阅。已有报告继续遵守自身 Schema。新输入和评分绑定形成新的测量身份，不能直接把旧分数拼进新比较序列。

机器契约见 [Eval Sample Set v3 JSON Schema](../../../schemas/eval-samples/v3/eval-sample-set.schema.json)。未知字段会被拒绝，包括旧 `prompt`、`context` 和 `sample_id` 字段。

```json
{
  "schemaVersion": "omk.eval-sample-set/v3",
  "samples": [{
    "sampleId": "review-1",
    "input": { "inputKind": "text", "text": "审查：db.query('SELECT * FROM users WHERE name=' + username)" },
    "evaluationContext": {
      "assertions": [{ "type": "contains", "value": "SQL" }],
      "rubric": { "security": { "criterion": "指出注入风险并给出具体修复。", "weight": 1 } }
    },
    "annotations": { "provenance": "human", "difficulty": "easy" }
  }]
}
```

## 字段说明

| 字段 | 契约 |
| --- | --- |
| `sampleId` | 必填，稳定的非空 ID，在加载的数据集中唯一 |
| `input` | 必填，区分 `text`、`json` 和 `messages` |
| `executionContext` | 可选，包含 `cwd`、`allowedTools`、`mocks`、`mocksStrict`、仅作题设的 `environment` 和应用 JSON `data` |
| `expected` | 可选，参考结果 JSON，只通过显式评分绑定消费 |
| `evaluationContext` | 可选，包含 `assertions`、`rubric`、仅供评分的 `reference` 和结构化 `checks` |
| `annotations` | 可选，包含 `capability`、`difficulty`、`construct`、`provenance`、`covers` 和 `tripwire`，不进入执行输入 |

`rubric` 每项包含非空 `criterion` 和正数 `weight`，权重之和为 1。`reference` 取代旧 `context` 含混的评分用途，**绝不拼入执行输入**。faithfulness 和 context-recall 断言需要自身的 `reference` 或 `evaluationContext.reference`。文本 rubric 和 LLM 断言评分要求文本输入。本次不引入新的评委 prompt 或评分公式。

## 输入与适配器支持

- `text`：`{ "inputKind": "text", "text": "..." }`，保留空白字符。声明 `executionContext.environment` 时，显式渲染为仅作 prompt 上下文的题设，不创建文件。`input.text` 内 HTTP URL 沿用宿主解析行为：编译前解析并封存内容，失败则停止；评分参考和结构化值不会被扫描、抓取。
- `json`：包含 `inputKind`、`value`、`schema`、`schemaDocument`。`schema` 复用 Core 的 `schemaVersion`、`schemaUri`、`schemaDigest`；摘要必须等于内嵌文档的 canonical JSON 摘要，URI 必须等于其 `$id`。自包含 JSON Schema 2020-12 校验 `value`，不做类型转换、默认值填充、属性删除或远端 Schema 加载。
- `messages`：包含 `inputKind: messages`、`interactionMode: history` 和非空 `messages`。每条消息有 `messageId`、`role` 和文本 `content`。角色为 `system`、`user`、`assistant`、`tool`。assistant 的 `toolCalls` 包含 `toolCallId`、`name`、JSON 对象 `arguments`；tool 结果引用此前尚未完成的调用。同一 ID 重复、孤立或重复结果、未完成调用、迟到的 system 消息均会被拒绝。

**执行器能力明确声明：**

| 执行器 | 文本 | JSON | 消息历史 |
| --- | --- | --- | --- |
| `openai-api`、`anthropic-api` | 支持 | canonical JSON 用户封套 | 原生 system/user/assistant 角色 |
| `codex`、`codex-sdk`、`claude`、`claude-sdk` | 支持 | 拒绝 | 拒绝 |
| custom-command | 支持 | 完整输入封套 | 完整输入封套，由应用解释 |

API 适配器先按样本 Schema 校验 JSON，再把完整类型封套以 canonical JSON 发送到用户内容。这是明确的文本映射，不是服务商的 JSON 输入通道，也不保证结构化输出。消息历史使用原生角色；支持文件和运行数据作为独立内容块放在第一条 user 消息中。OpenAI 用 `instructions` 承载知识载体，样本 system 内容保留为原生系统消息；Anthropic 将知识载体与样本系统消息依次放入顶层 `system` 内容块。消息 ID 保留在 OMK 证据中，不冒充服务商消息 ID。

API 历史要求内容非空，可有前置 system 消息，随后 user/assistant 交替，并以 user 开始和结束。工具调用历史、assistant 预填和其他序列在请求前被拒绝；这些应用协议使用 custom-command。输入历史是题设，不是本轮执行证据，输出轨迹只记录新生成的一轮。不启用工具、远端会话状态或用户模拟器。

API adapter identity 升级到 1.3.0，输入 Schema 升级到 v2，支持的映射策略计入指纹。原有 Core 原始 JSON 和文本渲染继续支持；Core 对象一旦声明 `inputKind`，就采用样本输入校验。更换适配器身份后应建立新比较序列，样本文件仍为 v3。供应商映射依据 [Responses](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create) 和 [Messages](https://platform.claude.com/docs/en/api/messages/create) 官方协议。

custom-command 的 `omk.custom-command-exchange/v1` 请求收到完整结构化输入封套和 `trial.executionContext`。所有执行器请求均不包含标准答案和评分上下文。

## 结构化检查

`checkKind: exact-match` 将输出或轨迹中的 JSON pointer，与 `expected` 中的 JSON pointer 显式绑定。OMK 复用 Evaluation Runtime 的 canonical JSON 精确比较评分器：对象键序无关，数组顺序和 JSON 类型有意义，不进行模糊转换。每个检查声明归属 `fact` 或 `behavior` 层，可指定正数权重。

```json
{
  "sampleId": "classification-1",
  "input": { "inputKind": "text", "text": "Classify this invoice dispute." },
  "expected": { "category": "billing" },
  "evaluationContext": {
    "checks": [{
      "checkKind": "exact-match",
      "checkId": "category",
      "actual": { "sourceKind": "output", "pointer": "/category" },
      "expectedPointer": "/category",
      "layer": "fact"
    }]
  }
}
```

此样本要求执行器输出结构化值，例如 `{ "category": "billing" }`。缺少 output、trace 或 pointer 对应证据时仍按缺失处理，不视为匹配成功。可用独立检查比较有序文档 ID、工具参数和实际状态快照。精确排名比较不等于 nDCG、语义回答质量或外部状态已经改变的证明；状态证据必须由执行器从真实被测系统读取。Runtime API 的检索和轨迹评分器保留其独立的既有声明，文件格式不会隐式启用它们。

## 元数据与沙箱字段

`annotations.covers` 通过 `targetKind` 和 `ref` 声明结构锚点，不能证明节点实际执行。`tripwire` 标记故意诱错样本，不反转评分。`executionContext.mocks` 要求执行器支持工具拦截，`mocksStrict` 默认拒绝未匹配调用，`mock_hit` 必须引用已有 mock。`executionContext.cwd` 提供工作区 fixture，资源沿用宿主隔离机制。详见[执行器](./executors#sample-mock-compatibility)。

旧 v2 的 `prompt: Q` 加 `context: C`，需要显式编写完整输入，例如 `input.text: "Q\n\n```\nC\n```"`。如果 C 只是评分参考，应放入 `evaluationContext.reference`。二者是不同实验，不能互相推断，也不自动改写用户数据。

## 评分策略

### 1. 断言评分

基于规则的本地检查，每个断言产生通过/失败结果。

**计算方式：**

- 通过率 = 通过断言的权重之和 / 总权重（0~1）
- 分数 = 1 + 通过率 × 4（映射到 1~5 分）
- 示例：3 个断言（权重各 1），2 个通过 → 通过率 = 2/3 → 分数 = 1 + 0.67 × 4 = **3.67**

算综合分时，断言会拆成两个独立层 —— **factScore**（事实类检查）和 **behaviorScore**（行为类检查），各自用上面的公式在自己那批断言上打分。

### 2. Rubric 评分

每个 rubric 维度会被编译成一次独立的评委调用，避免同一 prompt 内多个准则因排列位置产生优先级偏差。评委对每个适用维度打 1-5 分；只有全部计划维度都有观测值时，OMK 才按密封权重计算加权平均，任一维度缺失都会让 rubric 聚合结果缺失。所有适用维度也都会进入发布阶段的评委分歧与不确定性门禁。

### 3. 综合分数

综合分是**所有存在的层分数的平均** —— 共三层：

| 层 | 来源 |
|------|------|
| `factScore` | 事实类断言（`contains` / `regex` / `json_*` / `equals` / `semantic_similarity` / `tool_*_contains` …） |
| `behaviorScore` | 行为类断言（长度 / 词数 / `cost_max` / `latency_max` / `turns_*` / `tools_*` / `custom` …） |
| `judgeScore` | 独立判定的 rubric 维度加权聚合 |

`composite = mean(存在的层)`。某层没有断言（或没配评委）时**从平均里剔除**，不当作 0 分；没有任何已观测层的 sample 不产生数值型综合分。

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
| `faithfulness` | 输出是否被 `evaluationContext.reference` 支持（反幻觉） |
| `answer_relevancy` | 输出是否切题回答 `input.text`；能抓住跑题、回避、冗余 |
| `context_recall` | `evaluationContext.reference` 关键事实在输出中的覆盖率（`reference` 可显式列 gold facts） |
| `semantic_similarity` | 与 `reference` 的整体语义相似度 |

**通用修饰：**

任何断言加 `not: true` 即反向（替代 `not_contains` / `not_equals` 等成对类型；老类型保留作 alias）：

```yaml
- type: regex
  pattern: "TODO|FIXME"
  not: true              # 必须不含 TODO/FIXME
```

对于异步评委断言和 custom 断言，仅在得到有效的原始通过／失败读数后执行反转。Provider 失败、超时、取消、预算截断、缺少输入和无效输出仍是失败或缺失证据；`not: true` 绝不会把基础设施或协议失败变成通过。

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
