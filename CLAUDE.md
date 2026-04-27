# CLAUDE.md — 协作者(包括 AI agent)入场必读

omk 是 LLM 评测框架,主打**统计严谨性**(Bootstrap CI / Krippendorff α / Length-debias / Saturation curves)+ verdict / RAG / budget 决策面。两条底线:**测量学不变量不能动**,**分支操作走 gitflow**。

## 开工前

- 看 [CHANGELOG.md](./CHANGELOG.md) `[Unreleased]` 段了解在做什么版本
- 改完跑 `yarn lint && yarn build && yarn test`
- 分支模型 / 发版细节 / commit 风格全在 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 分支策略

严格 gitflow:`feat/* | fix/* | docs/* | chore/*` → `develop` → `main`(release)。

PR base **永远是 develop**,绝不在 main / develop 直接 commit。release PR merge 后必须 fast-forward `develop = main`,否则 develop 永远落后一个 merge commit。

## 测量学不变量(绝对不能动)

这些是历史报告可比性的锚,改动会破坏跨版本对比:

- **Report JSON schema**:`src/types/report.ts` 里 `Report` / `ReportMeta` / `VariantResult` / `VariantSummary` 字段含义
- **Judge Prompt Hash**:`v2-cot=fdc81b19c721` / `v3-cot-length=629bf3b8c41d`,由 `test/grading/judge-hash-frozen.test.ts` 字节级冻结。动 `src/grading/judge.ts` 的 prompt 文本会立即 fail
- **五层评分管道**:assertion / llm / judge / dimension / composite 的算法和权重
- **Bootstrap CI 公式**(`src/eval-core/bootstrap.ts`)、**Krippendorff α 公式**(`src/grading/human-gold.ts`)
- **Length-debias toggle**(`--no-debias-length` 与 prompt v2/v3 的对应关系)

确需 bump 见 CONTRIBUTING,核心动作是 bump `JUDGE_PROMPT_VERSION_DEBIAS_*` + CHANGELOG 标 breaking-comparability。**不要悄悄改**。

## 写代码约定

- **commit message 前缀英文 + 正文中文**:前缀走标准 Conventional Commits(`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `ci` / `perf` / `style` / `build`),正文继续中文写。例:`feat(v0.21 D.1.c): 接通 --lang flag 和 OMK_LANG 环境变量` / `chore(release): bump 0.20.1 → 0.20.2`。不追溯改历史 commit(中文前缀的老 commit 不动)
- **user-facing 文案中文优先**(报告 UI / CLI / 错误信息)。LLM judge 译为「**评委**」,不译「判官」,不中英混用
- **CI gate 两个**:`test/grading/judge-hash-frozen.test.ts`(judge prompt 不变性)、`test/__snapshots__/html-renderer.test.ts.snap`(zh/en × list/detail UI 回归)。改 UI / judge 后 review snapshot diff,确认无误再 `vitest -u`
- **顺手更新 CHANGELOG `[Unreleased]`**(Keep a Changelog 风格:Added / Changed / Fixed / Internal)
- **不要硬编码端口**:report server 默认请求 7799 但实际 bound 端口取自 `server.start()` 返回值(7799 被占会切 7800+),所有给用户看的 URL 都用 `serverUrl` 实参

## 发版

push tag `v*` 触发 publish.yml 全自动:lint + build + test → `npm publish` → 从 CHANGELOG 抽对应 section 建 GitHub Release。维护者只 bump version + 改 CHANGELOG `[Unreleased]` → `[VERSION] - YYYY-MM-DD`。细节见 CONTRIBUTING。

## 其他参考

[README.md](./README.md) / [README.zh.md](./README.zh.md) 用户面文档,[SKILL.md](./SKILL.md) Claude Code skill 用法,[docs/](./docs/) 设计 spec(rag-metrics / knowledge-gap-signal / 等)。维护者本地 plan(不在仓库):`~/.claude/plans/iridescent-zooming-lynx.md`。
