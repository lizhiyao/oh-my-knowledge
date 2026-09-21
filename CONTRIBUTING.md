# Contributing

Thanks for taking the time to contribute to `oh-my-knowledge`.

## Branch model — GitHub Flow

One long-lived branch:

- **`main`** — the single integration and release branch. All production-ready work lands here through PRs. Do not commit directly to `main`.

All work happens on short-lived topic branches cut from `main`:

| Branch prefix | Cut from | Merges back to | Purpose |
|---|---|---|---|
| `feat/<desc>` | `main` | `main` | new feature |
| `fix/<desc>` | `main` | `main` | bug fix, including urgent production fixes |
| `docs/<desc>` | `main` | `main` | docs only |
| `chore/<desc>` | `main` | `main` | build, tooling, dependency bumps, release version bumps |

The prefix is the Conventional Commits type of the change the branch mainly carries; `refactor/`, `test/`, `perf/` and `ci/` follow the same shape. Never take the prefix from the tool or the person doing the work.

Delete the topic branch after its PR is merged.

## Typical workflow

### Prerequisites

This repo uses **Yarn 4** (Berry), pinned via the `packageManager` field and driven by [Corepack](https://nodejs.org/api/corepack.html). Node ships Corepack but leaves it disabled, so enable it once:

```bash
corepack enable    # makes `yarn` in this repo resolve to the pinned Yarn 4
```

Node ≥ 22 is required (`engines`). After that, the `yarn` commands below Just Work — Corepack downloads the pinned Yarn version on first use.

### Everyday feature / fix

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

Validation triggers, evidence reuse, and exceptions are defined once in
[`AGENTS.md`](./AGENTS.md#开发反馈与验证). The commands below implement that policy;
follow-up fixes do not automatically require another full local gate.

### Local validation strategy

| Scenario | Strategy | Command |
|----------|----------|---------|
| Ordinary local changes | Targeted validation | `yarn ci:quick <相关测试文件>` |
| Tests depend on build artifacts | Update build first, then test | `yarn build:runtime && yarn test <相关测试文件>` |
| Cross-module, dependency, build/packaging, CI gate changes | Full local gate | `yarn ci` |
| PR merge | Remote gate passes + autonomous CR | See CI checks |

## Code review and definition of done

Every behavior, contract, packaging, documentation-promise, or repository-policy
change receives a risk-proportionate self-review before its first push or handoff.
Do not wait for a maintainer to ask whether CR happened. Follow
[`CODE_REVIEW.md`](./CODE_REVIEW.md) for the risk levels, review dimensions,
finding format, validation ladder, and stopping rules.

A green test suite alone does not establish completion. Use `CODE_REVIEW.md`
for risk-specific evidence and finding resolution, and `AGENTS.md` for when to
run the full gate or clean-room checks; do not independently expand those rules.

The pull request description records user impact, the migration or compatibility
decision, measurement caveats, the autonomous CR conclusion, real validation
evidence, and any accepted residual risk. Keep code-level change lists in the
diff rather than duplicating them in the description.

### Releasing a new version

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

Prerelease versions publish to the `next` dist-tag; stable versions publish to
`latest`. The workflow derives this from the package version. Trusted Publishing
is the current release path; do not restore token-based fallback publishing.
The CLI update notifier follows the installed version’s channel: prereleases
check `next`, stable releases check `latest`, with separate rebuildable caches.

### Hotfix against a released version

Create a short `fix/` branch from `main`, make the fix and version bump, and use
the same validation and PR flow. After merge, follow the annotated-tag release
steps above for the intended patch version.

## Release notes

Release notes are auto-generated by GitHub from merged PRs (no separate `CHANGELOG.md` to maintain). For BREAKING / migration callouts to surface clearly, prefix the PR title with the relevant tag — e.g. `feat(judge)!: BREAKING-COMPARABILITY ...` — and put migration steps in the PR description. The `softprops/action-gh-release` step in `.github/workflows/publish.yml` runs with `generate_release_notes: true` and produces the GitHub Release body from the PR list between tags.

After publish.yml finishes, **review the auto-generated GitHub Release notes** at `https://github.com/lizhiyao/oh-my-knowledge/releases/tag/vX.Y.Z`. The auto-gen lists PR titles only — if any included PR was tagged `BREAKING-*`, the migration steps from that PR's description need to be hoisted into the release notes by hand:

```bash
gh release edit vX.Y.Z --notes "$(cat <<'EOF'
## ⚠️ Breaking changes

<consolidated migration guide pulled from BREAKING-* PR descriptions>

---

<paste the auto-generated body below>
EOF
)"
```

This keeps users who only read release notes (not individual PR descriptions) from missing the migration path.

## Commit messages

Use Conventional Commits with a stable scope and a Chinese subject:

```
feat(cli): 新增工作流命令
fix(eval-core): 修复事实检查误报
docs(readme): 补充评测用例说明
```

## Tests

### Fast development feedback

```bash
# Each edit: select the affected logic and its direct callers.
yarn test test/scripts/test-profile.test.ts
# Checkpoint: lint + typecheck + explicitly selected tests, without a build.
yarn ci:quick test/scripts/test-profile.test.ts test/scripts/ci-quick.test.ts
# Final changes before the first push, high-risk tier: the complete gate.
# Ordinary local changes stop at the checkpoint line above; see AGENTS.md.
yarn ci
```

`yarn test` forwards Vitest arguments through the hermetic wrapper, which fails
if tests mutate repository-owned content. Use that entry point for targeted
runs too. The default is capped at two workers because CLI and package tests
spawn additional processes; a higher worker count can cause SIGKILL under memory
pressure. Explicit Vitest flags remain available for controlled experiments.
`ci:quick` requires existing `.test.ts` / `.test.tsx` files under `test/`;
no arguments, directories, missing files, or Vitest flags exit with code 2 before
checks run. It does not infer affected tests or build artifacts. Every failed
stage stops the command; passing it does not imply full CI coverage.

### Build only what the selected test consumes

| Test boundary / task | Preparation after relevant input changes |
|---|---|
| Imports source directly; no production assets | No build |
| Compiled CLI, package modules, schemas or runtime assets | `yarn build:runtime` |
| Source Next server / React production routes | `yarn build:studio:app` |
| Compiled Studio / distributed package / complete suite | `yarn build` |
| Regenerate CLI documentation | `yarn build:runtime` then `yarn build:docs` |

`build:runtime` compiles source and scripts, checks schemas and copies runtime
assets; it excludes Next. `build` adds Studio compilation and packaging. Changes
to modules imported by Next pages also invalidate the Studio build, even when
no React file changed. A pre-existing `dist` or `.next/BUILD_ID` only proves an
artifact exists, not that it matches current source. Refresh the relevant build
after source, dependency or build-config changes. Removed or renamed emitted
files may require `yarn clean` before rebuilding. Preserve incremental caches
between unchanged checks; use clean builds when the tested boundary requires it.

Keep the writable per-checkout state local to that checkout: incremental build
info, type-check state and lint caches decide work from that tree's file
signatures rather than from whether its output files already exist. A second
checkout that borrows them can finish `tsc -p tsconfig.build.json` with
exit code 0 while emitting almost no output; in a recorded run (PR #1028) it
wrote 22 JavaScript files, where the same tree with a private cache emitted 732.
That observation covers build artifacts only — the file added for the experiment was
still type-checked, so it is not a guarantee that sharing never affects
coverage. The read-only package download cache is a different thing: this
repository uses Yarn's global cache, which lives outside every checkout and
stays shared by default. Linking dependency directories per entry is acceptable
only while dependency versions and install configuration match and the shared
target is not modified concurrently; otherwise install inside the checkout.

- `yarn test` runs the full vitest suite
- `yarn test:profile` runs the full suite once and lists the slowest test files. Use it to locate optimization targets; it is not a performance baseline or CI gate. Pass `--top <n>` to control the list length.
- `yarn typecheck` 跑两个 tsc 程序：根程序（Node16、不开 `--jsx`）收 `src`／`test`／`scripts` 下的 `.ts`；`tsconfig.studio-web.json` extends `src/studio/web/tsconfig.json`，收整个 Studio web 子树和 `test/studio/web` 的用例，`.ts` 与 `.tsx` 同权。归属由 `test/architecture/test-gate-coverage.test.ts` 守住，新增文件不必再靠文件名试探谁在检查它。
- Add tests for behaviour you change; a regression test for bug fixes is strongly preferred
- CI classifies the complete event diff on PRs and `main` pushes. The exact root rule files listed in `scripts/ci/scope.mjs` use governance tests and whitespace checks. Ordinary `docs/**/*.md` and root README changes additionally run runtime/document-contract checks and the documentation build, without Studio or the full test matrix.
- Source, dependencies, CI/build/site configuration, skills, prompts, generated documentation and unknown paths run the full gate: quality, the four Node 24 shards, and the macOS risk-boundary subset on `macos-latest`. The Node 22 shards stay reserved for non-PR events (`main` pushes, releases, manual dispatch) and PRs labelled `dependencies`, because issue #932 measured roughly 40 runs with no Node 22/24 difference in test outcome. Missing history, empty diffs or classification errors select the full gate. Renames include both old and new paths; mixed changes use the strongest gate.
- Required checks remain `test (22)` and `test (24)`. They require the selected gate to succeed; a failed, cancelled or unexpectedly skipped gate cannot pass. Branch protection and the requirement to stay current with `main` are unchanged.
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

## Style

- TypeScript strict; `yarn lint` must be clean
- No unnecessary abstractions; no code for hypothetical future needs
- Keep comments minimal — explain the *why*, not the *what*

## Docs layout

`docs/` is organized by audience — pick the right bucket before creating a new file:

- `docs/reference/` — flag tables, sample format, executor matrix, comparison ↔ what users look up
- `docs/explanation/` — architecture, statistical rigor ↔ how / why omk works
- `docs/specs/` — design specs read by contributors (sample design, gap signal, RAG metrics, terminology, ...)
- `docs/quickstart-skill-eval.md` + `docs/README.md` stay at the top level; `docs/zh/` mirrors the same structure
- `docs/README.md` + `docs/zh/README.md` are the audience-grouped indexes — add new files to the matching section
- **EN/ZH symmetry is required.** Every published page has both an English version under `docs/` and a Chinese version at the same path under `docs/zh/` — the VitePress language switcher relies on this 1:1 mirror, and a strict dead-link build fails otherwise. When adding a doc, add both halves. Prefer putting design rationale and decision records *inside* the relevant published spec (e.g. as an appendix) so users see the full reasoning — keep notes outside `docs/` only when they are genuinely maintainer-only, where they stay exempt from the bilingual rule

## Scope

`oh-my-knowledge` focuses on **offline knowledge-artifact evaluation** and **skill-level production observability**. It deliberately does **not** cover:

- General APM / request-level latency and cost tracing (use Langfuse / Datadog)
- Streaming evaluation / real-time alerting
- Production scoring (no control group = no score)

PRs expanding into those areas will usually be declined. If you're unsure whether your idea fits, open a GitHub Discussion or issue first.

## Security

See the [Security notice](./README.md#security-notice) in the README for risks around custom assertions and the local report server.

## Release reliability and diagnosis

CD waits up to ten minutes for a successful **full** CI run on the exact tag
commit. Evidence must come from this repository's `ci.yml`, from a `main` push
or an explicit CI dispatch, with quality and every Node 22/24 shard successful.
A PR check, ancestor commit, skipped matrix or older success behind a newer
failed run cannot substitute. If the tag commit only has lightweight CI, dispatch
`CI` manually on that same tag, let it finish, and rerun release verification;
do not move/recreate the release tag. CI dispatch always selects the full gate.

Verification has read-only permissions. It builds once, packs with lifecycle
scripts disabled, installs that tarball into an isolated temporary directory,
and checks the CLI, module imports and packaged assets. The immutable artifact
contains the tarball, SHA-512 integrity, commit/version identity, installation
result and CI run/attempt reference. The OIDC publishing job downloads that
artifact and validates its identity and digest again, then publishes the tarball
with `--ignore-scripts`. It does not reinstall dependencies or rebuild the package.
Local `prepublishOnly` remains intact for manual folder publication.

Publication is serialized without cancelling an active upload. A registry
version with the exact same package integrity is treated as already uploaded;
a different or missing integrity fails closed. Tests, installs, builds and npm
publication are never automatically retried. Only read-only GitHub/registry GETs
retry transient timeouts, selected network failures, HTTP 408/429/5xx (at most
three attempts). An uncertain upload requires inspecting the registry and
rerunning the failed publish job with the original artifact. Rerunning all jobs
can rebuild different bytes and is not a substitute for reusing that artifact.

CI/CD bounded commands preserve logs, periodic memory/process samples and a
structured outcome: success, command failure, process timeout, evidence-backed
OOM, cancellation, execution failure, explicit network failure or an unexplained signal. `scripts/ci/diagnostics.mjs report`
aggregates counts into `summary.json` and the Actions job summary. Diagnostic
artifacts include the run, attempt and job identity and are retained for 14 days;
use these categories when comparing failure frequency. SIGKILL alone is not OOM,
and runner loss or a job-level kill may prevent final records/upload: missing
evidence remains unknown. The process deadline precedes the job deadline so
normal hangs leave time for termination, classification and artifact upload.
