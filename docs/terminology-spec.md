# OMK 术语规范

## 一、目标

这份规范用于统一 OMK 后续迭代中的对外文案、命令示例、数据结构与代码命名。

目标有三条：

- 对齐行业与开源社区常见说法，尽量减少 OMK 私有术语
- 把"被评测对象"、"运行环境"、"实验分组"与"实验角色"四层拆开，避免混用
- 为未来扩展到 skill、agent、workflow、agent team 等载体保留统一抽象

## 二、标准术语

### 1. Artifact

`artifact` 是 OMK 对"被评测对象"的统一标准术语。

它表示在实验中被拿来比较、注入、运行或观测的对象，可以是：

- `baseline`
- `skill`
- `prompt`
- `agent`
- `workflow`
- 未来的 `team` 或其他新型知识载体

规则：

- 对外文档优先使用 `artifact`
- 对内核心类型、请求结构、任务结构优先使用 `artifact`

### 2. Artifact Kind

`artifact kind` 是 artifact 的具体类别。

当前支持：

- `baseline`
- `skill`
- `prompt`
- `agent`
- `workflow`

规则：

- `baseline` 表示空 artifact，也就是不注入任何显式 artifact；对大多数使用者来说，可以直接理解为"什么都没有"
- `skill`、`agent`、`workflow` 是 artifact 的子类，不是顶层总称
- 新增载体时，优先扩展 `artifact kind`，不要另起一套平行抽象

### 3. Variant

`variant` 是一次实验中的一条对比臂的表达式，不是领域对象本身。

例如：

- `baseline`
- `prd`
- `/path/to/SKILL.md@/path/to/project`

规则：

- variant 表达式解析后得到 artifact 与 runtime context
- 每个 variant 都必须绑定一个 experiment role（control 或 treatment），见第 4 节
- CLI 层按 experiment role 声明 variant（`--control` / `--treatment`），不再使用扁平的 `--variants` 参数

### 4. Experiment Role

`experiment role` 是 variant 在当次实验中扮演的角色，采用统计学标准术语。

枚举：

- `control` — 对照组，提供基线测量
- `treatment` — 干预组（实验组），对比 control 看变化

规则：

- role 是 variant 的 run-time 属性，不是 artifact 的固有属性；同一个 artifact 在不同 run 可以扮演不同 role
- CLI 层通过 `--control <expr>` 和 `--treatment <v1,v2,...>` 两个独立参数声明
- 报告中以 control/treatment 标签展示，不再从 `artifactKind === 'baseline'` 反推角色
- `baseline` 是 artifact kind 术语，不是 experiment role 术语；参见第三节边界

### 5. Runtime Context

`runtime context` 是运行时上下文，当前最核心的是 `cwd`。

它表示模型或 agent 在什么环境里运行，而不是"被评测对象"本身。

在项目型 agent 场景下，`runtime context` 就直接包含这些会影响行为的环境因素：

- 项目目录
- `CLAUDE.md`
- 本地 skills
- 仓库文件
- 工具可见范围

规则：

- `cwd` 归属于 runtime context
- 如果要表达"空 artifact + 指定 runtime context"，推荐使用自描述标签，例如 `project-env@/path/to/project`
- 不要把项目目录、项目级 runtime context、显式 artifact 注入混成一个概念

### 6. Sample

`sample` 是评测样本的一条记录。

规则：

- 数据文件、类型、代码结构继续使用 `sample`
- `case` 可以作为自然语言描述使用，但不作为核心结构名

### 7. Task

`task` 是一次具体执行单元：

> 一个 sample × 一个 artifact × 一个 runtime context

规则：

- 任务层不直接代表实验结论
- 任务是执行与评分的最小单位

### 8. Trace

`trace` 是一次执行过程中产生的过程数据，包括：

- turns
- tool calls
- timing
- token / cost / cache 等执行指标

规则：

- trace 属于运行结果
- trace 用于解释 agent 行为差异，不用于命名被评测对象

## 三、术语边界

### 1. baseline 就是"什么都没有"

`baseline` 的标准含义是：

- 不做显式 artifact 注入
- 不额外附带项目级 runtime context

对大多数使用者来说，`baseline` 就可以直接理解为"什么都没有"。

如果要单独观察项目级 runtime context，推荐显式写成：

- `project-env@/path/to/project`

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
- 示例对象尽量写具体路径或具体名称，不用 `skill@...` 代替所有场景
- 复杂实验配置推荐用 `--config eval.yaml`，CLI 参数只承担简单场景

### 3. 报告与验收

报告、验收文档应优先回答：

- 这次比较的 artifact 是什么
- 它们运行在什么 runtime context 中
- 谁是 control、谁是 treatment
- 差异来自 artifact 本身，还是来自 runtime context

## 五、对内实现规范

### 1. 类型与字段

新代码优先使用：

- `Artifact`
- `ArtifactKind`
- `artifacts`
- `task.artifact`
- `artifactHashes`
- `VariantConfig.experimentRole`（新增字段，枚举 `'control' | 'treatment'`）

### 2. 去兼容策略

OMK 当前仍处于 0-1 阶段，用户规模很小，因此不主动保留历史兼容层。

规则：

- 新实现直接收敛到 artifact 术语
- 旧命名如果会造成长期歧义，应直接删除，而不是继续挂兼容别名
- 破坏性调整优先在现在完成，不向后滚雪球
- v0.16 起 `--variants` 直接移除（不打 deprecation warning），用户迁移到 `--control` / `--treatment`

### 3. 命名原则

- 通用抽象用 `artifact`
- 具体子类用 `skill` / `agent` / `workflow`
- 实验编排用 `variant`
- 实验角色用 `control` / `treatment`（不用 `baseline` / `experiment`）
- 运行环境用 `runtime context` / `cwd`

## 六、术语映射

| 旧术语 | 新标准术语 | 说明 |
|---|---|---|
| evaluand | artifact | 被评测对象的统一总称 |
| EvaluandSpec | Artifact | 核心对象类型 |
| EvaluandKind | ArtifactKind | 对象类别 |
| evaluands | artifacts | 请求中的对象列表 |
| task.evaluand | task.artifact | 单个任务绑定的对象 |
| evaluandHashes | artifactHashes | artifact 内容哈希 |
| skillHashes | artifactHashes | report 中的统一对象哈希 |
| skill 作为总称 | artifact | skill 退回为具体子类 |
| agent 作为总称 | artifact / agent runtime | 视语义选择 |
| `--variants` CLI 参数 | `--control` / `--treatment` | 按 experiment role 声明 variant，废除扁平列表 |
| 从 `artifactKind === 'baseline'` 推断对照组 | 显式读 `experimentRole === 'control'` | 对照组由用户声明，不从 artifact kind 反推 |

## 七、落地判断标准

后续新增功能、文档或接口时，如果遇到命名选择，按下面顺序判断：

1. 它是在描述被评测对象吗？如果是，用 `artifact`
2. 它是在描述实验分组吗？如果是，用 `variant`
3. 它是在描述实验角色吗？如果是，用 `control` / `treatment`
4. 它是在描述运行目录或环境吗？如果是，用 `runtime context`
5. 它是在描述具体对象类型吗？如果是，用 `skill` / `agent` / `workflow`
6. 如果一个词同时混合了对象、环境或角色语义，就要拆开重写
