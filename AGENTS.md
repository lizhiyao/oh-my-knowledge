# AGENTS.md - Agent 入场清单

omk 是面向 LLM 知识输入（prompt / RAG / skill / agent）的评测与迭代框架，固定模型只变知识载体，三阶段 doctor / eval / observe 输出统计可比的诊断，配套 sample / evolve 做用例生成与自动迭代。所有改动都要优先保护测量可比性。

本文件是 [agents.md](https://agents.md) 开放标准约定的多 agent 入场清单，跨 Claude Code / Codex / Cursor / Aider / Gemini CLI 等工具通用。Claude Code 用户：本仓库的 `CLAUDE.md` 通过 `@AGENTS.md` import 同一份内容，无需重复维护。

## 开工先做

- 涉及 commit、PR、分支或发版时，先看 `CONTRIBUTING.md`。
- 交付前默认跑 `yarn lint && yarn build && yarn test`，除非用户明确要求只做更窄验证。

## 硬规则

- 遵守 `CONTRIBUTING.md` 的 GitHub Flow：`main` 是唯一长期分支；feature / fix / docs / chore 从 `main` 切短分支，通过 PR 回 `main`；release / hotfix 也通过短分支 PR 回 `main`，再由 tag 触发发版。
- 不要直接在 `main` 上提交；不要再把新工作提交到 `develop`。
- commit 格式：`type(scope): 中文 subject`。scope 用稳定模块名，如 `cli` / `i18n` / `judge` / `renderer` / `eval-core` / `eval-workflows` / `inputs` / `executors` / `server` / `analysis` / `authoring` / `grading` / `doctor` / `release` / `agents-md`（早期 git history 用过 `claude-md`，rename 后统一用 `agents-md`）。
- 不要在给用户看的 URL 里硬编码 report server 端口；使用 `server.start()` 返回的实际 URL。
- 判别字段命名：新建或可安全改名的字段中，裸 `kind` 默认只表示 `Artifact.kind: ArtifactKind`（baseline / skill / prompt / agent / workflow）。例外是已经发布并落盘/对外暴露的 public schema（如 report / doctor / observe / diagnosis 的顶层 `kind`），这些既有 `kind` 字段不要顺手改成限定名；确需改名时单独做 schema / data migration，并保持读取旧文件。其它新判别字段用限定名（`eventKind` / `runtimeKind` / `standardKind` 等）。细节见 `docs/specs/terminology-spec.md` §5.4，CI 有 `test/scripts/kind-semantics-guard.test.ts` 拦新裸 `kind`。

## 测量学不变量

这些是跨版本报告可比性的锚点，不要静默修改：

- `src/types/report.ts` 里的 Report JSON schema 字段语义。
- `test/shared/prompt-registry-freeze.test.ts` 冻结的全部评分类 prompt hash（rubric 评委 / RAG / semantic / observe LLM 增强复盘），由 `src/shared/llm-prompts/registry.ts` 的 `PROMPT_REGISTRY` 驱动；评分类 prompt 文本统一在 `src/shared/llm-prompts/`。
- 五层评分管道语义：assertion / llm / judge / dimension / composite。
- Bootstrap CI 和 Krippendorff alpha 公式。
- Length-debias toggle 语义：`--no-debias-length` 关掉 rubric 评委的长度去偏（debias-off prompt 变体）；排版 / 语气中性化不受其影响、恒开。

确实需要改不变量时，必须在 PR 标题 / description 明确标 `BREAKING-COMPARABILITY`（GitHub Release notes 会从 PR title 自动汇总），并按 `CONTRIBUTING.md` 的版本规则处理。

## 写作规则

- CLI / 报告 UI / 错误信息等 user-facing 文案中文优先。
- 代码审查（用户说 `cr` / `review` / 要看 PR）完成后，必须把 CR 评论直接发到对应 PR；不要只在对话里给结论；评论语言跟随用户操作系统设置语言。
- 中文文案统一用全角标点 `，。：；！？（）「」`，符合 GB/T 15834《标点符号用法》。半角 `,.():` 只在以下技术混排里出现：代码块（``` ```）、inline code（`...`）、文件路径、命令行、URL、YAML/JSON frontmatter、数学区间（`[lo, hi]`）、citation 年份（`(2023)`）、`executor:model` 风格的标识符、英文术语 / 技术枚举的括注（如 `用例隔离(construct validity)`、`verdict(PROGRESS / ...)`、`omk 版本(reportMeta.cliVersion)`：括号内容是英文术语、API 字段、枚举值，半角更易复制粘贴）。范围：README.zh.md / docs/zh / SKILL.md / src 内 zh 字符串 / PR description / commit message 的中文 subject 部分。例外：commit 的 `type(scope):` 前缀是 Conventional Commits 语法保留半角，只有冒号后的中文 subject 走全角（写成 `docs(readme): 中文 subject`，不是 `docs（readme）：中文 subject`）。
- LLM judge 译为 `评委`，不要译为 `判官`。
- PR description 写用户影响、迁移说明、construct-validity 或测量学 caveat，链接相关 issue / 前置 PR。不要写行号、测试用例清单或嵌套实现细节 — 那些 git diff 里都有。

## UI / Judge 改动

- 改任何评分类 prompt 文本前（rubric 评委 / RAG / semantic，均在 `src/shared/llm-prompts/`），先确认 `test/shared/prompt-registry-freeze.test.ts` 的影响，不要随手更新冻结 hash。
- 改 observe LLM 增强复盘 prompt 文本前，先确认同一冻结测试里 `observe-llm-enhanced-review` 条目的影响；如果 runtimeAssessment 可比性会变化，PR 标题 / description 必须标 `BREAKING-COMPARABILITY`。
- 改报告 UI 后，先 review `test/__snapshots__/html-renderer.test.ts.snap` diff，再决定是否更新 snapshot。

## omk 自带 skill 安装（跨 agent）

仓库根 `.agents/skills/omk/` 是 omk 智能代理 skill 的**单一来源**——中性路径，跟 [AGENTS.md 标准](https://agents.md/)同源。在本仓库里 clone 即用，无需额外操作：

- **Codex**：原生加载 `.agents/skills/omk/`（Codex 从 cwd 向上扫到仓库根的 `.agents/skills/`）。
- **Claude Code**：通过软链 `.claude/skills/omk` → `.agents/skills/omk` 加载。

用户安装 npm 包后，推荐用内置安装命令把 omk 官方 Agent Skill 装到本机 agent 工具：

```bash
omk install omk-agent-skill
```

默认只写入本机已检测到、且 omk 明确支持的目标：检测到 `~/.codex` 或 `~/.agents` 时写入 Codex/AGENTS，检测到 `~/.claude` 时写入 Claude Code。需要强制写入当前 omk 已知的全部目标时，用 `--to all`；需要自定义 skill 根目录时，用 `--dest`。

仓库开发或手动复用时，也可以把 `.agents/skills/omk/` 整目录拷到对应工具的 skill 目录：

```bash
# Claude Code（全局）
cp -r .agents/skills/omk ~/.claude/skills/omk
# Codex（全局）
cp -r .agents/skills/omk ~/.agents/skills/omk
# Cursor / Aider / Gemini CLI 等：按各工具文档放到对应 skill 目录
```

skill 内容跟 agent 解耦（不依赖任何工具专属能力），可在任意支持 markdown skill 的 agent 里工作。跨多个评测项目大规模复用时，再考虑抽成 plugin / 独立发布包。

## 参考

- 用户文档：`README.md` / `README.zh.md`
- omk skill 入场：`.agents/skills/omk/SKILL.md`（单一来源，见上节）
- 设计 spec：`docs/`
- 分支 / 发版 / 贡献细节：`CONTRIBUTING.md`
