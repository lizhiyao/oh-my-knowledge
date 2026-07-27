# 评测 agent（项目级 runtime context）

**什么时候需要这篇？** 普通的 skill 评测（`omk eval --control baseline --treatment my-skill`）注入一份 `SKILL.md`、把它孤立起来测。但真实 agent 的行为还取决于它的 **runtime context**：运行所在的项目目录、`AGENTS.md` 或 `CLAUDE.md` 等项目指令、本地发现的 skills、仓库状态。当你真正想测的是「这个 agent 在这个项目里表现如何」，普通 skill 评测看不到全部上下文。这篇讲的是如何把项目上下文明确定义为被测输入。

Codex 与 Claude 执行器都会输出相同的 source-neutral turns / toolCalls 契约，因此 agent 断言不再绑定某个 provider。执行器本身是 construct 的一部分：

- 需要最强 artifact 隔离时用 `codex`；它会忽略用户配置和项目规则
- 明确要测量 **Codex 项目上下文**时用 `codex-sdk`
- 明确要测量 **Claude Code 项目上下文**时用 `claude-sdk`

不同 variant 之间必须固定执行器、模型和工作目录。报告会持久化 runtime 指纹与执行策略，避免把不兼容运行误写成只比较 artifact。

## 几个要分开理解的概念

- `artifact`：被评测对象，例如 baseline、skill、prompt、agent
- `variant`：CLI 里的实验分组表达式（见 [Artifact 与 variant 布局](../reference/artifact-layout)）
- `runtime context`：运行时上下文，当前主要是 `cwd`；在项目型 agent 场景下，它包含项目目录、provider 指令文件、本地 skills 等会影响行为的环境因素

在 omk 里，`agent` 不是所有对象的总称，`skill` 也不是所有对象的总称。更稳妥的说法是：你在比较不同 artifact 在不同 runtime context 下的表现。

## 推荐执行器

Codex 项目上下文实验使用：

```bash
omk eval --executor codex-sdk
```

严格隔离 artifact 时使用 `--executor codex`。测量 Claude Code 项目上下文时，将执行器替换为 `claude-sdk`。

## 支持的 agent 相关断言

工具调用与轮次相关的断言（`tools_called` / `tools_not_called` / `tools_count_min` / `tools_count_max` / `tool_output_contains` / `tool_input_contains` / `turns_min` / `turns_max`）见 [断言类型参考](../reference/eval-sample-format#断言类型)。

## 三种常见对照组

**1. 裸模型 baseline**

不注入 system prompt，也不进入带知识的项目目录。至少需要一个 treatment 做对比：

```bash
omk eval \
  --executor codex \
  --control baseline \
  --treatment my-skill
```

**2. 空 artifact + 项目级 runtime context**

不注入 system prompt，但在项目目录运行。它不是严格意义上的「裸 baseline」，而是「空 artifact + 项目级 runtime context」。

```bash
omk eval \
  --executor codex-sdk \
  --control baseline \
  --treatment project-env --treatment-cwd /path/to/target-project
```

**3. 显式 artifact 注入**

直接把某个外部 `SKILL.md` 作为 artifact 注入，同时保留项目目录上下文。适合对比「项目级 runtime context」与「显式单 artifact 注入」之间的差异。

```bash
omk eval \
  --executor codex-sdk \
  --control project-env --control-cwd /path/to/target-project \
  --treatment /path/to/target-project/.agents/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

## 推荐的第一轮对照设计

对于 PRD / 复杂业务知识场景，建议从下面开始：

```bash
omk eval \
  --executor codex-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment /path/to/target-project/.agents/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

如果你想证明「项目目录中的知识沉淀本身」是否有效，加第二个 treatment：

```bash
omk eval \
  --executor codex-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment project-env,/path/to/target-project/.agents/skills/prd/SKILL.md \
  --treatment-cwd /path/to/target-project,/path/to/target-project
```

## 设计建议

- **先用 `--dry-run`**：确认用例、variant 和 `cwd` 被正确解析
- **项目级对照必须区分 `cwd`**：相同 prompt 在不同项目目录下会走不同 runtime context
- **不要把 `codex` 与 `codex-sdk` 直接当作 artifact-only A/B**：二者的项目规则隔离不同，执行器选择本身会进入 treatment
- **优先先跑 PRD 场景**：相比 Coding，更容易验证知识完整性、影响面识别和业务正确性
