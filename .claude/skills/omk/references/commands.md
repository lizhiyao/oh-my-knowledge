# omk 命令参考

omk v0.30+ 顶层命令固定为 7 个：`init` / `doctor` / `eval` / `observe` / `evolve` / `sample` / `studio`。本文档同步当前 CLI 表面，跟 `omk <command> --help` 输出一致。

## omk init

生成评测项目脚手架（两版 starter skill + `eval-samples.json`）。

```
omk init [目录]
```

## omk doctor

LLM 健康度审计：7 个内置维度（结构 / 规范 / 工作流 / 依赖 / 内容 / 一致性 / 可观测性）+ 可扩展规则。

```
omk doctor                       # 项目内所有 skill 体检
omk doctor skills/my-skill.md    # 单 skill 体检
omk doctor --static-only         # 只跑静态规则，不调 LLM judge
omk doctor --html <path>         # 输出 HTML 报告
```

`omk eval` 默认会先跑一次 doctor 当 preflight 门禁，所以 doctor 一般不用单独跑；想在 eval 之前先扫一遍结构问题再决定要不要跑评测，就单独跑 doctor。

## omk eval

离线评测：比较版本，输出 verdict + report。

```
omk eval --control <variant> --treatment <variant> [选项]
```

常用选项：

```
--samples <path>          用例文件（默认 eval-samples.json，也接受 .yaml / .yml；自动发现 <skill>/.omk/samples.json）
--skill-dir <path>        skill 目录（默认 skills）
--control <expr>          对照组 variant 表达式
--treatment <v1,v2>       实验组 variant 名，逗号分隔
--config <path>           eval.yaml / JSON 配置
--executor <name>         执行器：claude / claude-sdk / codex / codex-sdk / openai-api / gemini / custom
--model <name>            任务执行模型（默认 opus；省钱用 sonnet / haiku）
--effort <level>          扩展思考预算 low / medium / high / xhigh / max（默认 low；跨 effort 报告不严格可比）
--judge-models <list>     评委配置，例如 claude:haiku 或 claude:opus,openai:gpt-4o（≥ 2 = ensemble）
--concurrency <n>         并行任务数
--dry-run                 预览任务计划，不调用模型
--batch                   批量模式：每个 skill 独立 vs baseline
--blind                   盲测模式
--bootstrap               显式开启 bootstrap CI（默认自动开启）
--bootstrap-samples <n>   bootstrap 重采样次数（默认 1000）
--threshold <number>      verdict gate 阈值（默认 3.5）
--trivial-diff <number>   实际可忽略 diff（默认 0.1）
--report-only / --no-gate 生成报告并打印 verdict，但始终 exit 0
--no-serve                评测后不自动启动报告 server
--no-judge                关闭 judge 主观评分（仍跑断言层）
--no-diagnostic           关闭 diagnostic 诊断 LLM 调用
--skip-doctor             escape hatch：跳过 doctor preflight 门禁
```

Variant 特殊值：

- `baseline` — 不注入 skill 的裸基线（保留 variant 名）
- `git:<name>` — 从 git HEAD 读取旧版本
- `git:<ref>:<name>` — 从指定 commit 读取
- 含 `/` 的路径 — 直接读取文件

退出码：verdict 为 `PROGRESS` 退 0，其他非 0（受 `--threshold` / `--report-only` 影响）。CI gate 直接用 exit code 就行。

## omk evolve

LLM 自动多轮迭代改进 skill。

```
omk evolve <skill 路径> [选项]
```

选项：

```
--rounds <n>           最大迭代轮数（默认 5）
--target <分数>        目标分数，达到即停
--samples <path>       用例文件
--model <name>         改进用模型
--effort <level>       扩展思考预算
--no-diagnostic        关闭 diagnostic
--skip-doctor          跳过 doctor preflight
```

每轮版本保存在 `skills/evolve/<skill>.rN.md`。连续 2 轮无改进自动早停。**必须前台运行**：evolve 自带实时进度输出，前台才能看到每个 sample 的 `[N/M] sample_id ⏳ 执行中...` 跟每轮 `Round N: score=... ✓ ACCEPT / ✗ REJECT`。

## omk sample

生成或补齐 eval-samples 评测用例。

```
omk sample <skill 路径>           # 单 skill
omk sample --batch [选项]         # skill 目录下缺测试集的 skill 批量生成
```

选项：

```
--count <n>            强制生成 N 条（不指定时 LLM 按 skill 类型自动判断：
                       工作流型 6-8 条 / 原子型 4-6 条 / 混合型 5-7 条）
--model <name>         生成模型（默认 opus；省钱用 sonnet / haiku）
--focus <text>         自然语言指定希望覆盖的场景（追加到 prompt）
--skill-dir <path>     skill 目录（batch 使用，默认 skills）
```

输出位置（默认）：

- `<skill>/SKILL.md` 风格 → `<skill>/.omk/samples.json`（omk 标准约定）
- 其他 `.md` 路径 → 当前目录 `eval-samples.json`（兜底）

## omk observe

线上观测：解析真实 session trace，输出 skill 健康度 / gap 信号 / 失败率 / observe inbox。

```
omk observe <sessions-dir>                          # skill 健康度报告（默认）
omk observe ingest <sessions-dir>                   # 摄入 trace 落盘到 .omk/observations/
omk observe inbox                                   # 看 inbox 列表
omk observe inbox --skill <name>                    # 只看某 skill
omk observe inbox --by-skill                        # 按 skill 资产视图
omk observe show <inbox_id>                         # 单条 observation 事件三元组
```

支持 trace 格式：Claude Code session JSONL、OpenClaw session JSONL、markdown 对话日志（`.log`）。

## omk studio

本地报告浏览器。

```
omk studio                                # 启动 web 服务
omk studio --port 8080                    # 改端口（默认 7799）
omk studio --host 0.0.0.0                 # 局域网访问（默认 127.0.0.1）
omk studio --reports-dir <path>           # 报告目录
omk studio --observations-dir <path>      # observe inbox 数据目录
omk studio --no-open                      # 不自动开浏览器
```

Studio 是 skill-centric：列表页（`/`）按 skill 卡片展示健康等级 / 0-100 参考分 / 待优化数 / 趋势；详情页（`/skills/<name>`）左栏列关键问题清单（skill 优化项 / 用例优化项 / 工具反馈三档），右栏画 chart.js 健康趋势 + 三个紧凑阶段卡。旧的 run 列表在 `/runs`，observe inbox 看板在 `/observations/inbox`。

## eval-samples 字段参考

| 字段 | 必填 | 说明 |
|------|------|------|
| `sample_id` | 是 | 唯一标识 |
| `prompt` | 是 | 用户提示词 |
| `context` | 否 | 附加上下文（代码片段等） |
| `cwd` | 否 | executor 工作目录，用于指定目标仓库路径 |
| `rubric` | 否 | LLM 评分标准 |
| `assertions` | 否 | 断言数组（含 `mock_hit` 等新 v0.30 类型） |
| `dimensions` | 否 | 多维度评分 `{ 维度名: 评分标准 }` |
| `capability` | 否 | 能力标签（HF Dataset Cards 风） |
| `difficulty` | 否 | 难度等级 |
| `construct` | 否 | 测的是什么构念 |
| `provenance` | 否 | 用例来源（`omk sample` 自动打） |
| `mocks` | 否 | 工具调用 mock 返回（sandbox 评测） |
| `environment` | 否 | 评测环境前置「已就绪」声明 |
| `tripwire` | 否 | 标记为「故意诱错」样本，failed 时 diagnostic 不建议改 skill |

完整 schema 见 [docs/sample-design-spec.md](../../../docs/sample-design-spec.md)。
