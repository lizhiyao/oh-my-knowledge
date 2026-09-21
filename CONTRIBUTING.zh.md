# 贡献指南

> 英文原文：[Contributing](./CONTRIBUTING.md)。本文件逐节对照维护，内容有出入时以英文版为准。

感谢你抽出时间为 `oh-my-knowledge` 做出贡献。

## 分支模型 —— GitHub Flow

只保留一条长期分支：

- **`main`** —— 唯一的集成与发布分支。所有达到生产就绪的工作都通过 PR 落到这里。不要直接向 `main` 提交。

所有工作都在从 `main` 切出的短期主题分支上进行：

| 分支名前缀 | 从何处切出 | 合回何处 | 用途 |
|---|---|---|---|
| `feat/<desc>` | `main` | `main` | 新功能 |
| `fix/<desc>` | `main` | `main` | 缺陷修复，包括紧急的生产环境修复 |
| `docs/<desc>` | `main` | `main` | 仅文档改动 |
| `chore/<desc>` | `main` | `main` | 构建、工具、依赖升级、发布版本号提升 |

前缀取该分支主要改动所对应的 Conventional Commits type；`refactor/`、`test/`、`perf/` 和 `ci/` 遵循同样形式。绝不按执行工作的工具或人员来取前缀。

PR 合并后删除该主题分支。

## 典型工作流

### 前置条件

本仓库使用 **Yarn 4**（Berry），通过 `packageManager` 字段锁定版本，并由 [Corepack](https://nodejs.org/api/corepack.html) 驱动。Node 自带 Corepack 但默认不启用，所以先开启一次：

```bash
corepack enable    # makes `yarn` in this repo resolve to the pinned Yarn 4
```

要求 Node ≥ 22（`engines`）。此后下文的 `yarn` 命令都能开箱可用 —— Corepack 会在首次使用时下载锁定的 Yarn 版本。

### 日常功能与缺陷修复

```bash
# sync main first

git checkout main
git pull --ff-only

# cut a topic branch from main

git checkout -b feat/my-feature

# Batch the intended changes, then validate based on risk level.

yarn install
# Review the complete diff and risk-specific evidence first.

# See CODE_REVIEW.md.


# Choose one of the two by risk level: the chosen layer satisfies the local gate.

# For ordinary local changes: targeted validation

yarn ci:quick <相关测试文件>

# For cross-module, dependency, build/packaging, or CI gate changes: full local gate

yarn ci

git commit -m "feat(cli): 中文 subject"
git push -u origin feat/my-feature

# open a PR against **main**

```

验证触发条件、证据复用与例外只在
[`AGENTS.md`](./AGENTS.md#开发反馈与验证) 中定义一次。下文命令实现该策略；
后续修复不会自动要求再跑一轮完整本地门禁。

### 本地验证策略

| 场景 | 策略 | 命令 |
|----------|----------|---------|
| 普通局部修改 | 精准验证 | `yarn ci:quick <相关测试文件>` |
| 测试依赖构建产物 | 先更新构建产物，再测试 | `yarn build:runtime && yarn test <相关测试文件>` |
| 跨模块、依赖、构建／打包、CI 门禁变化 | 完整本地门禁 | `yarn ci` |
| PR 合并 | 远端门禁通过 + 自主 CR | 见 CI 检查 |

## 代码审查与完成定义

涉及行为、契约、打包、文档承诺或仓库策略的改动，
在首次 push 或交付前都要做一次与风险相称的自我审查。
不要等维护者来问 CR 是否做了。
风险等级、审查维度、finding 格式、验证阶梯和停止规则，见
[`CODE_REVIEW.md`](./CODE_REVIEW.md)。

测试全绿本身不能证明已经完成。风险对应的证据与 finding 处理见 `CODE_REVIEW.md`，
何时跑完整门禁或 clean-room 验收见 `AGENTS.md`；
不要在这里另行扩写这些规则。

PR 描述记录用户影响、迁移或兼容决策、测量限制、
自主 CR 结论、真实验证证据，以及已接受的残余风险。
代码级的改动清单留在 diff 里，
不要在描述中重复一遍。

### 发布新版本

npm 发布使用 GitHub Actions OIDC Trusted Publishing，不保存长期 npm token。首次启用时，在
`oh-my-knowledge` 的 npm package settings 配置：

- provider：GitHub Actions
- repository：`lizhiyao/oh-my-knowledge`
- workflow：`publish.yml`（只填文件名）
- environment：留空
- allowed action：仅 `npm publish`

`.github/workflows/publish.yml` 固定使用 GitHub-hosted runner、Node 24 和 npm ≥ 11.5.1。
`id-token: write` 让 npm 用 OIDC 换取短期发布凭证，provenance 由 npm 自动生成；不要重新加入
`NPM_TOKEN`、`NODE_AUTH_TOKEN` 或显式 `--provenance`。

```bash
# cut a release version-bump branch from main

git checkout main
git pull --ff-only
# Replace X.Y.Z with the intended version, including any prerelease suffix.

release_version=X.Y.Z
git checkout -b "chore/release-${release_version}"

# bump version in package.json, final polish commits, then verify

yarn ci

# commit and open a PR against main

git commit -m "chore(release): 发布 ${release_version}"
git push -u origin "chore/release-${release_version}"

# after the PR is merged, tag the merge commit on main

git checkout main
git pull --ff-only
git tag -a "v${release_version}" -m "Release ${release_version}"

# Push the release tag separately to trigger publish.yml.

git push origin "v${release_version}"
```

预发布版本发布到 `next` dist-tag；稳定版本发布到 `latest`。
workflow 从包版本自行推导这一点。Trusted Publishing 是当前的发布路径；
不要恢复基于 token 的兜底发布。
CLI 的更新提醒跟随已安装版本所在的 channel：预发布检查 `next`，
稳定版本检查 `latest`，两者使用各自可重建的缓存。

### 针对已发布版本的紧急修复

从 `main` 创建短的 `fix/` 分支，完成修复和版本号提升，
并走同样的验证与 PR 流程。合并后，按上文带注释标签的发布步骤
处理目标补丁版本。

## 发布说明

发布说明由 GitHub 根据已合并的 PR 自动生成（没有需要单独维护的 `CHANGELOG.md`）。为了让 BREAKING／迁移提示清晰浮现，在 PR 标题前加上相应标签 —— 例如 `feat(judge)!: BREAKING-COMPARABILITY ...` —— 并把迁移步骤写进 PR 描述。`.github/workflows/publish.yml` 里的 `softprops/action-gh-release` 步骤以 `generate_release_notes: true` 运行，用两个标签之间的 PR 列表生成 GitHub Release 正文。

publish.yml 跑完后，请到 `https://github.com/lizhiyao/oh-my-knowledge/releases/tag/vX.Y.Z` **审阅自动生成的 GitHub Release 说明**。自动生成的内容只列出 PR 标题 —— 如果其中任何 PR 打了 `BREAKING-*` 标签，就要手工把该 PR 描述里的迁移步骤提到发布说明中：

```bash
gh release edit vX.Y.Z --notes "$(cat <<'EOF'
## ⚠️ Breaking changes

<consolidated migration guide pulled from BREAKING-* PR descriptions>

---

<paste the auto-generated body below>
EOF
)"
```

这样只读发布说明、不看单个 PR 描述的用户，才不会漏掉迁移路径。

## 提交信息

使用 Conventional Commits，scope 取稳定的模块名，subject 用中文：

```
feat(cli): 新增工作流命令
fix(eval-core): 修复事实检查误报
docs(readme): 补充评测用例说明
```

## 测试

### 快速开发反馈

```bash
# Each edit: select the affected logic and its direct callers.

yarn test test/scripts/test-profile.test.ts
# Checkpoint: lint + typecheck + explicitly selected tests, without a build.

yarn ci:quick test/scripts/test-profile.test.ts test/scripts/ci-quick.test.ts
# Final changes before the first push, high-risk tier: the complete gate.

# Ordinary local changes stop at the checkpoint line above; see AGENTS.md.

yarn ci
```

`yarn test` 通过 hermetic 包装器转发 Vitest 参数；测试改动仓库自身纳管的内容时它会
失败。定向运行也使用这个入口。默认最多两个 worker，因为 CLI 与打包测试会
派生额外进程；worker 数更高时，内存压力下可能出现 SIGKILL。
做受控实验时仍可显式传入 Vitest 参数。
`ci:quick` 要求 `test/` 下存在对应的 `.test.ts` / `.test.tsx` 文件；
无参数、传目录、文件不存在或传 Vitest 参数，
都会在检查开始前就以退出码 2 结束。
它不会推断受影响的测试或构建产物。任一阶段失败都会中止命令；
它通过也不代表覆盖了完整 CI。

### 只构建所选测试真正消费的部分

| 测试边界／任务 | 相关输入变更后的准备 |
|---|---|
| 直接 import 源码；不用生产资源 | 无需构建 |
| 编译后的 CLI、包模块、schema 或运行期资产 | `yarn build:runtime` |
| 源码态 Next server／React 生产路由 | `yarn build:studio:app` |
| 编译后的 Studio／分发产物／完整测试套件 | `yarn build` |
| 重新生成 CLI 文档 | 先 `yarn build:runtime`，再 `yarn build:docs` |

`build:runtime` 编译源码与脚本、检查 schema 并拷贝运行期资产；它不包含 Next。
`build` 在此之上增加 Studio 编译与打包。Next 页面所 import 的模块发生改动，
同样会让 Studio 构建失效，即使没有任何 React 文件被改动。
已存在的 `dist` 或 `.next/BUILD_ID` 只能证明产物存在，
不能证明它与当前源码一致。源码、依赖或构建配置变更后要刷新对应的构建产物。
被删除或改名的产出文件，
可能需要先 `yarn clean` 再重新构建。
检查项之间未变化时保留增量缓存；被测边界要求时才用全新构建。

每份检出各自私有的可写构建状态要留在该检出内部：增量构建信息、类型检查状态和
lint 缓存依据这棵树的文件签名决定要做什么，
而不是依据它的产物文件是否已经存在。第二份检出借用这些状态时，
`tsc -p tsconfig.build.json` 可能以退出码 0 结束，却几乎不产出任何文件；
在一次有记录的运行中（PR #1028）它只写了 22 个 JavaScript 文件，
而同一棵树使用私有缓存时产出 732 个。
这一观测只覆盖构建产物 —— 实验新增的那个文件仍然被类型检查过，
因此它不能保证共享永远不会影响覆盖面。
只读的软件包下载缓存是另一回事：本仓库使用 Yarn 的全局缓存，
它位于每一份检出之外，默认保持共享。
按条目软链依赖目录只有在依赖版本与安装配置一致、
且共享目标不会被并发改动时才可用；
否则请在这份检出内部自行安装。

- `yarn test` 跑完整的 vitest 套件
- `yarn test:profile` 把完整套件跑一遍并列出最慢的测试文件。用它定位优化目标；它不是性能基线，也不是 CI 门禁。传 `--top <n>` 控制列表长度。
- `yarn typecheck` 跑两个 tsc 程序：根程序（Node16、不开 `--jsx`）收 `src`／`test`／`scripts` 下的 `.ts`；`tsconfig.studio-web.json` extends `src/studio/web/tsconfig.json`，收整个 Studio web 子树和 `test/studio/web` 的用例，`.ts` 与 `.tsx` 同权。归属由 `test/architecture/test-gate-coverage.test.ts` 守住，新增文件不必再靠文件名试探谁在检查它。
- 为你改动的行为补测试；缺陷修复强烈建议附带回归测试
- CI 在 PR 和 `main` push 上对完整 event diff 做分类。`scripts/ci/scope.mjs` 列出的根规则文件与模块维护文档（`src/<area>/README.md`）使用治理测试和空白字符检查。普通的 `docs/**/*.md` 与根 README 改动额外运行运行时／文档契约检查和文档构建，不运行 Studio 或完整测试矩阵。
- 源码、依赖、CI／构建／站点配置、skills、prompts、生成文档以及未知路径运行完整门禁：quality、四个 Node 24 分片，以及 `macos-latest` 上的 macOS 风险边界子集。Node 22 分片继续留给非 PR 事件（`main` push、发布、手动 dispatch）和打了 `dependencies` 标签的 PR，因为 issue #932 测得约 40 次运行里 Node 22/24 的测试结果没有差异。历史缺失、diff 为空或分类出错时选择完整门禁。改名同时计入新旧路径；混合改动使用最强的门禁。
- 必需检查仍是 `test (22)` 和 `test (24)`。它们要求所选门禁成功；失败、被取消或意外跳过的门禁不能通过。分支保护以及必须与 `main` 保持同步的要求不变。
- 按层归属测试契约：领域单元测试覆盖完整分支矩阵，command 集成测试覆盖参数到业务的接线和输出信封，真实 `node dist/cli/index.js` 只覆盖 dispatcher、startup、进程退出、模块加载时 cwd、打包资源等进程边界。
- command 业务测试优先使用 `test/helpers/run-command.ts` 运行源码 Command 的完整 Oclif 生命周期，不要为每个 case 重复启动 Node。只有被测行为依赖 dispatcher、模块加载时环境或独立 `process` 时才使用真子进程，并统一走 `test/helpers/cli-process.ts` 的 `runCli`（期待 exit 0）／`runCliFailing`（期待非零退出码，必填），不在测试文件里手搓 `promisify(execFile)`；该边界在测试注释里说明。
- Oclif 的公共行为（例如 unknown flag 的统一 exit code）用代表命令锁一次；各命令只增加自身特有的 flag 校验、文案或历史回归，避免重复框架契约。

## CLI 维护

CLI 使用 [@oclif/core](https://oclif.io/docs/)。命令继承 `BaseCommand`，通过 `await this.parse(Command)` 解析一次参数；不要再次解析或透传原始 argv。

| 目录 | 职责 |
|---|---|
| `src/cli/commands/` | 命令、参数和帮助声明，以及产品入口接线 |
| `src/cli/lib/` | CLI 配置、交互、展示和跨命令辅助逻辑 |
| `src/cli/oclif/` | `BaseCommand`、帮助、语言选择、参数解析器和 dispatcher |

评测入口调用 Workflow 的产品接口；其他命令调用各自所属领域。CLI 不自行定义评分、编排或存储语义。简单交互可以留在 `run()`，跨领域业务应放回领域模块。

### 增加或修改命令

1. 按文件路由放入 `src/cli/commands/`。例如 `eval/index.ts` 对应 `omk eval`，`eval/gold/compare.ts` 对应 `omk eval gold compare`。
2. 继承 `BaseCommand`，声明 `static args / flags / examples / description`。帮助文案使用 `bilingual({zh, en})`。
3. 在 `run()` 中调用 `await this.parse(Command)`，用 `this.lang` 获取语言。可能抛出 `CliExit` 的业务通过 `this.runWithCliExit(async () => { ... })` 执行，共享错误边界负责转换退出码。
4. 用 `test/helpers/run-command.ts` 验证参数到业务的接线。只有 dispatcher、启动或独立进程行为需要真实 `node dist/cli/index.js` 测试。
5. 修改命令声明后运行 `yarn build:runtime && yarn build:docs`。提交前按仓库门禁验证最终改动。

`eval/gold/index.ts` 是显式的 topic 命令：裸 `omk eval gold` 显示帮助后退出 `1`，让脚本识别缺少子命令。需要同样行为的新 topic 应明确实现该契约。

### 语言与帮助边界

`BaseCommand.lang` 使用 `resolveLang(process.argv)`，按 `--lang`／`OMK_LANG` 选择语言。不要用 `flags.lang` 代替共享语言解析。

`oclif/i18n.ts` 提供静态帮助所需的 `bilingual` 与语言选择；`lib/i18n.ts` 提供运行期消息字典。两者服务不同边界，避免重复维护文案来源。

oclif Help 会经过 EJS 渲染，不能把用户输入拼入 description／flag／arg 帮助。`<%...%>` 模板只用于受控的 `examples[].command`；`bilingual` 会拒绝帮助文案中的模板标记。

### 生成文档

命令的 description／flags／args／examples 和 `CLI_EVALUATION_INPUT_REGISTRY` 是对应生成内容的单一来源。`scripts/build/docs.ts` 维护五个目标：

| 目标 | 生成内容 |
|---|---|
| `.agents/skills/omk/references/commands.md` | 完整中文命令参考 |
| `docs/reference/cli.md` | 英文 CLI flag 区段 |
| `docs/zh/reference/cli.md` | 中文 CLI flag 区段 |
| `docs/specs/cli-evaluation-input-compilation.md` | 英文输入 registry 表 |
| `docs/zh/specs/cli-evaluation-input-compilation.md` | 中文输入 registry 表 |

运行 `yarn build:runtime && yarn build:docs` 同步生成区段，`build:docs:check` 和测试会拦截漂移。marker 外的解释文字仍由人工维护。

新增顶层命令时，为中英文 CLI 参考增加对应的 `<!-- omk:cli:<id>:flags:start -->`／`<!-- omk:cli:<id>:flags:end -->` marker，并更新官方 `SKILL.md` 的 `argument-hint`。顶层命令集合由 oclif 配置派生，不另建手写清单；子命令会自动进入完整命令参考。Skill 正文不复制生成参考。

### 退出码

| code | 场景 |
|---|---|
| `0` | 正常完成 |
| `1` | 业务失败、门禁拒绝、未知命令，或显式要求子命令的 topic 被单独调用 |
| `2` | 参数校验失败，包括未知 flag、缺少 required arg 和类型错误 |

框架错误映射由 `package.json` 的 `oclif.exitCodes` 声明。命令不要自行复制参数错误处理或改变公共退出码。

## 代码风格

- TypeScript 严格模式；`yarn lint` 必须保持干净
- 不做不必要的抽象；不为假想的未来需求写代码
- 注释保持精简 —— 说明*为什么*，而不是*做了什么*

## 文档目录结构

`docs/` 按读者分组 —— 新建文件前先选对目录：

- `docs/reference/` —— flag 表、用例格式、executor 矩阵、对比 ↔ 用户查阅的内容
- `docs/explanation/` —— 架构、统计严谨性 ↔ omk 如何工作、为何这样设计
- `docs/specs/` —— 供贡献者阅读的设计规范（用例设计、gap signal、RAG 指标、术语规范……）
- `docs/quickstart-skill-eval.md` + `docs/README.md` 保持在顶层；`docs/zh/` 镜像同样的结构
- `docs/README.md` + `docs/zh/README.md` 是按读者分组的索引 —— 新文件加入对应小节
- **中英文对称是硬性要求。** 每个已发布页面都要有 `docs/` 下的英文版，以及 `docs/zh/` 下同一路径的中文版 —— VitePress 的语言切换依赖这份 1:1 镜像，否则严格的死链构建就会失败。新增文档时两半一起加。设计依据与决策记录优先写在相关已发布规范*内部*（例如作为附录），让用户看到完整推理；只有确实只面向维护者的笔记才放在 `docs/` 之外，这类笔记不受双语规则约束

## 范围

`oh-my-knowledge` 聚焦**离线知识载体评测**与 **skill 级生产可观测性**。它有意**不**覆盖：

- 通用 APM／请求级延迟与成本追踪（请使用 Langfuse／Datadog）
- 流式评测／实时告警
- 生产环境打分（没有对照组＝没有分数）

往这些方向扩展的 PR 通常会被拒绝。拿不准自己的想法是否合适时，先开一个 GitHub Discussion 或 issue。

## 安全

自定义断言与本地报告服务相关的风险，见 README 中的 [Security notice](./README.md#security-notice)。

## 发布可靠性与诊断

CD 最多等待十分钟，等的是打标签那个 commit 上的一次 **完整** CI 成功运行。
证据必须来自本仓库的 `ci.yml`，来自 `main` push 或一次显式的 CI dispatch，
并且 quality 与每个 Node 22/24 分片都成功。
PR 检查、祖先 commit、被跳过的 matrix，
或被更新的失败运行压在后面的旧成功运行，都不能作为替代证据。
如果打标签的 commit 上只有轻量 CI，就在同一个标签上手工 dispatch `CI`，等它跑完，再重新执行发布校验；
不要移动或重建发布标签。CI dispatch 始终选择完整门禁。

校验 job 的权限是只读的。它构建一次，在关闭 lifecycle 脚本的情况下打包，
把那个 tarball 装进隔离的临时目录，
并检查 CLI、模块 import 与打包资产。不可变产物里包含 tarball、
SHA-512 integrity、commit／版本身份、安装结果以及 CI run／attempt 引用。
OIDC 发布 job 下载该产物，再次校验它的身份与摘要，
然后用 `--ignore-scripts` 发布这个 tarball。
它不会重装依赖，也不会重新构建这个包。
本地的 `prepublishOnly` 保持不变，仍用于手工从目录发布。

发布过程串行执行，且不会取消正在进行的上传。
registry 上版本相同、包 integrity 也完全一致的，视为已经上传；
integrity 不同或缺失时 fail closed。测试、安装、构建和 npm 发布
都不会自动重试。只有只读的 GitHub／registry GET 会重试
瞬时超时、特定网络失败和 HTTP 408/429/5xx（最多三次尝试）。
上传结果不确定时，要检查 registry，并用原始产物重跑失败的那个发布 job。
重跑全部 job 可能构建出字节不同的产物，
不能替代复用那一份既有产物。

CI/CD 中有时限的命令会保留日志、定期的内存／进程采样，以及结构化的结果：
成功、命令失败、进程超时、有证据支撑的 OOM、被取消、
执行失败、明确的网络失败，或原因不明的信号。`scripts/ci/diagnostics.mjs report`
把各类计数汇总进 `summary.json` 和 Actions 的 job summary。诊断
产物包含 run、attempt 与 job 身份，保留 14 天；比较失败频率时按这些分类来看。
仅有 SIGKILL 不算 OOM；runner 丢失或 job 级 kill 可能让最终的记录与上传
来不及产生：证据缺失就仍是未知。
进程截止时间早于 job 截止时间，
这样普通卡死仍能留出终止、分类和产物上传的时间。
