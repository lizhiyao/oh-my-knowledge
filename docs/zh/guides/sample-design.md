# omk 用例设计指南

本页帮助用户编写和核对当前 v3 用例。字段的完整契约见[样本格式](../reference/eval-sample-format.md)；身份、封存和执行分工见[输入编译规范](../specs/evaluation/cli-evaluation-input-compilation.md)。本页不定义另一份 Schema。

## 一、为什么用例设计需要科学性 {#一、为什么用例设计需要科学性}

统计分析只能回答已声明用例和测量设计中的问题。比较 baseline 与 skill，和比较两个 skill 修订，检验的是不同假设；单靠分数不能证明必要性、知识正确性或现实收益。先写明目标、适用范围、对照条件和预期证据，再设计用例。

## 二、Sample 元数据 schema {#二、sample-元数据-schema}

```yaml
schemaVersion: omk.eval-sample-set/v3
samples:
  - sampleId: s001
    input:
      inputKind: text
      text: 用 React 画一个折线图，数据是日期 + 数值，给最小可运行代码
    evaluationContext:
      rubric:
        component_selection:
          criterion: 应识别 Line 组件并使用正确的数据格式
          weight: 0.6
        completeness:
          criterion: 必须包含图表渲染容器
          weight: 0.4
      assertions:
        - type: contains
          value: Line
          weight: 1
        - type: regex
          pattern: data
          weight: 1
    annotations:
      capability:
        - component-recognition
        - api-selection
      difficulty: easy
      construct: necessity
      provenance: human
      covers:
        - targetKind: reference
          ref: references/chart-api.md
        - targetKind: workflow_node
          ref: chart.render
```

### 字段语义 {#字段语义}

- **capability**（string[]）：作者声明的能力标签。自行保持大小写和拼写一致；当前实现不承诺自动归一或能力分布聚合。
- **difficulty**（enum）：`easy` / `medium` / `hard`，非法值在执行前由 Schema 拒绝；它是作者声明，不是经统计校准的难度。
- **construct**（string）：作者声明的测量假设，例如 `necessity`、`quality` 或 `capability`；允许自定义值，声明本身不验证构造效度。
- **provenance**（enum）：`human` / `llm-generated` / `production-trace`。`omk sample` 生成时声明 `llm-generated`；导入记录需要作者核对来源。
- **covers**（`{ targetKind, ref }[]`）：作者声明的结构锚点，如 reference、workflow 或 workflow node。未声明不等于未覆盖，已声明也不证明模型实际使用了该节点。

### 不参与 grading / judge / verdict {#不参与-grading-judge-verdict}

这些字段进入 Sample annotations，供审计和后续解释。当前 Rubric 评委不读取这些注释；它们不会自动改变评分权重或已注册 Decision。沙箱执行控制有独立职责，不能把实际改变执行的字段当成无影响注释。

注释仍是封存样本的一部分；修改它们需要重新编译测量设计并核对身份，不得用“未参与评分”作为复用旧产物的依据。精确摘要与复用规则由输入编译和 Core 契约规定。

### 沙箱评测字段（mocks / environment / tripwire / mocksStrict） {#沙箱评测字段-mocks-environment-tripwire-mocksstrict}

为了让评测脱离真实外部环境（数据库/API/文件系统/真 git push 等），Sample 还有一组沙箱字段。omk runtime 在工具调用前匹配 mocks，命中即返回假数据，不真调底层。

```yaml
schemaVersion: omk.eval-sample-set/v3
samples:
  - sampleId: s002
    input:
      inputKind: text
      text: 用 antlogs-query 查最近 1 小时 ERROR 日志数量
    executionContext:
      mocks:
        - tool: Bash
          match:
            command_glob: '*log-cli query --filter ERROR*'
          return:
            stdout: '{"count": 42}'
            exit: 0
        - tool: Read
          match:
            file_path_endswith: tasks/state.json
          return: '{"status":"running"}'
        - tool: WebFetch
          match:
            url_glob: https://internal.example.com/api/*
          return: ok
      mocksStrict: true
      environment:
        cli_available:
          - log-cli
        files_available:
          - ~/.config/log-cli.json
        notes: log-cli 已认证，token 在环境变量
    evaluationContext:
      rubric:
        workflow_quality:
          criterion: 应调用 logstore_query 工具，filter 包含 ERROR，时间窗口为 1 小时
          weight: 1
      assertions:
        - type: tool_input_contains
          value: Bash:logstore_query
          weight: 1
        - type: mock_hit
          value: Bash:1
          weight: 1
    annotations:
      tripwire: false
```

**字段语义**：

- **mocksStrict**（boolean，默认 `true`）：未命中任何 mock 的工具调用直接 `deny`（LLM 看到失败结果）。production resolver 对生成和手写用例采用同一个 fail-closed 默认值；只有用例明确允许未命中调用进入真实 runtime 时才设为 `false`。
- **tripwire**（boolean，默认 false）：声明这是一条诱错用例，prompt 有意加入违反 rubric 或 skill 的诱导。Evaluation Core 会把该声明作为 Sample annotation 保留供审计；它不会把 failed observation 变成 success，也不会改写已注册 Decision。
- **environment**（object，可选）：仅作 prompt 上下文的题设环境声明。LLM 可以据此跳过可用性探测（`which X` / `test -f Y` / `echo $Z`）直接进工作流，但 omk 不会创建文件、导出环境变量或修改 `PATH`。它不是 fixture 机制。doctor 仍可审计声明的物理路径（可用 `--skip-doctor` 跳过）。
  - `cli_available: string[]` —— 假定已在 PATH 上
  - `files_available: string[]` —— 题设引用的文件 / 脚本路径；需要读取真实字节时应使用 `executionContext.cwd` 或 mocks
  - `notes: string` —— 自由文本兜底，描述凭证 / 环境变量状态等
- **mocks**（object[]，可选）：工具调用拦截列表。运行时按数组顺序匹配第一条命中的 mock，返回 `return` / `return_file` / `return_seq[hitCount]` 之一作为 tool_result。
  - **`tool` 字段**：工具名（如 `"Bash"` / `"Read"` / `"Grep"`）。特殊值 `"*"`：通配任何工具名，配合 `input_contains` 做 intent-level mock。
  - **`match` 字段所有项 AND**：
    - `file_path: string` —— 严格相等（展开 `~`）。**仅在能预测完整路径时用**（如 `~/.config/x.json`）。
    - `file_path_endswith: string` —— 后缀匹配：actual === suffix 或在路径分隔符（`/` 或 `\`）后以 suffix 结尾。**默认推荐**（claude-cli 内部把相对路径 normalize 成 cwd 绝对路径，严格相等永远 miss）。
    - `url: string` / `url_glob: string` —— WebFetch / WebSearch 用，二选一。
    - `command_glob: string` —— Bash 用，`*` 通配跨换行（LLM 多行命令也命中）。
    - `input: object` —— 通用 deep-equal 子集匹配（可写任意 tool_input 字段）。
    - `input_contains: string` —— 递归扫描 tool_input 所有 string 值，任一含该子串即命中（大小写不敏感）。**配合 `tool: "*"` 做 intent-level mock**：LLM 搜代码时可能用 Bash grep / Grep 工具 / Glob / Read / Agent 等任意工具，用 `input_contains` 按关键词匹配意图，不用逐个枚举工具。示例：`{tool: "*", match: {input_contains: "MyServiceName"}, return: "<service .../>"}` —— 任何工具只要输入提到 MyServiceName 就命中。
  - **返回源**：每条 mock 必须且只能声明 `return`、`return_file`、`return_seq` 之一。`return` 接受 string 或 `{stdout, stderr, exit}`；`return_file` 加载外置 fixture；`return_seq[]` 是按命中次数取值的状态机，序列耗尽后保持最后一个值。
- **断言侧的 mock_hit / tool_input_contains**：配合 mocks 使用。`mock_hit: "Bash:2"` 表示「第 2 条 Bash mock 必须被命中至少一次」，证明 LLM 走到了那一步。`tool_input_contains: "Bash:logstore_query"` 验证 Bash 命令字符串里包含 `logstore_query`。
  - 每条 `mock_hit` 必须指向该工具已经声明的 mock 序号。引用不存在或越界时，loader 会在执行前拒绝用例。
  - mock 支持是执行器能力，不是 trace 能力。`claude` / `claude-sdk` 会安装拦截 hooks；`codex`、`codex-sdk` 和 API 直调执行器目前不支持。选择不支持的执行器时，生成阶段自动切换为无 mock 用例，评测阶段则在运行前拒绝已有 mocks 用例。

**与 grading / judge 的关系**：沙箱字段（mocks / environment / tripwire / mocksStrict）**不进 judge prompt**，judge 看到的只有 prompt + rubric + LLM 输出 + trace summary。`tripwire` 是审计元数据，不影响评分或已注册 Decision。当前 Core diagnostic projection 只报告经过认证的失败、缺失证据、排除项和稳定 reason code，不推断 `tripwire_intentional` 建议。

## 三、当前报告的阅读边界 {#三、用例设计相关分析功能}

### Coverage 的当前含义 {#coverage-块-studio-报告页呈现}

当前 Studio 评测页投影经过认证的 Core 产物。报告中的 evidence coverage 表达测量证据是否满足声明；它不等于作者填写的 `capability` 或 `covers` 的分布，也不等于知识库完备性。本文不承诺 Sample design coverage 面板或 Skill Map 样本覆盖着色。

### 已退役的分析字段 {#两个-issue-kind}

`report.analysis.sampleQuality`、`rubric_clarity_low` 和 `capability_thin` 属于旧报告实现，当前契约和 Studio 不提供这些字段或诊断。工具应按[当前报告投影](../specs/evaluation/evaluation-studio-projection.md)消费产物，不从这篇指南推导旧 JSON 字段。

## 四、自检清单：我的 sample 设计够科学吗？ {#四、自检清单-我的-sample-设计够科学吗}

- [ ] 问题、对照组和 `construct` 声明一致，且没有把声明当成验证结果。
- [ ] 每个声称覆盖的能力都有代表性用例；逐项检查内容，不能仅数标签。
- [ ] `covers` 指向的结构存在，并有实际执行证据支持需要验证的使用行为。
- [ ] 难度和来源覆盖实际场景；生成用例已人工复核，没有把自报来源当成污染检测。
- [ ] 根据效应大小、变异和预先声明的测量设计选择用例数；不存在通用的 5／20 条“足够”门槛。
- [ ] Rubric 写清可核对的标准；字数或关键词本身不能证明清晰度。
- [ ] 输入不泄露待验证答案；必须提供的上下文已明确纳入实验条件。
- [ ] 运行控制、mocks、fixture 和执行器支持均已核对，失败与缺失证据保持可见。

## 五、Verdict 解读如何配合 construct {#五、verdict-解读如何配合-construct}

PROGRESS / NOISE / REGRESSION / CAUTIOUS / UNDERPOWERED / SOLO 是已注册测量设计下的结论，算法不按 `construct` 标签自动切换。`necessity` 只是作者假设：PROGRESS 可以支持该实验条件下的差异，不能直接证明“skill 必需”。`quality` 也不能把一组样本的改善扩大成整体知识质量提升。

## 六、附录：设计依据与扩展边界 {#六、附录-设计依据-学术对齐与-schema-决策}

### 6.1 当前元数据的取舍 {#_6-1-行业共识-8-条-omk-v1-映射}

将输入、执行控制、评分期望与作者注释分开，有助于复核“实际测到的是什么”。标签方便描述意图，但自动归一、难度校准、污染检测、覆盖矩阵和构造效度验证都需要独立实现与验收，不能由字段存在推定已交付。

### 6.2 尚未承诺的分析能力 {#_6-2-已确认但-v1-不做-follow-up}

本指南不承诺 IRT 参数估计、自动挖掘对抗样本、Sample design health score、能力覆盖阈值或自动污染判定。研究方向需要真实需求和单独测量设计；不以固定的小样本数量或任意比例作通用科学保证。

### 6.3 字段扩展边界 {#_6-3-v2-schema-扩展候选与拒绝清单}

旧设计讨论过 `source_ids`、`status`、`tags`、`owner` 和 `risk_level`，它们不是当前 v3 字段。不要将草案字段写进用例；Schema 是严格的。也不能用草案 `deprecated` 状态静默排除样本或改变 Δ 权重。

增加字段须明确消费方、身份影响和公开契约版本；评分与复用语义的变化须单独说明。历史 v3 设计取舍见[通用用例提案](../specs/evaluation/history/general-sample-proposal.md)，其中兼容窗口和迁移工具提议已被 v3-only 决定取代。

### 6.4 参考 {#_6-4-参考}

- [样本格式](../reference/eval-sample-format.md)：当前公开封套、校验与支持范围。
- [统计严谨性](../explanation/statistical-rigor.md)：证据、比较与结论的限制。
- [评分规范](../specs/evaluation/scoring.md)：当前评分和已注册 Decision 的职责。

## 实现边界 {#实现边界}

`eval-workflows/inputs/contracts` 定义样本类型，`inputs/schemas` 负责校验和机器 Schema，`inputs/sample-mapping.ts` 映射公开 v3 封套与内部 DTO。内部 DTO 不是第二种公开协议，也不是 v2 reader。

`orchestration/measurement-design.ts` 编译 Core 声明，`measurement/evaluators` 与 `eval-runtime/evaluators` 拥有相应评估实现，宿主在 `hosts/composition` 装配执行器与评分器。Core 不依赖样本编写、文件系统或具体执行器。
