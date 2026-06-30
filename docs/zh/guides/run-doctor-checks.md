# doctor 体检

`omk doctor` 是对单个 artifact 的健康审计 —— 在你信任一次 eval 之前跑、以及当 CI 门禁跑。它不对比两个版本（那是 [`omk eval`](../reference/cli)），它告诉你一个 artifact 是否成型到值得测。

完整 flag 见 [CLI 参考](../reference/cli)。这篇覆盖常见任务。

## 快速体检

```bash
omk doctor                         # 体检当前目录或 ./skills
omk doctor skills/v1.md            # 体检单个 skill
```

默认会先跑静态规则（skill 可读性、frontmatter、正文依赖），再跑多维度健康审计（触发边界、文档清晰度、指令精确度、依赖、工具约定、安全、示例）。你会拿到各项 findings 和具体建议，按 fail → warn → pass 排序。用 `omk studio` 打开报告。

## 采样与共识

默认 `omk doctor` 把审计并行跑两遍（`--repeat 2`），finding 取并集，再用一次额外的 LLM 聚类归并同根因的 finding —— 每条标注 `k/n` 支持度（`n` 遍里有 k 遍报了它）。重复体检会收敛，而不是每次暴露不同子集。

```bash
omk doctor skills/v1.md --repeat 1             # 单次快检，最省
omk doctor skills/v1.md --repeat 3             # 更深、更稳的审计
omk doctor skills/ --repeat 3 --concurrency 1  # 串行（降低瞬时并发）
```

`--concurrency` 默认 = `--repeat`（全并行）；rate-limit 敏感就调小。成本随 `--repeat` 线性增长；墙钟约等于一遍（并行）+ 一次归并。

## 静态检测（无 LLM）

```bash
omk doctor skills/ --static-only
```

只跑默认 doctor 里同一套静态 lint 规则，**零 LLM 调用、且不加载 `samples.json`**：skill 可读性、frontmatter 合法性、以及 skill 正文里引用的脚本 / CLI / 文件 / env 是否存在。CI 节点没装 `claude` / `codex`、或本地断网调试时用。（samples 契约检查需要 `samples.json`，不在此模式内 —— 留给 `omk eval` 的评测前置门禁。）

## 当 CI 门禁

```bash
omk doctor --gate; echo $?        # 静默；fatal 问题 exit 1，警告不阻断
```

`--gate` 只在 fail 时打 stderr 摘要，用 exit code 标识结果，方便接进流水线。

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
