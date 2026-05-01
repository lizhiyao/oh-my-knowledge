# Changelog

All notable changes to `oh-my-knowledge` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

> **写作风格**:每条改动 3-5 行,链 PR # 让需要细节的人去看。详情见 commit / PR description / git tag,本文档只保留 user-facing 影响 / BREAKING / migration 指引 / 测量学不变量 callout。规则在 [CLAUDE.md](./CLAUDE.md)「写代码约定」段。0.18.0 - 0.23.0 的历史段已按规则一次性 backfill 精简(完整文本见对应 git tag 或 GitHub Release notes)。

---

## [Unreleased]

### Added

- **codex-cli executor**(`--executor codex`):接入 OpenAI Codex CLI 当被测 / 评委,跟 Claude Code 同类 agent CLI 对位。token 统计齐全,best-effort 抽 codex 事件流到 omk trace。skill isolation 仅 cwd 一条 channel(codex 没 SDK skill 等价物),`allowedSkills=[]` 强制 cwd 非空。EXECUTOR_REGISTRY 加 `'codex'` 跟 `'claude'` 对齐。详见 #31。
- **codex-sdk executor**(`--executor codex-sdk`):接入 `@openai/codex-sdk` 自带的 `@openai/codex` binary 和 SDK 事件流,复用 codex trace / token / cost-not-reported 语义。Construct validity:CODEX_HOME 隔离到 per-process tmp 防 `~/.codex/config.toml` 渗入 eval(等价 codex CLI `--ephemeral` + `--ignore-user-config`,auth.json symlink 透传);SIGINT 联动 abortController 让 PR #33 的 nested-host orphan 修复对 SDK 子进程同样生效。详见 #36。
- **executor runtime 指纹写入 report**:`meta.executorRuntimes` 按 variant 记录实际执行环境,`meta.executorRuntime` / `meta.judgeRuntime` 保留总览。指纹包含 binary 或 SDK 版本、模型和能力快照(system prompt / cost / trace / isolation)。HTML 报告展示指纹,`bench diff` / `bench verdict` 在缺失或不一致时提示 strict comparability 风险。详见 #37。

### Changed

- **cost 显示「—」 而非 `$0.0000`**(executor 不报 cost 时):`ExecResult` / `VariantResult` / `VariantSummary` / `GradeResult` 加 `costReportedByExecutor` / `execCostReported` / `judgeCostReported` 三层 flag,全可选缺位 ≡ true(老报告兼容)。Renderer(HTML detail / list / each / trends / variance chart / CLI bench diff / bench evolve)全部识别该 flag,not reported 时显示「—」+ tooltip 解释。详见 #31。
- **⚠ BREAKING:`bench run --each` 产物改为 `EvaluationBatchIndex` + child `EvaluationReport`** —— 顶层 batch index 只保存批次索引和摘要,每个 skill vs baseline 单独持久化为可比较的原子报告。删除 `Report.each` / `overview` / `artifacts` 这类混合 schema,`bench diff` / `verdict` / `diagnose` 等命令现在只接受 child reportId。旧 each 报告不做兼容迁移。

### Fixed

- **SIGINT 传播到 spawn 出来的子进程**(嵌套 host CLI 下避免 child orphan):用户在 host CLI(codex / claude code)按 Ctrl+C 时,omk spawn 的内层 codex / claude / gemini / script 子进程之前会成 orphan 跑到 timeout。新 `spawnWithSigintPropagation` helper 统一 SIGINT / timeout / abortSignal 三条 kill 路径,SIGTERM + 500ms grace + SIGKILL 兜底。**行为变化**:gemini / script 加 10MB maxBuffer 上限(旧 spawn 实现无限制);timeout grace 多 500ms(120s 默认下不显著)。详见 #33。
- **⚠ BREAKING-COMPARABILITY:`cacheKey()` 加 executor runtime 指纹,prefix `v3:` → `v4:`** —— 同 executor 换 binary / SDK 版本时旧 cache 不再误命中,避免报告写入新 runtime 指纹但输出来自旧 runtime。runtime 探测改用 executor 实际 `PATH` 形态,`codex-sdk` bundled `@openai/codex` 版本按 SDK 解析链读取。详见 #37。
- **⚠ BREAKING-COMPARABILITY:`cacheKey()` 加 executor 名,prefix `v2:` → `v3:`** —— 同 model 名跨 executor(如 `gpt-4o` 走 `openai-api` vs `codex`)旧 v2 schema 互相污染缓存。旧 v2 cache 一次性失效,无数据丢失,首跑无 cache 加速(同 v0.22.0 加 allowedSkills 那次 pattern)。详见 #31。

### Removed

- **⚠ BREAKING:删 `openai-cli` executor 及 `'openai'` alias** —— 跟 `'openai-api'` HTTP 实现职责重复(同 endpoint / token schema / `OPENAI_API_KEY` env),`openai-cli` 多一层 Python CLI binary 子进程,无独有便利。`--executor openai` 现在会 fall through 到 script executor 失败,改用 `--executor openai-api`。alias 从未被 README 推荐过,影响面小。详见 #32。

---

## [0.23.0] - 2026-04-29

### Added

- **测评用例科学性 v1**(对标 HELM / MMLU-Pro / Construct Validity / HF Dataset Cards):`Sample` schema 加 4 个可选元数据字段(`capability` / `difficulty` / `construct` / `provenance`),纯文档/诊断用,**完全不参与 grading / judge / verdict / Report 顶层 schema**(测量学不变量保护,跨版本 verdict / Δ 完全可比)。`bench diagnose` 加 `rubric_clarity_low` / `capability_thin` 两类 issue + sample design coverage 块。`bench gen-samples` 自动注入 `provenance: 'llm-generated'`。`Report.analysis.sampleQuality` 子结构(纯文档聚合,老报告兼容)。新建 [docs/sample-design-spec.md](docs/sample-design-spec.md) 设计 spec。

---

## [0.22.0] - 2026-04-28

### Changed

- **⚠ BREAKING:report server URL `/run/<id>` → `/reports/<id>`** —— 命名跟 `Report` 类型 / `~/.oh-my-knowledge/reports/` 目录 / `omk bench report` CLI 对齐;`/api/run/<id>` → `/api/reports/<id>`;`/api/runs` → `/api/reports`。直接删旧路径不留 alias(omk 0-1 阶段)。已有书签需要更新。
- **⚠ BREAKING-COMPARABILITY:`bench run` / `bench gate` 默认对 baseline-kind variant 启用 skill isolation**(`--strict-baseline` default true)—— 之前 baseline 通过三条 channel(SDK skill auto-discovery / subagent Skill 工具 / cwd 文件系统)拿到 `~/.claude/skills/` 全部 skill 污染评测,verdict 看着 NOISE 实为污染。本版默认三堵(main session skills / Skill 工具 / cwd 切到 isolated empty dir),验证用例集 verdict 从 NOISE 翻盘到 PROGRESS。`--no-strict-baseline` 是 opt-out 逃生口。`eval.yaml` 加 `variants[].allowedSkills?: string[]` 显式声明。`cacheKey` 升 `v2:` prefix + 含 allowedSkills,旧 cache 一次性失效。`report.meta.skillIsolation` 新字段供跨报告对比。**旧报告无此字段,verdict / Δ 不可跨版本对比**——等同 judge prompt bump 一档。设计 spec 见 [docs/terminology-spec.md §七](docs/terminology-spec.md)。

### Fixed

- **`VariantSummary.toolDistribution` 修真实 call count** —— 之前按 `result.toolNames`(per-sample dedup)累加,语义是"出现该 tool 的 sample 数"。修法:`VariantResult` 加 per-sample `toolDistribution`(从 `toolCalls` reduce),aggregate sum per-sample 字段。旧报告无该字段时 fallback 老 `toolNames` 语义保兼容。
- **release hardening**:report server 测试改动态端口(`port: 0`)避免 7799 占用 flake;`eval.yaml` `blind: true` 不再被 CLI 默认值覆盖(只显式 `--blind` 才覆盖);启动期 `package.json` 查找改 5 层向上,修发布包 `dist/src/package.json` 不存在导致的静默失效。

---

## [0.21.0] - 2026-04-27

Minor — `bench ci` 改名 `bench gate`(消除 omk 里 "CI" 歧义,从此 CI 永远只指置信区间);single-run 盲区在用户旅程三处可见;CLI 双语 i18n 全面落地;发版自动化(publish.yml 自动从 CHANGELOG 抽 release notes 建 GitHub Release)。

> 注:0.20.2 已 merge 到 main 但未发到 npm,从 0.20.1 升级会一次性收到 0.20.2 + 0.21.0 两批改动。

### Added

- **CLI 双语输出 (zh / en)**:所有 CLI 输出支持中英双语。优先级 `--lang` flag > `OMK_LANG` env > 默认 `zh`。覆盖 `--help`、所有子命令 help、实时进度、参数校验、`bench gen-samples` / `evolve` / `gold` / `saturation` runtime 反馈。基础设施在 `src/cli/i18n.ts` + `src/cli/i18n-dict.ts`(~80 个 key,zh/en 双写,Record 类型对齐)。
- **Single-run 盲区在用户旅程三处可见**——CLI 跑前 stderr(N<5 / N<20 / repeat=1 三档结构性 hard-floor 预警);`bench verdict` / `bench gate` 加 `rationale.stability`(单轮显式说"稳定性未测量,需 --repeat ≥ 2");HTML 报告稳定性列从灰 `—` 改红 `⚠ 未测量` + 引导文案。

### Changed

- **⚠ BREAKING:`bench ci` → `bench gate`** —— 消除 omk 内 "CI" 歧义(既指 Continuous Integration 又指 Confidence Interval),从此 omk 里 **CI 永远只指置信区间**。`evaluateCiGates` → `evaluateLayerGates` / `CiGateResult` → `LayerGateResult`,文件 `ci-gates.ts` → `layer-gates.ts`。**直接删旧命令不留 alias**(omk 0-1 阶段)。同步行为变更:gate 内核统一为 verdict —— exit code 与 `bench verdict` 对齐,只 PROGRESS / SOLO-pass 才 0,UNDERPOWERED / NOISE / CAUTIOUS / REGRESS 全 1。新增 `--trivial-diff` 调"实际可忽略的小差距"门限。**迁移**:CI/CD pipeline `omk bench ci` → `omk bench gate`。
- **user-facing 中文文案统一用「用例」,不用「样本」**——`docs/terminology-spec.md` §6 显式规则。代码 / API / 文件名 / CLI flag(`Sample` / `sample_id` / `eval-samples.json` / `--samples`)继续 `sample`(开源 API 通用术语),只 user-facing zh 切换。理由:omk eval-samples 是开发者**手挑**的测试用例,「样本」会误导为统计抽样。统计学场景(Cohen's d 小样本修正、bootstrap 重采样等)保留「样本」。
- **lib 层(非 cli)user-facing 错误统一英文**:遵循"对客表达层 i18n / 内部实现层统一英文"分层原则,zh 用户看到的最终输出形如"错误: skill file not found: /path"——前缀 cli 层本地化,内部错误细节英文。

### Fixed

- **directory-skill 路径解析(`SKILL.md` 约定)**——符号链接 / 非 cwd 子目录里的 directory-skill(如 `~/.claude/skills/foo/SKILL.md` 引用 `assets/...` 相对路径)在评测时 preflight 文件依赖互相覆盖产生 false-positive missing,运行时 cwd = `process.cwd()` 而非 skill 根导致 Read 工具找不到文件。修法:`Artifact` 加 `skillRoot?: string`,`task-planner.ts` cwd fallback 链改为 `artifact.cwd > artifact.skillRoot > sample.cwd > null`,依赖检查按 artifact 分桶。
- 依赖文件提取 regex 收紧(`.d.ts` / `index.ts` 这种示例性提及不再被误识别为依赖,要声明 bare 文件依赖请用显式 `requires:`)。

### Internal

- `publish.yml` 自动从 CHANGELOG 抽 release notes 创建 GitHub Release(push tag `v*` → `npm publish` → 找 CHANGELOG `## [VERSION]` section 当 Release body)。维护者只需 bump version + 改 CHANGELOG `[Unreleased]` → `[VERSION] - YYYY-MM-DD`。

---

## [0.20.1] - 2026-04-26

Patch — verdict 用户可见性升级 + 内部类型重构 + 测量学不变量保护(为 v0.21 路线做地基)。

### Added

- **列表页 verdict status pill**(明显进步 / 略微进步 / 基本持平 / 明显退步 / 样本不足 / 无法对比),首页一眼分辨。
- **judge prompt hash 字节级冻结测试**(`test/grading/judge-hash-frozen.test.ts`)—— 写死 v2-cot / v3-cot-length 的 12-char hex hash,任何动 prompt 文本立即失败,防跨版本报告不可比的隐性破坏。
- **ReportMeta.schemaVersion** 字段(v0.21+ 写 `1`,无字段视为 v0)+ html-renderer + i18n 双语 snapshot 测试基线。

### Changed

- **详情页 verdict 重写为一句话副标**(中文措辞自带状态信号,如「测评结论: skill 和 baseline 没看出明显差别 — 可以加大样本量再试」)。砍 banner / Δ 数字 / 副标 / 三层得分 strip / CTA 块。
- **`src/types.ts`(859 行)按消费域拆分**到 `src/types/{shared,executor,judge,eval,report,storage}.ts` + `index.ts`。原 `types.ts` 改 1 行 facade,95+ 处 import 路径 100% 不变。

### Fixed

- `computeVerdict` 在 each mode + 顶层 summary 缺 variant 数据的脏老报告上 NPE —— 渲染器层 try/catch 兜底,失败的 row(列表页)或 verdict 区(详情页)静默跳过。根因(`evaluateCiGates` 访问 undefined.avgFactScore)留 v0.21 单独修复。

---

## [0.20.0] - 2026-04-25

Major — statistical rigor 升一档,从 "evaluation runner" 转成 "evaluation reasoning system"。**503 → 673 tests**(+170 covering Bootstrap / α / Saturation / Verdict / RAG / Budget / Diagnose)。

### Added — 统计严谨性四件套

- **Bootstrap CI**(`--bootstrap` / `--bootstrap-samples`)—— 无分布假设的 variant 均值 CI + pairwise diff CI。t-test 在 ordinal LLM 评分上不可信,bootstrap 在小 N(<30)+ 偏态数据上仍 valid。CI 不跨 0 即显著。
- **Human gold dataset workflow + Krippendorff α** —— `omk bench gold {init,validate,compare}` + `omk bench run --gold-dir`。引入外部锚点;omk warn 当 gold annotator 跟 judge 是同模型。支持 α ordinal weights / weighted κ / Pearson + α 的 bootstrap CI。
- **Length-controlled judge prompt**(default ON,hash `v3-cot-length`)—— LLM 评委已知有"长答案=高分"偏置,新 prompt 显式声明"length is not a quality signal"。**老报告 hash mismatch by design**。`omk bench debias-validate length` 实证审计。
- **Saturation curves**(`omk bench saturation`,需 `--repeat ≥ 5`)—— 回答"我的样本量够不够?"。三种收敛方法(slope / bootstrap-ci-width / plateau-height)。

### Added — Verdict / 分析面

- `omk bench verdict <reportId>` —— 6 档一句话结论(PROGRESS / CAUTIOUS / REGRESS / NOISE / UNDERPOWERED / SOLO),聚合 bootstrap CI + 三层 ci-gate + saturation + human α。HTML 报告顶部同款 verdict pill。
- `omk bench diagnose <reportId>` —— 7 类 sample-quality issue + 0-100 healthScore,CI 友好 exit code。
- `omk bench failures <reportId>` —— 单 LLM call 把失败用例聚类到 ≤ N 个簇,每簇给 root cause + 建议 fix。
- `omk bench diff <reportId>` 单参形式 —— 同报告内 sample-level drilldown 按 |Δ| 排序;`--regressions-only` / `--top N` 过滤。

### Added — RAG metrics(自带 length-debias)

- `faithfulness` / `answer_relevancy` / `context_recall` 断言类型 —— 单 LLM call,内置同主 rubric 一致的 length-debias 指令。
- `examples/rag-eval/` 完整 demo + [docs/rag-metrics-spec.md](docs/rag-metrics-spec.md) 跟 RAGAS / DeepEval 对比。

### Added — Hard budget caps + 断言改进

- `--budget-usd` / `--budget-per-sample-usd` / `--budget-per-sample-ms` + `eval.yaml` `budget` schema。`report.meta.budgetExhausted=true` 时 partial report 持久化。**概念边界**:budget = workflow 级 hard cap(abort),`cost_max` / `latency_max` 断言 = per-sample 评分(continue)。
- 通用 `not: true` 修饰符(legacy `not_contains` / `not_equals` 保留 alias);`assert-set` 组合器(`mode: 'any' | 'all'`,可嵌套);确定性相似度断言 `rouge_n_min` / `levenshtein_max` / `bleu_min`(自实现零 npm dep,支持 CJK + Latin tokenization)。

### Removed

- Phase 3b position-aware judge debias 永久 drop —— omk 是 per-(sample × variant) 独立打分非 pairwise,classic position bias 在本架构下不存在。

---

## [0.19.0] - 2026-04-24

首个 public release 后的迭代 —— 产品打磨 + open-source day-1 可发现性。

### Added

- **`omk analyze`(production observability)**:重命名 `production-analyzer` → `skill-health-analyzer`;**execution failure rate** vs **knowledge gap rate** 拆开(flaky tool chain ≠ missing skill);加 cost / duration / turns per skill;**stability** 分类(stable / unstable / very-unstable,20% / 40% 失败率阈值);Skill 归因 fallback via `Read SKILL.md`。
- **Report server**:Skill health trend(per-skill 时序)+ diff(两份分析对比)页面;observability 页 EN/ZH 完整 i18n;版本指纹 UX(SHA-256 前 12 hex + tooltip)。
- **Open source day-1**:English-first README + `README.zh.md` mirror + 顶部 lang switcher;Gitflow 分支模型(`main` tag release / `develop` 集成);CODE_OF_CONDUCT / SECURITY / issue+PR templates;npm keywords 扩 9 个 + GitHub topics。

### Fixed

- `--each --repeat N` 静默吞 repeat(each 分支 thread `repeat`/`each` 进 `EvaluationRequest`);`--each` 错误要求 `--control` / `--treatment` 参数;per-skill variance 在 `--each` 下消失。

---

## [0.18.0] - 2026-04-23

**Initial public release**。

### Offline evaluation(`omk bench`)

- Controlled-variable experiments(固定 model + samples,只变 artifact + runtime context)
- **六维评分独立呈现**:Fact / Behavior / LLM-judge / Cost / Efficiency / Stability
- **18 类断言**:substring / regex / JSON Schema / semantic similarity / tool-call behavior / custom JS / cost / latency caps / 等
- **多执行器**:Claude CLI / Claude SDK / OpenAI / Gemini / Anthropic API / OpenAI API / 任意 custom command
- **批量模式 `--each`**(多 artifact vs baseline 一次跑)+ **多轮方差** `--repeat N`(Welch t-test / Cohen's d / 95% CI 三层独立)
- Blind A/B / interleaved scheduling / parallel execution / result caching / artifact 版本指纹
- Knowledge-gap signals 含严重度加权 + LLM-assisted hedging classification(量化风险敞口,不是完整性证明)
- CI gate `omk bench ci` 三层 all-pass(后 v0.21 改名 `bench gate`)
- Self-iterating `omk bench evolve`(LLM rewrite → re-eval → keep if better → repeat)
- MCP-based URL fetching(SSO-protected 私有文档)

### Production observability(`omk analyze`)

- Skill-health reports from Claude Code session traces(coverage / gap signals / stability / token & latency per skill)
- 时间窗(`--last 7d` / `--from` / `--to`)+ skill 白名单 + auto-inferred 知识库 root
- Trend / diff 视图

### Report server

- 本地 HTML 报告服务(`omk bench report`),eval 报告 + skill-health 报告统一浏览。EN/ZH 一键切换 + 跨页持久化。
- Evaluation-as-code via `eval.yaml`。

### Requirements

- Node.js >= 20
- `claude` CLI for default executor + LLM judge(用别的 executor 加 `--no-judge` 时可选)
