# omk 术语规范

> **范围**：面向 OMK 维护者的现行命名与隔离规则。日常用法见 [README](../../README.md)，具体名称以公开契约与源码为准。

## 一、目标

这份规范用于统一 omk 后续迭代中的对外文案、命令示例、数据结构与代码命名。

目标有三条：

- 对齐行业与开源社区常见说法，尽量减少 omk 私有术语
- 把"被评测对象"、"运行环境"、"实验分组"与"实验角色"四层拆开，避免混用
- 为未来扩展到 skill、agent、workflow、agent team 等载体保留统一抽象

## 二、标准术语

本节只规定首选名称，不重新定义概念或复制 API 字段。概念见[知识原理](../../explanation/knowledge.md)，查阅见[术语表](../../reference/shared/glossary.md)。

| 标识 | 中文表达 |
|---|---|
| `evaluation` | 评测 |
| `artifact` | 知识载体 |
| `variant` | 对比臂 |
| `control` | 对照角色 |
| `treatment` | 实验角色 |
| `runtime context` | 运行条件 |
| `dataset` | 用例集 |
| `sample` | 用例 |
| `executor` | 执行器 |
| `evaluator` | 评分器 |
| `metric` | 具名观测指标 |
| `judge` | LLM 评委 |
| `rubric` | 评分准则 |
| `experiment` | 实验设计 |
| `policy` | 测量策略 |
| `run` | 一次运行 |
| `comparison` | 比较声明 |
| `verdict` | 判定标签 |
| `evidence` | 证据 |
| `report` | 报告视图 |

`executionContext` 约束执行，`evaluationContext` 提供评估专用资料，`annotations` 保留作者注释；完整格式分别由样本格式和 Core API 拥有。用户可见中文优先写“用例”，统计学的样本均值、样本方差等固定术语仍使用“样本”。

<a id="_1-artifact"></a>
<a id="_2-artifact-kind"></a>
<a id="_3-variant"></a>
<a id="_4-experiment-role"></a>
<a id="_5-runtime-context"></a>
<a id="_6-sample-用例"></a>
<a id="_6-1-sample-元数据字段"></a>
<a id="_7-task"></a>
<a id="_8-trace"></a>
<a id="_9-evaluation-runtime-vocabulary-评测运行时词表"></a>
<a id="_10-knowledge-知识"></a>

## 三、术语边界

### 1. baseline 就是"什么都没有"

`baseline` 的标准含义是：

- 不做显式 artifact 注入
- 不额外附带项目级 runtime context

对大多数使用者来说，`baseline` 就可以直接理解为"什么都没有"。

如果要单独观察项目级 runtime context，推荐显式写成：

- artifact 用自描述标签 `project-env`，cwd 用 `--treatment-cwd /path/to/project`（或 eval.yaml 的 `cwd:` 字段）

这里的 `project-env` 只是实验分组标签，真正的语义是"空 artifact + 指定 runtime context"。

### 2. skill 不是总称

`skill` 只在对象确实是 skill 文件、skill 目录或 skill 风格 system prompt 时使用。

以下场景不要用 `skill` 做总称：

- 比较多个不同类型对象
- 描述 CLI 通用变体语法
- 描述未来 agent team、workflow 等对象

### 3. agent 不是总称

`agent` 用于描述具有 agent 运行特征的 artifact 或运行形态，例如：

- 有工具调用
- 有多轮轨迹
- 依赖运行时环境

但 `agent` 不应替代 artifact 成为通用术语。

### 4. baseline kind 和 control role 不是一回事

`baseline` 是 `ArtifactKind` 枚举中的一员，表示"空 artifact"（不注入任何显式 artifact）。
`control` 是 `experimentRole` 的取值，表示"这个 variant 在本次实验里扮演对照角色"。

两者正交：

- 一个 `baseline` kind 的 artifact 通常扮演 `control` role，但这不是定义
- 两个都是 `skill` kind 的 artifact（v1 vs v2）比较时，其中一个被显式声明为 `control`——此时 control role 和 baseline kind 没有任何关系
- 报告与代码都应以 `experimentRole` 作为判定对照组的唯一来源，不从 `artifactKind === 'baseline'` 反推

### 5. 区分置信区间与持续集成

测量结果中的 CI 表示置信区间（Confidence Interval）。仓库流程也使用持续集成 CI；必须按上下文区分，不能把仓库检查误读为统计区间。

规则:

- **持续集成场景的内部 helper 一律用 "gate"**：`omk eval` 的 gate 路径 / `evaluateLayerGates` / `gateThreshold` / `LayerGateResult`
- **置信区间场景一律用「CI」**：`Bootstrap CI` / `comparison CI` / `interval` Analysis result / `95% CI`
- 混合上下文优先写“置信区间”或“持续集成／仓库门禁”；不顺手重命名既有公开字段和 Actions 名称

### 6. 稳定性 = 跨独立 Run，而不是跨用例散度

稳定性属于 test-retest 概念：同一份 sealed measurement design 作为 Evaluation Series 中的独立 Run 重复执行。当前 Series Analysis 报告 run-mean composite 的无偏样本方差。单次 Run 不包含跨 run 稳定性证据，Run Decision 也绝不能自行推断。

跨用例 score range 与 success rate 都不是稳定性。用例本就会有意覆盖不同难度，而 success rate 属于运行健康事实；两者都应与 Series variance 分开表达。

### 7. Composite 三层：fact / behavior / judge

Core Composite Analysis 最多绑定 `fact`、`behavior` 与 `judge` 三个具名 layer。

| 层 | 来源 | 本质 |
|---|---|---|
| 事实 | 显式分类的 Boolean criterion observation | 规则可验证 |
| 行为 | 显式分类的执行合规 criterion observation | 规则可验证 |
| LLM 评价 | ensemble consensus 或 dimension aggregate | 模型评测 |

这些术语表示 Analysis 职责，不是可变的 report field。新代码使用限定 table entry 与 source binding；不得重新引入已删除的 `LayeredScores`、`factScore`、`behaviorScore`、`judgeScore` 或 `avg*Score` 结果行字段。中文在指 evaluator 来源时使用「LLM 评委」，指 Composite Analysis 时使用「judge layer」。

### 8. 对话是用户在读的那条，会话是宿主写下的那份

界面按所指分层用词，**不限制同一屏出现几个词**：

- **对话**（英文 `conversation`）：用户在 Studio 里阅读、筛选、提炼的那一条工作记录。列表、列表计数、导航、空态、按钮与页面标题都属于这一层。
- **会话**（英文 `session`）：宿主自己写下的原始记录——日志文件、trace 源、`--session` 一类参数、来源身份与快照元数据字段。指它时优先写**来源会话**，与界面阅读单位区分开。

规则是「**同一所指必须同名**」。下面两种同屏都合规：对话详情里标注「来源会话：…」（候选页现在就是这个形态）；健康度列表的「来源会话数」列，其数据是 `report-assembly.ts` 按来源聚合的 `sessions.length`，本来就不是对话条目数。

违规形态是同一个所指套两个词：页面标题写「全部对话」、同一列表的计数写「N 个会话」。

英文只有一个 `conversation` 而中文需要分层的场合，以中文所指为准，不为字面对齐把来源字段改写成「对话」。出处是 `evaluation-studio-projection.md` 的既有用法：Observe 的四条泳道写作「对话、执行、结果、知识」，而"不序列化整个源会话"说的是会话。

### 9. 两个对象层：知识内容与知识载体；候选是状态

`/knowledge` 一侧的对象层只有两个：

| 对象层 | 中文界面词 | 英文界面词 | 指什么 |
|---|---|---|---|
| 内容 | 知识内容（领域模型同一层也写作**知识条目**） | knowledge item | 一条可复核的事实、经验或方法：稳定身份＋不可变修订 |
| 载体 | **知识载体** | `Knowledge artifact` | 一份 skill、prompt 或项目规则文件 |

**「候选知识」不是第三个对象层，而是知识内容所处的状态。** 依据是 `knowledge-domain-model.md` §2：知识条目那一层自带稳定身份与不可变修订，而「未知或冲突的主张可作为候选保留」「只有背景来源的推断也可以成为待复核候选」说的都是**主张的复核状态**，该文没有为候选另建一种对象。

两类「候选」分别指向内容与载体：内容层的「候选知识」指待复核的知识条目；载体改动层的「候选版本」指拟采用的载体版本，尚未进入评测时也可以存在。进入评测时，`variant` 表达对比臂的配置，解析得到 artifact 与 runtime context（见 §二.3）；`control`／`treatment` 表达该臂在当次实验中的角色（见 §二.4）。载体版本身份、对比臂配置和实验角色分别表达；同一版本可以在不同运行上下文或不同实验中被多条对比臂引用。

还有一条约束要一并继承，不要引错：`knowledge-domain-model.md` §4.2 那句「知识改动经历提议、复核、形成候选、关联评测和采纳或拒绝」的主语是**知识改动**（把修订落实到载体的那一层），并且同一句接着规定「是否已评测、是否已写入、是否已发布分别记录，不能用一条线性状态强迫所有场景先后顺序一致」。引用它时不得改写成知识条目复核的单一线性顺序。

因此界面可以写「候选知识」，但它必须被读成"尚未复核的那条知识"：不得与内容层并列成一种新对象，也不得被术语门禁当成与内容互斥的类别。同理不封闭这一侧的界面词汇——修订、来源证据、知识缺口等既有概念按各自定义出现。

一致性检验两例，任何改名与门禁都要同时通过：① 一条候选知识经复核后仍是同一条知识，身份保留、只变状态；② 同一份载体可以同时装多条处于不同状态的条目。

依据是本文 §二.1 与 §二.10：一份载体可以装多条知识，同一条知识也可以出现在多个载体中；这些形式不扩展 `ArtifactKind`，也不替代现有 artifact 身份。

**拒绝「知识对象」的理由是它分不清内容层与载体层**——同一个词既能指一条知识也能指一份 skill，而拆开这两层正是本节的目的。旁证是改动前它在中英 specs 与 guides 里出现 0 次、只活在界面文案里；本文此处是登记被拒，不是启用。判法看数据不看习惯：`/knowledge` 列表一行就是一个 skill（主键是 skill 名），属载体层，该列与统计、搜索、标签标题都写「知识载体」；只有指条目计数时才用「知识内容」。界面改名由实现改动负责，本文先定口径。

**`skill` 在中文界面保留拉丁写法 `Skill`／`skill`，不译作「技能」。** 它在这里是产品身份词而不是普通名词：一个 skill 就是 `/knowledge/skills/[skillName]` 那一行的主键，与 `ArtifactKind`、`AGENTS.md`、`.agents/skills/` 同属一路拉丁标识。改前全站中文文案只有健康度表格的一个列标题写「技能」，其余一律拉丁（`Skill 健康度日报`、`Skill 趋势`、`各 skill 健康度`），且「技能」在中英 specs 与 guides 里出现 0 次——同一个所指两种写法，正是本节定义的「一物两名」，取既有覆盖面那一侧。门禁 `test/studio/web/terminology-guard.test.ts` 据此判定中文界面文案不得出现「技能」；内核代码注释与采集侧的中文关键词匹配（用来识别用户原文里的 skill 提及）不受此约束，它们不是界面文案。

## 四、对外表达规范

### 1. 文档

对外文档采用以下优先级：

- 顶层总称：`artifact`
- 实验分组：`variant`
- 实验角色：`control` / `treatment`
- 运行环境：`runtime context`
- 具体对象类型：`skill` / `agent` / `workflow`

### 2. 命令示例

命令示例中：

- 使用 `--control <expr>` + `--treatment <v1,v2,...>` 按 experiment role 声明 variant
- variant 表达式解析为 artifact 与 runtime context
- 示例对象尽量写具体路径或具体名称，不用泛化占位代替所有场景
- 复杂实验配置推荐用 `--config eval.yaml`，CLI 参数只承担简单场景

### 3. 报告与验收

报告、验收文档应优先回答：

- 这次比较的 artifact 是什么
- 它们运行在什么 runtime context 中
- 谁是 control、谁是 treatment
- 差异来自 artifact 本身，还是来自 runtime context

## 五、对内实现规范

### 1. 类型与字段

现行命名按所属契约确定：

- 知识载体使用 `Artifact`、`ArtifactKind`，集合使用 `artifacts`。
- CLI 配置通过 `variants[].role` 指定实验角色；编译后的目标使用 `experimentRole`，值为 `control` 或 `treatment`。
- 字段与类型以对应参考及公开 Schema 为准。

### 2. 替换与兼容边界

新实现直接使用当前术语，不为无明确需求的旧命名保留别名。涉及已发布公共契约或存量数据时，先明确版本与迁移影响，并按项目规则处理；不能依据用户规模推定可以破坏公共契约。旧版本的实际升级步骤由[维护指南](../../guides/maintenance/v1-preview-migration.md)统一维护。

### 3. 命名原则

- 通用抽象用 `artifact`
- 具体子类用 `skill` / `agent` / `workflow`
- 实验编排用 `variant`
- 实验角色用 `control` / `treatment`（不用 `baseline` / `experiment`）
- 运行环境用 `runtime context` / `cwd`

### 4. 裸 `kind` 留给 `ArtifactKind`

在 omk 的产品语义里，裸 `kind` 默认指 `Artifact.kind`（`ArtifactKind`：`baseline` / `skill` / `prompt` / `agent` / `workflow`）。`baseline` 表示 eval 里的空 artifact；实验角色仍然看 `control` / `treatment`。命令行设计同理：`omk install` 上的 `--kind` flag 表示 artifact kind（对齐 `Artifact.kind`），而不是安装目标、report 类型或 observe event 类型。

其它判别字段如果是新字段，或能安全改名，就用限定名。已经发布、已落盘或已有外部消费方依赖的 `kind` 字段保持原样，除非单独做 migration：

- `report.kind` 保持为 report public schema 的 canonical 字段
- `doctor.kind` 保持为 doctor report 的 canonical 字段
- `observe-*.kind` 保持为 observe report 的 canonical 字段
- `event.kind` → `eventKind`
- `executorRuntime.kind` → `runtimeKind`
- `standard.kind` → `standardKind`

两条注意：

- **持久化判别字段 —— report / observe / doctor / diagnosis 的顶层判别字段是 `kind`，由它早先的限定名字段经一次有意的 BREAKING-SCHEMA 硬切换而来。** 硬切换不做双读、不留迁移垫片：旧版本写的文件（顶层是旧的限定名判别字段、无 `kind`）直接不读、跳过。这是序列化向后兼容，不是统计可比性 —— 改字段名不改任何测量数字。（`report.kind` 另外还在 Report schema 不变量清单里，后续改动按常规 schema 谨慎处理。）
- 内部非持久字段的改名是渐进式的 —— 改到那块代码时顺手做，不搞一次性大扫除。一个 CI 护栏冻结当前裸 `kind` 声明点的集合，防止新的不加限定的 `kind` 混进来。

### 5. 退役 `admission`：一个场景只留一个限定名

`admission` 在本仓库曾至少承载五种互不相关的含义（provider-cost 预算预留、Core 的 plan 绑定能力 API、内存态阶段复用、知识草案校验、持久化的续跑信任）。该词按场景逐个退役，每个场景只保留一个限定名。

| 场景 | 标准名 | 说明 |
|---|---|---|
| 针对新封存 Plan 的内存态阶段复用 | plan-bound conformance verification（`verifyExecutedStageAgainstPlan`） | fail-closed 校验，不是资格检查 |
| 知识草案／证据／grounding 校验 | knowledge validation（`src/knowledge/validation.ts`、`KnowledgeValidationProblem`） | 纯校验器，不含治理含义 |
| 持久化的续跑信任判定 | resume disposition（`src/eval-workflows/resume-disposition/`、`CoreResumeDisposition*`） | `disposition` 本来就是该模块自己的用词 |
| provider-cost 预算预留 | 暂不改动 | 字段 `policy.budget.providerCostAdmission.admissionMode` 已发布且已落盘；改名会让存量 plan 读不回，因此等一次 schema 版本 bump（目标名 `providerCostOvershoot.mode`） |

两个身份被刻意冻结，保留旧词：

- 摘要推导标签 `omk.core-resume-admission/v1` —— 它是带版本的身份串，不是词汇；改动会静默改变所有续跑判定摘要。
- `'admitted'`／`'rejected'` 这类枚举值 —— 取值保持稳定，改名不会改变任何测量结果或已持久化判定。

Core 已发布的 `admit*` 能力 API（`admitExecutionBundle` 及同族）与 Series 的成员字段 `admissionStatus` 是另外两种含义。两者都是对外表面，只能在显式的词汇决策之后改名，不作为内部清扫的一部分。

### 6. 用户可见文案的双语完整性

每条用户可见文案都必须两种语言都在。已经有两套机制满足这件事，并继续使用：CLI 运行期字典（`tCli()` 加 `src/cli/lib/i18n-dict/`，两侧 key 完整性由 `test/cli-i18n.test.ts` 判）与 oclif 静态帮助用的 `bilingual({ zh, en })`。Studio 的文案仍然内联写成 `lang === 'zh' ? … : …`；这是刻意选择，不是等着还的技术债。

不引入 i18next／vue-i18n，也不把 Studio 的内联文案一次性扫进集中字典。这条规则要关的缺口是「漏翻」，而集中字典判不出漏翻——只在一侧加 key，和只写一个分支一样容易忘。承担这条规则的是：

- `test/studio/web/bilingual-copy.test.ts`：语言分支的英文侧仍带中文就判红。它刻意只判这个方向——按当前代码实测，反方向（中文侧必须含中文）会在分隔符、语言码、品牌复数和文件名上报错，只会逼出一份豁免名单。
- 需要跨组件复用的文案，用仓库里更强的既有构造：带访问器的 `Record<Lang, Record<Key, string>>`（`src/observability/inbox/metric-semantics.ts`、`src/studio/application/knowledge/candidate-status.ts`），或 `const enCopy: typeof zhCopy`（`src/studio/web/components/observe/health.tsx`）。那里少一个键是编译错误，强于任何运行期查表。
- 只属于单个组件的文案留在该组件里。
- 读路径上要区分「OMK 自己写的」与「已被记录下来的」。Studio 知识页的待优化项里，OMK 自己的规则文案按请求语言呈现；更早落盘的证据——doctor 规则自己的 message、Diagnosis 的标题／摘要／建议——按记录时的语言原样显示。在渲染层重翻已存证据，等于改写视图背后的记录。
- 语言按请求决定时，它同时属于缓存身份：缓存里存着展示文案的投影，不能把第一个请求者的语言发给之后所有人。

### 7. 两个库：实体组织与载体存储

两个域各自拥有一个「库」，命名不可混用：

- **实体组织库**——`src/knowledge/library/`：对提取实体的用户确认跨窗组织（`knowledge-library-object-history`）。
- **载体库**——`src/knowledge-artifacts/authoring/carrier-library.ts`（`CarrierLibrary`）：已保存 skill／prompt 载体的版本化存储（`omk-carrier-v1`）。代码与文件名使用 `carrier-` 限定；新代码不得再缩写为裸 `library`。

载体域目录保持 `src/knowledge-artifacts/`：裸名 `src/artifacts` 已被废弃（#613），因为它与评测产物（measurement artifacts，评测输出）冲突，两者是不同概念。不得重新引入。

## 六、Skill Isolation

### 1. 问题背景

omk 通过原生 coding-agent runtime 跑 baseline-vs-skill 评测时，baseline 可能发现从未被声明为测量输入的本地知识，导致它不再是「裸模型」，形成 **construct invalidity**。

Codex 会从 workspace 与本地 profile 发现 `AGENTS.md`、`.agents/skills/`、项目规则等上下文，也可能通过普通工具读取 cwd 下的 `skills/<name>/`。

严格 baseline 要求 Runtime 能禁用 skill 发现，私有工作区状态本身不能证明这一能力。发现仍启用时，verdict / Δ 测量的是所选 runtime context 与声明 treatment 的共同影响，不能解释为「无知识 vs 有知识」。

### 2. 术语

- **`allowedSkills`**（逐 variant 配置与编译后的执行控制）：
  - `undefined` → 使用执行器默认 runtime context，不请求隔离
  - `[]` → **请求禁用 skill 发现**：所选 Runtime 必须支持此能力，否则在 provider call 前拒绝执行；当前 Codex CLI／SDK adapter 不支持
  - `[name1, ...]`（非空）→ **在统一 execution-plan 边界拒绝**：原生 agent、API 与自定义执行器之间不存在可移植且可证明的白名单机制；严格隔离请用 `[]`，不隔离则省略
- **`--strict-baseline` flag**(default true):对所有 `kind === 'baseline'` 的 artifact 自动设 `allowedSkills = []`;`--no-strict-baseline` 关掉(显式 opt-out)
- **隔离身份**：隔离声明由输入编译封入执行控制，结合 Runtime identity 和执行坐标验证复用；现行报告没有 `meta.skillIsolation` 字段，详见[输入编译规范](../evaluation/cli-evaluation-input-compilation.md)。

### 3. 默认值与优先级

```
eval.yaml variant.allowedSkills (显式)
  > CLI --strict-baseline / --no-strict-baseline (批量)
  > default (strictBaseline = true)
```

baseline-kind 默认 `[]`（strict），其他 kind 默认 `undefined`（执行器默认上下文）。因此严格 Codex baseline 会被拒绝。裸模型 baseline 使用 `openai-api`；在固定 runtime context 下测量 Codex 时，比较两个显式 artifact 版本，并使用 runtime-default 发现。关闭 strict baseline 会改变测量声明。

### 4. 隔离覆盖范围

| Runtime / 通道 | 覆盖？ | 机制 |
|---|---|---|
| Core Trial 工作区 | 可变状态分离 | 已验证 workspace snapshot 的私有副本；没有绑定时使用私有空目录；同一 Trial 的重试保留状态 |
| Codex CLI profile、session 与规则 | 部分 | `--ephemeral --ignore-user-config --ignore-rules` 限制这些通道；skill 发现仍为 `runtime-default` |
| Codex SDK profile 与 session | 部分 | 私有 `CODEX_HOME` 分离 session 状态；项目规则和 runtime-default skill 发现仍然生效 |
| `openai-api` 本地 skill 发现 | 已禁用 | 无状态请求不加载本地 skill 或文件工具 |
| 自定义 script 执行器 | 无法强制 | 一次性告警；omk 无法证明用户命令加载了什么 |

**为什么工作区状态单独列出**：Core Trial 工作区隔离防止不同 Trial 共享可变状态，不会禁用工作区之外的用户、管理员或内置 skill。显式 workspace 会作为已验证资源捕获，再复制到 Trial；没有 workspace binding 时使用私有空 Trial 目录。两种情况都不能证明 Codex skill 发现已禁用。

私有工作区不是文件系统 sandbox。文件访问限制取决于所选 Runtime 的 sandbox 及其声明能力，空目录本身不能阻止读取绝对路径。

### 5. cache key 版本

Core 分阶段持有缓存。Execution key 的派生身份为 `omk.execution-cache-key/v2`，绑定 `executionCoordinateDigest` 和 `trialId`；Evaluation key 为 `omk.evaluation-cache-key/v2`，绑定 evaluation plan、evaluation id、evaluator Runtime、source trust 及 bindings。读回还验证 record、plan 与来源身份，摘要匹配不能替代信任校验。

隔离、输入和外部依赖如何进入封存身份，由[输入编译](../evaluation/cli-evaluation-input-compilation.md)与[Runtime Adapter](../evaluation/evaluation-runtime-adapter.md)规范规定；缓存身份本身不能建立测量可比性。

### 6. executor 兼容

| Executor | undefined | `[]` | `[name]` |
|---|---|---|---|
| `codex` | runtime-default skill 发现 | **拒绝：不支持禁用发现** | **统一 planner 抛错** |
| `codex-sdk` | runtime-default skill 发现；私有 `CODEX_HOME` | **拒绝：不支持禁用发现** | **统一 planner 抛错** |
| `openai-api` | 不隐式发现本地 skill | 接受；没有本地发现可禁用 | **统一 planner 抛错** |
| 自定义 script | 由命令决定 | stderr 告警，无法保证隔离 | **统一 planner 抛错** |

非空 skill 白名单 `[name]` 会在执行器分发前被拒绝，programmatic caller 即使绕过 eval.yaml 校验也一样。只有支持禁用发现的 Runtime（如 `openai-api`）才能使用 `[]`；执行器默认上下文则省略。辅助 Codex CLI／SDK 调用同样拒绝所有显式 `allowedSkills`，包括 `[]`。自定义 script 即使收到 `[]` 也无法证明严格隔离，因此辅助脚本调用只会告警，不声称已强制执行；Core 测量取决于自定义 Runtime 声明的契约。

## 七、落地判断标准

后续新增功能、文档或接口时，如果遇到命名选择，按下面顺序判断：

1. 它是在描述被评测对象吗？如果是，用 `artifact`
2. 它是在描述实验分组吗？如果是，用 `variant`
3. 它是在描述实验角色吗？如果是，用 `control` / `treatment`
4. 它是在描述运行目录或环境吗？如果是，用 `runtime context`
5. 它是在描述具体对象类型吗？如果是，用 `skill` / `agent` / `workflow`
6. 如果一个词同时混合了对象、环境或角色语义，就要拆开重写
