# 跑 doctor 检查

`omk doctor` 是对单个 artifact 的健康审计 —— 在你信任一次 eval 之前跑、以及当 CI 门禁跑。它不对比两个版本（那是 [`omk eval`](../reference/cli)），它告诉你一个 artifact 是否成型到值得测。

完整 flag 见 [CLI 参考](../reference/cli)。这篇覆盖常见任务。

## 快速体检

```bash
omk doctor                         # 体检当前目录或 ./skills
omk doctor skills/v1.md            # 体检单个 skill
```

你会拿到各维度健康分（触发边界、文档清晰度、指令精确度、依赖、工具约定、安全、示例）、findings 和具体建议，按 fail → warn → pass 排序。用 `omk studio` 打开报告。

## 离线 / 无 LLM 模式

CI 节点没装 `claude` / `codex`，或离线调试时，只跑静态 rule（可读性 / 元数据 / 依赖 / samples 契约）—— 零 LLM 调用、零成本：

```bash
omk doctor skills/ --static-only
```

## 当 CI 门禁

```bash
omk doctor --gate; echo $?        # 静默；fatal 问题 exit 1，警告不阻断
```

`--gate` 只在 fail 时打 stderr 摘要，用 exit code 标识结果，方便接进流水线。配 `--static-only` 就是一道快速、无 LLM 的前置门禁。

## 机读输出

```bash
omk doctor skills/ --json > doctor.json
```

把完整 `DoctorReport` 输出为 JSON，给 CI 或外部工具消费。

## 自动修复

```bash
omk doctor skills/v1.md --fix
```

跑一个 LLM agent，读 doctor findings 并改 skill 来解决它们。提交前先 review diff。

## 自定义维度

通过 YAML 文件在内置七维之上追加你自己的 LLM 打分维度：

```bash
omk doctor --dimensions my-dimensions.yaml
```

（也支持用 `registerHealthDimension` 编程注册——自定义维度会并入同一次 LLM 调用和报告。）

## 相关

- [三阶段](../explanation/three-stage-workflow) —— doctor 在 doctor → eval → observe 闭环里的位置
- [CLI 参考：`omk doctor`](../reference/cli) —— 每个 flag
