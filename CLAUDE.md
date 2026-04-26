# CLAUDE.md — 协作者(包括 AI agent)入场必读

omk 是 LLM 评测框架,主打**统计严谨性**(Bootstrap CI / Krippendorff α / Length-debias / Saturation curves)+ verdict / RAG / budget 决策面。任何代码改动都要尊重测量学不变量,任何分支操作都要走 gitflow。

## Session 启动 checklist(任何动手 edit 之前)

1. `git branch --show-current` —— 看当前 working branch
2. **如果是 `main` 或 `develop`,必须先 `git checkout -b feat/<topic>` 再开始改**。绝不在 main / develop 直接 commit。
3. 读 [CONTRIBUTING.md](./CONTRIBUTING.md) 第一遍(分支模型 / 发版流程 / commit 风格)
4. 看 [CHANGELOG.md](./CHANGELOG.md) `[Unreleased]` 段了解在做什么版本
5. 阅读相关文件,写代码,跑 `yarn lint && yarn build && yarn test`
6. PR `--base develop`(只有 release PR 是 `--base main`)

## 分支策略(详见 CONTRIBUTING.md)

严格 gitflow,三层流:

```
feat/* / fix/* / docs/* / chore/*  →  develop  →  main(release)
```

PR base **永远是 develop**,除非是 release PR。release PR 由 `release/x.y.z` 分支或直接 develop → main 触发,merge 后**必须 fast-forward develop = main**(`git checkout develop && git merge --ff-only origin/main && git push`),否则 develop 永远落后 main 一个 merge commit。

## 测量学不变量(绝对不能改)

这些字段 / 算法 / 哈希值是历史报告可比性的锚,任何改动都会破坏跨版本对比,违反 v0.21 测量学主线:

- **Report JSON schema**(`src/types/report.ts` 里的 `Report` / `ReportMeta` / `VariantResult` / `VariantSummary` 字段含义)
- **Judge Prompt Hash**:`v2-cot=fdc81b19c721` / `v3-cot-length=629bf3b8c41d`,由 `test/grading/judge-hash-frozen.test.ts` 字节级冻结。任何动 `src/grading/judge.ts` 的 prompt 文本会立即让这个测试 fail
- **五层评分管道**:assertion / llm / judge / dimension / composite 的算法和权重
- **Bootstrap CI 公式**(`src/eval-core/bootstrap.ts`)
- **Krippendorff α 公式**(`src/grading/human-gold.ts`)
- **Length-debias toggle**(`--no-debias-length` 与 prompt v2/v3 的对应关系)

如果确需 bump,流程:bump `JUDGE_PROMPT_VERSION_DEBIAS_*` 字符串 → 旧 hash 自然失效 → CHANGELOG 显著标注 breaking-comparability change → 新版本号 bump。**不要悄悄改**。

## 发版流程(自动化版,publish.yml 落地后)

push tag `v*` → publish.yml 自动跑:

1. yarn install + lint + build + test
2. `npm publish --access public --provenance`
3. **从 CHANGELOG.md 抽 `## [VERSION]` section 自动创建 GitHub Release**(PR #6 引入)

所以维护者只要做:bump `package.json` version + 更新 CHANGELOG.md `[Unreleased]` → `[VERSION] - YYYY-MM-DD`,merge release PR 后打 tag + push tag。其他全自动。

## 写代码约定

- **commit message 中文**(详见 git log 历史,前缀如 `重构(v0.21):` / `特性(v0.21 B.4):` / `测试:` / `修复:` / `chore(release):`)。Conventional Commits 风格但用中文写正文
- **user-facing 文案中文优先**(报告 UI / CLI 输出 / 错误信息)。LLM judge 中文译为「**评委**」,不译「判官」,不要中英混用
- **测试基线**:`test/grading/judge-hash-frozen.test.ts`(judge prompt 不变性)+ `test/__snapshots__/html-renderer.test.ts.snap`(zh/en × list/detail UI 回归)。这两个是 CI gate,改 UI / judge 时会自然失败,review snapshot diff 后 `vitest -u` 更新
- **CHANGELOG 维护**:每个 feat / fix PR 顺手更新 `[Unreleased]` 子分类(Added / Changed / Fixed / Internal,Keep a Changelog 风格)。release PR 时把 `[Unreleased]` 改成 `[VERSION] - YYYY-MM-DD`
- **不要硬编码端口**:report server 默认请求 7799 但实际 bound 端口取自 `server.start()` 返回值(可能被占而切到 7800+),所有显示 URL 给用户的代码都要用 `serverUrl` 实参

## 其他参考

- [README.md](./README.md) / [README.zh.md](./README.zh.md) — 用户面文档
- [SKILL.md](./SKILL.md) — Claude Code skill 用法
- [docs/](./docs/) — 设计 spec(rag-metrics / knowledge-gap-signal / 等)
- 本地 plan(不在仓库,仅维护者本地):`~/.claude/plans/iridescent-zooming-lynx.md`
