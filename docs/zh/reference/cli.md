# omk CLI 参考

omk 的公开 CLI 由顶层命令构成完整闭环：`init`（初始化一个 omk 项目）·`install`（安装 omk 官方 Agent Skill）·`list`（受管 skill 与证据状态）·`promote`（按证据接受版本）·`rollback`（撤销一次 promote）·`doctor`（健康度体检）·`eval`（离线 A/B 评测）·`observe`（线上 trace 观测）·`evolve`（多轮自动迭代 skill）·`sample`（生成或补齐评测用例）·`studio`（浏览本机对话、任务轨迹与知识载体报告）。

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

在目标目录初始化一个 **omk 项目**：待测知识载体（今天是 `skills/<name>/SKILL.md`）+ 它们的评测用例（`eval-samples.json`）—— 这是 `omk eval` / `doctor` / `evolve` / `observe` / `list` 共同操作的「每目录工作区」。跟 git 仓库一样，一个测量目标一个项目（用例集就是测量上下文，随载体走、不全局共享）。受管登记表（`install` / `list` / `promote`，可全局）是另一层，不归 `init` 管。现有两版 skill + 三条用例只是默认的 A/B 起步模板。

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

安装**用户自己的** skill（本地路径或 git 源）时，除分发外还会写一条**受管记录**到 `.omk/governance/managed/<id>.json` —— 这是「管理」支柱的入口，让证据随 artifact 一起走过 doctor / eval / promote。`git:` 源的可复现性最强：SHA 不可变、内容寻址可核验，分支则给真实漂移语义。

默认 `auto` 只写入本机已检测到、且 omk 明确支持的目标：检测到 `~/.codex` 或 `~/.agents` 时写入 Codex/AGENTS，检测到 `~/.claude` 时写入 Claude Code。要强制写入当前 omk 已知的全部目标，用 `--to all`；要指定自定义 skill 根目录，用 `--dest`。

## `omk list`

```bash
omk list                 # 当前项目的受管 skill（.omk/governance/managed）
omk list --global        # 全局受管 skill（~/.oh-my-knowledge/governance/managed）
omk list --json          # 机器可读输出，含完整可比性 marker
```

<!-- omk:cli:list:flags:start -->

**Flags:**

```text
  --global        看全局受管目录（~/.oh-my-knowledge/governance/managed）而非项目 .omk/governance/managed
  --json          输出 JSON（含完整可比性 marker），供脚本消费
  --lang <value>  输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
```

完整描述见 `omk list --help`。

<!-- omk:cli:list:flags:end -->

列出受管 skill 的**证据状态**，而非只列文件：生命周期状态、绑定当前内容的最新 verdict、当前/全部证据数、源。生命周期读时推导 —— `installed`（无有效证据）、`measurable`（eval 证据绑定到当前内容指纹）、`promoted`（当前内容有人工接受决定）、`stale`（源内容漂移、脱离证据）。因为指纹覆盖目录-skill 整棵树（`SKILL.md` + `references/`），改任一资产即把 skill 翻成 `stale`。`--json` 输出版本化信封 `{ schemaVersion, rows }`（有当前有效证据的行携带可比性 marker —— `cliVersion`，可选 `judgePromptHash` / `debiasMode`），让脚本能检测形态变更。参见[证据门控管理](../specs/evidence-gated-management.md)。

## `omk promote`

```bash
omk promote review                      # 证据过门禁则把当前版本接受为 promoted
omk promote review --accept-cautious    # 也接受 CAUTIOUS verdict
omk promote review --force --reason "已人工复核"   # 越门，记为人工决定
```

<!-- omk:cli:promote:flags:start -->

**Flags:**

```text
  --accept-cautious  把 CAUTIOUS 也算可接受（默认仅 PROGRESS）
  --actor <value>    决定的 actor（默认取 git config user.name）
  --force            越过可越门拦截强制 promote，记为人工 override 决定（无当前证据或源 hash 已变时仍拒）
  --global           操作全局受管目录而非项目 .omk/governance/managed
  --json             输出 JSON（版本化信封）供脚本消费
  --kind <value>     artifact 类型（当前仅 skill）
  --lang <value>     输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --reason <value>   promote / 越门的理由（写入决定）
```

完整描述见 `omk promote --help`。

<!-- omk:cli:promote:flags:end -->

把受管 skill 的当前版本按证据门禁接受为 `promoted`，并往记录里追加一条带证据指针的人工决定。门禁对最新一条**当前**证据判定（`contentHash` 与记录匹配）：源不能漂移/不可达、必须有当前证据（无证据即拦，`--force` 也无从锚定）、证据的 `judgePromptHash`（若有）须仍属当前评委模板、verdict 须为 `PROGRESS`（或加 `--accept-cautious` 接受 `CAUTIOUS`）。`--force` 必须配合非空 `--reason`，只可越过源不可达、不同比或 verdict 类拦截；不能越过缺当前证据，也不能越过源可达但内容 hash 已变的场景，因为 decision 仍会指向旧的受管基线。对已 promote 的当前版本重跑是幂等无操作。promote 是 `omk list` 的写侧对应。参见[证据门控管理](../specs/evidence-gated-management.md)。

## `omk rollback`

```bash
omk rollback review                          # 撤销当前版本的 promoted 接受
omk rollback review --reason "线上发现回归"   # 回退并记录理由
```

<!-- omk:cli:rollback:flags:start -->

**Flags:**

```text
  --actor <value>   决定的 actor（默认取 git config user.name）
  --global          操作全局受管目录而非项目 .omk/governance/managed
  --json            输出 JSON（版本化信封）供脚本消费
  --kind <value>    artifact 类型（当前仅 skill）
  --lang <value>    输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --reason <value>  回退的理由（写入决定）
```

完整描述见 `omk rollback --help`。

<!-- omk:cli:rollback:flags:end -->

回退受管 skill 当前版本的 `promoted` 接受，是 `omk promote` 的反操作。决定是 append-only 事件流，故 rollback 不删除原 promote，而是追加一条 `rollback` 决定；生命周期再按当前内容**最近一条** promote/rollback 决定推导，源未漂移则回到 `measurable`，源已漂移则仍为 `stale`（rollback 不探源）。rollback 是内容锚定的：只看 `record.contentHash` 上的 promote/rollback 历史，不设门禁（降级永远安全）。回退一个未 promoted 的版本以非零码退出（无可回退）；回退一个已回退的版本是幂等无操作；`promote → rollback → promote` 会恢复 `promoted`（latest-wins）。参见[证据门控管理](../specs/evidence-gated-management.md)。

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
  --lang <value>         输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
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
omk eval gold compare <run-id> --gold-dir gold-dataset
```

运行离线评测，应用 verdict gate，持久化报告，并用 exit code 表示 ship/no-ship。这个工作流默认开启 bootstrap CI。

<!-- omk:cli:eval:flags:start -->

**Flags:**

```text
  --batch                         batch 模式:baseline vs 每个 skill
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
  --executor <value>              执行器：claude / claude-sdk / codex / codex-sdk / anthropic-api / openai-api / 自定义命令。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
  --global                        报告写全局 ~/.oh-my-knowledge/eval，而非项目 .omk/eval
  --gold-dir <value>              gold dataset 目录
  --holdout-ratio <value>         留出比例 0-1（如 0.3）；切出 holdout 子集，对比 train/holdout 综合分检测过拟合
  --judge-models <value>          评委配置，格式 executor:model[,...]，例 claude:haiku 或 codex:<model>（≥ 2 个 = ensemble）。默认跟随所选执行器；Codex 沿用被测模型。
  --judge-repeat <value>          每个 dim 评 N 次
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --layered-stats                 输出分层统计
  --mcp-config <value>            MCP 配置文件路径
  --model <value>                 被测模型
  --no-cache                      跳过 executor cache
  --no-debias-length              关 length-debias（默认开）
  --no-diagnostic                 关闭基于 Core 失败、缺失、排除与稳定 reason code 的诊断投影。
  --no-evidence                   不把本次评测写成证据追加进受管记录(默认会为已 install 的 skill 自动写)。
  --no-gate                       关 verdict gate
  --no-judge                      跳过 LLM judge
  --no-serve                      不启 report server
  --no-strict-baseline            关闭 baseline 隔离
  --output-dir <value>            报告输出目录（默认项目级 .omk/eval）
  --repeat <value>                每个 sample 重复跑 N 次
  --report-only                   生成报告并打印 verdict，但始终 exit 0(不参与 CI gate）。
  --resume <value>                复用经过完整契约校验的 Core runId；拒绝时失败关闭
  --retry <value>                 失败 sample 重试次数
  --samples <value>               用例路径。自动发现项目级或单 treatment 目录 skill 下的 eval-samples.json / eval-samples.yaml；显式路径可为 JSON / YAML 文件或分片目录。
  --skill-dir <value>             skill 目录，默认 skills
  --skip-connectivity             跳 LLM 连通性预检
  --skip-doctor                   escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。
  --strict-baseline               强制 baseline 隔离（default true）
  --threshold <value>             verdict 阈值，默认 3.5
  --timeout <value>               单用例超时秒，默认 120
  --treatment <value>             treatment variant 列表，逗号分隔（仅 artifact 身份）
  --treatment-cwd <value>         treatment 的 runtime context 目录列表，逗号分隔、与 --treatment 按序对齐（空位 = 无 cwd）
  --trivial-diff <value>          可忽略 diff 容差，0 表示不启用容差
  --verbose                       详细日志
```

完整描述见 `omk eval --help`。

<!-- omk:cli:eval:flags:end -->

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
  --feedback            把生产健康观测反哺已纳管的同名 skill（--no-feedback 关闭）
  --from <value>        起始时间 ISO，优先级高于 --last
  --global              写全局 ~/.oh-my-knowledge/observe/health，而非项目 .omk/observe/health
  --kb <value>          知识库 root，启用 KB-aware 分析
  --lang <value>        输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
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

每条 observation 自带：

+ `confidence` 与 `attributionConfidence`：信号可信度 + skill 归因可信度，并列展示
+ `severityReasonCode`：判断为该 severity 的稳定结构化原因；人类可读说明由 CLI / studio 渲染时生成
+ `messageWindow`：前 3 条 / 触发点 / 后 3 条 message 上下文 + `resolutionAfter`（后续是否解决）
+ `evidence.{messageIndex,messageUuid,toolUseId}`：可反向回到原始 jsonl 的锚点

支持 trace 格式：Codex rollout JSONL（`.jsonl`）、Claude Code session JSONL（`.jsonl`）、OpenClaw session JSONL（`.jsonl`）、markdown 对话日志（`.log`）。

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
  --lang <value>                  输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --model <value>                 被评测的 LLM。Codex 自动读取本机配置；无用例时也用作自动生成用例的出题模型。
  --no-edit-budget                关掉 edit budget 约束（允许任意大小的单轮改动）
  --no-reject-memory              关掉 rejected-edit 记忆（不把被拒改法回灌下一轮 prompt）
  --rounds <value>                最大迭代轮数，默认 5
  --samples <value>               用例文件路径，默认 eval-samples.json
  --skip-doctor                   跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）
  --snapshot-only                 只产候选、不写回 source：胜出版本留在 evolve/，再由你人工选择。受管 skill 默认会写回 source 并记 Core 证据。
  --target <value>                目标 composite 分数，达到即停。不传则跑满 rounds
  --timeout <value>               单用例超时秒，默认 600
```

完整描述见 `omk evolve --help`。

<!-- omk:cli:evolve:flags:end -->

让 skill 跑 eval → judge → 改写 SKILL.md 的多轮闭环，直到达到 `--target` 或 `--rounds` 上限。耗时按 `轮数 × 用例 × 变体` 累加，几分钟到几十分钟级别。原始 skill 文件版本保存在 `skills/evolve/*.r0.md`。

CLI 完成摘要展示整次 evolve 的过程总成本，包括改写、可选的用例修复，以及候选选择期间实际执行的全部评测。合并后的 evolve 报告中，`meta.totalCostUSD` 有意采用更窄口径，只表示保留轮次结果所承载的评测成本；端到端总额另存于 `meta.evolve.processCostUSD`。对应的 `*CostReported` 为 `false` 时，该数值只是已上报成本的下界。

`omk evolve` 是一键闭环：每轮迭代前默认先跑 doctor 体检（`--skip-doctor` 可跳过）；**若目标 skill 还没有评测用例，会自动调用样本生成器先生成一批**（等价于先跑一遍 `omk sample`），随后进入自迭代。因此对一个全新 skill 直接 `omk evolve skills/foo.md` 即可走完「体检 → 生成用例 → 自迭代」。已有用例则原样使用，不重复生成。

对**受管** skill（经 `omk install` 登记过的）：evolve 成功跑完还会联动管理层 —— 把胜出版本记成证据、并把记录 re-baseline 到新内容，于是 `omk list` 显示为 `measurable` 而非 `stale`。升到 `promoted` 仍是另一步人工 `omk promote`（evolve 的统计接受门不是生产接受决定）。`--snapshot-only` 完全跳过写回 source —— 胜出版本留在 `evolve/` 供你查看应用，受管记录不动。

## `omk sample`

```bash
omk sample <skill>                  # 为单个 skill 生成或补齐评测用例
omk sample --batch                  # 为目录下缺评测集的 skill 批量生成
```

<!-- omk:cli:sample:flags:start -->

**Flags:**

```text
  --append                    在已有用例文件上追加新生成的用例（撞 sample_id 自动加后缀去重，保留原 json/yaml 格式）。仅单 skill 模式，不支持 --batch / --from-traces。不传则已有文件时报错保护。常配 --focus 补特定场景。
  --batch                     批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。
  --count <value>             生成用例条数。不传由 LLM 按 skill 类型自动决定。
  --executor <value>          执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
  --focus <value>             生成焦点（自然语言提示）。控制 LLM 偏向哪类用例。
  --from-traces               from-traces 模式：从 observe inbox 的失败信号回流生成评测用例草稿（provenance: production-trace），落草稿待人工 review。
  --lang <value>              输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
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
  --analyses-dir <value>      观测健康报告目录（可选，默认项目级 .omk/observe/health，空则全局兜底）
  --dev                       dev 模式：子进程启动 + 热更新
  --doctors-dir <value>       体检报告目录（可选，默认项目级 .omk/doctor，空则全局兜底）
  --global                    只看全局 eval / observe/health / doctor / observe/inbox 目录（~/.oh-my-knowledge/），而非机器级聚合 / 项目优先；governance/managed 不受影响
  --host <value>              监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网
  --lang <value>              输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
  --no-open                   不自动打开浏览器
  --observations-dir <value>  观测收件箱数据目录（可选，默认 .omk/observe/inbox）
  --port <value>              监听端口，默认 7799。传 0 让 OS 分配
  --reports-dir <value>       只看指定 Core 报告目录（可选；默认聚合当前项目 + 全局）
```

完整描述见 `omk studio --help`。

<!-- omk:cli:studio:flags:end -->

启动本地知识工作台。首页直接索引本机 Codex 对话，进行中的对话优先展示；选择对话和任务后，可在四条泳道中查看任务轨迹，并在语义轨迹、规范化事件与原始日志之间相互核对。进行中的任务支持实时跟随，旧的未闭合任务会显示为「未记录结束状态」。这条浏览路径不要求先运行 `omk observe ingest`。

顶部「知识载体」入口提供 doctor、Core eval 与 observe 视图。Core run 页面从已校验产物投影运行状态、evidence coverage、数值观测、Analysis result、Decision reason code 与 lineage。访问 `/observe-inbox` 可查看 observation reviewer 队列。CI gate 使用 `omk eval` 的 exit route，自动化应读取 Core report 产物。
