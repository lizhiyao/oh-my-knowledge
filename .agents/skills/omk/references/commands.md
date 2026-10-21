# omk 命令参考

<!-- omk:cli:start -->
<!-- 此段由 scripts/build/docs.ts 从 src/cli/commands/ 自动生成。
     改 CLI 后跑 `yarn build:docs` 同步,CI `yarn build:docs:check` 会拦截 drift。-->

## omk agents

识别本机已安装的 Agent，采集其日志并映射成统一格式，再提炼候选知识。

**用法:**

```bash
omk agents <operation> [flags]
```

**参数:**

- `operation`(必填):操作：list 识别安装情况，collect 采集日志并映射成统一 Trace IR，extract 从已采集日志提炼候选知识。

**Flags:**

- `--dir` `option`:清单与采集产物目录，默认全局 ~/.oh-my-knowledge/observe/agents。
- `--end-record` `option`:extract：最后一条记录序号，包含。
- `--executor` `option`:extract：生成执行器，沿用 OMK 运行配置。
- `--generation-policy` `option`:extract：完整生成策略 JSON；省略时仅调用一次。有界重试须明确调用及 token 预算，输出上限取自策略。
- `--json` `boolean`:输出完整 JSON；默认输出可读摘要。
- `--knowledge` `option`:extract：知识工作区，默认全局知识目录。
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--limit` `option`:collect 单轮处理的会话文件上限。
- `--model` `option`:extract：生成模型，沿用已配置模型。
- `--session` `option`:extract：采集报告里的 runId。
- `--start-record` `option`:extract：从零开始的非空记录序号，包含。

**示例:**

```bash
omk agents list
```

```bash
omk agents collect --limit 50
```

```bash
omk agents extract --session <runId> --executor codex --model <model>
```

```bash
omk agents extract --session <runId> --start-record 10 --end-record 30 --executor codex --model <model>
```

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
- `--global` `boolean`:写全局 ~/.oh-my-knowledge/doctor，而非项目 .omk/doctor
- `--json` `boolean`:JSON 输出到 stdout，适合 CI / 外部脚本消费。
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--model` `option`:LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。
- `--output-dir` `option`:报告输出目录，默认项目级 .omk/doctor（--global 写全局）。
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

跑评测：用一个对照组与多个实验组 skill 做对照试验，生成判定报告。

**用法:**

```bash
omk eval [flags]
```

**Flags:**

- `--batch` `boolean`:批量评测：baseline 作为对照组，逐个 skill 作为实验组；不支持 repeat 大于 1
- `--bootstrap` `boolean`:加 bootstrap CI
- `--bootstrap-samples` `option`:bootstrap 重采样次数，默认 1000
- `--budget-per-sample-ms` `option`:单用例时长上限 ms（必须 > 0，不传则无上限）
- `--budget-per-sample-usd` `option`:单用例预算上限 USD（必须 > 0，不传则无上限）
- `--budget-usd` `option`:总预算上限 USD（必须 > 0，不传则无上限）
- `--concurrency` `option`:并发数，默认 1
- `--config` `option`:eval.yaml 路径
- `--control` `option`:对照组（control）的 variant 表达式（仅 artifact 身份）
- `--control-cwd` `option`:对照组（control）的 runtime context 目录
- `--dry-run` `boolean`:只 plan 不实跑
- `--effort` `option`:被测 LLM 扩展思考预算 low/medium/high/xhigh/max（默认 low；跨 effort 报告不严格可比）。
- `--executor` `option`:执行器：codex / codex-sdk / openai-api / 自定义可执行文件路径（不接受带参数的命令字符串）。默认用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
- `--global` `boolean`:报告写全局 ~/.oh-my-knowledge/eval，而非项目 .omk/eval
- `--gold-dir` `option`:gold dataset 目录
- `--holdout-ratio` `option`:留出比例 0-1（如 0.3）；切出 holdout 子集，对比 train/holdout 综合分检测过拟合
- `--judge-models` `option`:评委配置，格式 executor:model[,...]，例 codex:<model> 或 openai-api:<model>（≥ 2 个 = ensemble）。默认沿用所选执行器与被测模型。
- `--judge-repeat` `option`:每个维度由评委评价 N 次
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--layered-stats` `boolean`:输出分层统计
- `--mcp-config` `option`:MCP 配置文件路径
- `--model` `option`:被测模型
- `--no-debias-length` `boolean`:关 length-debias（默认开）
- `--no-diagnostic` `boolean`:关闭基于 Core 失败、缺失、排除与稳定 reason code 的诊断投影。
- `--no-gate` `boolean`:关闭判定门禁
- `--no-judge` `boolean`:跳过 LLM 评委
- `--no-serve` `boolean`:不启 report server
- `--no-strict-baseline` `boolean`:关闭 baseline 隔离
- `--output-dir` `option`:报告输出目录（默认项目级 .omk/eval）
- `--repeat` `option`:预先固定 Evaluation Series 的独立 run 数
- `--report-only` `boolean`:生成报告并打印判定，但始终 exit 0(不参与 CI gate）。
- `--resume` `option`:复用经过完整契约校验的 Core runId；拒绝时失败关闭
- `--retry` `option`:单用例失败重试次数
- `--samples` `option`:用例路径。自动发现项目级或单个实验组（treatment）目录 skill 下的 eval-samples.json / eval-samples.yaml；显式路径可为 JSON / YAML 文件或分片目录。
- `--skill-dir` `option`:skill 目录，默认 skills
- `--skip-connectivity` `boolean`:跳 LLM 连通性预检
- `--skip-doctor` `boolean`:escape hatch:跳 doctor 健康检查门禁（默认强制启用）。沙箱 mock 提供依赖时绕开 doctor 物理路径误报；garbage-in 风险自负。
- `--strict-baseline` `boolean`:强制 baseline 隔离（default true）
- `--threshold` `option`:判定阈值，默认 3.5
- `--timeout` `option`:单用例超时秒，默认 120
- `--treatment` `option`:实验组（treatment）的 variant 列表，逗号分隔（仅 artifact 身份）
- `--treatment-cwd` `option`:实验组（treatment）的 runtime context 目录列表，逗号分隔、与 --treatment 按序对齐（空位 = 无 cwd）
- `--trivial-diff` `option`:可忽略 diff 容差，0 表示不启用容差
- `--verbose` `boolean`:详细日志

**示例:**

> 最简对照：baseline 作为对照组，my-skill 作为实验组

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

- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。

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
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--metric` `option`:显式选择 Core metric ID。
- `--minimum-alpha` `option`:可选的一致性阈值；按 Krippendorff α 置信区间下界评估
- `--reports-dir` `option`:只读取指定 Core 报告目录（默认当前项目 + 全局）
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
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
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

- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。

## omk eval task

从固定快照执行可信本地任务 A/B，采集产物并独立验收。

**用法:**

```bash
omk eval task <definition> [flags]
```

**参数:**

- `definition`(必填):本地任务 YAML／JSON 定义。

**Flags:**

- `--dry-run` `boolean`:预览封存计划，不执行任务。
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--output` `option` (默认 `.omk/eval`):报告输出目录。

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
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--model` `option`:被评测的 LLM。Codex 自动读取本机配置；无用例时也用作自动生成用例的出题模型。
- `--no-edit-budget` `boolean`:关掉 edit budget 约束（允许任意大小的单轮改动）
- `--no-reject-memory` `boolean`:关掉 rejected-edit 记忆（不把被拒改法回灌下一轮 prompt）
- `--rounds` `option` (默认 `5`):最大迭代轮数，默认 5
- `--samples` `option`:指定已有样本源；省略时先找 skill 私有样本，再找项目样本，都不存在时自动生成
- `--skip-doctor` `boolean`:跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）
- `--snapshot-only` `boolean`:只产候选、不写回 source：胜出版本留在 evolve/，再由你人工选择。默认仅在最终 Core 门禁通过后写回 source。
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

- `--force` `boolean`:允许覆盖目标目录中已有的 omk 脚手架文件
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--samples` `3|20` (默认 `3`):官方起步用例数量：3 条用于快速跑通，20 条用于达到默认启发式证据下限

**示例:**

> 在当前目录初始化一个 omk 项目

```bash
omk init
```

> 在指定目录初始化一个 omk 项目

```bash
omk init my-project
```

> 使用达到默认启发式证据下限的 20 条官方用例初始化

```bash
omk init my-project --samples 20
```

## omk install

安装 omk 官方 Agent Skill，或安装用户自己的 skill（内置 id omk-agent-skill，本地路径，或 git:<ref>:<name> 取当前仓库某个 ref 的 skill）。默认写入本机已检测 agent 目标。

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
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--to` `option` (默认 `auto`):安装目标：auto（默认，本机已检测目标） / codex / all。

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

> 安装用户自己的 skill（--kind 可省，命中 SKILL.md 自动推导）

```bash
omk install ./skills/review
```

> 从当前仓库某个 ref 安装 skill（可复现；SHA 不可变、分支会随 ref 漂移）

```bash
omk install git:main:skills/review
```

> 从远端 git 仓库安装 skill（位置参数是仓库内路径；认证用本机 git 凭证）

```bash
omk install --git-url https://github.com/org/repo.git --git-ref v1.0.0 skills/review
```

## omk observe

把 Codex、Claude Code、OpenClaw 或 markdown trace 统一为 Trace IR，分析 skill 调用健康度（默认行为）。子命令：ingest / inbox / show。

**用法:**

```bash
omk observe <sessionsDir> [flags]
```

**参数:**

- `sessionsDir`(必填):sessions 目录路径（如 ~/.codex/sessions 或 ~/.claude/projects/<project>）

**Flags:**

- `--from` `option`:起始时间 ISO，优先级高于 --last
- `--global` `boolean`:写全局 ~/.oh-my-knowledge/observe/health，而非项目 .omk/observe/health
- `--kb` `option`:知识库 root，启用 KB-aware 分析
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--last` `option`:时间窗(7d / 24h / 30m）
- `--output-dir` `option`:健康报告输出目录，默认项目级 .omk/observe/health（--global 写全局）
- `--skills` `option`:只看指定 skill，逗号分隔
- `--to` `option`:结束时间 ISO

**示例:**

> 分析最近 7 天的 Codex rollout

```bash
omk observe ~/.codex/sessions --last 7d
```

## omk observe entity-links

跨窗口核对实体关联：本地预览、明确确认一次调用，再由人工接受或拒绝。 先核对实体范围：Issue／PR 概念可以是实体，具体 Issue／PR 工作记录仅保留在来源或案例上下文。若选中了具体记录，先回到来源实体修订中纠正，并在知识上下文保留编号和链接；不要通过组织或改名将它变成概念。确认是同一对象，不代表应纳入实体目录；其他有来源依据的具体实例仍可保留。

**用法:**

```bash
omk observe entity-links <operation> [flags]
```

**参数:**

- `operation`(必填):candidates 本地召回；preview 冻结内容与配置；propose 明确调用；quality 零调用聚合；accept-preview 零调用展示证据替换；terminate 人工终止已启动执行；其余读取、人审或零调用恢复。

**Flags:**

- `--analysis` `option`:左侧实体分析 UUID；candidates／preview 必填。
- `--cancel-before-start` `boolean`:resume：明确取消尚未 started 的 prepared 计划，释放预约；须 request-id、generation 和 reason。
- `--confirm-identity` `boolean`:accept 必填：人工核对后确认两侧所指同一对象，不以模型判断代替。
- `--confirm-input` `option`:propose：人工核对内容、模型和 endpoint 后，显式填写计划顶层 confirmedDigest（含工作区）。
- `--confirm-replacement` `option`:accept：独立核对 accept-preview 的旧／新证据后，明确填写该预览 confirmationDigest；理由、名称或 head 变化须重新预览。
- `--entity` `option`:左侧实体 UUID；原实体身份保持不变。
- `--execution-id` `option`:terminate：show 中原执行的 executionId；仅终止这一已启动执行。
- `--executor` `openai-api|codex`:preview：执行器；API 已具备容量证明，Codex 尚不允许启动。
- `--generation` `option`:accept／reject／terminate／取消 prepared：show 读取的 generation。
- `--id` `option`:show／accept／reject／resume／terminate：稳定 review UUID。
- `--input` `option`:preview：核对已有计划；propose：读取 preview --json 导出的同一普通 JSON 文件，最多 2 MiB。
- `--json` `boolean`:输出完整机器 JSON；preview 的 JSON 可保存为 propose 计划。
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--mention` `option`:preview：选中的左侧 mention UUID，可重复传旗标；省略时选该实体全部提及。
- `--model` `option`:preview：明确模型，未提供时使用同执行器的已配置模型。
- `--object-label` `option`:accept：新组织对象的完整名称，最多 256 字符；不截断原实体名。
- `--owner-id` `option`:terminate：show 中原执行的 ownerId；不能用当前 PID 代替。
- `--reason` `option`:accept／reject／terminate／取消 prepared：明确人工理由。
- `--recover-unknown` `boolean`:resume：仅在可信本机 owner 已退出时明确记录 unknown，不退款、不重新调用。
- `--request-id` `option`:accept／reject／terminate／resume 的明确恢复或取消：稳定操作 UUID，重放沿用原值。
- `--retry-of` `option`:preview：明确核对过的旧 review UUID；失败或未知后重新确认调用时必填。
- `--right-analysis` `option`:preview：右侧分析 UUID。
- `--right-entity` `option`:preview：右侧实体 UUID。
- `--right-mention` `option`:preview：选中的右侧 mention UUID，可重复传旗标。
- `--start-prepared` `boolean`:propose：先 show 核对后，明确继续已持久 prepared 的同一次调用；已 started 时无效。
- `--workspace` `option`:知识工作区；terminate 必填；propose 默认沿用计划中的绝对目录，不得覆盖为其它目录。

**示例:**

```bash
omk observe entity-links candidates --workspace ./knowledge --analysis <analysis-id> --entity <entity-id>
```

```bash
omk observe entity-links preview --workspace ./knowledge --analysis <left-analysis> --entity <left-entity> --right-analysis <right-analysis> --right-entity <right-entity> --executor openai-api --model <model> --json
```

```bash
omk observe entity-links preview --input ./link-plan.json
```

```bash
omk observe entity-links propose --input ./link-plan.json --confirm-input <confirmedDigest> --json
```

```bash
omk observe entity-links show --workspace ./knowledge --id <review-id> --json
```

```bash
omk observe entity-links quality --workspace ./knowledge --json
```

```bash
omk observe entity-links accept-preview --workspace ./knowledge --id <review-id> --generation <generation> --reason "已核对两侧原文与身份" --json
```

```bash
omk observe entity-links accept --workspace ./knowledge --id <review-id> --request-id <request-id> --generation <generation> --reason "已核对两侧原文与身份" --confirm-identity
```

```bash
omk observe entity-links reject --workspace ./knowledge --id <review-id> --request-id <request-id> --generation <generation> --reason "证据不足"
```

```bash
omk observe entity-links resume --workspace ./knowledge --id <review-id>
```

```bash
omk observe entity-links terminate --workspace ./knowledge --id <review-id> --request-id <request-id> --generation <generation> --execution-id <execution-id> --owner-id <owner-id> --reason "人工核对后终止卡住的执行，不退款" --json
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
- `--global` `boolean`:直接读取全局 ~/.oh-my-knowledge/observe/inbox（跳过项目级与兜底）。
- `--include-noise` `boolean`:explore 时也包含 noise 桶
- `--input-dir` `option`:inbox 数据目录，默认 .omk/observe/inbox（项目级，相对于 cwd）；目录不存在时兜底读 ~/.oh-my-knowledge/observe/inbox。
- `--json` `boolean`:JSON 格式输出（schemaVersion: 1，kind 标识查询、聚合或增强复盘）
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
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

- `--global` `boolean`:写入全局 ~/.oh-my-knowledge/observe/inbox，而非项目 .omk/observe/inbox。
- `--json` `boolean`:把完整 observation inbox 报告输出到 stdout；默认只输出摘要。
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--output-dir` `option`:输出目录，默认 .omk/observe/inbox（项目级，相对于 cwd；--global 写全局）。

## omk observe knowledge

从选定工作日志提炼、核对和维护候选知识。 先核对实体范围：Issue／PR 概念可以是实体，具体 Issue／PR 工作记录仅保留在来源或案例上下文。若选中了具体记录，先回到来源实体修订中纠正，并在知识上下文保留编号和链接；不要通过组织或改名将它变成概念。确认是同一对象，不代表应纳入实体目录；其他有来源依据的具体实例仍可保留。

**用法:**

```bash
omk observe knowledge <operation> [flags]
```

**参数:**

- `operation`(必填):schema 导出响应协议；study 零调用核对可携带研究证据与复核记录；seal-run 人工封存，sealed-runs 查询封存及精确证据身份；归档、提炼、核对与维护知识；quality 查看结构接纳统计；entities 核对实体，correct-entities 纠正实体，apply-entities 创建绑定实体的知识修订。

**Flags:**

- `--analysis` `option`:entities：读取指定分析，省略时检索工作区实体；纠正或应用时必填，与提炼运行身份一致。
- `--author-review` `option`:study：输出前作者参考复核 JSON 文件。
- `--citations` `option`:revise／apply-entities：同一归档窗口的引用定位器 JSON 文件，提供完整非空数组以替换新修订的全部引用；省略时沿用适用的原引用。selection 含 evidenceRef、精确 quote 和可选的零基 occurrence；重复原文必须指定 occurrence。
- `--end-record` `option`:最后一条记录序号，包含。
- `--entity-revision` `option`:实体分析的明确修订身份；纠正或应用时必填。
- `--evidence` `option`:study：仓内研究工具导出的 evidence.json，只读重算原始证据；所有输入合计最多 128 MiB，不读取知识工作区。
- `--executor` `option`:generate：生成执行器；只有该操作发送选定片段并调用模型。
- `--generation` `option`:修改前读取的 generation，用于检测并发冲突。
- `--generation-policy` `option`:generate：完整生成策略 JSON；省略时仅调用一次。有界重试须明确模型、调用及 token 预算，输出上限取自策略。
- `--id` `option`:知识身份；resume／seal-run／sealed-runs 时为运行 UUID。
- `--identity-status` `all|proposed|unresolved`:entities：筛选身份对应状态。
- `--identity-uncertainties` `option`:apply-entities：显式核对后的附加身份不确定性 JSON 数组；省略时保留原说明，[] 清除原说明，当前实体歧义仍自动保留。
- `--input` `option`:revise／apply-entities：知识 JSON 草稿；correct-entities：entities、mentions 草稿，新身份使用 new: 前缀。
- `--inventory-digest` `option`:seal-run：sealed-runs 预先查询的精确归档清单 SHA-256。
- `--json` `boolean`:输出完整 JSON；默认输出可读摘要，schema 默认仅输出 JSON Schema。
- `--judge-review` `option`:study：带版本身份和独立用量声明的模型评委 JSON 文件，与人工判断比较；不执行评委。
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--manifest-digest` `option`:seal-run：sealed-runs 预先查询的原 manifest SHA-256。
- `--model` `option`:生成模型，沿用已配置模型。
- `--offline` `boolean`:seal-run：声明相关旧程序已停写／离线，不代表进程退出证明；opaque 封存必填。
- `--operation-id` `option`:seal-run：稳定的人工操作 UUID，重入必须复用。
- `--operator` `option`:seal-run：显式声明的人类操作者身份，不认证真人。
- `--output-review` `option`:study：绑定实际输出的逐项复核 JSON 文件；AI 探索不代表独立真人通过。
- `--page` `option`:entities：检索页码，从 1 开始。
- `--page-size` `option`:entities：每页对象数，默认 20，最多 100。
- `--query` `option`:entities：搜索名称、原文提及、限定条件及来源。
- `--reason` `option`:维护、修订或 seal-run 人工封存的理由；保留不代表已证实，纠正实体不自动改写知识，封存只记录人工处置。
- `--reference-review` `option`:study：输出前独立真人参考复核 JSON 文件，缺失时不产生 goldReady。
- `--revision` `option`:查看或处理的明确修订身份。
- `--run-id` `option`:generate：稳定 UUID；重复请求只恢复已归档结果，不再次调用模型。
- `--snapshot` `option`:generate／source／delete-source：归档身份。
- `--source` `option`:capture：一份已支持格式的 Agent 会话日志（Codex／Claude／Qoder 等）。
- `--source-status` `all|available|unavailable`:entities：筛选原文可用状态。
- `--start-record` `option`:从零开始的非空记录序号，包含。
- `--storage-namespace` `current|legacy`:封存／查询 current extraction-runs/ 或明确选择的 legacy runs/，默认 current。
- `--workspace` `option`:本地知识工作区，默认使用全局设置；seal-run／sealed-runs 必须显式提供且不读全局设置。CLI 与 Studio 共用。

**示例:**

```bash
omk observe knowledge schema --json
```

```bash
omk observe knowledge sealed-runs --workspace ./knowledge --id <run-id> --json
```

```bash
omk observe knowledge seal-run --workspace ./knowledge --id <run-id> --operation-id <uuid> --operator <human-id> --reason "reviewed offline disposition" --manifest-digest sha256:<digest> --inventory-digest sha256:<digest> --offline --json
```

```bash
omk observe knowledge study --evidence ./evidence.json --json
```

```bash
omk observe knowledge study --evidence ./evidence.json --author-review ./reference-author.json --reference-review ./reference-independent.json --output-review ./output-review.json --judge-review ./judge-review.json
```

```bash
omk observe knowledge capture --workspace ./knowledge --source ./session.jsonl
```

```bash
omk observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model>
```

```bash
omk observe knowledge list --workspace ./knowledge
```

```bash
omk observe knowledge quality --workspace ./knowledge --json
```

```bash
omk observe knowledge entities --workspace ./knowledge --analysis <run-id>
```

```bash
omk observe knowledge entities --workspace ./knowledge --query Atlas --json
```

```bash
omk observe knowledge show --workspace ./knowledge --id <knowledge-id> --json
```

```bash
omk observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --reason "已核对来源与适用条件"
```

```bash
omk observe knowledge correct-entities --workspace ./knowledge --analysis <run-id> --entity-revision <entity-revision-id> --generation 1 --input ./entities.json --reason "纠正身份对应"
```

```bash
omk observe knowledge apply-entities --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --analysis <run-id> --entity-revision <entity-revision-id> --input ./knowledge.json --reason "显式应用已核对实体"
```

```bash
omk observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --input ./knowledge.json --citations ./citations.json --reason "逐项核对并替换引用"
```

```bash
omk observe knowledge resume --workspace ./knowledge --id <run-id>
```

## omk observe show

展开 observation inbox 中某条 item 的详情。

**用法:**

```bash
omk observe show <inboxId> [flags]
```

**参数:**

- `inboxId`(必填):inbox item ID。

**Flags:**

- `--global` `boolean`:直接读取全局 ~/.oh-my-knowledge/observe/inbox（跳过项目级与兜底）。
- `--input-dir` `option`:inbox 数据目录
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。

## omk sample

为指定 skill 生成评测用例，支持 batch、single 与 from-traces 模式。

**用法:**

```bash
omk sample [skillPath] [flags]
```

**参数:**

- `skillPath`(可选):skill 文件路径或 SKILL.md 路径。batch 模式不需要；single 模式必填。

**Flags:**

- `--append` `boolean`:在已有用例文件上追加新生成的用例（撞 sampleId 自动加后缀去重，保留原 json/yaml 格式）。仅单 skill 模式，不支持 --batch / --from-traces。不传则已有文件时报错保护。常配 --focus 补特定场景。
- `--batch` `boolean`:批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。
- `--count` `option`:生成用例条数。不传由 LLM 按 skill 类型自动决定。
- `--executor` `option`:执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。
- `--focus` `option`:生成焦点（自然语言提示）。控制 LLM 偏向哪类用例。
- `--from-traces` `boolean`:from-traces 模式：从 observe inbox 的失败信号回流生成评测用例草稿（provenance: production-trace），落草稿待人工 review。
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--model` `option`:生成 LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。
- `--no-mock` `boolean`:不生成 mocks。执行器不支持工具拦截时会自动启用，避免产生必然失败的 mock_hit。
- `--observations-dir` `option`:observe inbox 目录（from-traces 模式用），默认项目 .omk/observe/inbox。
- `--skill` `option`:仅从指定 skill 的 observe inbox 信号生成草稿（仅 from-traces 模式用）。
- `--skill-dir` `option` (默认 `skills`):skill 根目录，默认 skills。batch 模式扫此目录。

**示例:**

> 为单个 skill 生成默认数量的用例

```bash
omk sample skills/my-skill/SKILL.md
```

> 批量为 skill 目录下所有缺 samples 的 skill 生成

```bash
omk sample --batch --skill-dir skills
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

- `--agents-dir` `option`:本机 Agent 识别／采集报告目录（可选，默认全局 ~/.oh-my-knowledge/observe/agents，即 `omk agents` 的落点）
- `--analyses-dir` `option`:观测健康报告目录（可选，默认项目级 .omk/observe/health，空则全局兜底）
- `--dev` `boolean`:dev 模式：子进程启动 + 热更新
- `--doctors-dir` `option`:体检报告目录（可选，默认项目级 .omk/doctor，空则全局兜底）
- `--global` `boolean`:只看全局 eval / observe/health / doctor / observe/inbox 目录（~/.oh-my-knowledge/），而非机器级聚合 / 项目优先
- `--host` `option`:监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网
- `--lang` `option`:输出语言 zh|en，优先级 CLI > OMK_LANG env > 全局设置 > 系统 locale > zh。
- `--no-open` `boolean`:不自动打开浏览器
- `--observations-dir` `option`:观测收件箱数据目录（可选，默认 .omk/observe/inbox）
- `--port` `option` (默认 `7799`):监听端口，默认 7799。传 0 让 OS 分配
- `--reports-dir` `option`:只看指定 Core 报告目录（可选；默认聚合当前项目 + 全局）

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

只使用 `omk.eval-sample-set/v3`；v2 不兼容，不自动改写旧文件。每个样本包含：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sampleId` | 是 | 唯一标识 |
| `input` | 是 | 文本、结构化 JSON 或消息历史；API 执行器支持 JSON 和普通角色历史；工具历史使用 custom-executor |
| `executionContext` | 否 | `cwd`、工具控制、mocks、题设 environment 和应用 `data` |
| `expected` | 否 | 仅供评分器使用的参考结果 |
| `evaluationContext` | 否 | `rubric`、`assertions`、评分 `reference`、结构化 `checks` |
| `annotations` | 否 | 来源、难度、能力、覆盖锚点和诱错标记 |

完整契约与能力边界见 [样本格式](https://github.com/lizhiyao/oh-my-knowledge/blob/main/docs/zh/reference/evaluation/eval-sample-format.md)。
