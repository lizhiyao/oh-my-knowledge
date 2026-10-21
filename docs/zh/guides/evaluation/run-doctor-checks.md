# doctor 体检

`omk doctor` 是对单个 artifact 的健康审计 —— 在你信任一次 eval 之前跑、以及当 CI 门禁跑。它不对比两个版本（那是 [`omk eval`](../../reference/cli.md)），它告诉你一个 artifact 是否成型到值得测。

完整 flag 见 [CLI 参考](../../reference/cli.md)。这篇覆盖常见任务。

## 快速体检

```bash
omk doctor                         # 体检当前目录或 ./skills
omk doctor skills/v1.md            # 体检单个 skill
```

默认会先跑静态规则（skill 可读性、frontmatter、正文依赖），再跑多维度健康审计（触发边界、文档清晰度、指令精确度、依赖、工具约定、安全、示例）。你会拿到各项 findings 和具体建议，按 fail → warn → pass 排序。用 `omk studio` 打开报告。

## 采样与共识

默认 `omk doctor` 把审计并行跑两遍（`--repeat 2`），finding 取并集，再用一次额外的 LLM 聚类归并同根因的 finding —— 每条标注 `k/n` 支持度（`n` 遍里有 k 遍报了它）。支持度描述本次审计的重复结果，不保证 findings 收敛或覆盖全部问题。

```bash
omk doctor skills/v1.md --repeat 1             # 单次快检，最省
omk doctor skills/v1.md --repeat 3             # 更深、更稳的审计
omk doctor skills/ --repeat 3 --concurrency 1  # 串行（降低瞬时并发）
```

`--concurrency` 默认 = `--repeat`（全并行）；rate-limit 敏感就调小。成本随 `--repeat` 线性增长；墙钟约等于一遍（并行）+ 一次归并。

## 静态检测（无 LLM）

未配置模型时，默认 doctor 以退出码 2 结束，同时给出模型配置方法和检查同一目标的 `--static-only` 命令，不会静默跳过 LLM 健康度审计。

```bash
omk doctor skills/ --static-only
```

只跑默认 doctor 里同一套静态 lint 规则，**零 LLM 调用、且不加载 `samples.json`**：skill 可读性、frontmatter 合法性、以及 skill 正文里引用的脚本 / CLI / 文件 / env 是否存在。CI 节点没装 `codex`、或本地断网调试时用。（samples 契约检查需要 `samples.json`，不在此模式内 —— 留给 `omk eval` 的评测前置门禁。）

运行 doctor 前应审阅并信任 skill：frontmatter 的 `preflight` 与 `requires.preflight` 命令会在解析后的依赖工作目录中，使用宿主环境执行，每条命令超时 10 秒；`--static-only` 与评测预检也会执行。零模型调用不代表命令在沙箱中运行。

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

逐条选择修复方向，确认后才修改文件。OMK 将所选文件备份到 `.omk/backups/doctor-fix/`，并打印备份位置。同一物理文件的问题合并为一次编辑请求；每次只传入该文件的内容及已选问题。输入关闭不视为同意修复。

模型返回 `omk.skill-edits/v1` JSON，由 OMK 校验并应用，无须授予模型写文件权限。每个非空 `oldText` 必须在前序编辑应用后的文本中恰好匹配一次；响应不合法时，该文件不变。某个文件失败会让命令失败，即使此前其他文件已修复；原始备份仍保留。编辑完成不代表重新体检一定通过，提交前先 review diff。

自定义执行器须遵循带版本的 `omk.doctor-fix-plan/v2` 与 `omk.doctor-fix/v2` prompt。原先直接编辑文件的集成须改为返回 `{"summary":"…","edits":[{"oldText":"…","newText":"…"}]}`。OMK 原子发布完整文本，保留原有权限及符号链接目标；准备编辑期间源文本发生变化时拒绝覆盖。临时文件放在同一文件系统、载体排除的 `.omk/` 目录，不进入载体摘要或快照。

## 自定义维度

通过 YAML 文件在内置七维之上追加你自己的 LLM 打分维度：

```bash
omk doctor --dimensions my-dimensions.yaml
```

（也支持用 `registerHealthDimension` 编程注册——自定义维度会并入同一次 LLM 调用和报告。）

## 相关

- [三阶段](../../explanation/three-stage-workflow.md) —— doctor 在 doctor → eval → observe 闭环里的位置
- [CLI 参考：`omk doctor`](../../reference/cli.md) —— 每个 flag
