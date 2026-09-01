# omk 用例设计指南

> **面向 omk 用户**：怎么给 sample 声明测量学元数据、写沙箱字段、跑评测前自检。背后的学术对齐（HELM / IRT / Construct Validity / 污染防御等）与 schema 扩展决策见文末第六节附录——我们把设计依据完整摊开，不藏在内部档里。

## 一、为什么用例设计需要科学性

omk 的统计严谨性栈（Bootstrap comparison family / Gold agreement / length-debias / evidence coverage / registered Decision）解决「评估**结论**算得对不对」。但**结论建立在用例集上**——用例本身科学性不够，后面所有统计严谨都是空的。

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

    # 测量元数据（纯文档 / 诊断，不参与 grading）
    capability:
      - component-recognition          # string[]，能力维度，可多个；归一时大小写/短横线/驼峰不敏感
      - api-selection
    difficulty: easy                    # 'easy' | 'medium' | 'hard'（强枚举，防错）
    construct: necessity                # 'necessity' | 'quality' | 'capability' suggested，允许自定义 string
    provenance: human                   # 'human' | 'llm-generated' | 'production-trace'
    covers:                             # Skill Map 使用的可选声明结构锚点
      - targetKind: reference
        ref: references/chart-api.md
      - targetKind: workflow_node
        ref: chart.render
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
- **covers**（`{ targetKind, ref }[]`）：这条 sample 可选声明的 skill 结构锚点。它是 `capability` 的结构侧补充：capability 说这条用例测哪个能力维度；covers 说作者希望声明这条用例具体测到哪个 SKILL.md 节点、reference、script、hard rule、workflow 或 workflow node。Studio 用它在 Skill Map 中标出已声明 / 未声明的结构边。它不会从 prompt 文本里自动推断；不写表示「尚未声明」，不代表「没有测到」。

### 不参与 grading / judge / verdict

这些元数据字段只用于：

- studio coverage 块 + `rubric_clarity_low` / `capability_thin` 两个 issue 检测
- Skill Map 声明锚点（`covers`）
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
  environment:                   # 仅作 prompt 上下文的题设环境声明，不物化文件或环境变量
    cli_available: ["log-cli"]
    files_available: ["~/.config/log-cli.json"]
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
- **tripwire**（boolean，默认 false）：声明这是一条诱错用例，prompt 有意加入违反 rubric 或 skill 的诱导。Evaluation Core 会把该声明作为 Sample annotation 保留供审计；它不会把 failed observation 变成 success，也不会改写已注册 Decision。
- **environment**（object，可选）：仅作 prompt 上下文的题设环境声明。LLM 可以据此跳过可用性探测（`which X` / `test -f Y` / `echo $Z`）直接进工作流，但 omk 不会创建文件、导出环境变量或修改 `PATH`。它不是 fixture 机制。doctor 仍可审计声明的物理路径（可用 `--skip-doctor` 跳过）。
  - `cli_available: string[]` —— 假定已在 PATH 上
  - `files_available: string[]` —— 题设引用的文件 / 脚本路径；需要读取真实字节时应使用 `sample.cwd` 或 mocks
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
  - **`return` 三种形式**：string / `{stdout, stderr, exit}`（模拟 Bash）/ `return_file` 外置文件 / `return_seq[]` 状态机（同 mock 第 N 次命中按序返回，超出回退 `return`）。
- **断言侧的 mock_hit / tool_input_contains**：配合 mocks 使用。`mock_hit: "Bash:2"` 表示「第 2 条 Bash mock 必须被命中至少一次」，证明 LLM 走到了那一步。`tool_input_contains: "Bash:logstore_query"` 验证 Bash 命令字符串里包含 `logstore_query`。
  - 每条 `mock_hit` 必须指向该工具已经声明的 mock 序号。引用不存在或越界时，loader 会在执行前拒绝用例。
  - mock 支持是执行器能力，不是 trace 能力。`claude` / `claude-sdk` 会安装拦截 hooks；`codex`、`codex-sdk` 和 API 直调执行器目前不支持。选择不支持的执行器时，生成阶段自动切换为无 mock 用例，评测阶段则在运行前拒绝已有 mocks 用例。

**与 grading / judge 的关系**：沙箱字段（mocks / environment / tripwire / mocksStrict）**不进 judge prompt**，judge 看到的只有 prompt + rubric + LLM 输出 + trace summary。`tripwire` 是审计元数据，不影响评分或已注册 Decision。当前 Core diagnostic projection 只报告经过认证的失败、缺失证据、排除项和稳定 reason code，不推断 `tripwire_intentional` 建议。

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
- [ ] **结构锚点**：关键 references / workflows / hard rules 是否至少有 1-2 条代表性 sample 声明了 `covers`，让 Skill Map 能看出哪些边界已显式声明、哪些仍未声明？
- [ ] **Difficulty 分层**：有 easy / medium / hard 都有吗？还是全 hard 让模型 noise 主导？
- [ ] **Provenance 透明**：human-curated / LLM-generated / production-trace 比例合理吗？LLM-generated 占比 > 50% 时小心 self-instruct 风险（judge bias 自我循环）。
- [ ] **Sample 数量**：`N < 5`（探索级）/ `N < 20`（只大效应可测）/ `N ≥ 20`（中等效应可测）—— omk pre-flight 已警告。
- [ ] **Rubric clarity**：rubric ≥ 20 字符，含至少一个评分级别词（优秀/良好/必须包含/至少包含 等），让 judge 有可执行的级别标准。
- [ ] **Prompt 不泄露答案**：prompt 里的术语不应直接给出 rubric/assertion 期望的答案。如果 prompt 必须含某关键词（产品 / 库 / API 名）而 rubric 也要这词，就削弱了「baseline 无知识」假设 —— 这是用例自然 trade-off，需要在 sample 设计时显式 callout。
- [ ] **Construct 跟实验设计匹配**：跑 baseline-vs-skill 时，`construct: necessity` 才合理。跑 skill-v1-vs-skill-v2 时，应该 `construct: quality`。
- [ ] **Provenance 防 contamination**：LLM-generated sample 跟模型自身训练数据可能同源（self-instruct 偏差）；`omk sample` 标记 `'llm-generated'` 后，人工 review 一遍是 v1 的 contamination 防御。
- [ ] **Capability_thin guard**：N≥10 时如果某 capability 只 1-2 sample 撑，该维度结论极不稳定。要么补 sample，要么删该 capability（明确不在测试范围）。

## 五、Verdict 解读如何配合 construct

`omk eval` verdict 输出 PROGRESS / NOISE / REGRESSION / CAUTIOUS / UNDERPOWERED / SOLO，**verdict 不区分 construct 类型**——但解读应该：

- 如果 sample 集 `construct: necessity` 占主流 → PROGRESS 表示「skill 是必需的」，**不能解读成「skill 写得好」**。要测质量须 follow-up 跑 skill-v1-vs-skill-v2（`construct: quality`）。
- 如果 sample 集 `construct: quality` 占主流 → PROGRESS / REGRESSION 才是真正的「skill 质量比较」信号。

---

## 六、附录：设计依据（学术对齐与 schema 决策）

本附录把元数据 schema 背后的取舍摊开：omk 的用例设计如何对齐学术 / 工业共识、哪些能力 v1 有意不做、v2 候选字段里哪些被拒绝（附理由）。放在这里是为了把思考真诚地呈现给读者——上面的实操指南已足够写出好用例，这一节回答的是「为什么这么设计」。

### 6.1 行业共识 8 条 + omk v1 映射

omk 的统计严谨性栈（Bootstrap comparison family / Gold agreement / length-debias / evidence coverage / registered Decision）解决「评估**结论**算得对不对」，但结论建立在用例集上——用例本身科学性不够，后面所有统计严谨都是空的。下表把测评用例设计对齐到学术 / 工业共识，并标 omk v1 的覆盖状态。

| # | 行业 gap | 学/工业出处 | omk v1 状态 |
|---|---|---|---|
| 1 | **IRT item discrimination**：每题给 a (discrimination) / b (difficulty) / c (guessing) 三参数，a < 0.3 是垃圾题 | [IrtNet (2510.00844)](https://arxiv.org/pdf/2510.00844)，[Columbia IRT primer](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory) | **out-of-scope**（N<30 IRT 不可靠，留 follow-up；v1 启发式 `flat_scores` 已 cover 部分） |
| 2 | **Difficulty stratification**：用例分层（MMLU-Pro 用多模型多数答对过滤难度） | [MMLU-Pro](https://intuitionlabs.ai/articles/mmlu-pro-ai-benchmark-explained) | **in-scope**：`Sample.difficulty` enum + studio 分桶呈现 |
| 3 | **Construct validity 三件套**（structural / convergent / discriminant） | [Measuring what Matters (2511.04703)](https://arxiv.org/abs/2511.04703)，[Measurement to Meaning (2505.10573)](https://arxiv.org/html/2505.10573v3) | **in-scope**：`Sample.construct` 字段（suggested：necessity / quality / capability）+ verdict 解读 callout；convergent / discriminant 自动检测 follow-up |
| 4 | **Capability matrix coverage**（HELM 16×7 矩阵） | [HELM (2211.09110)](https://arxiv.org/abs/2211.09110) | **partial**：`Sample.capability` string[] 字段 + studio coverage 分桶 + `capability_thin` issue；`Sample.covers` 为 Skill Map 增加可选声明结构锚点；详细矩阵可视化 follow-up |
| 5 | **Contamination 检测**（canary / paraphrase / timestamp-locked） | [BIG-Bench canary](https://www.lesswrong.com/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4)，[LiveBench](https://livebench.ai/livebench.pdf)，[contamination survey (2404.00699)](https://arxiv.org/html/2404.00699v4) | **partial**：`Sample.provenance` 做「声明式」contamination tracking，真正自动检测 follow-up（需要 embedding model 或训练数据访问） |
| 6 | **Sample provenance / dataset card**（annotations_creators 标准） | [HF Dataset Cards](https://huggingface.co/docs/hub/datasets-cards)，[Synthetic Data survey (2503.14023)](https://arxiv.org/html/2503.14023v1) | **in-scope**：`Sample.provenance` enum + `omk sample` 自动注入 `'llm-generated'` |
| 7 | **Adversarial / failure-driven mining**（Dynabench） | [Dynabench (2104.14337)](https://arxiv.org/abs/2104.14337) | **out-of-scope**：`omk evolve` 当前是单向演化；adversarial mining follow-up |
| 8 | **Production trace 自然分布抽样** | [Chatbot Arena (2403.04132)](https://arxiv.org/pdf/2403.04132) | **out-of-scope**：依赖外部 trace 系统集成 |

### 6.2 已确认但 v1 不做（follow-up）

- IRT 风格 item discrimination（N≥30 + multi-model 数据）
- 多评委 convergent / discriminant test（需要 ≥ 2 judge ensemble + 聚合分析）
- Adversarial mining loop（对抗 sample 挖掘）
- Production trace 自然分布抽样
- HTML renderer 显示 sample design coverage（v1 只 CLI）
- Evolve 演化策略升级（diversification signal / Series-aware evidence-budget stop / health-weighted improvement）
- Gold dataset 自动生成（改成「标注流程规范化」文档）
- Coverage matrix 详细 N×D 可视化（v1 出聚合分桶 + 用户自行可视化）
- Contamination 检测算法实现（canary string / paraphrase detection）
- 用户自定义 rubric 关键词清单（`diagnostics.rubricKeywords` 配置）

### 6.3 v2 schema 扩展候选与拒绝清单

初始 schema 只有 4 个测量效度字段（capability / difficulty / construct / provenance），回答**这条用例测的事是它声称要测的事吗**。`covers` 延续同一条「仅诊断、不进评分」原则，把能力维度之外的结构轴补上：**作者声明这条用例意图测到哪些 skill 节点**。社区另一类常见建议走的是「资产治理」（asset governance）轴：tags / risk_level / expected_facts / source_ids / owner——回答**这条用例归谁、来自哪里、有多重要**。这些轴正交不冲突，但治理假设测量学先稳固；v1 选了先解测量学。本节记录 v2 候选字段及拒绝清单，供后续决策时不必重新讨论一遍。

**v2 候选（高价值低风险，等真实用户需求触发再加）**

- **`source_ids?: string[]`**：具体来源标识（`issue-123` / `doc:react-charts.md#line-chart` / `slack-thread-...`）。补足 `provenance` enum 太粗的问题——provenance 答「机器 / 人 / 线上」，source_ids 答「具体哪个 issue / doc 段落」。debug 价值高（可追溯 sample 出处），纯文档不进 grading。代价：链接腐烂需用户自己治理。
- **`status?: 'active' | 'deprecated' | 'superseded'`**：lifecycle 字段。sample 集长期演化时，知道一条 sample 是「主力」还是「淘汰中」对 verdict 解读至关重要——`deprecated` sample 仍在跑但 Δ 不该计入主结论。比 `owner` 更要紧。

**已拒绝（附理由，防止反复讨论）**

- **`tags?: string[]`**：跟 `capability` 语义混。capability 是「测什么具体能力」，tags 想加的「regression / p0 / edge-case」要么属于 `capability`（能力维度）要么属于 `status`（lifecycle）。free-form string 没 enum 约束极易腐化为 mess。**结论**：不加，逼用户用 capability + status 表达。
- **`expected_facts?: string[]`**：跟 `rubric` + `assertions: contains` 大量重叠。omk 的 judge 已经在做语义评分，expected_facts 是同一抽象的另一个 alias。**结论**：不加，引入会让 sample 设计时有两个地方写期望，易漂移。
- **`owner?: string`**：治理字段，跟 omk 测量学使命错配。omk 不消费 owner 做 routing / notify；放在 git blame / CODEOWNERS 更合适。**结论**：不加。
- **`risk_level?: 'p0' | 'p1' | 'p2'`**：提了一个真问题（aggregate 应不应该按 risk 加权样本），但解这个会动 verdict 公式，属**测量学不变量**。当前 verdict / Δ 都是 sample-uniform，加权进 verdict 会破跨版本可比性。无 consumer 时纯噪音，有 consumer 时破不变量——两难。**结论**：不加；真要做，得单独立项跟 verdict v2 一起设计加权 aggregator。

**加任何新字段前的硬约束**

- 不进 `buildJudgePrompt` signature（`test/grading/judge-prompt-isolation.test.ts` 防御回归）
- 默认必须进入完整契约的 `sampleHash`。唯一排除项是作为 map key 的 `sample_id`；任何会改变执行或结果解释的字段，都必须让复用和跨报告可比性失效。
- 不进 verdict / Δ 算法
- 跟现有元数据字段 + `rubric` / `assertions` 语义不重叠

### 6.4 参考

- [Holistic Evaluation of Language Models (HELM, 2211.09110)](https://arxiv.org/abs/2211.09110)
- [Measuring what Matters: Construct Validity in LLM Benchmarks (2511.04703)](https://arxiv.org/abs/2511.04703)
- [Measurement to Meaning: A Validity-Centered Framework (2505.10573)](https://arxiv.org/html/2505.10573v3)
- [Position: Medical LLM Benchmarks Should Prioritize Construct Validity](https://openreview.net/pdf?id=YuMEUNNpeb)
- [Learning Compact Representations of LLM Abilities via Item Response Theory (IrtNet, 2510.00844)](https://arxiv.org/pdf/2510.00844)
- [IRT primer — Columbia Mailman](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory)
- [MMLU-Pro Benchmark methodology](https://intuitionlabs.ai/articles/mmlu-pro-ai-benchmark-explained)
- [Synthetic Data Generation Survey (2503.14023)](https://arxiv.org/html/2503.14023v1)
- [Auto Evol-Instruct (2406.00770)](https://arxiv.org/html/2406.00770v1)
- [Dynabench (2104.14337)](https://arxiv.org/abs/2104.14337)
- [Comprehensive Survey of Contamination Detection (2404.00699)](https://arxiv.org/html/2404.00699v4)
- [LiveBench: Contamination-Free Benchmark](https://livebench.ai/livebench.pdf)
- [BIG-Bench Canary in GPT-4](https://www.lesswrong.com/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4)
- [How to Publish Benchmarks Without True Answers (2505.18102)](https://arxiv.org/html/2505.18102v1)
- [Hugging Face Dataset Cards](https://huggingface.co/docs/hub/datasets-cards)
- [Judging LLM-as-a-Judge with MT-Bench / Chatbot Arena (2306.05685)](https://arxiv.org/abs/2306.05685)
- [Chatbot Arena Open Platform (2403.04132)](https://arxiv.org/pdf/2403.04132)
