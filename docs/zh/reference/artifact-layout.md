# 被测对象与变体布局(artifact / variant)

OMK 如何把一个 `variant` 表达式解析为 `artifact`（被评测对象）与可选的 `runtime context`。

## Artifact 目录结构

默认执行器（claude / codex / gemini 等）支持两种 artifact 布局，同一次评测中可混用：

```
skills/
├── v1.md                    # 方式一：直接放 .md 文件
└── my-skill/                # 方式二：完整 artifact 目录
    ├── SKILL.md             #   工具自动读取此文件作为 system prompt
    ├── config.json          #   其他文件不参与评测，仅保留完整性
    └── scripts/
```

## Variant 解析规则

`variant` 是实验分组表达式。解析之后，OMK 会得到一个 `artifact` 与可选的 `runtime context`（当前主要是 `cwd`）。

| 格式 | 含义 |
|------|------|
| `name` | 从 artifact 目录查找 `name.md` 或 `name/SKILL.md`，解析为一个 artifact |
| `baseline` | 空 artifact，不使用 system prompt；可直接理解为「什么都没有」 |
| `project-env`（任意非 skill 标签） | 空 artifact，配合下方的 cwd 在指定项目目录运行，用于单独观察项目级 runtime context |
| `git:name` | 从 git HEAD 读取一个 artifact 的上次提交版本 |
| `git:ref:name` | 从 git 指定 commit 读取一个 artifact |
| `./path/to/file.md` | 含 `/` 的路径，直接读取文件作为 artifact |

## 声明 runtime context（cwd）

`variant` 表达式只表达 **artifact 身份**。runtime context（`cwd`）单独声明：

- CLI 上用 `--control-cwd <dir>` 与 `--treatment-cwd <dir,...>`（后者逗号分隔，与 `--treatment` 按序对齐，留空位 = 该 treatment 无 cwd）；
- eval.yaml 里用每个 variant 的结构化 `cwd:` 字段。

旧的 `name@cwd` 字符串语法已移除。

`--control` 和 `--treatment` 都不传时，用 `--config eval.yaml` 或 `--batch`。`--batch` 模式下会自动用 `baseline` 作对照组，每个被发现的 artifact 作实验组。

## 命令示例

```bash
# 显式：一个 control，一个或多个 treatment
omk eval --control v1 --treatment v2
omk eval --control baseline --treatment v1,v2,v3

# 对比空 artifact 和显式 artifact 的效果差异
omk eval --control baseline --treatment my-skill

# 对比修改前后（旧版本从 git 历史读取）
omk eval --control git:my-skill --treatment my-skill

# 直接指定文件路径
omk eval --control ./old-skill.md --treatment ./new-skill.md

# 配置文件驱动（evaluation-as-code）
omk eval --config eval.yaml
```

把 artifact 与项目级 `cwd` 配对的场景（agent / 项目 runtime context）见 [评测 agent](../guides/agent-eval)。
