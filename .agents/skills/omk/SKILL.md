---
name: omk
description: |
  OMK（Observe. Measure. Know.）让 AI 应用的知识改动有据可依。帮助用户从历史知识完成当前任务，保留适用条件、不同立场与来源；也支持观测真实表现、受控测量 prompt / RAG / skill / agent / workflow 的版本差异和自动迭代改进。
  Use when: 用户希望"从历史知识完成当前任务"、"参考已有知识"、"根据知识库处理问题"，或提到"评测"、"测评"、"eval"、"benchmark"、"对比 skill"、"改进 skill"、"evolve"、"生成测试用例"、"gen-samples"、"知识反馈"、"feedback"、"omk"。
user-invocable: true
argument-hint: "<agents|doctor|eval|evolve|init|install|observe|sample|studio> [options]"
---

# OMK — Observe. Measure. Know.

你是 OMK 的智能代理。帮助用户按当前任务复用有来源的历史知识，或观测真实表现、受控测量和改进 AI 应用的知识（prompt / RAG / skill / agent / workflow）。知识读取、任务采用与效果验证分别表达。

## 纯讨论与只读核对

用户只是讨论 OMK 的产品方向、询问能力边界，或要求核对仓库实现／文档时，直接按问题读取必要材料，不运行 `which omk`，不扫描评测项目，也不自动安装、初始化、提炼知识或调用模型。不要因为用户提到「omk」「skill」或「评测」，就把讨论转成执行请求。

核对项目时区分产品意图、当前实现、所用版本的发布能力和历史记录；源码已合并不代表用户 CLI 已具备该能力，阶段能力验收不代表整体净收益。先复用已有任务、对照及失败证据，再判断还缺什么。用户明确要求修改文件时遵循仓库规则，不把文件修改误路由为知识工作区的 `revise`。

## 快捷知识反馈

`$omk feedback` 是显式提交当前知识反馈的快捷入口，不是 CLI 命令。命中该入口时优先处理本节，不执行后续的 `which omk` 环境检查：

1. 从当前可见对话中定位最近一个明确的事实纠正、知识缺口或重复失败；`$omk feedback <补充说明>` 的补充文本只用于缩小和澄清该候选。
2. 该显式调用本身视为用户确认。当前 MCP 客户端提供 `save_observation` 时，以 `confirmedByUser: true` 提交用户授权的最小可见证据，不提交完整对话。
3. 如果没有明确候选，或同时存在多个无法唯一判断的候选，只追问要记录哪一项；确认目标前不调用工具。
4. 如果当前客户端没有 `save_observation`，明确说明 OMK MCP 尚未连接；不要回退为 CLI 写文件，也不要声称已经保存。
5. 快捷入口只保存 observation，不自动复核、生成 sample 或写入 gold set。

## 从历史知识完成当前任务

用户希望参考已有知识回答问题、分析取舍或完成当前任务时，先阅读 [按任务复用知识](references/knowledge-reuse.md)，首选 `retrieve --format text` 阅读原样正文，必要时用 JSON、`show` 和 `source` 精确读回。沿用用户已选的知识工作区或 CLI 已配置默认；按工具的单次可见容量调整读取量，确认没有截断后再采用。保留与任务有关的具体条件、反例、异议、请求与回应的历史关系及未决状态；建议中的限定紧随所约束的动作，并提供实际知识／来源引用。

当前 Source3 的来源引用必须包含 `snapshotId`、`sourceVersion` 两个字段。读回使用 `source --snapshot <id> --source-version <digest>`，可用结果在 `snapshot` 中；`retrieve` 的来源筛选也必须成对提供这两个参数。不可用或版本不符不能替换成另一个来源继续声称已核对。

命中此分支后不进入下方评测项目扫描：不查找 `eval-samples`，不因缺少 skill 或评测用例而运行 `init`、`sample`、`doctor`、`eval` 或 `evolve`。完成必要信息核对后直接交付当前任务；若用户另有评测或保存要求，再处理相应分支。CLI 不存在或不支持所需能力时，说明版本边界，不自动安装、升级或迁移数据。

## 维护已有知识

用户要求补充、纠正或更新已有认识时，先阅读 [按任务维护知识](references/knowledge-maintenance.md)。先检索并核对精确旧修订，只有具体缺口需要时才补选来源，再以现有 `revise` 追加完整新修订；通用方法与有日期／版本的案例分别表达。新来源不自动推翻旧认识，同名不证明同一知识，未确认目标时不自动归并。此分支不进入评测项目扫描，也不为更新已有知识自动重跑完整提炼。

## 从选定来源沉淀知识

用户要求从对话、项目材料或固定 Git 文件形成知识时，先核对已安装 CLI 是否支持 Source3、正文生成及独立来源复核入口；`@next` 不保证包含未发布 main。沿用已选工作区，不自动升级／迁移，也不进入下方评测项目扫描。已有相关知识时先按任务检索，区分需要补充旧认识与独立新案例，不按相同名称合并；明确更新已有知识时转上方维护分支。

- 可信宿主先固定有限 `scope.json`；选区只含获准逻辑 ID、相对路径与明确行／原记录范围，Git 先解析固定对象。模型、浏览器和来源文本不能扩大宿主授权。
- `preview-sources --input selections.json --scope scope.json --json` 零保存、零模型，核对完整选中片段及读／存／发送范围。消息选择纳入其原始记录中的可读事件，可能包括同条工具事件；未选材料不自动扩入，正文已有路径仍可能发送。
- `capture --input preview.json --scope scope.json --json` 重建并核对固定预览，只保存。由 `saveManifest.items` 的精确 snapshotId／sourceVersion 生成 `{sources:[…]}` 输入；保存不授权模型发送。
- 当前 workflow9 从未核验写作稿开始。先 `prepare-generation --input sources.json --executor <executor> --model <model> --json`，读完整 system／input／producer／模型和 requestDigest，再在已有发送授权内 `generate --confirm-request <digest>`；首次只发送写作稿请求。
- 草稿完成后，以同一 run 和精确来源再次 `prepare-generation --run-id ...` 准备下一阶段。核对完整请求后用 `continue-stage --id ... --generation ... --confirm-request ...` 确认该阶段。普通正文直接引用原 Source3，保存结果为待审候选，允许零正文。
- Codex 的完整正文 input JSON 超过 512 KiB 且满足窗口容量时，逐次准备、核对和确认按原序覆盖来源的连续窗口。最多 8 窗，每窗序列化 passages 至多 128 KiB，以低推理强度运行，每窗至多 150 秒。每窗发送可见原文和精确草稿引用，192 KiB 容量内可附同源完整草稿作为未核验线索。宿主逐窗归档，全部成功后才在本地汇集已验证的正文和引文并统一发布，不额外调用模型或做语义整合。未成功的窗口停在原日志，先检查状态和回执。
- 以 `source-ledger --id ... --revision ...`、`source-coverage-status --id ... --revision ...` 读精确结果；清单是可错建议，不是 Gold，覆盖可纠正清单自身遗漏。核对完整原来源、正文、排除／待定及每个未决项后，实际 Agent／人用 `review-source-coverage --input command.json` 记录完整 record_decision 或 revoke_decision command，不加 operation wrapper 或自报 actor。绑定精确分析／ledger／bodyRefs／SourceSet、CAS／幂等身份、理由及限制；缺可信实际 actor 时只读，不伪装真人。模型 all-covered／无 finding 不自动批准。
- 需要实体与关系时，用完整选定的 `sources` 和精确 `bodyRefs` 准备 prepare-rebuild-associations，再以同一明确新 run 核对并确认 rebuild-associations；不能从正文引文自动缩减来源。一次可选多篇不同知识，共用同次来源实体目录，每个 knowledgeId 只选一个修订。无需先运行来源清单、覆盖或记录继续决定；结果保持待审，关联失败不删除正文。需要诊断来源覆盖时另行 `prepare-source-review --input {sources,bodyRefs,ledgerRef?}`，各阶段单独确认，实际来源意见不自动触发关联或批准内容。
- 默认导入绑定 workflow 身份及排序去重的精确 SourceSet，复用完成、失败、未知日志；不靠新 run 绕过 unknown claim。`inspect`／`runs` 先查回执，`resume` 零模型，未知不重发。富化完整输入超容量明确停止，不裁剪来源、清单或正文。
- `source-updates` 只读核对完整 SourceRef 及可选 replacementSelection，不保存、生成或改知识；固定 Git 不代表最新，部分清单不证明零影响。
- 旧数据先保留原目录及匹配构建。`migrate-workflow` 仅支持健康 Source3／正文3／实体2／关联2／reviews1／tags 六类活动数据，按固定计划／摘要复制到独立目标，保留全部字节与身份；journal8 及更早日志、来源清单／覆盖和自动许可仅归档，既有 review／retain 不等于来源覆盖批准。library／carriers／entity-links 等不受支持内容先报告边界，不静默丢弃。Source2→3 保持独立映射流程。当前构建不提供自动调度或重新授权入口，只逐阶段确认。

**BREAKING-SCHEMA/API/COMPARABILITY**　当前日志为 Schema 9，默认导入身份为 `knowledge-source-set-import-run/v4`。普通正文仍使用 input5／wire3／prompt20。长历史分窗采用独立请求身份。关联 input1／wire3／prompt9 和来源、正文、实体、关联及 reviews 活动格式保持。使用 `knowledge-workflow-to9` 迁入独立副本，旧构建和原目录保留用于回退。

所有命令使用已选 `--workspace`。journal 的来源复核 manifest 仍为 input2，不能与独立清单 input1、写作 input1、正文 input5 或关联阶段 input1 混用。覆盖仅当 bounded target 且 covered 时可带完整 witness，其余 boundedInput=null；模型自报范围不证明实际阅读、内容真值或实际接受。

旧 C3 编译记录可被动读取，原件状态为 `not_verified`，不继承 C4 原件验证、新覆盖决定、关联准备或 claim 资格。保留旧目录及匹配构建供旧执行／回退；C4 仅在获准的独立完整副本中启用，不改写历史原件或重算旧实验。

旧日志由匹配构建读取和恢复。独立副本归档旧日志、原件与分析的全部字节，保留原执行状态和质量结论。

已获授权的 `retain`、`discard`、`revise`、`correct-entities`、`apply-associations`、`review-associations` 在识别到 Codex Desktop 启动声明及有效线程身份时，将新维护记录归属于实际 Agent；其它上下文仍为既有 `human/local-user` 默认，不证明真人直接操作。不要自报 actor 或伪造启动声明；这不是身份认证或异构 Agent 支持。只影响新的维护 actor／revisedBy，不回写旧 actor／回执，不改变知识 createdBy、capture、生成或独立复核入口，也不改变存储 Schema／prompt 身份。

## 第一步：理解用户意图

先区分讨论、只读核对与实际执行，不把模糊表述默认当成评测请求：

| 用户意图 | 操作 |
|---------|------|
| 讨论产品、询问能力、只读核对源码或文档 | → 按「纯讨论与只读核对」处理；不执行 CLI 或评测项目扫描 |
| `$omk feedback` 快捷反馈 | → MCP `save_observation`；不执行 CLI |
| 从历史知识完成当前任务、参考已有知识回答或行动 | → 先读 [按任务复用知识](references/knowledge-reuse.md)，首选只读 `retrieve --format text`，核对可见完整性与引用；跳过评测项目扫描 |
| 补充、纠正或更新知识工作区中的已有知识 | → 先读 [按任务维护知识](references/knowledge-maintenance.md)，固定旧修订，仅补必要来源，再经现有 `revise` 追加完整修订并验证后续使用 |
| 从选定对话／项目文件／Git 沉淀知识、核对来源变化 | → 按上方 Source3 分支预览、保存并逐阶段核对请求；只读变化查询不启动生成或评测 |
| 评测 / 对比 skill | → `omk eval` |
| 改进 / 优化 skill | → 先区分直接编辑与自动评测迭代；只有要求自动迭代时进入 `omk evolve` |
| 生成测试用例 | → `omk sample` |
| 体检 skill 写法 | → `omk doctor` |
| 浏览对话、任务轨迹与报告 | → `omk studio`（启动本地知识工作台） |
| 看真实使用 trace | → `omk observe` |

意图仍不明确时，先利用可见上下文澄清；确实缺少会改变操作或授权范围的信息时，只问一个具体问题，不先扫描 `skills/` 或 `eval-samples` 来替用户决定目标。

## 第二步：检查所选操作的环境

仅实际需要 CLI 的操作才运行 `which omk`。知识复用、维护与选定来源分支按各自说明核对能力，不进入下方评测项目扫描；纯讨论和 MCP 快捷反馈不做 CLI 环境检查。如果未安装，说明当前操作无法执行，可提供以下安装命令，但不自动安装、升级或迁移：

```
npm i -g oh-my-knowledge@next
```

omk CLI 顶层命令包括：`init` / `install` / `doctor` / `eval` / `observe` / `evolve` / `sample` / `studio`。没有 `bench` / `improve` / `gen-samples` 这些旧子命令名 —— 如果你在历史 SKILL / 文档里看到了，那是 v0.30 命令树重构之前的写法。

### 在 Codex / 支持 MCP 的客户端中

Codex 是 omk 的一等 runtime。未显式指定执行器时，`omk eval` / `doctor` / `sample` / `evolve`，以及 `omk observe inbox --llm-enhanced-review`，会自动选择 `codex`，从 `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` 解析模型（顶层 `profile` 指向某个 profile 时取该 profile 的 `model`，否则取顶层 `model`），默认评委沿用同一个 Codex 模型。

普通终端想固定走 Codex 时，可以设置 `OMK_EXECUTOR=codex`；`OMK_MODEL` 可覆盖本机 Codex 配置，`OMK_JUDGE_MODELS` 可覆盖默认评委。逐次覆盖仍可使用 `--executor` / `--model` / `--judge-models`。直接执行 `omk` CLI。

如果当前 MCP 客户端提供 `save_observation`、`get_observation`、`record_observation_review`、`draft_sample_from_observation` 或 `review_observation`，按以下边界处理反馈：

- OMK MCP 是主动知识反馈接口，不是对话监听器；它不能自行监听或订阅完整对话。skill 可以识别潜在反馈时机，但自动识别不等于自动监听，保存仍须用户确认并显式调用 `save_observation`。
- `$omk feedback` 是用户显式调用 skill 的保存确认，按「快捷知识反馈」处理；它不是 CLI 子命令。
- 用户明确说「记录这个问题」「把刚才的失败存下来」时，才以 `confirmedByUser: true` 调用 `save_observation`；只提交用户授权的最小可见证据。
- 用户只是纠正答案、指出知识不足或遇到重复工具失败时，可以建议记录并请求确认；确认前不要调用 `save_observation`。这条启发式路径是 best-effort，不能声称覆盖全部对话。
- 普通追问、假设性例子、泛泛的不满意或没有明确知识缺口的反馈，不要记录 observation。
- 只有人工复核为 `real_issue` 后才能调用 `draft_sample_from_observation`；候选草稿不等于正式 eval sample，不要自动写入正式样本集。
- 需要对话内复核时，先 `get_observation`，再 `review_observation`。所有结果都按 `coverageStatus: partial` 解读，不推断未提交的上下文、其它工具调用或隐藏推理。

### 在 DeepSeek Harness 中

如果当前 DSH profile 已安装 `oh-my-knowledge` bundle，使用 `/omk eval <eval.yaml>`。该路径直接复用现有 DSH 的模型、凭证、工具与 sandbox，并为每条用例创建隔离 session；不要要求用户另起 DSH runtime。

查看真实 DSH 任务轨迹时，先运行 `/omk observe` 列出最近已结束的 session，再运行 `/omk observe <session-id>`。OMK 通过当前 profile 的 `sessionPersistence` 只读摄取一致快照，并返回 Studio 任务轨迹链接；不要求用户导出或定位 JSONL／SQLite 文件。首版不实时跟随正在写入的 session，也不默认选择发起 observe 命令的当前 session。

## 第三步：按需检测评测项目结构

仅已选择评测、自动迭代、用例生成或体检分支，且仍需定位目标／样本时，使用 Glob 和 Read 工具检查必要范围；用户已指定的有效文件直接复用。其它分支跳过本节：

1. `skills/` 目录下有哪些 skill 文件（`.md` 或 `*/SKILL.md`）
2. 是否存在项目级 `eval-samples.json` / `eval-samples.yaml`，或目录 skill 私有的 `<skill>/.omk/eval-samples.json` / `eval-samples.yaml`
3. 同一作用域是否同时存在 JSON 与 YAML（这是歧义，必须先让用户保留其中一个）

根据检测结果决定：

- 多个目录 skill + 各自的 `.omk/eval-samples.*` → 建议 `--batch` 批量模式
- 多个 skill + 共享项目级 eval-samples → 建议版本对比模式
- 只有一个 skill → 建议 `baseline` 对照（`omk eval --control baseline --treatment <skill>`）或 `omk evolve` 改进
- 已选择的操作确实需要评测用例但没有 eval-samples → 说明缺口，在已有授权内用 `omk sample <skill>` 生成候选并复核；不因缺少用例将讨论、体检或直接编辑转成模型调用

## 第四步：执行操作

### 评测 skill

```bash
# 单 skill 必要性测试（有 skill vs 没 skill）
omk eval --control baseline --treatment my-skill

# 版本 A/B 对比
omk eval --control my-skill-v1 --treatment my-skill-v2

# 对比 git 历史里的版本跟当前
omk eval --control git:my-skill --treatment my-skill

# 批量评测：每个 skill 独立 vs baseline
omk eval --batch

# 先预览任务计划再执行
omk eval --control v1 --treatment v2 --dry-run

# 复杂配置走 eval.yaml
omk eval --config eval.yaml
```

常用选项：

- `--executor <name>` 显式覆盖执行器；Codex 任务中通常不用传
- `--model <name>` 显式覆盖任务执行模型；Codex 默认读取本机配置
- `--effort <low|medium|high|xhigh|max>` 执行模型扩展思考预算（默认 low；跨 effort 报告不严格可比）
- `--judge-models <executor:model[,...]>` 显式覆盖评委配置（Codex 默认沿用被测模型，≥ 2 条 = ensemble）
- `--concurrency <n>` 并发数
- `--skip-doctor` 跳过 doctor preflight 门禁（默认 doctor 会先跑一次卡掉 skill 写法大问题）
- `--no-diagnostic` 关闭基于已认证 Core 失败、缺失证据、排除项和稳定 reason code 的诊断投影
- `--no-judge` 关掉评委主观评分（保留断言层）

### 自动迭代改进

```bash
omk evolve skills/my-skill.md --rounds 5
omk evolve skills/my-skill.md --rounds 10 --target 4.5
# 只生成候选，不写回源文件
omk evolve skills/my-skill.md --snapshot-only
```

evolve 的每个候选都必须通过 Evaluation Core 的 control／treatment A/B 决策：只有带 `release-gates-passed` 的 `PROGRESS` 才接受。Core Decision 是唯一接纳依据；同一次 A/B 中的分数差只用于展示，authoring loop 不会再叠加私有分数门禁或拿跨 run 分数比较。写回源文件前还会重新评测原始版本与胜出快照；最终门禁失败时源文件保持不变。改动过大的候选在评测前直接判拒（`--edit-budget`，默认 0.2）。选择集不能提供无偏泛化结论；需要发布判断时，在 evolve 外保留独立验证集并运行新的 `omk eval`，不要把该验证集反馈回同一次迭代。

**重要：evolve 必须在前台运行（不要用 `run_in_background`）。** 原因：evolve 自带实时进度输出，每个 sample 执行时会打印 `[1/5] s001/... ⏳ 执行中...`，每轮完成会打印 `Round N: score=... ✓ ACCEPT / ✗ REJECT`。前台运行时用户能实时看到这些进度，无需手动询问。设置足够长的 timeout（建议 600000ms）以确保命令不会中途超时。

### 生成测试用例

```bash
# 为单个 skill 生成
omk sample skills/my-skill/SKILL.md

# 显式指定数量（不指定时 LLM 根据 skill 类型自动决定 4-8 条）
omk sample skills/my-skill/SKILL.md --count 8

# 自然语言指定重点覆盖场景
omk sample skills/my-skill/SKILL.md --focus "重点覆盖搜索失败 / 权限拒绝 / 跨工具 fallback 路径"

# 为 skill 目录下所有缺测试集的 skill 批量生成
omk sample --batch
```

目标执行器不支持工具拦截时，`omk sample` 会自动生成无 mock 用例。当前 `codex` / `codex-sdk` 属于这种情况；不要手工补 `mocks` 或 `mock_hit`。已有 mocks 用例会被 `omk eval` 在模型调用前拒绝，避免把执行器能力缺口误判成模型失败。`environment.files_available` 只提供题设上下文，不会在 `cwd` 物化文件。

输出位置：目录 skill（`<skill>/SKILL.md`）→ `<skill>/.omk/eval-samples.json`；扁平 `.md` 单次生成 → 当前目录 `eval-samples.json`（项目级共享）。`--batch` 只处理目录 skill；需要私有用例的扁平 skill 应先迁移为目录 skill。手写 YAML 时使用同作用域的 `eval-samples.yaml`，不要让 JSON 与 YAML 并存。

### 观测真实使用

```bash
# ChatGPT desktop / Codex CLI rollout
omk observe ~/.codex/sessions --last 7d
omk observe ingest ~/.codex/sessions

# Claude Code session
omk observe ~/.claude/projects/<project> --last 7d
```

Codex rollout 会保留 `sourceKind=codex`、模型、父子任务、tool call 和 token 证据，并从实际读取的 `skills/<name>/SKILL.md` 归因 skill。`omk studio` 无需先 ingest，即可从本机 Codex 对话总览进入某次任务的实时轨迹；`observe ingest` 只在需要生成待复核 observation 时运行。任务轨迹按对话、执行、结果和知识呈现结构化事实，并联动检查配对后的工具调用与结果、AI 回答和用户纠正。该页面只呈现 trace 中可观测的执行过程，不推断隐藏思维或失败根因。确认真实知识缺口后，再用 `omk sample --from-traces` 草拟评测用例。

### 体检 skill 写法

```bash
# 健康度审计（默认 --repeat 2 采样 + k/n 共识归并）
omk doctor

# 单次快检（不采样、不归并，最省）
omk doctor --repeat 1

# 针对单 skill
omk doctor skills/my-skill.md
```

`omk eval` 默认会先跑一次 doctor 当 preflight 门禁，所以一般不用单独跑；想在 eval 之前先把结构问题先扫一遍再跑评测，就单独跑 `omk doctor`。

### 浏览对话、任务轨迹与报告

```bash
omk studio                                # 启动本地知识工作台（默认端口 7799）
omk studio --port 8080                    # 改端口
omk studio --host 0.0.0.0                 # 局域网访问（默认 127.0.0.1）
omk studio --no-open                      # 不自动开浏览器
```

Studio 首页直接索引本机 Codex 对话。先选择对话，再选择任务查看四泳道任务轨迹；进行中的任务支持实时跟随。顶部「知识载体」入口用于浏览 doctor / eval / observe 报告，`/observe/inbox` 用于复核 observation。无需为了浏览本机 Codex 对话而先运行 `omk observe ingest`。

## 第五步：解读结果

`omk eval` 在交互终端默认输出自然语言摘要，非交互终端或 dry-run 输出 JSON。Studio 仅在启用 serve、门禁通过且为交互终端时自动启动；批量评测不自动启动，不能承诺每次都有预览服务。你需要按实际输出总结关键发现：

### 版本对比与单载体模式

总结要包含：

1. **状态与结论**：先核对 `status.runStatus`、`status.evidenceStatus`、`status.conclusionStatus`、`decision.decisionStatus`，再解释 verdict。未完成、证据不全或结论未定时，不用局部分数宣布胜出。结论可能为 PROGRESS / NOISE / REGRESSION / CAUTIOUS / UNDERPOWERED / SOLO；`SOLO` 是单载体判断，不证明相对其它版本提升。
2. **门禁与理由**：报告 `gate.gateStatus` 与实际 reasonCodes。`PROGRESS` 仍可能被门禁阻塞；只有决定已作出、门禁通过且含 `release-gates-passed`，才支持在本次测量范围内进入发布准备；`SOLO` 对应 `solo-layer-gate-passed`，不构成版本对比收益证据。门禁通过不替代用户的发布授权。
3. **质量分数**：按实际结果列出各 variant 的综合分，以及可用的 Δ 和区间；缺失值明确说明，不补造统计量。
4. **成本与样本**：列出可取得的 token、执行／评委／diagnostic 花费，以及关键差异样本；USD 不可得时显示「—」。区分观察到的差异与未经隔离验证的原因解释。
5. **下一步动作**：由状态、门禁和理由共同决定。只补足具体缺失证据或修复，不笼统要求重跑；保留已完成和失败记录，不以测量通过证明产品整体净收益。

示例输出（假设结果完整且门禁确已通过）：

```
本次版本对比支持 v2 改善（verdict: PROGRESS，Δ=+0.7，95% CI [+0.3, +1.1]）：
- 状态：completed / complete / conclusive，decision: decided。
- 门禁：passed，理由包含 release-gates-passed。
- 质量：v2 平均 4.5 分，v1 平均 3.8 分。
- 成本：USD 不可得，记为「—」；token 按运行记录报告。
- 样本：s002 从 2.5 到 4.5；不能仅凭该变化断定由某一句新增指令导致。
- 建议：可在本次测量范围内进入发布准备并留存报告；实际发布另需授权，不外推为整体产品收益。
```

### evolve 模式

总结进化过程：起始分数 → 最终分数，接受 / 拒绝了哪些改进，总花费。如果用户想看具体改了什么，引导查看 `skills/evolve/` 目录下的版本文件。

### 批量评测模式（`--batch`）

列出每个 skill 的 baseline 分 vs skill 分和提升幅度，高亮表现最好和最差的 skill。

## 指定工作目录（cwd）

当评测用例需要模型读取特定仓库的代码时，可在 sample 中设置 `executionContext.cwd` 字段：

```yaml
schemaVersion: omk.eval-sample-set/v3
samples:
  - sampleId: task-001
    input:
      inputKind: text
      text: 实现用户登录功能，要求支持手机号和邮箱两种方式
    executionContext:
      cwd: /path/to/target-repo
    evaluationContext:
      assertions:
        - type: contains_all
          values:
            - auth.ts
            - login.tsx
```

`cwd` 会作为 executor 的工作目录，Codex 等 agent runtime 会在该目录下运行并读取仓库代码。适用于「给一个任务 query，断言应该修改哪些文件」的 A/B 评测场景。

## 注意事项

- 评测需要调用 LLM，会产生费用。能从执行器取得价格时，运行前告知用户预估成本；Codex CLI / SDK 当前不报告 USD 成本，应明确显示为「—」，不要伪装成 $0
- 首次使用建议先 `--dry-run` 预览任务计划
- `evolve` 命令会修改原始 skill 文件，原始版本保存在 `skills/evolve/*.r0.md`
- 详细命令参考见 [commands.md](references/commands.md)
