# AGENTS.md - Agent 入场清单

OMK（Observe. Measure. Know.）让 AI 应用的知识改动有据可依。它面向 prompt / RAG / skill / agent / workflow 观测真实表现、受控测量版本差异，并判断改动是否有效、版本能否发布。它固定模型只变知识载体，三阶段 doctor / eval / observe 输出统计可比的诊断，配套 sample / evolve 做用例生成与自动迭代。所有改动都要优先保护测量可比性。

本文件是 [agents.md](https://agents.md) 开放标准约定的工具中立入场清单。Codex 原生加载；Claude Code 通过 `CLAUDE.md` import。其它工具是否自动加载以各自对 agents.md 的支持为准，仅在仓库实际使用并完成验证时增加工具专属配置，不复制第二份规则。

## 开工先做

- 涉及 commit、PR、分支或发版时，先看 `CONTRIBUTING.md`。
- 修改子目录前，检查从仓库根到目标文件路径上的 `AGENTS.md`；距离目标最近的文件补充或覆盖上层规则。
- 开发反馈优先跑受影响验证；首次 push 前默认跑一次 `yarn ci`，除非用户明确要求更窄验证，或改动仅限不影响生成产物、链接、打包与行为的手写文档／规则。首次 push 后事实未变化时，不为交付机械重跑本地门禁；存在远端 CI 时，以其结果补充确认。事实变化时，后续修复成批完成，并按影响范围重跑精准验证或完整门禁，避免无条件重复运行和把远端 CI 当作增量反馈环。

## 高效交付

- 用户已确认目标和实施方向后，在已授权的交付链内连续推进到下一个外部决策边界；不要在实现、精准验证、自主 CR、首次 push 等常规步骤之间反复询问「下一步」。合并、发版和未获授权的外部发布不因连续推进而自动获得授权。
- clean-room 验收只在发布、打包／安装契约变化、真实用户入口变化或风险审查明确要求时执行；触发条件、被测边界与证据未变化时不重复执行。
- 过程更新只在出现新发现、风险、决策点或阶段结果时发送；工具仍在运行且状态未变化时不重复播报。

## 自主 CR 与完成定义

- 任何会改变行为、契约、打包、文档承诺或仓库规则的改动，在首次 push／交付前都必须由当前 Agent 自主完成一次 CR；不要等待用户再问「CR 了吗」。纯机械改动也要快速复核，但审查深度应与风险匹配。
- 开工时先识别需求／非目标、受影响边界和风险等级；实现结束后必须完整阅读 [`CODE_REVIEW.md`](./CODE_REVIEW.md)，再以审查者视角只读检查完整 diff、调用链、契约和验证证据。能使用独立 reviewer 时可以使用，不能使用时做 fresh-pass 自审，不得跳过。
- P0～P2 必须在交付前解决；P3 要么解决，要么明确登记为 follow-up。修复后复查最终 diff，并重跑受影响验证；只有最终复查不再产生新的 P0～P2，且所需门禁与真实用户路径通过，任务才算完成。
- 只有架构／公开行为发生实质变化、CI 暴露新问题、重要 rebase 冲突或外部审查提出新高风险方向时，才重新做完整 CR；普通小修只复查受影响面，避免无限循环审查。
- Finding 的证据、优先级与输出格式以 `CODE_REVIEW.md` 为准；无 finding 时明确报告 no findings，不制造猜测性问题。用户显式要求 `cr`／`review` 时，仍按「写作规则」把结论直接发到对应 PR。

### CR 运行产物隔离

- `artifacts/cr/` 和 `knowledge/cr/` 属于 CR 工具运行状态，不是 OMK 源码资产；不得在仓库内创建或保留。不要用 `.gitignore` 隐藏这类工作树污染。
- 只有实际运行会写盘的 CR 工具时，才用 `mktemp -d` 创建唯一的仓库外运行目录，并把材料快照与索引、Material IR、运行证据、图谱缓存、Context Package、编排结果和最终报告全部写入该目录。纯只读 diff／调用链／测试证据审查直接完成，不得为了留痕创建空目录、重复快照或过程报告。工具默认指向仓库时，必须用显式 `--runtime-dir`、`--graph-cache`、`--out`、`--results` 或等价参数改到该目录；不得执行回写仓库的结果同步。
- Issue／PR／CI 是持久审查记录。只有用户明确要求把某份材料或报告作为项目资产维护时，才按正常文档改动评审并提交；外部发布同样需要用户明确授权。
- CR 前后检查 `git status --short`；除本次有意源码改动外，工作树必须保持不变。工具无法避免写入仓库时停止使用该写入路径，清理其可重建产物，并披露限制。

## Code Review Rules

### 测量可比性与公开身份

- 必须拦截任何静默改变评分口径、统计语义、prompt 字节、Schema identity 或持久化契约的改动，否则历史报告会被错误当作可比。安全路径：保持不变量，或显式版本化并在 PR 标题／描述标记对应 `BREAKING-*`、迁移和测量影响。

### Core 与宿主边界

- 必须拦截 `eval-core` 对 CLI、文件系统、网络、环境变量、执行器或 Studio 的反向依赖，否则 Core 会失去宿主无关性和可重放性。安全路径：Core 只表达纯契约与确定性变换，副作用放在 `eval-workflows` 或对应 adapter。

### 用户与测试状态

- 必须拦截未授权的仓库文件、用户目录或全局状态写入，以及失败／中断后未清理的临时资源。安全路径：测试使用显式临时根和环境隔离，生产写入只落到公开存储契约允许的位置，并覆盖 cleanup 路径。

## 硬规则

- 遵守 `CONTRIBUTING.md` 的 GitHub Flow：`main` 是唯一长期分支；feature / fix / docs / chore 从 `main` 切短分支，通过 PR 回 `main`；release / hotfix 也通过短分支 PR 回 `main`，再由 tag 触发发版。
- 不要直接在 `main` 上提交；不要再把新工作提交到 `develop`。
- commit 格式：`type(scope): 中文 subject`。scope 用稳定模块名，如 `cli` / `i18n` / `eval-core` / `eval-workflows` / `knowledge-artifacts` / `evidence` / `measurement-governance` / `observability` / `studio` / `executors` / `release` / `agents-md`（早期 git history 用过 `claude-md`，rename 后统一用 `agents-md`）。
- 不要在给用户看的 URL 里硬编码 report server 端口；使用 `server.start()` 返回的实际 URL。
- 判别字段命名：新建或可安全改名的字段中，裸 `kind` 默认只表示 `Artifact.kind: ArtifactKind`（baseline / skill / prompt / agent / workflow）。例外是已经发布并落盘/对外暴露的 public schema（如 report / doctor / observe / diagnosis 的顶层 `kind`），这些既有 `kind` 字段不要顺手改成限定名；确需改名时单独做 schema / data migration，并保持读取旧文件。其它新判别字段用限定名（`eventKind` / `runtimeKind` / `standardKind` 等）。细节见 `docs/specs/terminology-spec.md` §5.4，CI 有 `test/scripts/kind-semantics-guard.test.ts` 拦新裸 `kind`。

## 写作规则

- CLI / 报告 UI / 错误信息等 user-facing 文案中文优先。
- 代码审查（用户说 `cr` / `review` / 要看 PR）完成后，必须把 CR 评论直接发到对应 PR；不要只在对话里给结论；评论语言跟随用户操作系统设置语言。
- 中文文案统一用全角标点 `，。：；！？（）「」`，符合 GB/T 15834《标点符号用法》。半角 `,.():` 只在以下技术混排里出现：代码块（``` ```）、inline code（`...`）、文件路径、命令行、URL、YAML/JSON frontmatter、数学区间（`[lo, hi]`）、citation 年份（`(2023)`）、`executor:model` 风格的标识符、英文术语 / 技术枚举的括注（如 `用例隔离(construct validity)`、`verdict(PROGRESS / ...)`、`omk 版本(reportMeta.cliVersion)`：括号内容是英文术语、API 字段、枚举值，半角更易复制粘贴）。范围：README.zh.md / docs/zh / SKILL.md / src 内 zh 字符串 / PR description / commit message 的中文 subject 部分。例外：commit 的 `type(scope):` 前缀是 Conventional Commits 语法保留半角，只有冒号后的中文 subject 走全角（写成 `docs(readme): 中文 subject`，不是 `docs（readme）：中文 subject`）。
- LLM judge 译为 `评委`，不要译为 `判官`。
- PR description 写用户影响、迁移说明、construct-validity 或测量学 caveat，链接相关 issue / 前置 PR。不要写行号、测试用例清单或嵌套实现细节 — 那些 git diff 里都有。

## omk skill 单一来源

- 仓库根 `.agents/skills/omk/` 是 omk 官方 Agent Skill 的单一来源；`.claude/skills/omk` 只是指向它的软链，不要复制维护第二份内容。
- npm 用户的安装方式见 `README.md` / `README.zh.md` 和 `docs/quickstart-skill-eval.md`；本文件不复制用户教程。

## 参考

- 用户文档：`README.md` / `README.zh.md`
- omk skill 入场：`.agents/skills/omk/SKILL.md`（单一来源，见上节）
- 自主代码审查：`CODE_REVIEW.md`
- 设计 spec：`docs/`
- 分支 / 发版 / 贡献细节：`CONTRIBUTING.md`
