# omk CLI 参考

omk 提供知识建设工作流命令：`init`（初始化项目）、`install`（安装 skill）、`doctor`（健康体检）、`eval`（受控评测）、`observe`（真实工作观测）、`evolve`（自动迭代）、`sample`（生成或补充用例）、`agents`（识别本机 Agent）与 `studio`（浏览知识及证据）。

<!-- 维护者须知：本文件里的 Flags 区块由 scripts/build/docs.ts 从 oclif 命令源码自动生成。改 CLI flag 后跑 `yarn build:docs` 同步；CI 跑 `yarn build:docs:check` 拦截 drift。 -->

## `omk init`

```bash
omk init [目录]
```

<!-- omk:cli:init:flags:start -->

**Flags:**

```text
  --force           允许覆盖目标目录中已有的 omk 脚手架文件
  --lang <value>    输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --samples <3|20>  官方起步用例数量：3 条用于快速跑通，20 条用于达到默认启发式证据下限
```

完整描述见 `omk init --help`。

<!-- omk:cli:init:flags:end -->

在目标目录初始化一个 **omk 项目**：待测知识载体（今天是 `skills/<name>/SKILL.md`）+ 它们的评测用例（`eval-samples.json`）—— 这是 `omk eval` / `doctor` / `evolve` / `observe` 共同操作的「每目录工作区」。跟 git 仓库一样，一个测量目标一个项目（用例集就是测量上下文，随载体走、不全局共享）。默认 3 条 A/B 用例是低成本流程检查；`--samples 20` 会选择达到默认启发式证据下限的官方起步用例集，但不代表完成先验功效规划。起步用例标记为 `llm-generated`，作为发布证据前必须人工复核或替换。写到磁盘的脚手架内容（两份起步 `SKILL.md`、`.omk/.gitignore` 与起步用例集）按解析出的输出语言（`--lang`／`OMK_LANG`／全局设置／系统 locale）生成：英文环境拿到的是英文题干与英文评分标准；用例中的代码、断言与权重两版完全一致。除非显式传入 `--force`，`init` 不会覆盖已有脚手架文件。

## `omk install`

```bash
omk install omk-agent-skill            # 内置 omk 官方 Agent Skill（onboarding）
omk install omk-agent-skill --to all
omk install ./skills/review            # 安装本地 skill
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
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --to <value>                    安装目标：auto（默认，本机已检测目标） / codex / claude / all。
```

完整描述见 `omk install --help`。

<!-- omk:cli:install:flags:end -->

安装一个知识输入（skill），把它分发到本机支持的 coding-agent 目标。三种源：内置 id `omk-agent-skill`（omk 官方 Agent Skill 的 onboarding）、本地 skill 路径（目录或 `.md`）、`git:<ref>:<spec>`（当前仓库某个 ref 上的 skill）。`registry` / `marketplace`（按包名去注册表解析）不是目标。

默认 `auto` 只写入本机已检测到、且 omk 明确支持的目标：检测到 `~/.codex` 或 `~/.agents` 时写入 Codex/AGENTS，检测到 `~/.claude` 时写入 Claude Code。要强制写入当前 omk 已知的全部目标，用 `--to all`；要指定自定义 skill 根目录，用 `--dest`。

## `omk doctor`

```bash
omk doctor                              # 体检当前目录或 ./skills
omk doctor skills/v1.md                 # 体检单个 skill
omk doctor skills/ --json > r.json      # JSON 给 CI / 外部工具消费
omk doctor --gate; echo $?              # 静默门禁，fatal 问题 exit 1，警告不阻断
omk doctor --repeat 1                    # 单次快速体检（不采样、不归并，最省）
omk doctor --static-only                 # 只跑静态检测：不调 LLM、不读 samples —— 结构 + 正文依赖
```

<!-- omk:cli:doctor:flags:start -->

**Flags:**

```text
  --concurrency <value>  多次采样的并发数。默认 = --repeat（全并行，各遍相互独立，压墙钟时间）。设 1 = 串行。成本不变，只抬高瞬时并发（rate-limit 敏感时调小）。
  --dimensions <value>   自定义维度配置文件（YAML），追加到内置 7 维度之后。每条维度二选一：promptSection（走 LLM 体检）或 endpoint（POST skill 快照给接口判定）。注意：endpoint 会把 SKILL.md 全文 + 子文件发到该地址，仅对可信配置/可信地址启用。
  --effort <value>       LLM 推理 effort：low / medium / high / xhigh / max。
  --executor <value>     执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。指定为测试 fixture 路径可在测试里跑。
  --fix                  交互式修复：根据 doctor 报告问题，用 LLM agent 修复 skill。
  --gate                 静默模式，只在 fail 时输出 stderr 摘要，exit code 标识结果。
  --global               写全局 ~/.oh-my-knowledge/doctor，而非项目 .omk/doctor
  --json                 JSON 输出到 stdout，适合 CI / 外部脚本消费。
  --lang <value>         输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --model <value>        LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。
  --output-dir <value>   报告输出目录，默认项目级 .omk/doctor（--global 写全局）。
  --repeat <value>       健康度体检重复采样次数（self-consistency）。默认 2：并行跑 2 遍、finding 取并集并用 LLM 聚类归并同根因、标注支持度 k/N，压低单次采样方差。设 1 = 单次快速体检（不采样、不归并，最省）。
  --static-only          只跑静态检测（不调 LLM、不读 samples.json）：skill 可读性 / frontmatter 合法性 / 正文引用的脚本·CLI·文件·env 是否存在。CI 无 LLM 凭证或断网时用。
  --timeout <value>      单次 LLM 会话超时秒数，默认 600(10 分钟）。
```

完整描述见 `omk doctor --help`。

<!-- omk:cli:doctor:flags:end -->

默认 doctor 会先跑静态规则（skill 可读性、frontmatter、正文依赖），再跑 LLM 健康度审计。单次 LLM 会话产出 7 个内置维度的健康度评分 + findings + 改进建议；结果按 fail→warn→pass→skipped 排序，错误 finding 优先。维度可扩展（在自己代码里调 `registerHealthDimension`，自动并入同一次 LLM 调用的 prompt 与报告，顺序 = 注册顺序）。可视化报告请通过 `omk studio` 启动后选择最近一次运行查看。

通过 `--dimensions <yaml>` 自定义维度：每条维度二选一 —— **LLM 维度**（`promptSection`，并入健康度 LLM 调用）或**接口维度**（`endpoint`，doctor 把 skill 快照 POST 给你的服务并把响应映射成判定）。同一条维度两者互斥。接口维度属于「在线」检查（与健康度 LLM 审计一起运行），可以做 prompt 表达不了的深度检查 —— 例如调用外部安全审查服务。

```yaml
dimensions:
  # LLM 维度
  - id: tone-check
    displayName: 语气检查
    severity: warn
    promptSection: 检查 skill 文案是否礼貌、无歧义。
  # 接口维度
  - id: deep-security-audit
    displayName: 深度安全审查
    severity: fatal
    endpoint: https://my-service.com/audit   # POST 到这里
    headers: { Authorization: "Bearer xxx" }  # 可选：鉴权请求头
    params: { env: production }               # 可选：原样透传给接口
    includeFiles: true                        # 可选（默认 true）：打包 references/scripts 子文件
    maxFileBytes: 204800                      # 可选：单文件字节上限（默认 200KB，超出截断）
    maxTotalBytes: 2097152                    # 可选：files 总字节上限（默认 2MB，超出停止收集）
    allowPrivateHost: false                   # 可选：放行私网/本机 endpoint（默认 false，拒绝以防 SSRF）
```

请求体（doctor → endpoint）：`{ dimensionId, params, skill: { name, content, skillRoot, ref, files } }` —— `files` 是 skill 子文件的相对路径 → 内容映射（只收文本；单文件超 `maxFileBytes`（默认 200KB）截断，整个 `files` 块受 `maxTotalBytes`（默认 2MB）封顶，两者均可按维度覆写）。响应（endpoint → doctor）：`{ status: "pass"|"warn"|"fail", message: string, hint?: string, detail?: object }`。任何网络错误 / 非 2xx / 协议违规都映射为 `fail`，让问题浮出来而不是静默放行。响应字段落盘前同样限长（超长 `message` / `hint` 截断；超大 `detail` 替换为 `{ truncated: true, preview }`）。

endpoint 地址校验：只接受 `http` / `https` 协议；指向私网/本机的地址 —— localhost、`*.local`、`::1`、127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16（含云 metadata `169.254.169.254`）—— 默认拒绝：doctor 会把 skill 完整快照发给 endpoint 并把响应回填进报告，不设防就会成为 SSRF 跳板。确认内网服务可信后，在该维度配置 `allowPrivateHost: true` 放行。此校验只看字面 hostname（defense-in-depth），不做 DNS 解析；公网域名解析到内网（DNS rebinding）不在防护范围。

采样与共识：默认 `omk doctor` 把审计 `--repeat 2` 遍并行跑，finding 取并集，再用一次额外的 LLM 聚类把同根因（措辞不同）的 finding 归并，每条标注 `k/n` 支持度（n 遍里有 k 遍报了它）。这样重复体检会收敛，而不是每次暴露不同的子集。`--repeat 1` 单次快检；调大做更深、更稳的审计。`--concurrency` 节流并发（默认 = `--repeat`）。

静态检测（`--static-only`）：只跑默认 doctor 里同一套静态 lint 规则，零 LLM 调用、**且不加载 `samples.json`** —— skill 可读性、frontmatter 合法性、以及 **skill 正文** 里引用的脚本 / CLI / 文件 / env 是否存在。CI 节点没装 `claude` / `codex` 或断网调试时用。samples 契约检查被有意排除（它需要 `samples.json`），留给 `omk eval` 的评测前置门禁 —— 在那里依赖检查还会用上用例声明的 `requires` 做增强。

## `omk eval`

```bash
omk eval --control baseline --treatment my-skill                # 单 skill 必要性测试（baseline 是保留 variant，代表「不注入 skill」）
omk eval --control code-review-v1 --treatment code-review-v2    # 多版本 A/B
omk eval --config eval.yaml
omk eval --batch
omk eval gold compare <run-id> --gold-dir gold-dataset \
  --target <id> --evaluator <id> --metric <id> --minimum-alpha <value>
```

运行离线评测，应用 verdict gate，持久化报告，并用 exit code 表示 ship/no-ship。这个工作流默认开启 bootstrap CI。

`eval gold compare` 是独立的事后探索性校准。`--minimum-alpha` 是可选项；提供后，OMK 会用 Krippendorff alpha 置信区间下界与该显式阈值比较。未提供时，assessment 以 `gold-agreement-threshold-not-configured` 明确表示 inconclusive，OMK 不会假定通用可靠性阈值。v2 区间遵循 Krippendorff 的可靠性 bootstrap：重采样配对的观测分歧，同时固定原始评分的期望分歧，因此不会静默剔除退化 draw。观测结果完全一致时输出结构化的「bootstrap 不适用」，而不是编造区间。该 assessment 不会改写 run 的预注册 release verdict，也不改变命令退出状态。

<!-- omk:cli:eval:flags:start -->

**Flags:**

```text
  --batch                         批量评测：baseline 作为对照组，逐个 skill 作为实验组；不支持 repeat 大于 1
  --bootstrap                     加 bootstrap CI
  --bootstrap-samples <value>     bootstrap 重采样次数，默认 1000
  --budget-per-sample-ms <value>  单用例时长上限 ms（必须 > 0，不传则无上限）
  --budget-per-sample-usd <value> 单用例预算上限 USD（必须 > 0，不传则无上限）
  --budget-usd <value>            总预算上限 USD（必须 > 0，不传则无上限）
  --concurrency <value>           并发数，默认 1
  --config <value>                eval.yaml 路径
  --control <value>               对照组（control）的 variant 表达式（仅 artifact 身份）
  --control-cwd <value>           对照组（control）的 runtime context 目录
  --dry-run                       只 plan 不实跑
  --effort <value>                被测 LLM 扩展思考预算 low/medium/high/xhigh/max（默认 low；跨 effort 报告不严格可比）。
  --executor <value>              执行器：claude / claude-sdk / codex / codex-sdk / anthropic-api / openai-api / 自定义可执行文件路径（不接受带参数的命令字符串）。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
  --global                        报告写全局 ~/.oh-my-knowledge/eval，而非项目 .omk/eval
  --gold-dir <value>              gold dataset 目录
  --holdout-ratio <value>         留出比例 0-1（如 0.3）；切出 holdout 子集，对比 train/holdout 综合分检测过拟合
  --judge-models <value>          评委配置，格式 executor:model[,...]，例 claude:haiku 或 codex:<model>（≥ 2 个 = ensemble）。默认跟随所选执行器；Claude 使用 haiku，其他执行器沿用被测模型。
  --judge-repeat <value>          每个维度由评委评价 N 次
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --layered-stats                 输出分层统计
  --mcp-config <value>            MCP 配置文件路径
  --model <value>                 被测模型
  --no-debias-length              关 length-debias（默认开）
  --no-diagnostic                 关闭基于 Core 失败、缺失、排除与稳定 reason code 的诊断投影。
  --no-gate                       关闭判定门禁
  --no-judge                      跳过 LLM 评委
  --no-serve                      不启 report server
  --no-strict-baseline            关闭 baseline 隔离
  --output-dir <value>            报告输出目录（默认项目级 .omk/eval）
  --repeat <value>                预先固定 Evaluation Series 的独立 run 数
  --report-only                   生成报告并打印判定，但始终 exit 0(不参与 CI gate）。
  --resume <value>                复用经过完整契约校验的 Core runId；拒绝时失败关闭
  --retry <value>                 单用例失败重试次数
  --samples <value>               用例路径。自动发现项目级或单个实验组（treatment）目录 skill 下的 eval-samples.json / eval-samples.yaml；显式路径可为 JSON / YAML 文件或分片目录。
  --skill-dir <value>             skill 目录，默认 skills
  --skip-connectivity             跳 LLM 连通性预检
  --skip-doctor                   escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。
  --strict-baseline               强制 baseline 隔离（default true）
  --threshold <value>             判定阈值，默认 3.5
  --timeout <value>               单用例超时秒，默认 120
  --treatment <value>             实验组（treatment）的 variant 列表，逗号分隔（仅 artifact 身份）
  --treatment-cwd <value>         实验组（treatment）的 runtime context 目录列表，逗号分隔、与 --treatment 按序对齐（空位 = 无 cwd）
  --trivial-diff <value>          可忽略 diff 容差，0 表示不启用容差
  --verbose                       详细日志
```

完整描述见 `omk eval --help`。

<!-- omk:cli:eval:flags:end -->

`--repeat` 会创建一个预注册的 Evaluation Series，其独立 Run 数在执行前固定。应当在查看结果前确定数量，并报告所有 member Run。不能在 verdict 不理想后持续新建 Run，再遇到第一次有利结果时停止；这属于未校正的 optional stopping。`--retry` 另行计算，只在已封存的 retry policy 下处理运行失败的 sample attempt。

Studio 打开的是经过校验的 Core run，而不是第二套报告模型。Run detail 会分别投影运行、证据与结论状态，展示数值观测、Analysis result、Decision reason code、成本、coverage 与 provenance，并把每个视图追溯到不可变 Core 产物。Diagnostic 后处理只使用经过认证的 Core 失败、缺失证据、排除项与稳定 reason code。沙箱 mock 字段语义（`mocks` / `environment` / `tripwire` / `mocksStrict`）见 [sample-design-spec.md §三](../specs/sample-design-spec.md)。

## `omk observe`

omk observe 提供两条工作流：默认的 skill 健康度报告，以及 observe inbox（`ingest` / `inbox` / `show`）走 reviewer 逐条复核。

### A. skill 健康度报告（默认）

```bash
# ChatGPT desktop / Codex CLI
omk observe ~/.codex/sessions --last 7d

# Claude Code
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
  --global              写全局 ~/.oh-my-knowledge/observe/health，而非项目 .omk/observe/health
  --kb <value>          知识库 root，启用 KB-aware 分析
  --lang <value>        输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --last <value>        时间窗(7d / 24h / 30m）
  --output-dir <value>  健康报告输出目录，默认项目级 .omk/observe/health（--global 写全局）
  --skills <value>      只看指定 skill，逗号分隔
  --to <value>          结束时间 ISO
```

完整描述见 `omk observe --help`。

<!-- omk:cli:observe:flags:end -->

把真实 Codex rollout、Claude Code / OpenClaw session 与 markdown 对话日志统一转换为 source-neutral Trace IR，再生成 skill 健康度报告：知识使用、[gap 信号](../specs/knowledge-gap-signal-spec)、执行稳定性、token 和耗时。这是生产观测，不是生产评分。

### B. observe inbox：reviewer 闭环

把真实 session trace 解析、聚合、降噪，输出可逐条 review 的 observation 列表。基础链路纯本地、零 LLM；`--llm-enhanced-review` 是显式开启的可选模型调用。

```bash
# 1. 把 trace 解析、聚合、落盘到 .omk/observe/inbox/
omk observe ingest ~/.codex/sessions
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

`observe inbox --json` 返回带有 `schemaVersion: 1` 的对象。既有 `kind` 区分视图：`observe-inbox-query`（`items`）、`observe-inbox-by-skill`（`rows`）或 `observe-llm-enhanced-review`（`records`）。空结果使用相同信封。严格拒绝未知字段的消费者需允许 `schemaVersion`；既有结果字段和落盘观测文件不变。

每条 observation 自带：

+ `confidence` 与 `attributionConfidence`：信号可信度 + skill 归因可信度，并列展示
+ `severityReasonCode`：判断为该 severity 的稳定结构化原因；人类可读说明由 CLI / studio 渲染时生成
+ `messageWindow`：前 3 条 / 触发点 / 后 3 条 message 上下文 + `resolutionAfter`（后续是否解决）
+ `evidence.{messageIndex,messageUuid,toolUseId}`：可反向回到原始 jsonl 的锚点

落盘观察报告的口径版本是 `schemaVersion: 4`：时间线证据档新增 `observed_effect`——运行时观察到的文件变更独立成行，不并入触发它的工具调用，因为多数变更是命令的副作用而非模型发起的编辑。旧口径（如 `3`）的报告不再被读取：对它重跑一次 `omk observe` 即可刷新。人工评审状态独立存储、时间线行的 id 由证据内容派生，因此重跑后评审结果会接回同一批证据，不需要为旧报告保留双读分支。

支持 trace 格式：Codex rollout JSONL（`.jsonl`）、Claude Code session JSONL（`.jsonl`）、Qoder session JSONL（`.jsonl`）、OpenClaw session JSONL（`.jsonl`）、markdown 对话日志（`.log`）。

## `omk agents`

```bash
omk agents list                          # 识别本机装了哪些编码 Agent
omk agents list --json                   # 给脚本消费的完整清单报告
omk agents collect --limit 40            # 把它们的会话日志映射成统一 Trace IR
omk agents extract --session <runId>     # 从一份已采集会话提炼候选知识
```

<!-- omk:cli:agents:flags:start -->

**Flags:**

```text
  --dir <value>        清单与采集产物目录，默认全局 ~/.oh-my-knowledge/observe/agents。
  --executor <value>   extract：生成执行器，沿用 OMK 运行配置。
  --json               输出完整 JSON；默认输出可读摘要。
  --knowledge <value>  extract：知识工作区，默认全局知识目录。
  --lang <value>       输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --limit <value>      collect 单轮处理的会话文件上限。
  --model <value>      extract：生成模型，沿用已配置模型。
  --session <value>    extract：采集报告里的 runId。
```

完整描述见 `omk agents --help`。

<!-- omk:cli:agents:flags:end -->

`list` 按 Agent 登记表核对 `PATH` 与主目录，写出 `inventory.json`。登记表是内置条目与本机扩展文件 `~/.oh-my-knowledge/agents.json`（契约 `agent-catalog-v1`）合并的结果：你在扩展文件里声明自己宿主的安装目录与日志根，就能被识别和采集，不需要改动代码；同身份时扩展条目整条替换内置条目。内置表覆盖 Codex、Claude Code、Qoder、OpenClaw 等公开产品。`collect` 遍历每个已安装 Agent 声明的日志根，把会话日志解析成与 `observe` 同源的 Trace IR，每个会话落一份归一化产物到 `~/.oh-my-knowledge/observe/agents/traces/<agentId>/<traceId>.json`，并写出 `collection.json`（契约 `agent-collection-v2`）说明发现、采集、跳过与失败各多少。采集是增量的：摘要与修改时间已出现在上一轮报告里的文件会被跳过，因此第二轮通常零新增。`extract` 把一份已采集会话归档成证据快照，再让配置的执行器提炼候选知识，走的是与 `omk observe knowledge` 相同的 `entities`／`evidence` 契约。

读不出的记录不再只有一个计数。`collection.json` 按会话把它们分成三档：`unknownEventCount` 是未支持格式，适配器完全读不出语义，属于真正的能力缺口；`duplicateViewCount` 是重复视图已忽略，同一条事实已被另一个视图映射过、或者它本身是累计快照，再映射一遍会变成双计，因此刻意不产出事件；第二次写入现在按原生 id 精确判定——映射事件会把它见过的调用 id 与 item id 都登记在 `sourceIds` 上，只有身份对不上时才退回「同类已映射事件数」的上界近似。`unmappedEvidenceCount` 是待映射证据，记录族已经识别但还没决定映射成什么事件，原始记录仍留在产物里。已经定论的族不再留在未知档：Codex 的 `FileChange` 映射成 `observed_effect`（运行时观测到的效果，不算模型发起的调用，也不进工具计数）、`SubAgentActivity` 映射成 `agent_activity`、进入评审映射成 `lifecycle`，改由 `Extension` 承载的网页搜索沿用 `WebSearch` 的同一口径，shell 结果视图的退出码与时长并入同一次调用的 `tool_result`——一次桥接跑多条命令时，每个结果视图只在被唯一一次调用包含时才归入该调用，时长取同组求和，退出码仅在同组每条都报告且取值唯一时才填，否则宁缺不猜。单条原始记录超过 8 KB 时，产物只留开头节选、字节数与摘要，族名和记录自身的 id 始终保留：完整证据仍是原始日志本身，靠 `sourceIndex` 与会话的 `sourcePath` 回指。三档互不重叠，相加等于改动前那个未识别总数；把缺口和刻意不映射混成一个数，会让人误以为已经看过了全部事实。分桶是采集期推导的结论，口径版本记在 `unknownDispositionRulesVersion`；上一轮报告是旧口径（例如 `agent-collection-v1`）时，旧计数不再沿用，本轮按全量重新采集并如实写进 `limitations`，磁盘上的旧文件被整份覆盖而不是逐字段迁移，`extract` 也会直接拒绝旧口径报告，不拿旧计数继续提炼。

两点是刻意设计。探测不执行被探测的二进制——安装情况只由文件系统和 `PATH` 推断，一次清单运行不可能触发第三方代码。采集不移动、不截断、不删除你自己的日志：原始文件留在原地继续作为证据，派生内容一律写在 OMK 侧。单轮容量上限（文件数、字节数、单文件字节数）是硬约束而不是建议；命中上限时本轮干净收尾，并在 `limitations` 里说明截断了什么，被截断的计数不会被当作全量。

登记表扩展文件的边界与内置表一致：字段只有产品名与相对主目录的路径，没有绝对路径字段，也没有任何执行能力；文件不存在就是「没有扩展条目」，但存在却读不动、JSON 畸形或路径越出主目录都会直接报错退出。半份登记表会让清单静默少一个宿主，因此这里选择失败而不是继续。

`omk studio` 的 Agents 页（`/agents`）读的就是这两份报告：装了哪些 Agent、它们的日志落在哪个目录、采集了多少会话与事件、未识别记录分成哪三档，以及哪些计数被容量上限截断。页面不重新扫描这台机器，也没有采集或提炼按钮——那两步仍是你在终端里执行的命令，刷新页面改变不了证据。

## `omk evolve`

```bash
omk evolve <skill>                  # 多轮自动迭代 skill
omk evolve skills/foo.md --rounds 10 --target 4.5
```

<!-- omk:cli:evolve:flags:start -->

**Flags:**

```text
  --concurrency <value>           评测并发数，默认 1
  --edit-budget <value>           单轮最多改动的 skill 行占比（默认 0.2）。超预算的候选评测前直接判拒，省 eval 成本
  --effort <value>                reasoning effort: low/medium/high/xhigh/max
  --executor <value>              执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
  --improve-mode <agent|rewrite>  改写策略（默认：agent）
  --improve-model <value>         负责重写 skill 的 LLM，默认沿用被测模型
  --judge-models <value>          评委 model（单评委约束），格式 executor:model。默认跟随所选执行器；Codex 沿用被测模型。
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --model <value>                 被评测的 LLM。Codex 自动读取本机配置；无用例时也用作自动生成用例的出题模型。
  --no-edit-budget                关掉 edit budget 约束（允许任意大小的单轮改动）
  --no-reject-memory              关掉 rejected-edit 记忆（不把被拒改法回灌下一轮 prompt）
  --rounds <value>                最大迭代轮数，默认 5
  --samples <value>               指定已有样本源；省略时先找 skill 私有样本，再找项目样本，都不存在时自动生成
  --skip-doctor                   跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）
  --snapshot-only                 只产候选、不写回 source：胜出版本留在 evolve/，再由你人工选择。默认仅在最终 Core 门禁通过后写回 source。
  --target <value>                目标 composite 分数，达到即停。不传则跑满 rounds
  --timeout <value>               单用例超时秒，默认 600
```

完整描述见 `omk evolve --help`。

<!-- omk:cli:evolve:flags:end -->

让 skill 跑 eval → judge → 改写 SKILL.md 的多轮闭环，直到达到 `--target` 或 `--rounds` 上限。耗时按 `轮数 × 用例 × 变体` 累加，几分钟到几十分钟级别。原始 skill 文件版本保存在 `skills/evolve/*.r0.md`。

CLI 完成摘要展示整次 evolve 的过程总成本，包括改写、可选的用例修复，以及候选选择期间实际执行的全部评测。合并后的 evolve 报告中，`meta.totalCostUSD` 有意采用更窄口径，只表示保留轮次结果所承载的评测成本；端到端总额另存于 `meta.evolve.processCostUSD`。对应的 `*CostReported` 为 `false` 时，该数值只是已上报成本的下界。

`omk evolve` 是一键闭环：每轮迭代前默认先跑 doctor 体检（`--skip-doctor` 可跳过）；**若目标 skill 还没有评测用例，会自动调用样本生成器先生成一批**（等价于先跑一遍 `omk sample`），随后进入自迭代。因此对一个全新 skill 直接 `omk evolve skills/foo.md` 即可走完「体检 → 生成用例 → 自迭代」。已有用例则原样使用，不重复生成。

`--snapshot-only` 不写回源文件，胜出版本保留在 `evolve/`，供你核对后手动应用。

## `omk sample`

```bash
omk sample <skill>                  # 为单个 skill 生成或补齐评测用例
omk sample --batch                  # 为目录下缺评测集的 skill 批量生成
```

<!-- omk:cli:sample:flags:start -->

**Flags:**

```text
  --append                    在已有用例文件上追加新生成的用例（撞 sampleId 自动加后缀去重，保留原 json/yaml 格式）。仅单 skill 模式，不支持 --batch / --from-traces。不传则已有文件时报错保护。常配 --focus 补特定场景。
  --batch                     批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。
  --count <value>             生成用例条数。不传由 LLM 按 skill 类型自动决定。
  --executor <value>          执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
  --focus <value>             生成焦点（自然语言提示）。控制 LLM 偏向哪类用例。
  --from-traces               from-traces 模式：从 observe inbox 的失败信号回流生成评测用例草稿（provenance: production-trace），落草稿待人工 review。
  --lang <value>              输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --model <value>             生成 LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。
  --no-mock                   不生成 mocks。执行器不支持工具拦截时会自动启用，避免产生必然失败的 mock_hit。
  --observations-dir <value>  observe inbox 目录（from-traces 模式用），默认项目 .omk/observe/inbox。
  --skill <value>             仅从指定 skill 的 observe inbox 信号生成草稿（仅 from-traces 模式用）。
  --skill-dir <value>         skill 根目录，默认 skills。batch 模式扫此目录。
```

完整描述见 `omk sample --help`。

<!-- omk:cli:sample:flags:end -->

一次性生成。自动给生成的用例打 `provenance`。生成的 assertions 使用英文 / 数字 / 代码 token，便于跨中英文输出对比。

## `omk studio`

```bash
omk studio
omk studio --port 7799
omk studio --host 0.0.0.0                          # 局域网访问（默认 127.0.0.1）
omk studio --reports-dir ~/.oh-my-knowledge/eval
omk studio --observations-dir .omk/observe/inbox    # observe inbox 数据目录
omk studio --no-open
```

<!-- omk:cli:studio:flags:start -->

**Flags:**

```text
  --agents-dir <value>        本机 Agent 识别／采集报告目录（可选，默认全局 ~/.oh-my-knowledge/observe/agents，即 `omk agents` 的落点）
  --analyses-dir <value>      观测健康报告目录（可选，默认项目级 .omk/observe/health，空则全局兜底）
  --dev                       dev 模式：子进程启动 + 热更新
  --doctors-dir <value>       体检报告目录（可选，默认项目级 .omk/doctor，空则全局兜底）
  --global                    只看全局 eval / observe/health / doctor / observe/inbox 目录（~/.oh-my-knowledge/），而非机器级聚合 / 项目优先
  --host <value>              监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网
  --lang <value>              输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
  --no-open                   不自动打开浏览器
  --observations-dir <value>  观测收件箱数据目录（可选，默认 .omk/observe/inbox）
  --port <value>              监听端口，默认 7799。传 0 让 OS 分配
  --reports-dir <value>       只看指定 Core 报告目录（可选；默认聚合当前项目 + 全局）
```

完整描述见 `omk studio --help`。

<!-- omk:cli:studio:flags:end -->

启动本地知识工作台。首页直接索引本机 Codex 对话，进行中的对话优先展示；选择对话和任务后，可在四条泳道中查看任务轨迹，并在语义轨迹、知识访问、标准化事件与原始记录之间相互核对。进行中的任务支持实时跟随，旧的未闭合任务会显示为「未记录结束状态」。这条浏览路径不要求先运行 `omk observe ingest`。

一级导航为「观测 → 评测 → 知识」，页面路径对应 `/observe`、`/measure`、`/knowledge`。观测展示对话与任务轨迹，评测展示 Core 测量结果，知识展示知识健康度与管理记录。访问 `/observe/inbox` 可查看观测审阅队列。旧页面地址不再提供服务。CI gate 使用 `omk eval` 的退出码，自动化应读取 Core report 产物。
