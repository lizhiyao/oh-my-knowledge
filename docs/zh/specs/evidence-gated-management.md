# 证据门控的知识输入管理

> **状态**：#203 的设计说明。本文先定义产品边界，再考虑新增通用管理命令。本文不修改 Report schema、评委提示词、评分管道或可比性规则。

## 1. 产品判断

omk 只有在「测量证据」能形成差异化时，才应该管理知识输入。

通用 skill 管理已经是平台原生能力的红海：Claude plugins / skills、Codex skills、Cursor rules 以及类似 registry 都在做「复制、列出、归档、安装」这类 CRUD。omk 不应该把定位稀释成一个更通用的文件搬运工具。

omk 独有的资产是证据：verdict、Δ、置信区间、评委一致性、用例集 hash、线上 trace 信号和可比性诊断。所以 omk 的管理应该意味着：

- 根据证据决定某个版本能不能转正。
- 保存带评测证据的版本史。
- 回滚到有证据背书的历史版本。
- 发现证据过期、不可比，或被线上 trace 反证。

一句话：omk 不是因为更会拷文件才管理知识输入，而是因为它能说明某个版本为什么值得上线。

## 2. 范围与非目标

### 范围内

- 对知识 artifact 做证据门控管理：先从 skill 开始，再逐步覆盖 prompt、agent context、workflow，以及模型定义清楚后的 RAG / corpus 类输入。
- 接住既有 omk 阶段之后的决策：
  - `doctor` 证明 artifact 结构可测。
  - `sample` 生成或修复测量用例。
  - `eval` 判断一次改动是进步、噪声还是回退。
  - `evolve` 产出候选版本。
  - `observe` 发现线上缺口，反哺下一轮 eval 用例。
- 记录并解释管理决策：已转正、已拒绝、已回滚、证据过期或需要补证据。

### 非目标

- 不做任意 skill 的通用 marketplace 或 registry。
- 不做超出 omk 明确支持目标的通用平台插件管理。
- 不在缺少共享 eval 设计时声明「A skill 比 B skill 更好」。
- 不把线上观测当作绝对评分。`observe` 是信号来源，不替代受控 eval。
- 不把 `omk install omk-agent-skill` 这个 onboarding helper 当作 #203 的完成；这部分已经在 #208 解耦。

## 3. 核心不变量：可比性优先于便利性

每个管理决策都必须保护 omk 的测量姿态：

- 转正决策必须指向可比报告，或明确标注可比性限制。
- 回滚决策必须指向历史版本，以及当时支撑它的证据。
- 线上观测必须展示归因可信度，不能静默覆盖 eval 证据。
- 证据过期或不可比时必须对用户可见，不能藏在绿色状态后面。

因此，omk 管理宁可「因为证据无效而阻塞」，也不应该「因为文件存在就安装 / 转正」。

## 4. 术语

- **知识输入**：用户可见的总称，指 LLM 接收到的 prompt、skill、RAG / corpus 输入、agent context 或 workflow 指令。
- **Artifact**：omk eval 模型里真正被测量的对象。见 [术语规范](./terminology-spec.md)。
- **Artifact kind**：具体的 `Artifact.kind` 值，例如 `skill`、`prompt`、`agent`、`workflow`。产品语义里的 `kind` 应保留给这个含义。
- **候选版本**：由 `evolve` 或人工编辑提出、尚未转正的 artifact 版本。
- **转正版本**：被接受为当前受管版本，并附带证据。
- **证据包**：解释一次管理决策所需的最小证据集合。

## 5. 证据包

一次管理决策应该保存或引用这些证据：

- Artifact 身份：名称、kind、来源路径或来源 URI、内容 hash、版本 / ref。
- 运行上下文：executor、model、cwd / runtime context、允许的 skill / tool 隔离、依赖指纹。
- Eval 身份：report id、omk CLI 版本、评委提示词 hash、用例集 hash 覆盖率、评分管道版本、长度去偏设置。
- Verdict 摘要：verdict、control / treatment 名称、Δ、置信区间、用例数、underpowered / cautious 标记、成本。
- 用例设计 caveat：construct 分布、provenance 分布、覆盖薄弱 capability 和明确 warning。
- 线上观测链接：trace 时间窗、归因可信度、知识缺口信号，以及这些信号是否已转成 eval 用例。
- 人类决策：转正 / 拒绝 / 回滚 / override、操作者、时间和原因。

第一版可以先引用现有 report，而不是立刻引入很重的新 schema。如果必须改 Report schema，应单独走迁移，并明确可比性影响。

## 6. 生命周期状态

受管 artifact 可以有这些产品状态：

| 状态 | 含义 | 下一步 |
|---|---|---|
| `discovered` | omk 找到候选 artifact，但还没有管理记录 | `doctor`、`install` |
| `installed` | omk 知道 artifact 在哪里，但没有有效 eval 证据 | `doctor`、`sample`、`eval` |
| `measurable` | doctor 和 samples 足以支持受控 eval | `eval`、`evolve` |
| `candidate` | 存在一个候选版本，通常来自 `evolve` | `eval`、`promote`、`reject` |
| `promoted` | 当前被接受版本，附带证据 | `observe`、`rollback`、`evolve` |
| `stale` | 证据不再匹配 artifact / runtime / sample context | `doctor`、`eval` |
| `rolled-back` | 已恢复到有证据的历史转正版本 | `observe`、`evolve` |

这些状态先作为产品概念存在，不一定第一天就落成新的持久化 enum。

## 7. 命令面

长期命令闭环保持：

```text
install → list → doctor → sample → eval → evolve → promote
                                      ↘ rollback
observe → studio
```

### `install`

当前发布范围：

```bash
omk install omk-agent-skill
```

这只是安装 omk 官方 Agent Skill 的 onboarding 入口。`omk-agent-skill` 是保留内置 id，不是 registry 包，也不是用户自己的被测 artifact。

未来受管输入范围：

```bash
omk install ./skills/review/SKILL.md --kind skill
omk install ./prompts/rewrite.md --kind prompt
```

规则：

- `--kind` 应对齐 `Artifact.kind`，不要拿 `kind` 表示 runtime / report / event 分类。
- 安装用户 artifact 只创建管理记录，不等于转正。
- 安装后的 artifact 根据 doctor / sample 状态进入 `installed` 或 `measurable`。

### `list`

`list` 应展示证据状态，而不只是文件：

- 已发现 vs 已管理。
- artifact kind。
- 最近转正版本。
- 最近 verdict，以及是否可比。
- 证据过期标记。
- 线上观测 warning。

### `promote`

`promote` 把候选版本转成当前受管版本。

默认门禁：

- 存在可比报告。
- verdict 为 `PROGRESS`，或满足配置允许的结果。
- 置信区间 / underpowered 状态可见。
- 用例设计 warning 被展示。

可以允许 override，但必须显式记录成人类决策。

### `rollback`

`rollback` 恢复到历史转正版本，并指向它的证据包。它不应该是盲目的文件恢复。

### `observe`

`observe` 通过标记证据过期、发现线上缺口或建议新增用例来反哺管理决策。它不能静默转正或降级 artifact。

### `studio`

Studio 应让决策轨迹可检查：为什么当前是这个版本、证据是什么、还有哪些 warning，以及自上次转正后发生了什么变化。

## 8. 分阶段

### Phase 0：onboarding install

#208 / PR #207 已完成：

- npm 包携带 omk 官方 Agent Skill。
- `omk install omk-agent-skill` 只安装到已检测或显式指定的支持目标。
- 这不关闭证据门控管理设计。

### Phase 1：设计与只读 inventory

- 合入本文。
- 增加只读 `list` 语义，或做一个 inventory 原型：展示已发现 / 已管理 / 证据状态，但不改 artifact。
- 定义第一版证据包存储形态。

### Phase 2：转正记录

- 增加候选 / 转正记录。
- 让 `evolve` 产出的候选版本可以带证据转正。
- 默认要求可比 eval 证据才能转正。

### Phase 3：回滚与 observe 反馈

- 增加回滚到有证据历史版本。
- 让 `observe` 标记证据过期并建议新增用例。
- 在 Studio 展示决策历史。

## 9. 开放问题

- 管理记录放在哪里：`.omk/managed.json`、`.omk/artifacts/`，还是其它 store？
- git ref 与 omk 证据记录如何协作？
- 默认允许哪些 verdict 转正：只允许 `PROGRESS`，还是允许带 caveat 的 `CAUTIOUS`？
- 当只有 sample、runtime context 或 artifact 内容变化时，证据过期策略分别是什么？
- 人类 override 应该允许在 CLI、Studio，还是两者都允许？
- `omk init` 何时演进为 `omk eval init`，兼容 alias 策略怎么定？

## 10. 当前决策

把证据门控管理视为 omk 的真实方向，但不要急着做宽泛 CRUD 命令。

下一步实现更适合从小型、证据感知的 inventory / prototype 开始，而不是通用 skill registry。这样 omk 的身份仍然锚定在测量上：只有当证据能跟 artifact 一起走时，管理才成立。

