# omk 存储布局规范

> **范围**: 这篇写给 omk 维护者，讲清 omk 跑出来的各种文件到底放哪、为什么这么放、什么时候清。涉及两个地方：你电脑上的全局目录 `~/.oh-my-knowledge/`，和每个项目自己的 `<project>/.omk/`。中英双版并存（`docs/specs/` 英文 / `docs/zh/specs/` 中文）。具体目录名以源码（`src/eval-core/default-dirs.ts` 等）为准，这篇只讲「为什么」。日常怎么用看 [README](../README.md)。

## 一、放文件这件事，要同时满足三条

看着简单，其实缺一条就埋雷：

- **同一类东西得有同一个家**。不能报告这类默认丢全局、治理档案那类放项目，两套规则——用户根本猜不到自己的报告在哪、`omk studio` 该去哪读。
- **列表可以跨项目看，但分数不能跨项目比**。一份报告只在它自己那套测试用例下才说得通，换套用例分数就变。两个项目用例不一样，分数摆一起比就是耍流氓（专业叫 construct validity，见 [who-omk-is-for](../explanation/who-omk-is-for.md)）。要是所有项目的报告默认全堆进一个全局文件夹，`omk studio` 从哪个目录打开都是一锅粥、分不清哪份属于哪个项目，等于把「拿 A 班的分跟 B 班比」这种错焊死在「文件怎么存」上。
- **草稿别跟正经数据混**。`cache` / `trees` / `isolated-cwd` / `jobs` 这些是草稿，删了程序自己能重建。它们要是跟报告这种正经数据平铺、长得还一样，你想清磁盘时根本不敢删，怕误伤。

## 二、一条规则决定每样东西放哪

就问两个问题，外加一条贯穿规则：

- **问题一 · 删了能自己长回来吗？** 能 → 草稿，扔进专门的 `state/` 文件夹，「这一坨随便删」一眼可见；不能、得留着 → 放正经数据区。
- **问题二 · 它只在某个项目里才有意义吗？** 是（比如报告，绑着那套用例）→ 放进那个项目的 `.omk/` 抽屉；不是、哪个项目都能共用（缓存、临时副本）→ 放电脑的全局目录。
- **贯穿规则 · 用身份证认东西，不靠它在哪个文件夹**。每样东西用自己的 `id + 内容指纹`当身份，搬家只改指路牌，不会把引用它的链接弄断。

照这个，omk 的东西各就各位：

| 产物 | 删了能重建？ | 绑项目吗？ | 放哪 |
|---|---|---|---|
| `reports` / `observe-health` / `doctors` / `observe-inbox` | 不能，要留 | 绑用例集 | 项目本地 `.omk/` 默认，全局兜底读 |
| `graphs` | 不能，要留 | 绑它的来源 run | 跟随主写入命令的 `.omk/` 根目录 |
| `managed` | 不能，要留 | 绑被治理 skill 装在哪 | 项目优先 → 全局兜底 |
| `cache` / `trees` / `isolated-cwd` | 能 | 哪个项目都能共用 | 全局 `state/` 子树 |
| `jobs` / `artifact-index` | 能 | 从测量派生出来的 | 全局 `state/` 子树 |

一句话：要留 + 绑项目 → 放本地；删了能重建 → 扔进可整删的 `state/` 子树（哪都能用的留全局）。**最容易犯的错，就是把「要留 + 绑项目」的测量结论，当成「哪都能用」的缓存来放——global-default 正是这个错。**

第一行测量产物放法一致（项目本地默认 + 全局兜底读 + 默认 gitignore）。主写入命令用 `--global` 写全局：`reports` / `observe-health` / `doctors` 拿标准用例集跑分时写全局（见第四节），`observe-inbox` 也支持（`omk observe ingest --global` 写、`omk observe inbox --global` 读），补全全局 skill 的观测闭环。`graphs` 这类 sidecar 跟随产生它的主产物输出根目录，不另起一套路由。`managed` 是例外，不靠开关，按被治理 skill 装在哪自动走。

doctor 和 eval graph sidecar 对标准报告目录保留 sibling 布局：`.omk/doctors` → `.omk/graphs/doctor`，`.omk/reports` → `.omk/graphs/eval`。如果用户传入的自定义 `--output-dir` 不是对应主写入命令的标准目录，graph sidecar 留在显式目录内部，例如 `<output-dir>/graphs/doctor` 或 `<output-dir>/graphs/eval`。

## 三、最终长这样

```
~/.oh-my-knowledge/             # 电脑全局目录（认 OMK_HOME，可整体搬走）
  reports/ observe-health/ doctors/ observe-inbox/ graphs/   # 只有 omk ... --global 主动跑时才写这里
  managed/                      # 全局装的 skill 的治理档案
  update-check.json
  state/                        # 草稿区 · 随时可整删
    cache/  isolated-cwd/  trees/  jobs/
    artifact-index/<domain>/<id>.json   # 跨项目总览用的索引卡片（见第六节）

<项目>/.omk/                    # 项目本地 · 要留 · 绑这个项目的用例集
  reports/  observe-health/  doctors/  observe-inbox/  graphs/   # 测量产物、收件箱与 sidecar —— 默认 gitignore，不进库
  backups/                      # doctor --fix 改 skill 前存的原件（撤销用）—— 默认 gitignore，不进库
  managed/                      # 项目自带 skill 的治理档案 —— 可以提交（决策史）
  eval-samples.yaml / eval.yaml # 测量定义 —— 提交
```

`OMK_HOME` 是这棵全局树的总开关：改一处，`reports` / `doctors` / `observe-health` / `graphs` / `state`（含里面的 `cache` / `trees` / `jobs` / `artifact-index`）一起搬。整盘迁移靠它，测试也靠它一把把整棵树指到临时目录、不脏你真实的 home。

### 文件命名语法

目录和文件名各自承载不同含义：

- **目录表达产品域**。例如 `.omk/doctors/` 已经说明这是 doctor，`.omk/graphs/doctor/` 已经说明这是 doctor 产生的图谱 sidecar；文件名不再重复这些 domain 词。
- **所有 run-derived artifact 都用 `<subject>-<runSuffix>.<artifactKind>.<ext>`**。`subject` 通常是 skill 或 artifact 名（eval 取主评测对象，也就是非 baseline treatment，而不是完整 control-vs-treatment 关系），`runSuffix` 是让本次运行唯一的时间戳 + 随机后缀，`artifactKind` 说明文件是什么，`ext` 说明怎么解析。
- **人读 / 机读双文件要在扩展名前区分**。优先用 `.graph.json`、`.card.md`、`.summary.json`，不要只靠 `.json` 和 `.md` 区分一对 sidecar。
- **固定源文件 / 配置文件保留人类可读名**。`eval-samples.json`、`<skill>/.omk/samples.json`、`eval.yaml`、`metadata.yaml`、`review-state.json` 是源数据 / 配置 / 状态约定，不套 run-derived 语法。

Evaluation Core 按 `runId` 一次一个目录存储；manifest 与 sealed documents 在目录内使用固定 schema 文件名。旧的扁平 evaluation report 不再读取，也不迁移。一次性的 `.report.json` 文件名迁移只保留给 `doctors` / `observe-health` / `observe-inbox`；无关 JSON 会被跳过。

示例：

```
.omk/reports/01JY.../manifest.json
.omk/reports/01JY.../evaluation-report.json
.omk/doctors/service-guide-20260620T105109-aqgq.report.json
.omk/observe-health/20260620T105109-aqgq.report.json
.omk/observe-inbox/20260620T105109-aqgq.report.json
.omk/graphs/eval/service-guide-20260620T105109-aqgq.graph.json
.omk/graphs/doctor/service-guide-20260620T051909-aqgq.graph.json
.omk/graphs/doctor/service-guide-20260620T051909-aqgq.card.md
```

## 四、skill、测量、治理是三层，别混成一栏

有人会问：skill 装在全局，那还管得住吗？这问题点破一件事——skill 本身、对它的测量、对它的治理，是三层，各归各的：

- **skill 本身 = 全局资产**。装在 `~/.claude/skills` 那种，全局认它。这层不动。
- **测量结果（`reports` / `observe-health` / `doctors` / `graphs`）= 绑用例集**。同一个 skill 换套用例分数就变，所以报告及其 sidecar 跟项目走。
- **治理档案（`managed`，记着「这个 skill 凭什么准上线」）= 跟 skill 装在哪走**，不跟测量走。全局装的 skill，治理档案放全局；项目里自带的，放项目。

**怎么连起来**：治理档案里不存报告的文件路径，而是把要用的字段（报告 `id`、内容指纹、结论）直接抄一份进去（专业叫 denormalize）。所以哪怕报告是项目本地的、治理档案是全局的，上线门禁照样查、报告搬家也不受影响。想给全局 skill 一个「全局成绩」：挑一套代表通用用法的标准用例集（golden set），用 `omk eval --global` 专门跑它、写全局——这比把各项目八竿子打不着的用例硬倒进一个桶假装全局成绩，要诚实得多。`--global` 在这套布局里是正经的一等模式，没被砍。

## 五、放进项目文件夹 ≠ 提交进 git

有人担心：`.omk/` 放在 repo 里会不会污染 git？不会。它像 `node_modules` / `.pytest_cache` / `mlruns` 那样——住在你项目文件夹里，但默认不进版本库。三种放法：

- **全局桶**（如 promptfoo）：不脏 repo，但分不清哪份是哪个项目的。
- **项目文件夹 + 默认 gitignore**（MLflow `./mlruns`、Inspect `./logs`、HELM `benchmark_output`）：分得清归属，又不进 PR / diff。**这套布局走这种。**
- **项目文件夹 + 故意提交**（DVC）：要分享时只提交一小份元数据。

`.omk/` 里面也分两类：

- 会越长越大的 `reports` / `observe-health` / `doctors` / `observe-inbox` / `graphs` → 默认 gitignore，不提交。
- 小而重要的治理决策 `managed` → 可以提交，像 CHANGELOG / ADR 那样，队友 clone 下来就看到「当初凭什么放行这个版本」。
- 用例集 / `eval.yaml` → 提交。

`omk init` 会自动写一个 `.omk/.gitignore`（挡住会涨的目录、放行 `managed` 和配置），像 `dvc init` 那样，你不会手滑提交。全队想看完整报告？走 `--global` / 搭个共享 server / 导出证据包——跟 MLflow「本地不提交、要分享就起个 server」一个路子。

## 六、测量产物保持项目归属

Evaluation Core run 正文只存在于一个项目本地目录，或用户显式选择的全局目录。Studio 扫描所选的项目 / 全局根目录，并在列出前验证 Core manifest。它不使用旧 evaluation report 索引，不打开扁平报告文件，也不重建跨项目分数曲线。

Doctor 与 observe-health 仍保留轻量全局索引卡，因为它们独立的报告 schema 仍采用这套发现模型。卡片位于 `state/artifact-index/<domain>/<id>.json`，其中 `domain` 仅为 `doctor` 或 `observe-health`。Evaluation 与 observe-inbox 都有意排除在外。

几条要点：

- **evaluation 不回填**：旧的扁平 evaluation report 永远不会生成 Core run 或索引卡。
- **全局写不留卡片**：全局 doctor / observe 根目录本来就会被直接扫描。
- **doctor / observe 卡片尽力写入**：正文始终是权威来源。
- **卡片是活指针**：正文已经消失的卡片会从发现结果中过滤。
- **显式根目录不合并卡片**：只读取用户点名的位置。

Core `runId` 与独立的 doctor / observe id 都具备防碰撞身份。id 只是标签，不是算出来的分数，因此不影响跨版本可比性。

## 七、什么自动清、什么永远留

按「删了能不能重建」分：

- **已经在自动清的（草稿）**：`doctor` 每个 skill 留最近 50 份；`cache` 最多 2000 条；`trees` / `isolated-cwd` 最多 200 条（带正在用的进程锁保护）。三个都能用环境变量调。
- **故意不清的（数据）**：`reports` / `observe-health` / `observe-inbox` 永不后台删。两个理由：(1) `reports` 被治理档案和任务记录按 `id` 引着，自动删会断链；(2) 报告的全部价值就是「拿历史比新版」，自动删等于偷偷毁掉比较的底子。也就几个 json，不占地方。
- **暂时没上限的**：`backups`（doctor --fix 每次改 skill 前存的原件）是撤销安全网，删早了就没法回退；只有确实膨胀时才应增加宽松上限。

## 八、这套不是拍脑袋，业界都这么干

| 惯例 | 谁这么干 | 对应本规范 |
|---|---|---|
| 项目本地优先、全局兜底 | git（`.git/` + `~/.gitconfig`）、cargo（`target/`）、pytest（`.pytest_cache`）、terraform | 问题二：绑项目的跟项目走 |
| 数据 / 状态 / 缓存分层 | XDG Base Directory Spec | 问题一：正经数据 vs `state/` 草稿 |
| 源码和编译产物分开 | Bazel（`bazel-out`）、Cargo（`target/`）、Make | 问题一：草稿「一眼可删」且跟数据物理隔开 |
| 实验按项目 / experiment 归组 | MLflow `./mlruns`、W&B、DVC、Inspect `./logs`、HELM | 问题二 construct validity：报告只在自己上下文里可比 |
| 用内容指纹当身份 | git（content-addressed）、Nix（store path = hash） | 贯穿规则：身份靠 `id + 指纹`，搬家不断引用 |

唯一对「维持全局默认」有利的现实是：不少工具确实留全局缓存 / registry（cargo `~/.cargo`、npm cache）。但它们放全局的都是**删了能重建、哪个项目都能共用**的东西（缓存、依赖包），不是「测量结论」这种绑上下文的数据——正好落在「能重建且共用 → 全局」那格，跟本规范一致。

## 九、几个关键决策

- **测量产物默认放项目**（reports / observe-health / doctors / graphs 默认 `.omk/`，主写入命令通过 `--global` 主动写全局，sidecar 跟随该根目录）。理由：跟 omk 的项目模型（用例集就是上下文）一致；让「放对地方」成为默认行为，而不是一条容易被忘的约定。
- **Evaluation Core 按 `runId` 从通过认证的 run 目录读取**。项目与全局根可以共同搜索，但绝不会从旧报告或索引卡合成 run。
- **Studio 列出通过认证的 Core run，以及独立的 doctor / observe 域**，不合并旧 evaluation 卡片。
- **项目级保留全局兜底**（`.omk/x` 不存在就读全局），不是纯项目级。跟 `observe-inbox` 一个样，迁移更平滑。
- **`managed` 跟 skill 装在哪走**，不跟测量走。三层解耦：测量绑用例集、治理绑 skill、中间靠内容指纹连。

整套布局**不影响跨版本可比性**：只改了默认放哪 / 搬了位置 / 加了一层索引，没碰报告格式、评委 prompt、observe 复盘 prompt，也没碰任何算出来的数字。

## 相关

- [who-omk-is-for](../explanation/who-omk-is-for.md)——「不能跨用例集比分」和「omk 为谁做」，是这套归属设计的上游依据。
- [terminology-spec](terminology-spec.md)——`artifact` / `kind` / `domain` 这些词的命名归档。
- [evidence-gated-management](evidence-gated-management.md)——`managed` 治理档案与通过认证的 Core evidence projection。
