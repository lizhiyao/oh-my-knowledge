# CLAUDE.md - Agent 入场清单

omk 是 LLM 评测框架。所有改动都要优先保护测量可比性。

## 开工先做

- 涉及 commit、PR、分支或发版时，先看 `CONTRIBUTING.md`。
- 交付前默认跑 `yarn lint && yarn build && yarn test`，除非用户明确要求只做更窄验证。

## 硬规则

- 遵守 `CONTRIBUTING.md` 的 GitHub Flow：`main` 是唯一长期分支；feature / fix / docs / chore 从 `main` 切短分支，通过 PR 回 `main`；release / hotfix 也通过短分支 PR 回 `main`，再由 tag 触发发版。
- 不要直接在 `main` 上提交；不要再把新工作提交到 `develop`。
- commit 格式：`type(scope): 中文 subject`。scope 用稳定模块名，如 `cli` / `i18n` / `judge` / `renderer` / `eval-core` / `eval-workflows` / `inputs` / `executors` / `server` / `analysis` / `authoring` / `grading` / `doctor` / `release` / `claude-md`。
- 不要在给用户看的 URL 里硬编码 report server 端口；使用 `server.start()` 返回的实际 URL。

## 测量学不变量

这些是跨版本报告可比性的锚点，不要静默修改：

- `src/types/report.ts` 里的 Report JSON schema 字段语义。
- `test/grading/judge-hash-frozen.test.ts` 冻结的 judge prompt hash。
- 五层评分管道语义：assertion / llm / judge / dimension / composite。
- Bootstrap CI 和 Krippendorff alpha 公式。
- Length-debias toggle 语义：`--no-debias-length` 与 prompt v2/v3 的对应关系。

确实需要改不变量时，必须在 PR 标题 / description 明确标 `BREAKING-COMPARABILITY`（GitHub Release notes 会从 PR title 自动汇总），并按 `CONTRIBUTING.md` 的版本规则处理。

## 写作规则

- CLI / 报告 UI / 错误信息等 user-facing 文案中文优先。
- 中文文案统一用全角标点 `，。：；！？（）「」`，符合 GB/T 15834《标点符号用法》。半角 `,.():` 只在以下技术混排里出现：代码块（``` ```）、inline code（`...`）、文件路径、命令行、URL、YAML/JSON frontmatter、数学区间（`[lo, hi]`）、citation 年份（`(2023)`）、`executor:model` 风格的标识符、英文术语 / 技术枚举的括注（如 `用例隔离(construct validity)`、`verdict(PROGRESS / ...)`、`omk 版本(reportMeta.cliVersion)`：括号内容是英文术语、API 字段、枚举值，半角更易复制粘贴）。范围：README.zh.md / docs/zh / SKILL.md / src 内 zh 字符串 / PR description / commit message 的中文 subject 部分。例外：commit 的 `type(scope):` 前缀是 Conventional Commits 语法保留半角，只有冒号后的中文 subject 走全角（写成 `docs(readme): 中文 subject`，不是 `docs（readme）：中文 subject`）。
- LLM judge 译为 `评委`，不要译为 `判官`。
- PR description 写用户影响、迁移说明、construct-validity 或测量学 caveat，链接相关 issue / 前置 PR。不要写行号、测试用例清单或嵌套实现细节 — 那些 git diff 里都有。

## UI / Judge 改动

- 改 judge prompt 文本前，先确认 `test/grading/judge-hash-frozen.test.ts` 的影响，不要随手更新 hash。
- 改报告 UI 后，先 review `test/__snapshots__/html-renderer.test.ts.snap` diff，再决定是否更新 snapshot。

## 参考

- 用户文档：`README.md` / `README.zh.md`
- Claude Code skill：`SKILL.md`
- 设计 spec：`docs/`
- 分支 / 发版 / 贡献细节：`CONTRIBUTING.md`
