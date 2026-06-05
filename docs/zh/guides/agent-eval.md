# 评测 agent（项目级 runtime context）

当执行器使用 `claude-sdk` 时，OMK 支持第一版 agent-aware evaluation：自动抽取 turns / toolCalls trace、支持基于工具调用行为的断言，并能在指定 `cwd` 下运行，让 Claude Code 自动加载项目内的 `CLAUDE.md`、skills 和本地 runtime context。

## 几个要分开理解的概念

- `artifact`：被评测对象，例如 baseline、skill、prompt、agent
- `variant`：CLI 里的实验分组表达式（见 [Artifact 与 variant 布局](../reference/artifact-layout)）
- `runtime context`：运行时上下文，当前主要是 `cwd`；在项目型 agent 场景下，它就包含项目目录、`CLAUDE.md`、本地 skills 等会影响行为的环境因素

在 OMK 里，`agent` 不是所有对象的总称，`skill` 也不是所有对象的总称。更稳妥的说法是：你在比较不同 artifact 在不同 runtime context 下的表现。

## 推荐执行器

```bash
omk eval --executor claude-sdk
```

## 支持的 agent 相关断言

工具调用与轮次相关的断言（`tools_called` / `tools_not_called` / `tools_count_min` / `tools_count_max` / `tool_output_contains` / `tool_input_contains` / `turns_min` / `turns_max`）见 [断言类型参考](../reference/eval-sample-format#assertion-types)。

## 三种常见对照组

**1. 裸模型 baseline**

不注入 system prompt，也不进入带知识的项目目录。至少需要一个 treatment 做对比：

```bash
omk eval \
  --executor claude-sdk \
  --control baseline \
  --treatment my-skill
```

**2. 空 artifact + 项目级 runtime context**

不注入 system prompt，但在项目目录运行。它不是严格意义上的「裸 baseline」，而是「空 artifact + 项目级 runtime context」。

```bash
omk eval \
  --executor claude-sdk \
  --control baseline \
  --treatment project-env --treatment-cwd /path/to/target-project
```

**3. 显式 artifact 注入**

直接把某个外部 `SKILL.md` 作为 artifact 注入，同时保留项目目录上下文。适合对比「项目级 runtime context」与「显式单 artifact 注入」之间的差异。

```bash
omk eval \
  --executor claude-sdk \
  --control project-env --control-cwd /path/to/target-project \
  --treatment /path/to/target-project/.claude/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

## 推荐的第一轮对照设计

对于 PRD / 复杂业务知识场景，建议从下面开始：

```bash
omk eval \
  --executor claude-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment /path/to/target-project/.claude/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

如果你想证明「项目目录中的知识沉淀本身」是否有效，加第二个 treatment：

```bash
omk eval \
  --executor claude-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment project-env,/path/to/target-project/.claude/skills/prd/SKILL.md \
  --treatment-cwd /path/to/target-project,/path/to/target-project
```

## 设计建议

- **先用 `--dry-run`**：确认样本、variant 和 `cwd` 被正确解析
- **项目级对照必须区分 `cwd`**：相同 prompt 在不同项目目录下会走不同 runtime context
- **优先先跑 PRD 场景**：相比 Coding，更容易验证知识完整性、影响面识别和业务正确性
