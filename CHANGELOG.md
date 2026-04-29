# Changelog

All notable changes to `oh-my-knowledge` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

- **测评用例科学性 v1**(对标 HELM / MMLU-Pro / Construct Validity 三件套 / HF Dataset Cards 行业共识):`Sample` schema 加 4 个可选元数据字段(`capability` / `difficulty` / `construct` / `provenance`),纯文档/诊断用,**完全不参与 grading / judge / verdict / Report 顶层 schema**(测量学不变量保护,跨版本 verdict / Δ 完全可比,跟 v0.22 strict-baseline 那次的 breaking-comparability 区分开)。
  - **Sample 元数据**(`src/types/eval.ts`):
    - `capability?: string[]` — 该用例覆盖的能力维度(如 `['api-selection', 'error-diagnosis']`),归一时大小写/短横线/驼峰/下划线不敏感
    - `difficulty?: 'easy' | 'medium' | 'hard'` — 难度分层(强枚举,防错)
    - `construct?: string` — 该用例测的 construct 类型,suggested values:`'necessity'`(测必要性,baseline-vs-skill)/ `'quality'`(测 skill 写得好不好,skill-v1-vs-skill-v2)/ `'capability'`(测某具体能力);free-form string 允许自定义
    - `provenance?: 'human' | 'llm-generated' | 'production-trace'` — 数据来源
  - **`load-samples.ts` 新增 enum 校验**:`difficulty` / `provenance` 非法值含 `sample_id` 定位的错误信息(形如 `samples[3] (s007) invalid difficulty: 'easy?', expected one of [easy, medium, hard]`);`capability` 必须是 string[];`construct` 接受任意 string。
  - **`bench diagnose` 加 2 类新 issue**:
    - `rubric_clarity_low`(info):rubric < 20 字符 **AND** 不含任何评分级别词(中英 22 词清单)→ static rubric quality signal,跟现有 `ambiguous_rubric`(runtime/judge stddev)互补
    - `capability_thin`(warning):某 capability 只 ≤ `max(2, N*0.2)` 个 sample 撑(总 N≥10 才检测,小 N 自动跳过避免全报)
    - fine-grained discrimination signal(IRT 风格)留 follow-up
  - **`bench diagnose` CLI 加 sample design coverage 块**:capability / difficulty / construct / provenance 分桶呈现(ASCII),数据从 `report.analysis.sampleQuality` 取(分桶聚合)或 fresh 加载 samples 算
  - **`Report.analysis.sampleQuality`**:新增 `SampleQualityAggregate` 子结构,纯文档聚合(`capabilityCoverage` / `difficultyDistribution` / `constructDistribution` / `provenanceBreakdown` / `avgRubricLength` / `sampleCountWith*`)。**不破老报告兼容**:不传 samples 时不挂此字段,老 reader 读取仍正常。
  - **`bench gen-samples` 自动注入 `provenance: 'llm-generated'`**:`SYSTEM_PROMPT` 加可选 hint 段(LLM 如能判断顺便填 capability / difficulty / construct,无法判断省略不强制)
  - **新建 [`docs/sample-design-spec.md`](docs/sample-design-spec.md)**:行业 8 条 gap 引用 + omk v1 映射 + 完整 yaml example + 11 条用例设计自检 checklist + verdict 解读跟 construct 配合
  - **HTML report 暂不显示 sample design coverage**(只 CLI `bench diagnose`),HTML 渲染留 follow-up — 用户跑 HTML 报告需要看 coverage 时,从 `report.json` 的 `analysis.sampleQuality` 读
  - **R11 防御测试**:`test/grading/judge-prompt-isolation.test.ts` 锁住 judge prompt 不含任何 sample 元数据 token(`'capability:'` / `'difficulty:'` 等),防未来 refactor 把元数据意外注入 judge prompt 破坏 construct validity
  - **软兼容性 callout**:如果用户之前用 sample.capability 作为自由 unknown 字段(string / object / 其它),v1 起此字段是 `string[]`,类型校验会拒掉非数组值(此前 omk 没 publicize 过 capability 名字,概率极低)。`provenance` enum 简化:`'evolved'` / `'mixed'` 留 follow-up 跟 evolver 升级一起做。

### Fixed

- **`VariantSummary.toolDistribution` 修真实 call count**:之前 aggregate 阶段按 `result.toolNames`(per-sample dedup 列表)累加,语义是"出现该 tool 的 sample 数",跟字段名"工具调用分布"不符 — 用户读 summary 看到 `Read: 5` 以为模型调了 5 次 Read,实际是"5 个样本里出现过 Read"。修法:`VariantResult` 加 per-sample `toolDistribution`(从 `toolCalls` reduce 得到真实 call count map),aggregate 时 sum per-sample 字段。旧报告 result 没 `toolDistribution` 字段时 fallback 到老 `toolNames` 语义保兼容。

### Changed

- **⚠️ BREAKING:report server URL 从 `/run/<id>` 改为 `/reports/<id>`**:命名跟 codebase 内一致语义(`Report` 类型 / `~/.oh-my-knowledge/reports/` 目录 / `omk bench report` CLI 命令)对齐。`/run/` 是 omk 内部把 "evaluation run" 当 entity 的旧叫法,但用户打开 URL 是来"看报告"的——`/reports/` 直接匹配心智。同步改:`/api/run/<id>` → `/api/reports/<id>`,`/api/runs` → `/api/reports`。**直接删旧路径,不留兼容 alias**(omk 0-1 阶段)。已有书签需要更新。

- **⚠️ BREAKING-COMPARABILITY:`bench run` / `bench gate` 默认对 baseline-kind variant 启用 skill isolation**(`--strict-baseline` default true)。这是 omk 测量学严谨性的根本承诺补全:之前 baseline 通过三条 channel(SDK skill auto-discovery / subagent Skill 工具 / cwd 文件系统)拿到 `~/.claude/skills/` 全部 skill,导致 baseline-vs-skill 比较 construct invalid——baseline 跟 treatment 看到的是同一份 skill 内容,Δ 接近 0 是必然结果。本版默认三堵(main session skills + subagent Skill 工具 + cwd 切到 isolated empty dir),baseline 真正干净。

  改动范围:
  - **CLI flag**:新增 `--strict-baseline`(default true) / `--no-strict-baseline`(显式 opt-out 逃生口)。`bench run` + `bench gate` 同步支持。pre-flight 在 `--no-strict-baseline` + `~/.claude/skills/` 非空时 stderr 显式提醒。
  - **eval.yaml schema**:新增 `variants[].allowedSkills?: string[]` 显式声明,优先级高于 CLI flag。`undefined` = 默认 / `[]` = 完全隔离 / `[name1, name2]` = 白名单。YAML `allowedSkills:` 不写值会被 parse 成 null,显式 reject(语义不清)。
  - **executor 行为**:claude-sdk 注入 `skills` + `disallowedTools:['Skill']`;**claude-cli 等价**(`--disable-slash-commands` + `--disallowedTools Skill`,文档说前者就是 "Disable all skills"),任意非空白名单 throw 提示改 sdk(CLI 没暴露 partial whitelist);script 仅 stderr warn 不参与 isolation。
  - **cache key 升级 `v2:` prefix + 含 allowedSkills**:旧 cache 一次性失效(避免 strict / non-strict 切换时误命中污染结果)。同 prompt 不同 isolation 必拿不同 cache key。
  - **report.meta.skillIsolation**:新字段记录每个 variant 的 allowedSkills 快照(undefined → null),供跨报告对比。`--resume` 时 isolation 状态不一致 stderr warn 不阻塞。
  - **隔离覆盖(三条 channel)**:
    1. **main session skills**(SDK `options.skills`):`skills:[]` 关 SDK 内部 skill 发现
    2. **subagent Skill 工具**(SDK `options.disallowedTools`):`disallowedTools:['Skill']` 关 SDK 内置 task subagent 调 Skill 工具
    3. **cwd 文件系统访问**(切到 isolated empty dir):baseline 默认 cwd 是 `process.cwd()`(用户评测工作目录),那里通常有 `skills/<name>/` symlink 给 treatment 用 — baseline 用 Glob/Read 直接顺 symlink 读 SKILL.md 就完全绕过 SDK 隔离。strict 模式 + 用户没显式 cwd 时切到 `~/.oh-my-knowledge/isolated-cwd/`(空目录),Glob/Read 探索不到任何 skill 文件。**这条是真正 load-bearing 的 channel** — 仅堵 SDK 两条时 baseline 输出仍含被测 skill 的私有 token,加 cwd 隔离后才真正干净。
  - **MCP servers**:已默认堵(SDK `settingSources` 默认 `[]` + omk 不传 `mcpServers`)。
  - **已知 limit**:`AgentDefinition.skills` 白名单精确控制留 follow-up(白名单场景 subagent 仍能调 Skill 工具,但 v1 用户主要用 `[]` 完全隔离,影响小)。

  **breaking-comparability 标记**:旧报告(无 `meta.skillIsolation`)与新报告 verdict / Δ 不可跨版本对比——等同 judge prompt bump 一档;CHANGELOG 显式 callout。**迁移指南**:
  - 已有 baseline-vs-skill 评测脚本无需改 flag 即享受 default strict;旧报告作为"污染基线"留存,新跑作为"干净基线"。
  - 需要老行为(测 baseline 走默认 skill 发现的效果)显式加 `--no-strict-baseline`。
  - 跨版本对比 verdict / Δ 前先看 `meta.skillIsolation` 是否一致。

  设计 spec 见 [docs/terminology-spec.md §七 Skill Isolation](docs/terminology-spec.md)。

### Internal

- 新增 `buildSdkIsolationOptions(allowedSkills)`(纯函数,可测) + `buildIsolationWarnings(artifacts, strictBaseline)` pre-flight helper。
- `resolveArtifacts(skillDir, variants, opts)` 新增 `opts: { strictBaseline?, variantAllowedSkills? }`,旧 caller 0 改动(opts 全 optional)。
- `cacheKey()` signature 加 `allowedSkills?: string[]` 入参,旧 caller 不传时退化到默认行为(但 prefix 升级到 `v2:`,旧 cache 一次性失效)。
- 单测覆盖:resolveArtifacts 三种优先级 / cache key 不同 isolation 不同键 + 顺序不敏感 / SDK option 形态契约 / claude-cli throw 非空白名单 / eval-config schema reject null + 非数组 / report.meta.skillIsolation populate / pre-flight isolation warning 触发条件。

---

## [0.21.0] - 2026-04-27

Minor — **BREAKING** `bench ci` 改名 `bench gate`(消除 omk 里 "CI" 歧义,从此 CI 永远只指置信区间),gate 内核切换为完整 verdict;single-run 盲区在用户旅程三处可见;CLI 双语 i18n 全面落地;发版自动化(publish.yml 现自动从 CHANGELOG 抽 release notes 建 GitHub Release)。

> 注:0.20.2 已 merge 到 main 但**未发到 npm**(tag 没打),所以从 0.20.1 升级的用户会在本版本一次性收到 0.20.2 + 0.21.0 两批改动。

### Added

- **CLI 双语输出 (zh / en)**:`omk` 所有 CLI 输出现支持中英两种语言。优先级 `--lang` flag > `OMK_LANG` 环境变量 > 默认 `zh`。覆盖范围:
  - `omk --help` 主帮助文档(140 行)+ 所有子命令 help(`gold` / `verdict` / `diagnose` / `failures` / `saturation` / `debias-validate` / `diff` / `analyze`)
  - 实时进度反馈(预检 / 重试 / 执行中 / 评委评审 / 已完成 / 已跳过 / 错误)
  - 评测完成提示 + report server 启动信息 + gold dataset 对比反馈
  - 参数校验提示(`--repeat` / `--judge-repeat` / `--judge-models` / `--bootstrap-samples` / `--no-debias-length` 等)
  - `bench gen-samples` / `bench evolve` / `bench gold` / `bench saturation` 等子命令的 runtime 反馈
- **CLI i18n 基础设施**:`src/cli/i18n.ts`(`tCli` / `getCliLang` / `parseLangFromArgv` / `langFromArgv` / `makeOnProgress` factory)+ `src/cli/i18n-dict.ts`(~80 个 key,zh/en 双写,`Record` 类型强制对齐)。新增 `test/cli-i18n.test.ts`(10 用例)做 dict parity / placeholder 替换 / lang 优先级 runtime 校验。
- **`src/cli/i18n-dict.ts` 头部翻译守则文档**(受 [lizhiyao/cc-viewer](https://github.com/lizhiyao/cc-viewer) i18n 方案启发):明确"保留原文白名单"(产品名 / 子命令名 / 业务术语 skill/variant/sample/judge / 技术参数 / 文件名 / 数学缩写) vs "必须翻译的内容"(动作 / 状态 / 引导文案 / 解释),后续维护者按守则审 dict。

### Changed

- **⚠️ BREAKING:`bench ci` 删除,改名 `bench gate`,内核同步升级为完整 verdict**:omk 里 "CI" 一直有歧义——既指 Continuous Integration(`bench ci` 命令),又指 Confidence Interval(`bootstrap CI` / `diff CI` / `95% CI`)。读代码注释 / 文档 / commit message 时常常需要看上下文猜哪个 CI。本版**直接删除 `bench ci`**(omk 0-1 阶段不留兼容层),命令改名 `bench gate`,从此 omk 里 **CI 永远只指置信区间**。

  改动范围:
  - CLI:`omk bench ci` → `omk bench gate`(= `runEvaluation + computeVerdict + 0/1 exit code`)
  - 内部:`evaluateCiGates` → `evaluateLayerGates`,`CiGateResult` → `LayerGateResult`,`VerdictOptions.ciThreshold` → `gateThreshold`
  - 文件:`src/eval-core/ci-gates.ts` → `layer-gates.ts`,`test/ci-gates.test.ts` → `test/layer-gates.test.ts`
  - 文档:`README.md` / `README.zh.md` / `docs/comparison.md` / `docs/zh/comparison.md` / `docs/knowledge-gap-signal-spec.md` 全部 sweep
  - `terminology-spec.md` 加 §5"CI 在 omk 里只指 Confidence Interval"显式规则

  为什么改名"gate"而不是别的:**业界 vocabulary**(SonarQube Quality Gate / Azure release gates / Spinnaker pipeline gates),"gate" 在 CI/CD 圈是通用名词。codebase 内本来满地是 `gate`(`three-layer gate` / `gate.allPass` / `layer-gate check`),命令名也叫 gate 后,代码 / 文档 / commit 讲同一个词,可搜索性升一级。

  **同步行为变更:gate 内核统一为 verdict**——之前 `bench ci` 只看三层平均分阈值(`evaluateCiGates`),用户花钱跑 `--bootstrap` 但 ci 退出码完全忽略 bootstrap diff CI、saturation、Krippendorff α——是个**隐性漏洞**。本版把 `handleCi` 重写为 `runEvaluation + computeVerdict + formatVerdictText`,exit code 与 `bench verdict` 对齐:**只有 PROGRESS / SOLO-pass 才 0**;`NOISE` / `UNDERPOWERED` / `CAUTIOUS` / `REGRESS` 全 1。**这是行为变更**:之前三层都过 3.5 即 PASS 的 underpowered run 现在会 FAIL——这正是 gate 应有的语义(数据不显著就不该进 deploy)。`--threshold` 继续生效作为三层 gate 阈值,新增 `--trivial-diff` 调"实际可忽略的小差距"门限。两个 CLI 表层(`gate` 一句话跑+判 / `verdict` 离线判已有报告)继续保留,内核共用。这一改与下面的 single-run verdict rationale 是同一回路:underpowered 数据自动 FAIL,堵住"单轮过 PASS 就 deploy"的漏洞。

  **迁移指南**(用户面):GitHub Actions / GitLab CI / 任何 shell pipeline 把 `omk bench ci` 替换为 `omk bench gate`,其余 flag 不变。omk 还在 0.x,主动放弃兼容层,**不留 deprecation alias**。内部代码引用 `evaluateCiGates` / `ciThreshold` 的请相应改名。

- **single-run 盲区在用户旅程三处可见(三处一致信号)**:之前用户跑单轮(`--repeat=1`)评测,**没有任何一个面提醒"稳定性测不到"**——单轮报告读起来就像满分,容易误读为"稳"。本版在用户接触 omk 的三个时间点都加显眼信号,**单轮的盲区不会再被默默忽略**:

  1. **进门(`bench run` / `--dry-run` 跑前 stderr)**——pre-flight 结构性预警,N<5 / N<20 / repeat=1 三档:
     - `N < 5` → `⚠ exploration-only, any conclusion is unreliable, CI will be uselessly wide`
     - `5 ≤ N < 20` → `⚠ large-effect-only (Cohen's d > 0.8), medium effects hard to detect`
     - `--repeat=1` → `⚠ single-run cannot measure stability (CV will be marked "not measured")`

     **不预测 MDE 数值** — σ 跑前不知道,拍脑袋写"CI 半宽 ±0.4"是 hand-wave。所以纯**结构性 hard-floor**,严肃 power 判定交给 `bench verdict` + saturation 曲线 post-hoc。`buildPowerWarnings(n, repeat): string[]` 抽为纯函数,9 个单测覆盖各档边界。

  2. **决策(`bench verdict` / `bench gate`)**——`computeVerdict` 加 `rationale.stability` 字段,三态:
     - `--repeat ≥ 2` + variance 数据齐:报 `CV=X.X% (稳定/中等/不稳, runs=N)` 主指标(阈值参考 terminology-spec §5)
     - `--repeat ≥ 2` 但 variance 缺失:标"variance 数据缺失"
     - `--repeat < 2`:**显式说**「稳定性未测量(单轮评测,需 --repeat ≥ 2 才能测 CV)」

     `formatVerdictText` 同步打印 Stability 行,SOLO 单 variant 路径走同一逻辑。**之前 verdict 不报告稳定性,导致单轮用户无法感知盲区**。

  3. **复盘(HTML 报告稳定性列)**——`--repeat=1` 时从灰色 `—` + 灰色"需 --repeat ≥ 2"改成**红色 `⚠ 未测量` + 红字引导文案**(英文 `⚠ Not measured` / `single-run; needs --repeat ≥ 2 to measure CV`)。**之前太弱容易被误读为"无显示=没问题"**,改红让缺失可见。zh + en snapshot 同步重生,UI 结构 0 改动。

  无论用户是 CLI pipeline、verdict 用户、还是只看 HTML 的用户,都能在最自然的地方看到这个盲区。

- **user-facing 中文文案统一用「用例」,不用「样本」**:`docs/terminology-spec.md` §6 加显式规则——代码 / API / 文件名 / CLI flag(`Sample` / `sample_id` / `eval-samples.json` / `--samples`)继续用 `sample`(开源 API + 英文圈通用术语),只 user-facing zh 切换。理由:omk 的 `eval-samples` 是开发者**手挑**的测试用例,不是从某分布**随机抽样**的统计样本——「样本」会暗示"再多跑就能扩大样本量"误导用户,实际是要补设计、补用例。

  本版同步把 `src/cli/i18n-dict.ts`(15 处 zh CLI 输出)/ `src/renderer/{summary,layout}.ts`(报告 UI zh)/ `src/grading/{debias-validate,gold-cli}.ts`(5 处 stderr)/ `src/analysis/{report,sample}-diagnostics.ts`(22 处 diagnostic message)/ `src/authoring/{generator,evolver}.ts`(7 处 LLM prompt zh) / `src/types/report.ts` + `src/analysis/gap-analyzer.ts` + `src/eval-core/schema.ts` 注释 / `docs/{knowledge-gap-signal-spec,zh/comparison}.md` 全部 sweep。HTML 报告 zh 快照同步重生。

  **例外:统计学术语场景保留「样本」**——Cohen's d / Hedges' g 的"**小样本修正**"、"**样本均值**"、"**样本量**"、bootstrap "**重采样**" 等是 stats 领域固定提法(对应英文 small-sample correction / sample mean / sample size / resampling),硬翻成「用例」反让懂统计的读者多一拍。判定准则:这个词指的是**对总体的一次随机抽样**(stats 概念,用「样本」),还是**开发者手挑的一条测试用例**(用「用例」)——两者不混用,上下文清晰。本版当前涉及 4 处统计语境(Cohen's d 多重比较 disclaimer / Hedges' g 小样本修正版描述 / t-test 正态假设小样本提示)保留「样本」。

- **CLI 默认输出从英文混搭中文改为彻底双语化**:之前 `omk bench run` / `omk --help` / 进度反馈混合中英文(例如 "评测完成 done"),用户每次 review 报告或调试都要"切语境"。本版整体重写:中文用户读到的全是中文,英文用户读到的全是英文,无任何中英混搭。
- **lib 层(非 cli)user-facing 错误统一英文**:遵循"对客表达层 i18n / 内部实现层统一英文"分层原则,把 `src/inputs/eval-config.ts`(16 处)/ `skill-loader.ts`(5 处)/ `load-samples.ts`(4 处)/ `eval-workflows/run-evaluation.ts`(3 处)/ `inputs/url-fetcher.ts`(2 处)/ `inputs/mcp-resolver.ts`(4 处)/ `executors/{anthropic,openai}-api.ts`(2 处)/ `eval-core/evaluation-execution.ts`(1 处)/ `server/report-server.ts`(2 处)/ `authoring/{generator,evolver}.ts`(6 处)/ `grading/gold-cli.ts`(1 处)的中文 `throw new Error` 和 `process.stderr.write` 改英文。zh 用户看到的最终输出形如"错误: skill file not found: /path"——前缀本地化(由 cli 层负责),内部错误细节是英文工程内容。
- **`unknown` 提示文案更准**:`未知模块` → `未知顶层命令`,`未知 bench 子命令` → `未知子命令: bench {command}`(中文语序更自然)。
- **`Skill 健康度日报` 中英混搭 bug 修复**:之前 HELP 主常量中文版混杂了中文短语 "skill 健康度日报",现在英文版改为 `skill health report`。

### Fixed

- **directory-skill 路径解析(`SKILL.md` 约定)**:符号链接或非 cwd 子目录里的 directory-skill(例如 `~/.claude/skills/foo/SKILL.md` 引用 `assets/references/...` 相对路径)在评测时:
  1. preflight 把所有 artifact 的文件依赖 fold 进单一 cwd 检查,不同 skill 的 `assets/foo.md` 互相覆盖,会产生大量 false-positive missing。
  2. 运行时 executor cwd = `process.cwd()` 而非 skill 根,LLM 的 Read 工具按 SKILL.md 的相对路径找文件全部失败,触发反复 retry / 模型放弃 / 长时间超时。

  修复:`Artifact` 加 `skillRoot?: string`,在 `src/inputs/skill-loader.ts` 对 SKILL.md 约定的 directory-skill 设值(单文件 file-skill 维持 `process.cwd()` 语义不变)。`src/eval-core/task-planner.ts` `cwd` fallback 链改为 `artifact.cwd > artifact.skillRoot > sample.cwd > null`,`src/eval-core/dependency-checker.ts` `preflightDependencies` 文件依赖按 artifact 分桶解析(每个 skill 用各自 `skillRoot` 当 base)。端到端验证修复前后差异显著:false-positive missing 完全消除、tool failure 减半、不再超时、treatment 平均分从受 bug 拖累的低值恢复到正常水平。

- **依赖文件提取 regex 收紧**:之前 `FILE_PATH_REGEX` 把 SKILL.md 里"查看 `.d.ts` / `index.ts` 文件"这种**示例性扩展名提及 / bare 文件名提及**误识别为依赖。新增过滤:跳过以 `.` 开头的路径(扩展名讨论)和不含 `/` 的 bare 文件名(通用文件名几乎都是示例)。要声明 `package.json` / `README.md` 等 bare 文件作为真依赖请走显式 `requires:`。

- **(已知漏洞)CLI 中英混搭**:历史上 cli.ts / lib 层中混有大量"中文 stderr 嵌入英文 token / 英文 console.error 嵌入中文短语"。`grep -E "console\\.(log|error|warn).*[一-鿿]|process\\.stderr\\.write.*[一-鿿]|throw new Error.*[一-鿿]" src/` 现为 0 残留(除 `judge.ts` 测量学锚点不动)。

### Internal

- **`publish.yml` 自动从 CHANGELOG 抽 release notes 创建 GitHub Release**:push tag `v*` 触发后,workflow 在 `npm publish` 之后自动找 CHANGELOG.md `## [VERSION]` section,用作 GitHub Release 的 body。维护者只需 bump `package.json` + 改 CHANGELOG `[Unreleased]` → `[VERSION] - YYYY-MM-DD`,merge release PR 后打 tag + push tag 即可,Release notes 不再手动写。
- **协作者入场文档 `CLAUDE.md` 精简**(61 → 39 行,-36%):删除与 `CONTRIBUTING.md` 重复内容,目标"AI / 新人 90 秒读完不踩雷"。
- `src/cli.ts` 顶部 `const HELP` 142 行原英文模板字符串删除,内容完整迁到 dict。`HELP` 现通过 `tCli('cli.help.main', lang).trim()` 取得。
- 13 处 `parseArgs options` 块统一 spread `COMMON_OPTIONS = { lang: { type: 'string' } }`,所有子命令都接收 `--lang` flag。
- `defaultOnProgress` 改为 `makeOnProgress(lang)` factory:evaluation engine 异步回调时拿不到 argv,通过 closure 闭住 lang。每个 handler 入口通过 `langFromArgv(argv)` 一行拿到 lang 并传 factory。
- 测量学不变量未受影响:`src/grading/judge.ts` prompt 文本字节级未动,`test/grading/judge-hash-frozen.test.ts` 仍冻结 `v2-cot=fdc81b19c721` / `v3-cot-length=629bf3b8c41d` 两个 hash。
- 10 处测试 assertion regex 同步从中文更新为英文(`test/eval-config.test.ts` / `test/runner.test.ts` / `test/inputs/{load-samples,skill-loader}.test.ts` / `test/grading/gold-cli.test.ts`)。

---

## [0.20.1] - 2026-04-26

Patch — verdict 用户可见性升级 + 内部类型重构 + 测量学不变量保护(为后续 v0.21 路线做地基)。

### Added

- **列表页 verdict 信号**:RUN ID 旁加 status pill(明显进步 / 略微进步 / 基本持平 / 明显退步 / 样本不足 / 无法对比),从首页一眼分辨结果,不再需要挨个点进详情页。
- **列表页 verdict 图例条**:默认顶部显示一行带过 6 个状态词的语义,× 关闭后 localStorage 记忆,老用户不被打扰。
- **ReportMeta.schemaVersion 字段**:v0.21+ 写 `1`,无字段视为 v0,为后续兼容机制做准备。
- **judge prompt hash 字节级冻结测试**(`test/grading/judge-hash-frozen.test.ts`):写死 v2-cot / v3-cot-length 的 12-char hex hash,任何动 prompt 文本会立即失败 — 防止跨版本报告不可比的隐性破坏(原 `judge-prompt-version.test.ts` 只断 12 hex 形态不锁具体值,可被无声破坏)。
- **html-renderer + i18n 双语 snapshot 测试基线**:`renderRunList` / `renderRunDetail` × zh / en × list / detail 4 个 snapshot,加 `t()` 默认行为 + zh/en key set 一致性测试,作为后续 UI 改动的回归网。

### Changed

- **详情页 verdict 重写为一句话副标**:`测评结论: skill 和 baseline 没看出明显差别 — 可以加大样本量再试`。砍掉之前的强 banner / Δ 数字 / "skill vs baseline" 副标 / "样本=N" / 三层得分 strip / CTA 块。中文措辞自带状态信号("明显更好" / "明显更差" / "略好" / "没看出差别"),视觉融入页面扁平 + outline 风格,不依赖颜色 dot 或边框块。
- **`src/types.ts`(859 行)按消费域拆分**到 `src/types/{shared,executor,judge,eval,report,storage}.ts` + `index.ts`。原 `src/types.ts` 改为 1 行 facade(`export * from './types/index.js'`),95+ 处 `'../types.js'` import 路径 100% 不变。

### Fixed

- **`computeVerdict` 在 each mode + 顶层 summary 缺 variant 数据的脏老报告上 NPE**:渲染器层加 try/catch 兜底,失败的 row(列表页)或 verdict 区(详情页)静默跳过显示,不让一个坏 report 撤掉整页。根因(`evaluateCiGates` 访问 `undefined.avgFactScore`)留作 v0.21 单独修复。

### Internal

- 6 个分域类型文件取代单一 859 行 `src/types.ts`,跨域引用关系明晰(`shared` 叶子 / `executor` 自闭 / `judge` 自闭 / `eval → judge` / `report → executor + judge + eval` / `storage → eval + report`)。

---

## [0.20.0] - 2026-04-25

Major release — statistical rigor as a first-class concern, plus a verdict / diagnostics / RAG / budget surface that turns omk from "evaluation runner" into "evaluation reasoning system."

### Added — Statistical rigor four-piece (业界唯一全栈)

- **Bootstrap CI** (`--bootstrap` / `--bootstrap-samples`) — distribution-free confidence intervals for variant means + pairwise diff CI. t-test breaks on ordinal LLM scores; bootstrap stays valid at small N (< 30) and on skewed data. CI not crossing 0 = significant.
- **Human gold dataset workflow** with **Krippendorff α** — `omk bench gold {init,validate,compare}` and `omk bench run --gold-dir`. Brings external annotation as anchor; omk warns when gold annotator and judge are the same model. Supports α ordinal weights, weighted κ, Pearson, plus bootstrap CI on α itself.
- **Length-controlled judge prompt** (default ON, hash `v3-cot-length`) — research consistently shows LLM judges over-weight verbosity. omk's prompt now explicitly states "length is not a quality signal"; older reports hash-mismatch by design. Audit empirically via `omk bench debias-validate length`.
- **Saturation curves** (`omk bench saturation`, requires `--repeat ≥ 5`) — answers "do I have enough samples?". Three convergence methods (slope / bootstrap-ci-width / plateau-height); CI shrink rate < threshold across 3 windows = saturated.

### Added — Verdict and analysis surface

- `omk bench verdict <reportId>` — six-tier one-line verdict aggregating bootstrap CI / three-layer ci-gate / saturation / human α. Levels: PROGRESS / CAUTIOUS / REGRESS / NOISE / UNDERPOWERED / SOLO. Exit code routes for shell `&&` chains.
- HTML report top-of-page **verdict pill** sharing rules with the CLI.
- `omk bench diagnose <reportId>` — 7 sample-quality issue kinds (`flat_scores`, `all_pass`, `all_fail`, `near_duplicate`, `ambiguous_rubric`, `cost_outlier`, `latency_outlier`, `error_prone`) + 0-100 healthScore. CI-friendly exit code.
- `omk bench failures <reportId>` — single-LLM-call clustering of failure cases into ≤ N clusters with per-cluster root cause + suggested fix.
- `omk bench diff <reportId>` (single-arg) — within-report sample-level drilldown sorted by |Δ|; `--regressions-only` / `--top N` filters. Two-arg form (cross-report) preserved.

### Added — RAG metrics (auto length-debias)

- `faithfulness` / `answer_relevancy` / `context_recall` assertion types — single-call LLM judge with the same length-debias instruction as the main rubric. `reference` falls back to `sample.context` or `sample.prompt` as appropriate.
- `examples/rag-eval/` complete demo (3 samples covering grounded answer / concise summary / refusal).
- `docs/rag-metrics-spec.md` — prompt forms, comparison with RAGAS / DeepEval, known limitations.

### Added — Hard budget caps

- `--budget-usd` / `--budget-per-sample-usd` / `--budget-per-sample-ms` CLI flags.
- `eval.yaml` `budget: { totalUSD?, perSampleUSD?, perSampleMs? }` schema.
- `report.meta.budgetExhausted = true` flag when totalUSD trips abort; partial report persisted.
- Concept boundary documented:budget = workflow-level hard cap (abort);`cost_max` / `latency_max` assertions = per-sample scoring rules (continue).

### Added — Assertion improvements

- Universal `not: true` modifier — works on ANY assertion type (legacy `not_contains` / `not_equals` etc. preserved as aliases).
- `assert-set` combinator with `mode: 'any' | 'all'`, nestable.
- Deterministic similarity assertions: `rouge_n_min` / `levenshtein_max` / `bleu_min` — self-implemented, zero npm dep, supports CJK + Latin tokenization.

### Added — Production polish

- `omk bench verdict` and `omk bench diagnose` exit-code semantics designed for CI/CD chains
- HTML report verdict pill / pairwise CI / human-gold / saturation curve sections all 中英 i18n complete
- `examples/rag-eval/` and `examples/gold-dataset/` zero-config demos

### Changed

- SKILL.md updated:`--variants`(removed since v0.16) → `--control` / `--treatment`;`gen-samples` no longer takes a path;dead `references/commands.md` link replaced with README pointer.
- README zh + en synchronized to v0.20 surface (4 new CLI sections, 5 new feature rows, 3 new RAG assertion rows, budget vs `cost_max` concept boundary).
- Tagline rewritten to surface statistical rigor first ("LLM evaluation framework with built-in statistical rigor...").
- npm `keywords` expanded from 9 → 20 with long-tail SEO terms (bootstrap-ci / krippendorff-alpha / rag-evaluation / llm-judge / evaluation-as-code etc.).

### Removed

- Phase 3b position-aware judge debias permanently dropped — omk does per-(sample × variant) independent scoring rather than pairwise comparison, so classic position bias is not present in this architecture.

### Tests

- 503 → **673 tests passing** (+170 covering Bootstrap / α / Saturation / Verdict / RAG / Budget / Diagnose / Failure clustering)

---

## [0.19.0] - 2026-04-24

First iteration after the initial public release — product polish + open-source day-1 discoverability.

### Production observability (`omk analyze`)

- Renamed `production-analyzer` → `skill-health-analyzer` (closer to what the report actually shows)
- Separated **execution failure rate** from **knowledge gap rate** (a flaky tool chain is not the same as a missing skill)
- Added **cost / duration / turns** dimensions per skill (billable vs. cached tokens shown separately)
- Added **stability** classification per skill (`stable` / `unstable` / `very-unstable`) with 20% / 40% failure-rate thresholds
- Skill attribution signal 3: fallback via `Read SKILL.md` when the session didn't invoke the Skill tool explicitly
- Aligned `omk analyze` output with `omk bench` — JSON-only artifact, HTML rendered on-demand by `omk bench report`

### Report server

- **Skill health trend** page: per-skill time series (gap / weighted-gap / failure / coverage / tokens / duration)
- **Skill health diff** page: side-by-side comparison of two analyses with sort + removed/new tags
- Observability pages fully internationalized (EN / ZH), language choice persists across pages via URL + localStorage
- Version fingerprint UX: labeled "Version fingerprint" / "版本指纹" with tooltip, truncated to first 12 hex of SHA-256

### Offline evaluation (`omk bench`)

- Fixed `--each --repeat N` silently swallowing repeat (each-branch now threads `repeat`/`each` through `EvaluationRequest`)
- Fixed `--each` mode incorrectly requiring `--control` / `--treatment` variant-role arguments
- Per-skill variance now surfaces correctly in `--each` mode (was previously discarded)
- Unified separator in each-mode overview subtitle (`·` instead of mixing `·` and `×`)

### Open source

- English-first README with `README.zh.md` mirror; top-bar language switcher
- Gitflow branching model: `main` for tagged releases, `develop` for integration (see `CONTRIBUTING.md`)
- npm keywords expanded to 9 (added `claude-code`, `prompt-engineering`, `evaluation-framework`); added `homepage` and `bugs` fields
- Community files: `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue forms templates, PR template
- GitHub topics enriched with `claude-code` + `evaluation-framework`

### Developer experience

- Unified "six-dimension" terminology across README / docs / renderer (replaced stale "four-dimension" references)
- Per-page language persistence in report server
- CI runs `yarn build` before `yarn test` (fixes `test/cli.test.ts` dependency on `dist/`)

---

## [0.18.0] - 2026-04-23

Initial public release.

### Offline evaluation (`omk bench`)

- Controlled-variable experiments: fix the model and samples, vary only the artifact and runtime context
- Six-dimension scoring shown independently: **Fact / Behavior / LLM-judge / Cost / Efficiency / Stability**
- 18 assertion types (substring, regex, JSON Schema, semantic similarity, tool-call behavior, custom JS, cost / latency caps, …)
- Multi-executor support: Claude CLI / Claude SDK / OpenAI / Gemini / Anthropic API / OpenAI API / any custom command
- Batch mode `--each` for evaluating multiple independent artifacts vs baseline in one run
- Multi-run variance analysis `--repeat N` with Welch t-test, Cohen's d, 95% CI independently per scoring layer
- Blind A/B mode, interleaved scheduling, parallel execution, result caching, artifact version fingerprint
- Knowledge-gap signals with severity weighting and LLM-assisted hedging classification (quantify risk exposure, not completeness proof)
- CI gate `omk bench ci` with three-layer all-pass semantics (catches single-layer regressions the composite would hide)
- Self-iterating improvement `omk bench evolve` (LLM rewrites → re-evaluate → keep if better → repeat)
- MCP-based URL fetching for private-doc URLs (SSO-protected knowledge bases)

### Production observability (`omk analyze`)

- Skill-health reports from Claude Code session traces: coverage / gap signals / execution stability / token & latency per skill
- Time-window filtering (`--last 7d` / `--from` / `--to`), skill whitelist, auto-inferred knowledge-base root
- Execution-stability warning when a skill's tool-failure rate exceeds 20% (flags gap signals as possibly environmental noise)
- Skill health **trend** view (per-skill time series: gap / failure / coverage / tokens)
- Skill health **diff** view (side-by-side comparison of two reports)

### Report server

- Local HTML report service (`omk bench report`), browses eval reports and skill-health reports in one place
- EN / ZH one-click language toggle, language choice persists across pages
- Evaluation-as-code via `eval.yaml` config

### Requirements

- Node.js >= 20
- `claude` CLI for the default executor and LLM judge; optional when using other executors with `--no-judge`
