# CLAUDE.md - Agent 入场清单

omk 是 LLM 评测框架。所有改动都要优先保护测量可比性。

## 开工先做

- 改代码前先看 `CHANGELOG.md` 的 `[Unreleased]`。
- 涉及 commit、PR、分支或发版时，先看 `CONTRIBUTING.md`。
- 交付前默认跑 `yarn lint && yarn build && yarn test`，除非用户明确要求只做更窄验证。

## 硬规则

- 遵守 `CONTRIBUTING.md` 的 Gitflow：普通 feature / fix / docs / chore PR 进 `develop`；release / hotfix 走专门路径。
- 不要直接在 `main` 或 `develop` 上提交。
- commit 格式：`type(scope): 中文 subject`。scope 用稳定模块名，如 `cli` / `i18n` / `judge` / `renderer` / `eval-core` / `eval-workflows` / `inputs` / `executors` / `server` / `analysis` / `authoring` / `grading` / `doctor` / `release` / `claude-md`。
- 用户可见、发版相关或影响 construct validity 的改动，要更新 `CHANGELOG.md` `[Unreleased]`。
- 不要在给用户看的 URL 里硬编码 report server 端口；使用 `server.start()` 返回的实际 URL。

## 测量学不变量

这些是跨版本报告可比性的锚点，不要静默修改：

- `src/types/report.ts` 里的 Report JSON schema 字段语义。
- `test/grading/judge-hash-frozen.test.ts` 冻结的 judge prompt hash。
- 五层评分管道语义：assertion / llm / judge / dimension / composite。
- Bootstrap CI 和 Krippendorff alpha 公式。
- Length-debias toggle 语义：`--no-debias-length` 与 prompt v2/v3 的对应关系。

确实需要改不变量时，必须在 `CHANGELOG.md` 标明 BREAKING-COMPARABILITY，并按 `CONTRIBUTING.md` 的版本规则处理。

## 写作规则

- CLI / 报告 UI / 错误信息等 user-facing 文案中文优先。
- LLM judge 译为 `评委`，不要译为 `判官`。
- CHANGELOG 每条保持克制：3-5 行，写用户影响、迁移说明、construct-validity 或测量学 caveat，并链接 PR。不要写行号、测试用例清单或嵌套实现细节。

## UI / Judge 改动

- 改 judge prompt 文本前，先确认 `test/grading/judge-hash-frozen.test.ts` 的影响，不要随手更新 hash。
- 改报告 UI 后，先 review `test/__snapshots__/html-renderer.test.ts.snap` diff，再决定是否更新 snapshot。

## 参考

- 用户文档：`README.md` / `README.zh.md`
- Claude Code skill：`SKILL.md`
- 设计 spec：`docs/`
- 分支 / 发版 / 贡献细节：`CONTRIBUTING.md`
