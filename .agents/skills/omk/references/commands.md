# omk 命令参考

<!-- omk:cli:start -->
<!-- 此段由 scripts/build-docs.ts 从 src/cli/commands/ 自动生成。
     改 CLI 后跑 `yarn build:docs` 同步,CI `yarn build:docs:check` 会拦截 drift。-->

## omk doctor

体检 omk 工作目录：先跑静态规则，再对 skill 做多维度 LLM 健康度审计（默认 --repeat 2 采样 + 共识归并）。

**用法:**

```bash
omk doctor [target] [flags]
```

**参数:**

- `target`(可选):要体检的 skill 路径或目录。可选，默认扫当前 cwd 下的 skills/。

**Flags:**

- `--concurrency` `option`:多次采样的并发数。默认 = --repeat（全并行，各遍相互独立，压墙钟时间）。设 1 = 串行。成本不变，只抬高瞬时并发（rate-limit 敏感时调小）。
- `--dimensions` `option`:自定义维度配置文件（YAML），追加到内置 7 维度之后。每条维度二选一：promptSection（走 LLM 体检）或 endpoint（POST skill 快照给接口判定）。注意：endpoint 会把 SKILL.md 全文 + 子文件发到该地址，仅对可信配置/可信地址启用。
- `--effort` `option`:LLM 推理 effort：low / medium / high / xhigh / max。
- `--executor` `option`:执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。指定为测试 fixture 路径可在测试里跑。
- `--fix` `boolean`:交互式修复：根据 doctor 报告问题，用 LLM agent 修复 skill。
- `--gate` `boolean`:静默模式，只在 fail 时输出 stderr 摘要，exit code 标识结果。
- `--global` `boolean`:写全局 ~/.oh-my-knowledge/doctors，而非项目 .omk/doctors
- `--json` `boolean`:JSON 输出到 stdout，适合 CI / 外部脚本消费。
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--model` `option`:LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。
- `--output-dir` `option`:报告输出目录，默认项目级 .omk/doctors（--global 写全局）。
- `--repeat` `option`:健康度体检重复采样次数（self-consistency）。默认 2：并行跑 2 遍、finding 取并集并用 LLM 聚类归并同根因、标注支持度 k/N，压低单次采样方差。设 1 = 单次快速体检（不采样、不归并，最省）。
- `--static-only` `boolean`:只跑静态检测（不调 LLM、不读 samples.json）：skill 可读性 / frontmatter 合法性 / 正文引用的脚本·CLI·文件·env 是否存在。CI 无 LLM 凭证或断网时用。
- `--timeout` `option`:单次 LLM 会话超时秒数，默认 600(10 分钟）。

**示例:**

> 默认模式跑静态规则 + LLM 健康度审计（7 内置维度）。

```bash
omk doctor
```

> 单次快速体检（不采样、不归并，最省）。

```bash
omk doctor --repeat 1
```

> 只跑静态检测（不调 LLM、不读 samples）：结构 + 正文依赖检查。

```bash
omk doctor --static-only
```

> JSON 输出 + 静默 gate，给 CI 抓 exit code 同时人看。

```bash
omk doctor --json --gate
```

## omk eval

跑评测：对一个 control vs 多个 treatment skill 做对照试验，产 verdict 报告。

**用法:**

```bash
omk eval [flags]
```

**Flags:**

- `--batch` `boolean`:batch 模式:baseline vs 每个 skill
- `--bootstrap` `boolean`:加 bootstrap CI
- `--bootstrap-samples` `option`:bootstrap 重采样次数，默认 1000
- `--budget-per-sample-ms` `option`:单 sample 时长上限 ms（必须 > 0，不传则无上限）
- `--budget-per-sample-usd` `option`:单 sample 预算上限 USD（必须 > 0，不传则无上限）
- `--budget-usd` `option`:总预算上限 USD（必须 > 0，不传则无上限）
- `--concurrency` `option`:并发数，默认 1
- `--config` `option`:eval.yaml 路径
- `--control` `option`:control variant 表达式（仅 artifact 身份）
- `--control-cwd` `option`:control 的 runtime context 目录
- `--dry-run` `boolean`:只 plan 不实跑
- `--effort` `option`:被测 LLM 扩展思考预算 low/medium/high/xhigh/max（默认 low；跨 effort 报告不严格可比）。
- `--executor` `option`:执行器：claude / claude-sdk / codex / codex-sdk / anthropic-api / openai-api / 自定义命令。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
- `--global` `boolean`:报告写全局 ~/.oh-my-knowledge/reports，而非项目 .omk/
- `--gold-dir` `option`:gold dataset 目录
- `--holdout-ratio` `option`:留出比例 0-1（如 0.3）；切出 holdout 子集，对比 train/holdout 综合分检测过拟合
- `--judge-models` `option`:评委配置，格式 executor:model[,...]，例 claude:haiku 或 codex:<model>（≥ 2 个 = ensemble）。默认跟随所选执行器；Codex 沿用被测模型。
- `--judge-repeat` `option`:每个 dim 评 N 次
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--layered-stats` `boolean`:输出分层统计
- `--mcp-config` `option`:MCP 配置文件路径
- `--model` `option`:被测模型
- `--no-cache` `boolean`:跳过 executor cache
- `--no-debias-length` `boolean`:关 length-debias（默认开）
- `--no-diagnostic` `boolean`:关闭基于 Core 失败、缺失、排除与稳定 reason code 的诊断投影。
- `--no-evidence` `boolean`:不把本次评测写成证据追加进受管记录(默认会为已 install 的 skill 自动写)。
- `--no-gate` `boolean`:关 verdict gate
- `--no-judge` `boolean`:跳过 LLM judge
- `--no-serve` `boolean`:不启 report server
- `--no-strict-baseline` `boolean`:关闭 baseline 隔离
- `--output-dir` `option`:报告输出目录（默认项目级 .omk/reports）
- `--repeat` `option`:每个 sample 重复跑 N 次
- `--report-only` `boolean`:生成报告并打印 verdict，但始终 exit 0(不参与 CI gate）。
- `--resume` `option`:复用经过完整契约校验的 Core runId；拒绝时失败关闭
- `--retry` `option`:失败 sample 重试次数
- `--samples` `option`:用例文件路径。默认项目级 eval-samples.json，也接受 .yaml/.yml；单 treatment 时可自动发现 <skill>/.omk/。
- `--skill-dir` `option`:skill 目录，默认 skills
- `--skip-connectivity` `boolean`:跳 LLM 连通性预检
- `--skip-doctor` `boolean`:escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。
- `--strict-baseline` `boolean`:强制 baseline 隔离（default true）
- `--threshold` `option`:verdict 阈值，默认 3.5
- `--timeout` `option`:单用例超时秒，默认 120
- `--treatment` `option`:treatment variant 列表，逗号分隔（仅 artifact 身份）
- `--treatment-cwd` `option`:treatment 的 runtime context 目录列表，逗号分隔、与 --treatment 按序对齐（空位 = 无 cwd）
- `--trivial-diff` `option`:可忽略 diff 容差，0 表示不启用容差
- `--verbose` `boolean`:详细日志

**示例:**

> 最简对照:baseline vs my-skill

```bash
omk eval --control baseline --treatment my-skill
```

> eval.yaml 驱动 + bootstrap CI

```bash
omk eval --config eval.yaml --bootstrap
```

## omk eval gold

管理 human-gold 标注集（init / validate / compare 三个子命令）。

**用法:**

```bash
omk eval gold [flags]
```

**Flags:**

- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

## omk eval gold compare

把一组 Core run 观测跟 gold dataset 对比，计算 bootstrap CI 后的 agreement。

**用法:**

```bash
omk eval gold compare <runId> [flags]
```

**参数:**

- `runId`(必填):Core run ID。

**Flags:**

- `--bootstrap-samples` `option`:bootstrap 重采样次数，默认 1000
- `--evaluator` `option`:显式选择 Core evaluator ID。
- `--gold-dir` `option`:gold dataset 目录，必填
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--metric` `option`:显式选择 Core metric ID。
- `--reports-dir` `option`:报告目录，默认 ~/.oh-my-knowledge/reports
- `--seed` `option`:bootstrap seed，可复现
- `--target` `option`:显式选择 Core target ID。
- `--trial-index` `option`:显式选择 trial index。

## omk eval gold init

初始化 gold dataset 目录（human-gold 标注集脚手架）。

**用法:**

```bash
omk eval gold init [flags]
```

**Flags:**

- `--annotator` `option`:标注者名，写入 metadata.yaml
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--out` `option` (默认 `./gold-dataset`):输出目录，默认 ./gold-dataset

## omk eval gold validate

校验 gold dataset 目录格式（annotations.yaml schema）。

**用法:**

```bash
omk eval gold validate <dir> [flags]
```

**参数:**

- `dir`(必填):gold dataset 目录。

**Flags:**

- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

## omk evolve

自动迭代改进 skill:多轮 eval + skill 重写，直到达到 --target 或耗尽 --rounds。

**用法:**

```bash
omk evolve <skillPath> [flags]
```

**参数:**

- `skillPath`(必填):skill 文件或 SKILL.md 路径。

**Flags:**

- `--concurrency` `option` (默认 `1`):评测并发数，默认 1
- `--edit-budget` `option` (默认 `0.2`):单轮最多改动的 skill 行占比（默认 0.2）。超预算的候选评测前直接判拒，省 eval 成本
- `--effort` `option`:reasoning effort: low/medium/high/xhigh/max
- `--executor` `option`:执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
- `--improve-mode` `agent|rewrite` (默认 `agent`):改写策略（默认：agent）
- `--improve-model` `option`:负责重写 skill 的 LLM，默认沿用被测模型
- `--judge-models` `option`:评委 model（单评委约束），格式 executor:model。默认跟随所选执行器；Codex 沿用被测模型。
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--model` `option`:被评测的 LLM。Codex 自动读取本机配置；无用例时也用作自动生成用例的出题模型。
- `--no-edit-budget` `boolean`:关掉 edit budget 约束（允许任意大小的单轮改动）
- `--no-reject-memory` `boolean`:关掉 rejected-edit 记忆（不把被拒改法回灌下一轮 prompt）
- `--rounds` `option` (默认 `5`):最大迭代轮数，默认 5
- `--samples` `option` (默认 `eval-samples.json`):用例文件路径，默认 eval-samples.json
- `--skip-doctor` `boolean`:跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）
- `--snapshot-only` `boolean`:只产候选、不写回 source：胜出版本留在 evolve/，再由你人工选择。受管 skill 默认会写回 source 并记 Core 证据。
- `--target` `option`:目标 composite 分数，达到即停。不传则跑满 rounds
- `--timeout` `option` (默认 `600`):单用例超时秒，默认 600

**示例:**

> 默认 5 轮迭代

```bash
omk evolve skills/my-skill/SKILL.md
```

> 指定目标分 + 自定义模型

```bash
omk evolve skills/my-skill/SKILL.md --target 4.5 --model opus --improve-model opus
```

## omk init

初始化一个 omk 项目：在目标目录铺好待测知识载体（skills/）与评测用例（eval-samples.json），供 omk eval / doctor / evolve / observe / list 操作。默认是两版 code-review skill 的 A/B 起步模板。

**用法:**

```bash
omk init [targetDir] [flags]
```

**参数:**

- `targetDir`(可选):初始化目标目录，默认当前目录（.）

**Flags:**

- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

**示例:**

> 在当前目录初始化一个 omk 项目

```bash
omk init
```

> 在指定目录初始化一个 omk 项目

```bash
omk init my-project
```

## omk install

安装 omk 官方 Agent Skill，或登记并分发用户自己的 skill（内置 id omk-agent-skill，本地路径，或 git:<ref>:<name> 取当前仓库某个 ref 的 skill）。默认写入本机已检测 agent 目标；安装用户 skill 时同时登记一条受管记录。

**用法:**

```bash
omk install <input> [flags]
```

**参数:**

- `input`(必填):要安装的知识输入：内置 id omk-agent-skill，本地 skill 路径（目录或 .md），或 git:<ref>:<name>（当前仓库某 ref 的 skill）。

**Flags:**

- `--dest` `option`:自定义 skill 根目录；skill 安装到 <dir>/<name>（内置 omk-agent-skill 为 <dir>/omk）。
- `--dry-run` `boolean`:只打印安装目标，不写文件。
- `--force` `boolean`:覆盖目标位置已存在的 skill。
- `--git-ref` `option`:远端 git 的 ref（分支 / tag / SHA），默认 HEAD。仅配合 --git-url 使用。
- `--git-url` `option`:远端 git 仓库 URL（https / ssh / git@host:path）。给了它时，位置参数当作仓库内 skill 路径（spec）。
- `--kind` `skill|prompt|agent|workflow`:用户 artifact 的 kind（对齐 Artifact.kind）。可省：命中 SKILL.md 自动推导，当前仅支持 skill。
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--to` `option` (默认 `auto`):安装目标：auto（默认，本机已检测目标） / codex / claude / all。

**示例:**

> 安装 omk 官方 Agent Skill 到默认本机目标

```bash
omk install omk-agent-skill
```

> 强制安装到当前 omk 已知的所有目标

```bash
omk install omk-agent-skill --to all
```

> 安装到自定义 skill 根目录

```bash
omk install omk-agent-skill --dest ~/.my-agent/skills
```

> 登记并分发用户自己的 skill（--kind 可省，命中 SKILL.md 自动推导）

```bash
omk install ./skills/review
```

> 从当前仓库某个 ref 安装 skill（可复现；SHA 不可变、分支会随 ref 漂移）

```bash
omk install git:main:skills/review
```

> 从远端 git 仓库安装 skill（位置参数是仓库内路径；认证用本机 git 凭证；记录钉实际 SHA）

```bash
omk install --git-url https://github.com/org/repo.git --git-ref v1.0.0 skills/review
```

## omk list

列出受管 skill 及其证据状态：生命周期（installed / measurable / promoted / stale）、最新 verdict、证据数、源。

**用法:**

```bash
omk list [flags]
```

**Flags:**

- `--global` `boolean`:看全局受管目录（~/.oh-my-knowledge/managed）而非项目 .omk/managed
- `--json` `boolean`:输出 JSON（含完整可比性 marker），供脚本消费
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

**示例:**

> 列出当前项目的受管 skill

```bash
omk list
```

> 列出全局受管 skill

```bash
omk list --global
```

> 机器可读 JSON 输出

```bash
omk list --json
```

## omk observe

把 Codex、Claude Code、OpenClaw 或 markdown trace 统一为 Trace IR，分析 skill 调用健康度（默认行为）。子命令：ingest / inbox / show。

**用法:**

```bash
omk observe [sessionsDir] [flags]
```

**参数:**

- `sessionsDir`(可选):sessions 目录路径（如 ~/.codex/sessions 或 ~/.claude/projects/<project>）

**Flags:**

- `--feedback` `boolean`:把生产健康观测反哺已纳管的同名 skill（--no-feedback 关闭）
- `--from` `option`:起始时间 ISO，优先级高于 --last
- `--global` `boolean`:写全局 ~/.oh-my-knowledge/observe-health，而非项目 .omk/observe-health
- `--kb` `option`:知识库 root，启用 KB-aware 分析
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--last` `option`:时间窗(7d / 24h / 30m）
- `--output-dir` `option`:健康报告输出目录，默认项目级 .omk/observe-health（--global 写全局）
- `--skills` `option`:只看指定 skill，逗号分隔
- `--to` `option`:结束时间 ISO

**示例:**

> 分析最近 7 天的 Codex rollout

```bash
omk observe ~/.codex/sessions --last 7d
```

## omk observe inbox

查询 observation inbox(skill 调用洞察）。

**用法:**

```bash
omk observe inbox [flags]
```

**Flags:**

- `--by-skill` `boolean`:按 skill 聚合输出
- `--executor` `option`:LLM 增强复盘使用的执行器。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
- `--explore` `option`:抽样 N 条 medium/low 长尾（replaces limit）
- `--global` `boolean`:直接读取全局 ~/.oh-my-knowledge/observe-inbox（跳过项目级与兜底）。
- `--include-noise` `boolean`:explore 时也包含 noise 桶
- `--input-dir` `option`:inbox 数据目录，默认 .omk/observe-inbox（项目级，相对于 cwd）；目录不存在时兜底读 ~/.oh-my-knowledge/observe-inbox。
- `--json` `boolean`:JSON 格式输出
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--limit` `option`:限制条数，默认 20
- `--llm-enhanced-review` `boolean`:显式调用模型进行链路增强复盘，包含标准抽取、目标判断、类型判断、产物匹配和 owner 建议
- `--model` `option`:LLM 增强复盘使用的模型。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。
- `--refresh` `boolean`:重新生成 LLM 增强复盘，不复用已有结果
- `--skill` `option`:只看指定 skill

## omk observe ingest

把 trace 目录 ingest 成 observation inbox 报告。

**用法:**

```bash
omk observe ingest <traceDir> [flags]
```

**参数:**

- `traceDir`(必填):trace 目录路径。

**Flags:**

- `--global` `boolean`:写入全局 ~/.oh-my-knowledge/observe-inbox，而非项目 .omk/observe-inbox。
- `--json` `boolean`:把完整 observation inbox 报告输出到 stdout；默认只输出摘要。
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--output-dir` `option`:输出目录，默认 .omk/observe-inbox（项目级，相对于 cwd；--global 写全局）。

## omk observe show

展开 observation inbox 中某条 item 的详情。

**用法:**

```bash
omk observe show <inboxId> [flags]
```

**参数:**

- `inboxId`(必填):inbox item ID。

**Flags:**

- `--global` `boolean`:直接读取全局 ~/.oh-my-knowledge/observe-inbox（跳过项目级与兜底）。
- `--input-dir` `option`:inbox 数据目录
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

## omk promote

把受管 skill 的当前版本按证据门禁「接受」为 promoted：默认仅放行 verdict=PROGRESS,在记录里追加一条带证据指针的人工决定。

**用法:**

```bash
omk promote <name> [flags]
```

**参数:**

- `name`(必填):受管 skill 名（omk list 里的 NAME）

**Flags:**

- `--accept-cautious` `boolean`:把 CAUTIOUS 也算可接受（默认仅 PROGRESS）
- `--actor` `option`:决定的 actor（默认取 git config user.name）
- `--force` `boolean`:越过可越门拦截强制 promote，记为人工 override 决定（无当前证据或源 hash 已变时仍拒）
- `--global` `boolean`:操作全局受管目录而非项目 .omk/managed
- `--json` `boolean`:输出 JSON（版本化信封）供脚本消费
- `--kind` `option` (默认 `skill`):artifact 类型（当前仅 skill）
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--reason` `option`:promote / 越门的理由（写入决定）

**示例:**

> promote 一个证据达标的 skill

```bash
omk promote review
```

> 接受 CAUTIOUS 结果（显式放宽门禁）

```bash
omk promote review --accept-cautious
```

> 越门 promote 并记录理由（人工 override）

```bash
omk promote review --force --reason "已人工复核"
```

## omk rollback

回退受管 skill 当前版本的 promoted 接受：撤销最近一次 promote，在记录里追加一条 rollback 决定（源未漂移则状态回到 measurable，源已漂移则仍 stale）。

**用法:**

```bash
omk rollback <name> [flags]
```

**参数:**

- `name`(必填):受管 skill 名（omk list 里的 NAME）

**Flags:**

- `--actor` `option`:决定的 actor（默认取 git config user.name）
- `--global` `boolean`:操作全局受管目录而非项目 .omk/managed
- `--json` `boolean`:输出 JSON（版本化信封）供脚本消费
- `--kind` `option` (默认 `skill`):artifact 类型（当前仅 skill）
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--reason` `option`:回退的理由（写入决定）

**示例:**

> 回退一个已 promoted 的 skill

```bash
omk rollback review
```

> 回退并记录理由

```bash
omk rollback review --reason "线上发现回归"
```

## omk sample

为指定 skill 生成评测用例（eval-samples），支持 batch / single / fix / from-traces 四种模式。

**用法:**

```bash
omk sample [skillPath] [flags]
```

**参数:**

- `skillPath`(可选):skill 文件路径或 SKILL.md 路径。batch 模式不需要；single / fix 模式必填。

**Flags:**

- `--append` `boolean`:在已有用例文件上追加新生成的用例（撞 sample_id 自动加后缀去重，保留原 json/yaml 格式）。仅单 skill 模式，不支持 --batch / --from-traces / --fix。不传则已有文件时报错保护。常配 --focus 补特定场景。
- `--batch` `boolean`:批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。
- `--count` `option`:生成用例条数。不传由 LLM 按 skill 类型自动决定。
- `--executor` `option`:执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
- `--fix` `boolean`:fix 模式：基于最近评测报告自动修复 sample_design 类型失败。
- `--focus` `option`:生成焦点（自然语言提示）。控制 LLM 偏向哪类用例。
- `--from-traces` `boolean`:from-traces 模式：从 observe inbox 的失败信号回流生成评测用例草稿（provenance: production-trace），落草稿待人工 review。
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--model` `option`:生成 LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。
- `--no-mock` `boolean`:不生成 mocks。执行器不支持工具拦截时会自动启用，避免产生必然失败的 mock_hit。
- `--observations-dir` `option`:observe inbox 目录（from-traces 模式用），默认项目 .omk/observe-inbox。
- `--reports-dir` `option`:报告目录（fix 模式用），默认 ~/.oh-my-knowledge/reports。
- `--skill` `option`:仅从指定 skill 的 observe inbox 信号生成草稿（仅 from-traces 模式用）。
- `--skill-dir` `option` (默认 `skills`):skill 根目录，默认 skills。batch 模式扫此目录。
- `--treatment` `option`:指定 treatment 名（fix 模式用），默认推断自 skill 路径。

**示例:**

> 为单个 skill 生成默认数量的用例

```bash
omk sample skills/my-skill/SKILL.md
```

> 批量为 skill 目录下所有缺 samples 的 skill 生成

```bash
omk sample --batch --skill-dir skills
```

> 根据最近评测报告自动修复 sample_design 类型失败

```bash
omk sample skills/my-skill/SKILL.md --fix
```

> 从 observe inbox 的失败信号回流生成评测用例草稿

```bash
omk sample --from-traces
```

## omk studio

启动 omk Studio 报告服务（skill-centric 仪表盘 + 浏览器自动打开）。

**用法:**

```bash
omk studio [flags]
```

**Flags:**

- `--analyses-dir` `option`:观测健康报告目录（可选，默认项目级 .omk/observe-health，空则全局兜底）
- `--dev` `boolean`:dev 模式：子进程启动 + 热更新
- `--doctors-dir` `option`:体检报告目录（可选，默认项目级 .omk/doctors，空则全局兜底）
- `--global` `boolean`:只看全局 reports / observe-health / doctors / observe-inbox 目录（~/.oh-my-knowledge/*），而非机器级聚合 / 项目优先；managed 不受影响
- `--host` `option`:监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--no-open` `boolean`:不自动打开浏览器
- `--observations-dir` `option`:观测收件箱数据目录（可选，默认 .omk/observe-inbox）
- `--port` `option` (默认 `7799`):监听端口，默认 7799。传 0 让 OS 分配
- `--reports-dir` `option`:只看指定报告目录（可选；默认机器级聚合：当前项目 + 全局 + 别项目索引）

**示例:**

> 默认端口 7799

```bash
omk studio
```

> 指定端口，不打开浏览器

```bash
omk studio --port 8080 --no-open
```
<!-- omk:cli:end -->

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
| `environment` | 否 | 题设环境声明（仅注入 prompt，不物化） |
| `tripwire` | 否 | 标记为「故意诱错」样本，failed 时 diagnostic 不建议改 skill |

完整 schema 见 [docs/specs/sample-design-spec.md](https://github.com/lizhiyao/oh-my-knowledge/blob/main/docs/specs/sample-design-spec.md)。
