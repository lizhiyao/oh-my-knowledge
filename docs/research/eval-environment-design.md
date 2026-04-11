# 评测环境设计：CLI 依赖与工具可用性

> 调研时间：2026-04-10
> 作者：lizhiyao
> 背景：insiop skill 评测中发现 CLI 鉴权失败导致模型诊断循环超时，引发对评测环境设计的深入调研

---

## 问题

评测依赖外部 CLI 的 skill 时，CLI 在 eval 环境不可用（未安装、鉴权失败等），模型会：

1. 尝试执行 CLI → 报错
2. 尝试诊断/修复环境问题
3. 重试 → 再失败
4. 循环直到超时

这导致评测数据被超时污染，无法获得有效的质量信号。

## 行业共识

调研了主流 agent 评测框架后，行业做法高度一致：**eval 环境是评测者的责任，不是模型的责任**。

### SWE-bench

每个评测实例有专属 Docker 镜像，所有依赖预装好，工具保证可用。评测在完全隔离的容器中运行。

> 参考：https://www.swebench.com/SWE-bench/guides/evaluation/

### Inspect（UK AISI）

评测在 Docker 沙箱里跑，bash、text_editor 等工具直接可用。提供标准化的沙箱工具箱。

> 参考：https://inspect.aisi.org.uk/evals/

### TAU-bench

模拟环境里工具调用返回确定性结果，不存在"工具不可用"的情况。

> 参考：https://toloka.ai/blog/tau-bench-extension-benchmarking-policy-aware-agents-in-realistic-settings/

### 共同模式

- 环境预配好，工具保证可用
- 评测前做 preflight 检查
- 不期望模型处理环境不可用的情况

## 排除的方案

调研过程中考虑并排除了以下方案：

### 1. 工具失败熔断

在执行器层拦截工具失败，连续 N 次失败后终止。

排除原因：本质是 hack，不解决根因，只是让超时变快。

### 2. System prompt 注入 eval 指令

追加"如果命令失败不要诊断，直接输出方案"的提示。

排除原因：没有任何主流评测框架这么做。eval 环境的行为应由环境决定，不应通过 prompt 改变模型行为。这会导致 eval 行为和真实使用行为偏差。

### 3. 要求每个 CLI 支持 mock/dry-run 模式

让 skill 作者给 CLI 加 `--dry-run` 或 `MOCK=1` 模式。

排除原因：推不动。omk 要批量测很多 skill，不能要求每个 CLI 作者都配合改造。

### 4. 限制工具权限（不给 Bash）

用 `allowedTools` 限制模型只能用 Read，不能执行命令。

排除原因：大多数 skill 都需要 Bash，一刀切禁止等于测不到真实的 skill 行为。

### 5. 按样本内容自动判断评测意图

根据样本的断言类型自动区分"测推理"还是"测执行"。

排除原因：分层概念是评测框架设计者的概念，不应暴露给 skill 作者。且大多数 skill 同时涉及推理和执行，难以自动区分。

## 设计方案

### 短期：强化 preflight 检查

在评测开始前，自动检测 skill 依赖的 CLI 工具是否可用：

1. 解析 SKILL.md 中引用的 CLI 命令（如 `foo-cli`）
2. 检查命令是否在 PATH 中（已通过 node_modules/.bin 注入部分解决）
3. 尝试执行 `<cli> --version` 或 `<cli> --help` 验证可用性
4. 如果不可用，在评测开始前报错，给出明确的修复指引：
   - "foo-cli 未安装，请运行 npm install"
   - "foo-cli 鉴权失败，请先执行 foo-cli login"

这样用户在评测前就知道环境有问题，而不是等模型跑了 180s 才发现。

### 长期：容器化 eval 环境

skill 声明运行环境依赖，omk 拉起预配好的容器跑评测：

```yaml
# SKILL.md frontmatter（未来扩展）
runtime:
  image: registry.example.com/insiop/eval-env:latest
  # 或
  setup: npm install && foo-cli auth --token $FOO_TOKEN
```

- skill 作者只需维护一个"能跑通自己 CLI"的环境描述
- omk 批量拉起容器，不同 skill 互不干扰
- 鉴权 token 通过环境变量或 secret 注入

### 当前进展

| 项目 | 状态 | 说明 |
|------|------|------|
| node_modules/.bin PATH 注入 | 已完成 | 201b1c4 — 解决"找不到命令"问题 |
| CLI preflight 检查框架 | 已有基础 | e6f1224 — 已有 CLI/文件/环境变量检测能力 |
| CLI 鉴权状态检测 | 待做 | 需要 skill 声明 preflight 检查命令 |
| 容器化 eval 环境 | 待做 | 长期方案，需要基础设施支持 |

## 参考资料

- [SWE-bench Evaluation Guide](https://www.swebench.com/SWE-bench/guides/evaluation/)
- [Inspect Evals – UK AISI](https://inspect.aisi.org.uk/evals/)
- [TAU-bench Extension – Toloka](https://toloka.ai/blog/tau-bench-extension-benchmarking-policy-aware-agents-in-realistic-settings/)
- [Demystifying evals for AI agents – Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [How to scale agentic evaluation: lessons from 200,000 SWE-bench runs – AI21](https://www.ai21.com/blog/scaling-agentic-evaluation-swe-bench/)
- [LLM Agent Evaluation Complete Guide – Confident AI](https://www.confident-ai.com/blog/llm-agent-evaluation-complete-guide)
- [The Complete Guide to Evaluating Tools & Agents – Composo](https://www.composo.ai/post/agentic-evals)
