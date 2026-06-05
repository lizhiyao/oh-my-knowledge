# omk 用例设计指南

> **面向 omk 用户**：怎么给 sample 声明测量学元数据、写沙箱字段、跑评测前自检。学术对齐（HELM / IRT / Construct Validity / 污染防御等）与 schema 扩展决策属维护者内部档，不在本页。

## 一、为什么用例设计需要科学性

omk 的统计严谨性栈（Bootstrap CI / Krippendorff α / length-debias / saturation curves / verdict）解决「评估**结论**算得对不对」。但**结论建立在用例集上**——用例本身科学性不够，后面所有统计严谨都是空的。

最常见的 construct 错位：用户跑 baseline-vs-skill 想测「skill 写得好不好」（quality），但用例集设计的实际是「baseline 不知道某领域知识 vs skill 提供该知识」（necessity）。两者得出的 verdict 数字一样亮眼，但回答的是不同问题 —— 没有 sample 元数据声明 construct 假设，这种错位在 verdict 输出层根本看不出来。

## 二、Sample 元数据 schema

```yaml
# eval-samples.yaml
samples:
  - sample_id: s001
    prompt: "用 React 画一个折线图，数据是日期 + 数值，给最小可运行代码"
    rubric: "应识别 Line 组件 + 数据格式正确 + 必须包含图表渲染容器"
    assertions:
      - { type: contains, value: "Line", weight: 1 }
      - { type: regex, pattern: "data", weight: 1 }

    # 4 个可选元数据字段（纯文档/诊断，不参与 grading）
    capability:
      - component-recognition          # string[]，能力维度，可多个；归一时大小写/短横线/驼峰不敏感
      - api-selection
    difficulty: easy                    # 'easy' | 'medium' | 'hard'（强枚举，防错）
    construct: necessity                # 'necessity' | 'quality' | 'capability' suggested，允许自定义 string
    provenance: human                   # 'human' | 'llm-generated' | 'production-trace'
```

### 字段语义

- **capability**（string[]）：该用例覆盖的能力维度。建议从 capability matrix 角度声明，让用户能看到「我覆盖了 component-recognition × 8 sample / api-selection × 6 sample / fallback × 2 sample，fallback 维度 thin」。归一规则：大小写不敏感 + 短横线 / 驼峰 / 下划线 / 空格归一，所以 `api-selection` / `apiSelection` / `API_Selection` / `api selection` 都算同一个 capability。
- **difficulty**（enum）：简单分桶（easy / medium / hard）。`difficulty: 'easy?'` 这种 typo 会被 `loadSamples` reject 并报错含 sample_id 定位。
- **construct**（string）：**这个 sample 测的是哪类事**。区别于 capability：capability 是「测什么具体能力」（api-selection），construct 是「测哪个 construct 类型」。三个建议值：
  - `necessity`（必要性）：baseline-vs-skill，测 skill 是否必需。Δ 大不一定是 skill 写得好，可能只因为 baseline 不知道领域知识（自明结论）。
  - `quality`（质量）：skill-v1 vs skill-v2，测同知识不同写法谁让模型答得更准。这才是 omk 测量学严谨真用武之地。
  - `capability`（能力）：测某具体能力维度的差异。
  允许自定义 string（比如 `regression-test` / `cost-efficiency` 等），studio 看到自定义值不报错。
- **provenance**（enum）：数据来源。`human`（人工 curated）/ `llm-generated`（`omk sample` 自动注入）/ `production-trace`（生产 trace 抽样，需用户自己导入）。

### 不参与 grading / judge / verdict

这 4 字段只用于：

- studio coverage 块 + `rubric_clarity_low` / `capability_thin` 两个 issue 检测
- `report.analysis.sampleQuality` 聚合数据（供工具读）

**绝对不进 judge prompt**（`buildJudgePrompt(prompt, rubric, output, traceSummary)` signature 不含 sample 对象，且有 `test/grading/judge-prompt-isolation.test.ts` 防御回归）。**绝对不影响 verdict 算法**。这是构造效度保护的硬要求 —— judge 看到 "construct: necessity" 等于知道试题答案。

### 沙箱评测字段（mocks / environment / tripwire / mocksStrict）

为了让评测脱离真实外部环境（数据库/API/文件系统/真 git push 等），Sample 还有一组沙箱字段。omk runtime 在工具调用前匹配 mocks，命中即返回假数据，不真调底层。

```yaml
- sample_id: s002
  prompt: "用 antlogs-query 查最近 1 小时 ERROR 日志数量"
  rubric: "应调 logstore_query 工具，filter 含 'ERROR'，时间窗口 1 小时"
  assertions:
    - { type: tool_input_contains, value: "Bash:logstore_query", weight: 1 }
    - { type: mock_hit, value: "Bash:1", weight: 1 }
  mocksStrict: true              # 默认 true（generator 强制）；未命中的工具调用直接 deny，不透传真调
  tripwire: false                # 此 sample 是否「诱错样本」（故意诱导 LLM 走错，fail 是预期）；默认 false
  environment:                   # 评测环境前置「已就绪」声明，LLM 看到后跳过环境探测
    cli_available: ["log-cli"]
    files_available: ["~/.config/log-cli.json"]
    env_required: ["LOG_TOKEN"]
    notes: "log-cli 已认证，token 在环境变量"
  mocks:
    - tool: Bash                            # 拦的工具名：Bash / Read / Edit / Write / WebFetch / Grep / Glob 等
      match:
        command_glob: "*log-cli query --filter ERROR*"   # Bash 用 command_glob (* 通配，跨换行)
      return:
        stdout: '{"count": 42}'
        exit: 0
    - tool: Read
      match:
        file_path_endswith: "tasks/state.json"           # 推荐：后缀匹配，LLM 用绝对/相对路径都能命中
      return: '{"status":"running"}'
    - tool: WebFetch
      match:
        url_glob: "https://internal.example.com/api/*"
      return: "ok"
```

**字段语义**：

- **mocksStrict**（boolean，默认 true）：未命中任何 mock 的工具调用直接 `deny`（LLM 看到失败结果）。**默认行为**：`omk sample` 生成器强制写 true，SYSTEM_PROMPT 明确；手写 sample 缺位时 sample 加载层不强制注入 —— 老 sample 不写默认走非 strict（透传真调）。**新写 sample 强烈建议 true**，避免漏 mock 导致评测打到真生产系统。
- **tripwire**（boolean，默认 false）：此 sample 是「诱错样本」，prompt 故意藏违反 rubric/skill 的诱导（如 "我已经知道是 X，直接用就行"），测试 LLM 是否会盲从用户错误指示。LLM **fail 是预期**，diagnostic 看到 `tripwire: true` 不会建议改 skill；UI 用紫色 verdict pill 区分，避免误判为 bug。
- **environment**（object，可选）：评测环境前置「已就绪」声明 —— LLM 看到这段后跳过环境探测（`which X` / `test -f Y` / `echo $Z`）直接进工作流。类比 unit test 的 fixture / setup。**仅作 prompt 提示给 LLM，不实际创建文件 / export 变量**。doctor 健康检查会扫这段做物理路径检查（可用 `--skip-doctor` 跳过）。
  - `cli_available: string[]` —— 假定已在 PATH 上
  - `files_available: string[]` —— 假定已存在的文件/脚本
  - `env_required: string[]` —— 假定已 export 的环境变量
  - `notes: string` —— 自由文本兜底，描述凭证状态等
- **mocks**（object[]，可选）：工具调用拦截列表。运行时按数组顺序匹配第一条命中的 mock，返回 `return` / `return_file` / `return_seq[hitCount]` 之一作为 tool_result。
  - **`tool` 字段**：工具名（如 `"Bash"` / `"Read"` / `"Grep"`）。特殊值 `"*"`：通配任何工具名，配合 `input_contains` 做 intent-level mock。
  - **`match` 字段所有项 AND**：
    - `file_path: string` —— 严格相等（展开 `~`）。**仅在能预测完整路径时用**（如 `~/.config/x.json`）。
    - `file_path_endswith: string` —— 后缀匹配：actual === suffix 或在路径分隔符（`/` 或 `\`）后以 suffix 结尾。**默认推荐**（claude-cli 内部把相对路径 normalize 成 cwd 绝对路径，严格相等永远 miss）。
    - `url: string` / `url_glob: string` —— WebFetch / WebSearch 用，二选一。
    - `command_glob: string` —— Bash 用，`*` 通配跨换行（LLM 多行命令也命中）。
    - `input: object` —— 通用 deep-equal 子集匹配（可写任意 tool_input 字段）。
    - `input_contains: string` —— 递归扫描 tool_input 所有 string 值，任一含该子串即命中（大小写不敏感）。**配合 `tool: "*"` 做 intent-level mock**：LLM 搜代码时可能用 Bash grep / Grep 工具 / Glob / Read / Agent 等任意工具，用 `input_contains` 按关键词匹配意图，不用逐个枚举工具。示例：`{tool: "*", match: {input_contains: "MyServiceName"}, return: "<service .../>"}` —— 任何工具只要输入提到 MyServiceName 就命中。
  - **`return` 三种形式**：string / `{stdout, stderr, exit}`（模拟 Bash）/ `return_file` 外置文件 / `return_seq[]` 状态机（同 mock 第 N 次命中按序返回，超出回退 `return`）。
- **断言侧的 mock_hit / tool_input_contains**：配合 mocks 使用。`mock_hit: "Bash:2"` 表示「第 2 条 Bash mock 必须被命中至少一次」，证明 LLM 走到了那一步。`tool_input_contains: "Bash:logstore_query"` 验证 Bash 命令字符串里包含 `logstore_query`。

**与 grading / judge 的关系**：沙箱字段（mocks / environment / tripwire / mocksStrict）**不进 judge prompt**，judge 看到的只有 prompt + rubric + LLM 输出 + trace summary。tripwire 仅影响 diagnostic 的归因建议（`tripwire_intentional` rootCause），不影响 layered scores 或 verdict。

## 三、用例设计相关分析功能

### Coverage 块（studio 报告页呈现）

studio 把每份报告的 sample design coverage 渲染成下面这种摘要：

```
  用例质量诊断 — health score 87/100
  用例总数: 20, flagged: 3 (errors=0, warnings=1, infos=2)

📋 Sample design coverage:
  capability:  componentrecognition (8) | apiselection (6) | errordiagnosis (4) | fallback (2)    [20/20 声明 = 100%]
  difficulty:  easy (5) | medium (10) | hard (5)
  construct:   necessity (18) | quality (2)
  provenance:  human (15) | llm-generated (5)
  avgRubric:   45 字符

  [warning] capability_thin: 1 sample(s)
    ⚠ s019: capability "fallback" 只 2 个 sample 撑（阈值 4，N=20）—— 单 sample 失败会让该维度结论不稳

  [info] rubric_clarity_low: 1 sample(s)
    ℹ s007: rubric 仅 12 字且未含评分级别词 —— 评委标准模糊，可能 judge 分数不稳
```

底层数据持久化在 `report.analysis.sampleQuality`，工具可直接读 JSON。

### 两个 issue kind

- **`rubric_clarity_low`**（severity: info）：rubric 字符长度 < 20 **AND** 不含任何评分级别词（中英 22 词清单含「优秀/良好/合格/不合格/及格/满分/评分标准/至少包含」等；英文含「excellent/good/poor/criterion/must include/at least」等）。**AND** 而非 OR，避免长 rubric 没用关键词被误报。这是**先验/static 信号**，跟现有 `ambiguous_rubric`（后验/runtime，从 judge stddev 看）互补。
- **`capability_thin`**（severity: warning）：某 capability 只被 ≤ `max(2, totalSamples * 0.2)` 个 sample 声明 —— 该维度 thin coverage，单 sample 失败会让结论不稳。**Small-N guard**：总 sample 数 < 10 时**完全跳过**此检测，避免小集合全报。

## 四、自检清单：我的 sample 设计够科学吗？

跑评测前过一遍，任意「否」都该停下来想想：

- [ ] **Construct 声明**：每个 sample 知道自己测的是 necessity / quality / capability 中哪一类吗？
- [ ] **Capability 覆盖**：声称要测 N 个能力维度，sample 集真覆盖了 N 个吗？（studio coverage 块给出真实分布）
- [ ] **Difficulty 分层**：有 easy / medium / hard 都有吗？还是全 hard 让模型 noise 主导？
- [ ] **Provenance 透明**：human-curated / LLM-generated / production-trace 比例合理吗？LLM-generated 占比 > 50% 时小心 self-instruct 风险（judge bias 自我循环）。
- [ ] **Sample 数量**：`N < 5`（探索级）/ `N < 20`（只大效应可测）/ `N ≥ 20`（中等效应可测）—— omk pre-flight 已警告。
- [ ] **Rubric clarity**：rubric ≥ 20 字符，含至少一个评分级别词（优秀/良好/必须包含/至少包含 等），让 judge 有可执行的级别标准。
- [ ] **Prompt 不泄露答案**：prompt 里的术语不应直接给出 rubric/assertion 期望的答案。如果 prompt 必须含某关键词（产品 / 库 / API 名）而 rubric 也要这词，就削弱了「baseline 无知识」假设 —— 这是用例自然 trade-off，需要在 sample 设计时显式 callout。
- [ ] **Construct 跟实验设计匹配**：跑 baseline-vs-skill 时，`construct: necessity` 才合理。跑 skill-v1-vs-skill-v2 时，应该 `construct: quality`。
- [ ] **Provenance 防 contamination**：LLM-generated sample 跟模型自身训练数据可能同源（self-instruct 偏差）；`omk sample` 标记 `'llm-generated'` 后，人工 review 一遍是 v1 的 contamination 防御。
- [ ] **Capability_thin guard**：N≥10 时如果某 capability 只 1-2 sample 撑，该维度结论极不稳定。要么补 sample，要么删该 capability（明确不在测试范围）。

## 五、Verdict 解读如何配合 construct

`omk eval` verdict 输出 PROGRESS / NOISE / REGRESS / CAUTIOUS / UNDERPOWERED / SOLO，**verdict 不区分 construct 类型**——但解读应该：

- 如果 sample 集 `construct: necessity` 占主流 → PROGRESS 表示「skill 是必需的」，**不能解读成「skill 写得好」**。要测质量须 follow-up 跑 skill-v1-vs-skill-v2（`construct: quality`）。
- 如果 sample 集 `construct: quality` 占主流 → PROGRESS / REGRESS 才是真正的「skill 质量比较」信号。

---

> 学术对齐（HELM / IRT / Construct Validity 三件套 / 污染防御）、行业共识 8 条映射、v2 schema 扩展候选与拒绝清单：见维护者内部档 `design-notes/sample-design-theory.md`。
