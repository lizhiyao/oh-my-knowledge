# Changelog

All notable changes to `oh-my-knowledge` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

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

- **CLI 默认输出从英文混搭中文改为彻底双语化**:之前 `omk bench run` / `omk --help` / 进度反馈混合中英文(例如 "评测完成 done"),用户每次 review 报告或调试都要"切语境"。本版整体重写:中文用户读到的全是中文,英文用户读到的全是英文,无任何中英混搭。
- **lib 层(非 cli)user-facing 错误统一英文**:遵循"对客表达层 i18n / 内部实现层统一英文"分层原则,把 `src/inputs/eval-config.ts`(16 处)/ `skill-loader.ts`(5 处)/ `load-samples.ts`(4 处)/ `eval-workflows/run-evaluation.ts`(3 处)/ `inputs/url-fetcher.ts`(2 处)/ `inputs/mcp-resolver.ts`(4 处)/ `executors/{anthropic,openai}-api.ts`(2 处)/ `eval-core/evaluation-execution.ts`(1 处)/ `server/report-server.ts`(2 处)/ `authoring/{generator,evolver}.ts`(6 处)/ `grading/gold-cli.ts`(1 处)的中文 `throw new Error` 和 `process.stderr.write` 改英文。zh 用户看到的最终输出形如"错误: skill file not found: /path"——前缀本地化(由 cli 层负责),内部错误细节是英文工程内容。
- **`unknown` 提示文案更准**:`未知模块` → `未知顶层命令`,`未知 bench 子命令` → `未知子命令: bench {command}`(中文语序更自然)。
- **`Skill 健康度日报` 中英混搭 bug 修复**:之前 HELP 主常量中文版混杂了中文短语 "skill 健康度日报",现在英文版改为 `skill health report`。

### Internal

- `src/cli.ts` 顶部 `const HELP` 142 行原英文模板字符串删除,内容完整迁到 dict。`HELP` 现通过 `tCli('cli.help.main', lang).trim()` 取得。
- 13 处 `parseArgs options` 块统一 spread `COMMON_OPTIONS = { lang: { type: 'string' } }`,所有子命令都接收 `--lang` flag。
- `defaultOnProgress` 改为 `makeOnProgress(lang)` factory:evaluation engine 异步回调时拿不到 argv,通过 closure 闭住 lang。每个 handler 入口通过 `langFromArgv(argv)` 一行拿到 lang 并传 factory。
- 测量学不变量未受影响:`src/grading/judge.ts` prompt 文本字节级未动,`test/grading/judge-hash-frozen.test.ts` 仍冻结 `v2-cot=fdc81b19c721` / `v3-cot-length=629bf3b8c41d` 两个 hash。
- 10 处测试 assertion regex 同步从中文更新为英文(`test/eval-config.test.ts` / `test/runner.test.ts` / `test/inputs/{load-samples,skill-loader}.test.ts` / `test/grading/gold-cli.test.ts`)。

### Fixed

- **(已知漏洞)CLI 中英混搭**:历史上 cli.ts / lib 层中混有大量"中文 stderr 嵌入英文 token / 英文 console.error 嵌入中文短语"。`grep -E "console\\.(log|error|warn).*[一-鿿]|process\\.stderr\\.write.*[一-鿿]|throw new Error.*[一-鿿]" src/` 现为 0 残留(除 `judge.ts` 测量学锚点不动)。

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
