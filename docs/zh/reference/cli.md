# omk CLI 参考

omk 的公开 CLI 由顶层命令构成完整闭环：`init`（脚手架）·`install`（安装 omk 官方 Agent Skill）·`doctor`（静态检查）·`eval`（离线 A/B 评测）·`observe`（线上 trace 观测）·`evolve`（多轮自动迭代 skill）·`sample`（生成或补齐评测用例）·`studio`（本地 Web 工作台，看报告 / 分析）。

<!-- 维护者须知：本文件里的 Flags 区块由 scripts/build-docs.ts 从 oclif 命令源码自动生成。改 CLI flag 后跑 `yarn build:docs` 同步；CI 跑 `yarn build:docs:check` 拦截 drift。 -->

## `omk init`

```bash
omk init [目录]
```

<!-- omk:cli:init:flags:start -->

**Flags:**

```text
  --lang <value>  输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
```

完整描述见 `omk init --help`。

<!-- omk:cli:init:flags:end -->

生成一个评测项目脚手架，包含两版 starter skill 和 `eval-samples.json`。

## `omk install`

```bash
omk install omk-agent-skill            # 内置 omk 官方 Agent Skill（onboarding）
omk install omk-agent-skill --to all
omk install ./skills/review            # 登记并分发本地 skill（写一条受管记录）
omk install git:main:skills/review     # 从当前仓库某个 ref 安装（SHA 不可变、分支随 ref 漂移）
omk install ./skills/review --dest ~/.my-agent/skills
```

<!-- omk:cli:install:flags:start -->

**Flags:**

```text
  --dest <value>                  自定义 skill 根目录；skill 安装到 <dir>/<name>（内置 omk-agent-skill 为 <dir>/omk）。
  --dry-run                       只打印安装目标，不写文件。
  --force                         覆盖目标位置已存在的 skill。
  --git-ref <value>               远端 git 的 ref（分支 / tag / SHA），默认 HEAD。仅配合 --git-url 使用。
  --git-url <value>               远端 git 仓库 URL（https / ssh / git@host:path）。给了它时，位置参数当作仓库内 skill 路径（spec）。
  --kind <skill|prompt|agent|workflow>用户 artifact 的 kind（对齐 Artifact.kind）。可省：命中 SKILL.md 自动推导，当前仅支持 skill。
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --to <value>                    安装目标：auto（默认，本机已检测目标） / codex / claude / all。
```

完整描述见 `omk install --help`。

<!-- omk:cli:install:flags:end -->

安装一个知识输入（skill），把它分发到本机支持的 coding-agent 目标。三种源：内置 id `omk-agent-skill`（omk 官方 Agent Skill 的 onboarding）、本地 skill 路径（目录或 `.md`）、`git:<ref>:<spec>`（当前仓库某个 ref 上的 skill）。`registry` / `marketplace`（按包名去注册表解析）不是目标。

安装**用户自己的** skill（本地路径或 git 源）时，除分发外还会写一条**受管记录**到 `.omk/managed/<id>.json` —— 这是「管理」支柱的入口，让证据随 artifact 一起走过 doctor / eval / promote。`git:` 源的可复现性最强：SHA 不可变、内容寻址可核验，分支则给真实漂移语义。

默认 `auto` 只写入本机已检测到、且 omk 明确支持的目标：检测到 `~/.codex` 或 `~/.agents` 时写入 Codex/AGENTS，检测到 `~/.claude` 时写入 Claude Code。要强制写入当前 omk 已知的全部目标，用 `--to all`；要指定自定义 skill 根目录，用 `--dest`。

## `omk doctor`

```bash
omk doctor                              # 体检当前目录或 ./skills
omk doctor skills/v1.md                 # 体检单个 skill
omk doctor skills/ --json > r.json      # JSON 给 CI / 外部工具消费
omk doctor --gate; echo $?              # 静默门禁，fatal 问题 exit 1，警告不阻断
omk doctor --static-only                # 离线模式：只跑静态检查，不调 LLM
```

<!-- omk:cli:doctor:flags:start -->

**Flags:**

```text
  --dimensions <value>  自定义维度配置文件（YAML），追加到内置 7 维度之后。
  --effort <value>      LLM 推理 effort：low / medium / high / xhigh / max。
  --executor <value>    执行器名，默认 claude。指定为测试 fixture 路径可在测试里跑（同 omk doctor）。
  --fix                 交互式修复：根据 doctor 报告问题，用 LLM agent 修复 skill。
  --gate                静默模式，只在 fail 时输出 stderr 摘要，exit code 标识结果。
  --json                JSON 输出到 stdout，适合 CI / 外部脚本消费。
  --lang <value>        输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --model <value>       LLM model 名，默认 sonnet。
  --output-dir <value>  报告输出目录，默认 ~/.oh-my-knowledge/doctors。
  --samples <value>     用例文件路径（.json/.yaml）。不传则按 target / cwd 顺序自动发现。
  --static-only         离线静态模式，只跑 4 条静态 rule(skill_readable / skill_metadata / dependencies_present / samples_contract_aligned），不调 LLM。
  --timeout <value>     单次 LLM 会话超时秒数，默认 600(10 分钟）。
```

完整描述见 `omk doctor --help`。

<!-- omk:cli:doctor:flags:end -->

LLM 健康度审计：单次 LLM 会话产出 7 个内置维度的健康度评分 + findings + 改进建议；结果按 fail→warn→pass→skipped 排序，错误 finding 优先。维度可扩展（在自己代码里调 `registerHealthDimension`，自动并入同一次 LLM 调用的 prompt 与报告，顺序 = 注册顺序）。可视化报告请通过 `omk studio` 启动后选择最近一次运行查看。

离线静态模式（`--static-only`）：CI 节点没装 claude / codex、本地断网调试等场景下跑 4 条静态 rule（可读性 / 元数据 / 依赖 / samples 契约），零 LLM 调用、零成本。结果同样进 `DoctorReport`，可与 `--json` / `--gate` 组合。

`omk eval` 内部继续跑静态 readability / metadata / dependency / samples 契约 gate 保护评测质量，这条路径与用户入口的 `omk doctor` 角色分离，互不干扰。

## `omk eval`

```bash
omk eval --control baseline --treatment my-skill                # 单 skill 必要性测试（baseline 是保留 variant，代表「不注入 skill」）
omk eval --control code-review-v1 --treatment code-review-v2    # 多版本 A/B
omk eval --config eval.yaml
omk eval --batch
omk eval gold compare <report-id> --gold-dir gold-dataset
```

运行离线评测，应用 verdict gate，持久化报告，并用 exit code 表示 ship/no-ship。这个工作流默认开启 bootstrap CI。

<!-- omk:cli:eval:flags:start -->

**Flags:**

```text
  --batch                         batch 模式:baseline vs 每个 skill
  --blind                         judge blind 模式
  --bootstrap                     加 bootstrap CI
  --bootstrap-samples <value>     bootstrap 重采样次数，默认 1000
  --budget-per-sample-ms <value>  单 sample 时长上限 ms（必须 > 0，不传则无上限）
  --budget-per-sample-usd <value> 单 sample 预算上限 USD（必须 > 0，不传则无上限）
  --budget-usd <value>            总预算上限 USD（必须 > 0，不传则无上限）
  --concurrency <value>           并发数，默认 1
  --config <value>                eval.yaml 路径
  --control <value>               control variant 表达式（仅 artifact 身份）
  --control-cwd <value>           control 的 runtime context 目录
  --dry-run                       只 plan 不实跑
  --effort <value>                被测 LLM 扩展思考预算 low/medium/high/xhigh/max（默认 low；跨 effort 报告不严格可比）。
  --executor <value>              执行器:claude / claude-sdk / codex / codex-sdk / openai-api / gemini / 自定义命令（默认 claude）。
  --gold-dir <value>              gold dataset 目录
  --judge-models <value>          评委配置，格式 executor:model[,...]，例 claude:haiku 或 claude:opus,openai:gpt-4o(≥ 2 个 = ensemble）。默认 <executor>:haiku。
  --judge-repeat <value>          每个 dim 评 N 次
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --layered-stats                 输出分层统计
  --mcp-config <value>            MCP 配置文件路径
  --model <value>                 被测模型
  --no-cache                      跳过 executor cache
  --no-debias-length              关 length-debias（默认开）
  --no-diagnostic                 关闭 diagnostic 诊断 LLM 调用（默认开，给 failed sample 出「哪错了 + 怎么改」建议）。
  --no-gate                       关 verdict gate
  --no-judge                      跳过 LLM judge
  --no-serve                      不启 report server
  --no-strict-baseline            关闭 baseline 隔离
  --output-dir <value>            报告输出目录
  --repeat <value>                每个 sample 重复跑 N 次
  --report-only                   生成报告并打印 verdict，但始终 exit 0(不参与 CI gate）。
  --resume <value>                从某次失败 run 续跑
  --retry <value>                 失败 sample 重试次数
  --samples <value>               用例文件路径。默认 eval-samples.json，也接受 .yaml/.yml；自动发现 --skill-dir 下的 <skill>/.omk/samples.json。
  --skill-dir <value>             skill 目录，默认 skills
  --skip-connectivity             跳 LLM 连通性预检
  --skip-doctor                   escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。
  --strict-baseline               强制 baseline 隔离（default true）
  --threshold <value>             verdict 阈值，默认 3.5
  --timeout <value>               单用例超时秒，默认 600
  --treatment <value>             treatment variant 列表，逗号分隔（仅 artifact 身份）
  --treatment-cwd <value>         treatment 的 runtime context 目录列表，逗号分隔、与 --treatment 按序对齐（空位 = 无 cwd）
  --trivial-diff <value>          可忽略 diff 容差，0 表示不启用容差
  --verbose                       详细日志
```

完整描述见 `omk eval --help`。

<!-- omk:cli:eval:flags:end -->

HTML 报告有两个 tab：
- **📊 评分视角** — verdict 驱动的 A/B 对比（[事实/行为/judge 三层](../specs/scoring)、bootstrap CI、length-debias）。
- **✅ 功能视角** — 每条 sample 当一条单测看：用例设计（prompt / rubric / 工具调用 mock / environment）+ 执行轨迹 + 断言结果 + 可操作的 diagnostic 建议。诊断给出归因（skill 文档模糊 / LLM 误读 / sample 设计 bug / 诱错样本 / ...）、工作流校验（rubric 每步 ✓/✗ + 证据）和失败模式标签（工作流跳步 / 硬编码值 / 幻觉输出 / 工具误用 / 环境拦截 / 误读约束 / 其他）。沙箱 mock 字段语义（`mocks` / `environment` / `tripwire` / `mocksStrict`）见 [sample-design-spec.md §三](../specs/sample-design-spec.md)。

## `omk observe`

omk observe 提供两条工作流：默认的 skill 健康度报告，以及 reviewer 闭环用的 observe inbox。

### A. skill 健康度报告（默认）

```bash
omk observe ~/.claude/projects/-Users-you-Documents-my-project
omk observe ~/.claude/projects/my-project --last 7d
omk observe ~/.claude/projects/my-project --from 2026-04-01T00:00:00Z --to 2026-04-15T23:59:59Z
omk observe ~/.claude/projects/my-project --skills audit,polish
omk observe ~/.claude/projects/my-project --kb /path/to/project
```

<!-- omk:cli:observe:flags:start -->

**Flags:**

```text
  --from <value>        起始时间 ISO，优先级高于 --last
  --kb <value>          知识库 root，启用 KB-aware 分析
  --lang <value>        输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --last <value>        时间窗(7d / 24h / 30m）
  --output-dir <value>  分析结果输出目录
  --skills <value>      只看指定 skill，逗号分隔
  --to <value>          结束时间 ISO
```

完整描述见 `omk observe --help`。

<!-- omk:cli:observe:flags:end -->

把真实 Claude Code session trace 转成 skill 健康度报告：知识使用、[gap 信号](../specs/knowledge-gap-signal-spec)、执行稳定性、token 和耗时。这是生产观测，不是生产评分。

### B. observe inbox：reviewer 闭环

把真实 session trace 解析、聚合、降噪，输出可逐条 review 的 observation 列表。整条链路纯本地、零 LLM。

```bash
# 1. 把 trace 解析、聚合、落盘到 .omk/observations/
omk observe ingest ~/.claude/projects/my-project
omk observe ingest ~/.claude/projects/my-project --output-dir ./custom-dir

# 2. 看 inbox（默认 top 20，按 severity / confidence / lastSeen 排序）
omk observe inbox
omk observe inbox --limit 50
omk observe inbox --skill audit                    # 只看某个 skill
omk observe inbox --by-skill                       # 按 skill 资产视图
omk observe inbox --explore 10                     # 从 medium / low 桶抽 10 条长尾
omk observe inbox --explore 10 --include-noise     # 显式包含 noise 桶
omk observe inbox --llm-enhanced-review            # 显式调用模型进行链路增强复盘
omk observe inbox --json                           # JSON 输出，便于自动化消费

# 3. 反向查单条 observation 的事件三元组（前后 message 上下文）
omk observe show <inbox_id>
```

每条 observation 自带：

+ `confidence` 与 `attributionConfidence`：信号可信度 + skill 归因可信度，并列展示
+ `severityReasonCode`：判断为该 severity 的稳定结构化原因；人类可读说明由 CLI / studio 渲染时生成
+ `messageWindow`：前 3 条 / 触发点 / 后 3 条 message 上下文 + `resolutionAfter`（后续是否解决）
+ `evidence.{messageIndex,messageUuid,toolUseId}`：可反向回到原始 jsonl 的锚点

支持 trace 格式：Claude Code session JSONL（`.jsonl`）、OpenClaw session JSONL（`.jsonl`）、markdown 对话日志（`.log`）。

## `omk evolve`

```bash
omk evolve <skill>                  # 多轮自动迭代 skill
omk evolve skills/foo.md --rounds 10 --target 4.5
```

<!-- omk:cli:evolve:flags:start -->

**Flags:**

```text
  --auto-fix-samples              每轮先修 skill，再修 sample，随后一起评估候选结果
  --concurrency <value>           评测并发数，默认 1
  --edit-budget <value>           单轮最多改动的 skill 行占比（默认 0.2）。超预算的候选评测前直接判拒，省 eval 成本
  --effort <value>                reasoning effort: low/medium/high/xhigh/max
  --executor <value>              执行器名，默认 claude
  --holdout-ratio <value>         留出验收集比例（0..1，默认 0=关）。> 0 时按 holdout 分接受候选、weak-sample 只取训练集，防 train-on-test
  --improve-mode <agent|rewrite>  改写策略（默认：agent）
  --improve-model <value>         负责重写 skill 的 LLM，默认 sonnet
  --judge-models <value>          评委 model（单评委约束），格式 executor:model。默认 claude:haiku
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --model <value>                 被评测的 LLM，默认 sonnet
  --no-diagnostic                 关 LLM diagnostic 调用
  --no-edit-budget                关掉 edit budget 约束（允许任意大小的单轮改动）
  --no-reject-memory              关掉 rejected-edit 记忆（不把被拒改法回灌下一轮 prompt）
  --no-significance-gate          关掉显著性接受门，退回「候选分高一点点就收」的点估计判定（默认门开：只收统计显著的提升）
  --reuse-latest-eval             复用可比的最新 eval 报告作为 round-0
  --rounds <value>                最大迭代轮数，默认 5
  --sample-fix-max-attempts <value>每条 sample 自动修复最多尝试次数（默认：2）
  --samples <value>               用例文件路径，默认 eval-samples.json
  --significance-alpha <value>    显著性门的 diff CI 显著性水平（默认 0.05 = 95% CI）
  --skip-connectivity             跳过 LLM 连通性预检
  --skip-doctor                   跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）
  --stop-on-assertions-pass       普通用例断言全过时提前停止
  --target <value>                目标 composite 分数，达到即停。不传则跑满 rounds
  --test-ratio <value>            锁定 test 集比例（0..1，默认 0=关），需配 --holdout-ratio。全程不参与选择，收尾读一次给无偏泛化分
  --timeout <value>               单用例超时秒，默认 600
```

完整描述见 `omk evolve --help`。

<!-- omk:cli:evolve:flags:end -->

让 skill 跑 eval → judge → 改写 SKILL.md 的多轮闭环，直到达到 `--target` 或 `--rounds` 上限。耗时按 `轮数 × 用例 × 变体` 累加，几分钟到几十分钟级别。原始 skill 文件版本保存在 `skills/evolve/*.r0.md`。

## `omk sample`

```bash
omk sample <skill>                  # 为单个 skill 生成或补齐评测用例
omk sample --batch                  # 为目录下缺评测集的 skill 批量生成
```

<!-- omk:cli:sample:flags:start -->

**Flags:**

```text
  --batch                     批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。
  --count <value>             生成用例条数。不传由 LLM 按 skill 类型自动决定。
  --fix                       fix 模式：基于最近评测报告自动修复 sample_design 类型失败。
  --focus <value>             生成焦点（自然语言提示）。控制 LLM 偏向哪类用例。
  --from-traces               from-traces 模式：从 observe inbox 的失败信号回流生成回归用例草稿（provenance: production-trace），落草稿待人工 review。
  --lang <value>              输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --model <value>             生成 LLM model 名，默认 sonnet。
  --no-mock                   不生成 mocks，eval 时所有工具调用真实执行。
  --observations-dir <value>  observe inbox 目录（from-traces 模式用），默认项目 .omk/observations。
  --reports-dir <value>       报告目录（fix 模式用），默认 ~/.oh-my-knowledge/reports。
  --skill-dir <value>         skill 根目录，默认 skills。batch 模式扫此目录。
  --treatment <value>         指定 treatment 名（fix 模式用），默认推断自 skill 路径。
```

完整描述见 `omk sample --help`。

<!-- omk:cli:sample:flags:end -->

一次性生成。自动给生成的用例打 `provenance`。生成的 assertions 使用英文 / 数字 / 代码 token，便于跨中英文输出对比。

## `omk studio`

```bash
omk studio
omk studio --port 7799
omk studio --host 0.0.0.0                          # 局域网访问（默认 127.0.0.1）
omk studio --reports-dir ~/.oh-my-knowledge/reports
omk studio --observations-dir .omk/observations    # observe inbox 数据目录
omk studio --no-open
```

<!-- omk:cli:studio:flags:start -->

**Flags:**

```text
  --analyses-dir <value>      分析数据目录（可选）
  --dev                       dev 模式：子进程启动 + 热更新
  --host <value>              监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网
  --lang <value>              输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --no-open                   不自动打开浏览器
  --observations-dir <value>  观测数据目录（可选）
  --port <value>              监听端口，默认 7799。传 0 让 OS 分配
  --reports-dir <value>       报告目录，默认 ~/.oh-my-knowledge/reports
```

完整描述见 `omk studio --help`。

<!-- omk:cli:studio:flags:end -->

启动本地知识工作台浏览报告。verdict、用例回退、跨用例 diff、饱和曲线、单用例 drill-down 全部在 studio UI 里 —— omk 不提供 CLI 导出 / 分析子命令。CI gate 用 `omk eval` 的 exit code（PROGRESS 退 0、其他非 0），需要文字摘要自己 `jq` report JSON。

Studio 是 skill-centric 信息架构 — 列表页（`/`）按 skill 卡片展示健康等级 / 0-100 参考分 / 待优化数 / 趋势，详情页（`/skills/<name>`）左栏列关键问题清单（skill 优化 / 用例优化 / 工具反馈三档），右栏画 chart.js 健康趋势 + 三个紧凑阶段卡（doctor / eval / observe），细节走 modal。旧的 run 列表挪到 `/runs`。访问 `/observations/inbox` 查看 observe inbox 看板：按 skill 资产视图（rollup）+ reviewer 待办建议 + 当前可观测漏斗 + 单 observation 详情面板（含事件三元组）。
