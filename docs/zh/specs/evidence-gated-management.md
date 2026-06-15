# 证据门控的知识输入管理

> **状态**：#203 的设计说明。管理支柱的入口 —— `omk install` 登记受管记录、`omk list` 展示证据状态与生命周期、`omk promote`（证据门禁的接受决定，MVP）、`omk rollback`（撤销该接受，MVP），以及 `omk evolve` 的受管证据联动（evolve 跑在受管 skill 上会 re-baseline 并记证据 → `measurable`，默认仍写回 source；`--snapshot-only` 退出）—— 已落地（#211/#212/#224 + promote/rollback/evolve MVP）。曾计划的「promote 独占源文件 canonical 写回」迁移（旧决策 B）已**否决** —— 见 §7 `evolve` 与 §8。把历史版本内容恢复写回源（真正的文件恢复）**交给 git**——超出 omk 范围；omk 的本分是证据 + 决策轨迹；计划新增的（#236 后续）是每版的 git 坐标指针 + 还原提示，不是版本仓库（见 §7 `rollback` / §8）。本文定义产品边界；不修改 Report schema、评委提示词、评分管道或可比性规则。

## 1. 产品判断

omk 只有在「测量证据」能形成差异化时，才应该管理知识输入。

通用 skill 管理已经是平台原生能力的红海：Claude plugins / skills、Codex skills、Cursor rules 以及类似 registry 都在做「复制、列出、归档、安装」这类 CRUD。omk 不应该把定位稀释成一个更通用的文件搬运工具。

omk 独有的资产是证据：verdict、Δ、置信区间、评委一致性、用例集 hash、线上 trace 信号和可比性诊断。所以 omk 的管理应该意味着：

- 根据证据决定某个版本能不能转正。
- 保存带评测证据的版本史。
- 回滚到有证据背书的历史版本。
- 发现证据过期、不可比，或被线上 trace 反证。

一句话：omk 不是因为更会拷文件才管理知识输入，而是因为它能说明某个版本为什么值得上线。

## 2. 范围与非目标

### 范围内

- 对知识 artifact 做证据门控管理：先从 skill 开始，再逐步覆盖 prompt、agent context、workflow，以及模型定义清楚后的 RAG / corpus 类输入。
- 接住既有 omk 阶段之后的决策：
  - `doctor` 证明 artifact 结构可测。
  - `sample` 生成或修复测量用例。
  - `eval` 判断一次改动是进步、噪声还是回退。
  - `evolve` 产出候选版本。
  - `observe` 发现线上缺口，反哺下一轮 eval 用例。
- 记录并解释管理决策：已转正、已拒绝、已回滚、证据过期或需要补证据。

### 非目标

- 不做任意 skill 的通用 marketplace 或 registry。
- 不做超出 omk 明确支持目标的通用平台插件管理。
- 不在缺少共享 eval 设计时声明「A skill 比 B skill 更好」。
- 不把线上观测当作绝对评分。`observe` 是信号来源，不替代受控 eval。
- 不把 `omk install omk-agent-skill` 这个 onboarding helper 当作 #203 的完成；这部分已经在 #208 解耦。

## 3. 核心不变量：可比性优先于便利性

每个管理决策都必须保护 omk 的测量姿态：

- 转正决策必须指向可比报告，或明确标注可比性限制。
- 回滚决策必须显式且留痕；MVP 只撤销当前版本的接受。恢复*历史*版本内容交给 git——omk 负责指出该回到哪个有证据背书的版本——计划中的每版 git 坐标（#236）让这步变成精确的 `git checkout` 提示——字节层面的还原由 git 做。
- 线上观测必须展示归因可信度，不能静默覆盖 eval 证据。
- 证据过期或不可比时必须对用户可见，不能藏在绿色状态后面。

因此，omk 管理宁可「因为证据无效而阻塞」，也不应该「因为文件存在就安装 / 转正」。

## 4. 术语

- **知识输入**：用户可见的总称，指 LLM 接收到的 prompt、skill、RAG / corpus 输入、agent context 或 workflow 指令。
- **Artifact**：omk eval 模型里真正被测量的对象。见 [术语规范](./terminology-spec.md)。
- **Artifact kind**：具体的 `Artifact.kind` 值，例如 `skill`、`prompt`、`agent`、`workflow`。产品语义里的 `kind` 应保留给这个含义。
- **候选版本**：尚未落到 source of record 的 artifact 版本 —— `evolve --snapshot-only` 写在 evolve 工作目录里的快照，或人工正在编辑的改动。（默认 `evolve` 会把胜者*写回*源，所以默认 evolve 产出不是候选，而是一个被测过的当前版本。）
- **转正版本**：由人通过 `promote` 接受的当前 source-of-record 版本，附带证据。内容由产出它的一方写入（`evolve`、人工编辑或 `install`）；`promote` 记录接受，不写文件。
- **证据包**：解释一次管理决策所需的最小证据集合。

## 5. 证据包

一次管理决策应该保存或引用这些证据：

- Artifact 身份：名称、kind、来源路径或来源 URI、内容 hash、版本 / ref。
- 运行上下文：executor、model、cwd / runtime context、允许的 skill / tool 隔离、依赖指纹。
- Eval 身份：report id、omk CLI 版本、评委提示词 hash、用例集 hash 覆盖率、评分管道版本、长度去偏设置。
- Verdict 摘要：verdict、control / treatment 名称、Δ、置信区间、用例数、underpowered / cautious 标记、成本。
- 用例设计 caveat：construct 分布、provenance 分布、覆盖薄弱 capability 和明确 warning。
- 线上观测链接：trace 时间窗、归因可信度、知识缺口信号，以及这些信号是否已转成 eval 用例。
- 人类决策：转正 / 拒绝 / 回滚 / override、操作者、时间和原因。

第一版可以先引用现有 report，而不是立刻引入很重的新 schema。如果必须改 Report schema，应单独走迁移，并明确可比性影响。

强制项 vs 派生项。默认 `promote` 门禁里有四项是强制的，且必须解析到同一份可比报告：report id、用例集 hash 覆盖（报告的 `sampleHashes`）、verdict，以及可比性标记（`cliVersion` / `judgePromptHash` / `debiasMode` 一致）。缺任意一项的候选被阻塞，而不是放行；其余是 advisory 上下文。注意上面有几项并不是持久化的 Report 字段，而是从 Report 派生的——verdict、underpowered / cautious 标记、评分管道版本都是在出报告时算出来的——所以 Phase 1 应把它们当作「从被引用的 Report 派生」，而不是现成的 ReportMeta 列。把评分管道版本持久化属于 §9 的 schema 迁移问题。

## 6. 生命周期状态

受管 artifact 可以有这些产品状态：

| 状态 | 含义 | 转移（动词 → 目标状态） |
|---|---|---|
| `discovered` | omk 找到候选 artifact，但还没有管理记录（install 之前跑的 `doctor` 只是 advisory，不建记录） | `install → installed` |
| `installed` | omk 知道 artifact 在哪里，但没有有效 eval 证据 | `doctor` / `sample` → `measurable` |
| `measurable` | doctor 和 samples 足以支持受控 eval | `eval → measurable`；`evolve → measurable`（受管：写回源 + 记证据 + re-baseline）；`evolve --snapshot-only → candidate` |
| `candidate` | 一个尚未落到 source of record 的版本（`evolve --snapshot-only` 快照或人工编辑） | `eval → candidate`；`promote → promoted`（或拒绝，不动源文件） |
| `promoted` | 当前被接受版本（内容由 evolve / 人工编辑 / install 写入），经 `promote` 接受，附带证据 | `observe → promoted` / `stale`；`rollback → measurable`（源已漂移则 `stale`）；`evolve → measurable`（re-baseline 到新版本） |
| `stale` | **可达**的源、其内容 hash 不再匹配被测内容——身份漂移；源不可达（未核）以及 runtime / 样本集偏移是单独的读时 marker，不是这个标签（§6.1） | `doctor` / `sample` / 重 `eval` → `measurable` |
这些状态先作为产品概念存在，不一定第一天就落成新的持久化 enum。MVP 的 `rollback` 撤销当前版本的接受、让 skill 回到 `measurable`（源已漂移则 `stale`）。不存在 `rolled-back` 生命周期：文件层还原交给 git（§7 `rollback` / §8），用户若用 `git checkout` 回到历史版本字节，omk 只按当下当前内容经 `deriveManagedState` 重新推导状态，无特殊态。`reject` 是 `promote` 决策的否定结果（记进证据包，不动源文件），不是单独的命令。

### 6.1 证据时效：三条漂移轴

一条记录的证据证明的是*某一个 artifact 版本、在某一个样本集上、用某一套测量仪测出来的结果*。所以「过期」不是一种情况，而是三条相互独立的轴，各自对**当前**上下文判定、各自有不同后果。只有第一条是身份变化；后两条是读时 marker，不是新的生命周期标签——生命周期 enum 仍是五值，不动 Report / record schema（§6）。

| 轴 | 漂移判据 | 生命周期影响 | promote 门禁后果 |
|---|---|---|---|
| **内容**（artifact 身份） | 源**可达**且 `currentContentHash !== record.contentHash` | → `stale` | **硬拦、不可越** —— 盘上字节不是被测内容；重跑 `eval` / 重 install。 |
| **源可达性** | 源不可达——解析失败 / 拒读 / `cwd` 相对 locator；当下核不了内容 | 无 —— 保留按证据推出的标签（`installed` / `measurable` / `promoted`）+ `reachable:false`「未核」marker，**绝不** `stale` | **可越**的人工未核放行（`--force --reason`、留痕）——「这儿查不了」≠「变了」（cwd 漂掉的本地 git locator 不能读成 `stale`）。 |
| **样本**（覆盖） | `currentSampleSetHash !== evidence.sampleCoverage.hash`，**仅当**当前样本集可解析时才判（上下文里有 `eval.yaml` / 样本集） | 无 —— 读时 `sampleDrift` marker | **可越的硬拦**（`--force --reason`、记 override）—— artifact 没变，是用例集动了；人来认这个覆盖缺口，或重跑 `eval` 刷新。 |
| **运行时**（测量仪） | 评委身份：`evidence.comparability.judgePromptHash` 已不属当前评委；版本：`cliVersion` / `debiasMode` 不同 | 无 —— 读时 `judgeDrift` / `versionDrift` marker | 评委身份变（`judgeDrift`）→ **硬拦（`incomparable`）、可越**；`versionDrift`（`cliVersion` / `debiasMode`）→ **只展示、永不门控**（否则每次发版即令全部证据失效）。 |

为什么不对称：内容变了意味着 omk 测的是*另一个 artifact* —— 致命、不可越。样本集或测量仪变了意味着 omk 诚实地测了*这个* artifact，只是衡量它的尺子后来动了 —— verdict 仍是一次真实测量，所以门禁把这个偏移暴露出来、让人带留痕的理由认下缺口，而不是假装证据作废。这既守住 §3（漂移必须可见），又不把「测错了对象」（致命）和「尺子动了」（提醒）混为一谈。

读时 currency 与 `deriveManagedState` 一起算出，从不持久化：

```ts
interface EvidenceCurrency {         // 全部读时派生 —— 不动 schema
  contentDrift: boolean | 'unknown'; // true = 可达且 hash 不同 → `stale`、不可越；'unknown' = 源不可达 → 保留原标签、可越
  sampleDrift: boolean | 'unknown';  // 'unknown' = 当前上下文里没有样本集
  judgeDrift: boolean | 'unknown';   // 'unknown' = 证据没带 judgePromptHash
  versionDrift: boolean;             // cliVersion / debiasMode 偏移 —— 仅展示
}
```

`unknown` 既不是隐式放行*也不是*隐式拦截：它表示这条轴在当前上下文无从判定（源不可达、没有可解析的样本集，或证据早于 judge-hash 记录），并照此暴露 —— 与现有「缺 `judgePromptHash` 只 warn 不拦」一致。内容轴及其 `'unknown'`/未核处理今天已上线（`deriveManagedState` + `list` / `promote`：源不可达时保留原标签、仍可 `--force` 放行）；把 `sampleDrift` 接进 promote 门禁、`list`、Studio 是后续实现项 —— 策略在此已定。

## 7. 命令面

长期命令闭环保持：

```text
install → list → doctor → sample → eval → evolve → promote
                                                   ↘ rollback
observe → studio
```

### `install`

`install` 是管理支柱的入口。当前可用的源：

```bash
omk install omk-agent-skill            # 保留内置 id：omk 官方 Agent Skill（onboarding）
omk install ./skills/review            # 本地 skill（目录或 .md）
omk install git:<ref>:skills/review    # 当前仓库某个 ref 上的 skill
omk install --git-url <url> --git-ref <ref> skills/review   # 远端 git 仓库的 skill
```

内置 id 是保留的 onboarding skill，不是 registry 包，也不是用户自己的被测 artifact。安装**用户自己的** skill（本地路径、`git:` 或远端 `--git-url`）时，除分发到已检测的 agent 目标外，还会写一条管理记录到 `.omk/managed/<id>.json`。远端源会记录结构化 `url` 加**钉死的 SHA**（分支 / tag 会漂，SHA 可复现）。远端 URL 以结构化 `url`/`ref`/`spec` 字段流转，绝不拼进 `git:<ref>:<spec>` 的冒号语法（其 `:` / `@` 会切碎 `https://` 或 `git@host:` 形式的 URL）。eval 侧经 `eval.yaml`（`variants[].git: { url, ref, spec }`）接受对称的结构化写法；eval CLI 的 `--control`/`--treatment` 会拒绝远端 URL 字符串并指向 `eval.yaml`，因为它们的逗号 / `@cwd` 解析无法安全携带 URL。

未来受管输入范围（尚不支持 —— 当前 `install` 对非 skill kind 直接报错）：

```bash
omk install ./prompts/rewrite.md --kind prompt
```

规则：

- `--kind` 对齐 `Artifact.kind`，不要拿 `kind` 表示 runtime / report / event 分类。可省、命中 `SKILL.md` 自动推导，当前仅支持 `skill`。
- 安装用户 artifact 只创建管理记录，不等于转正。
- 安装后的 artifact 根据 doctor / sample 状态进入 `installed` 或 `measurable`。

### `list`

`list` 应展示证据状态，而不只是文件：

- 已发现 vs 已管理。
- artifact kind。
- 最近转正版本。
- 最近 verdict，以及是否可比。
- 证据过期标记。
- 线上观测 warning。

### `evolve`

`evolve` 跑显著性门控的迭代改进，默认把胜出版本写回 source-of-record 文件（一键化行为）。每轮候选也作为快照留在工作目录（`evolve/<skillName>.r{N}.md`）。当被 evolve 的 skill 是**受管**的，evolve 随后把这次胜出记入管理层：把记录的 `contentHash` re-baseline 到新内容 + 追加一条 `ManagedEvidenceRef`（verdict 按胜出版本 vs `round-0` 基线、用与 `omk eval` 同口径的方式算出 —— 同 bootstrap α / 重采样数），生命周期推到 `measurable`。它**不**写 `promote` 决定 —— 升 `promoted` 仍由人跑 `omk promote`（evolve 的统计接受门不是生产接受决定）。`--snapshot-only` 完全退出写回：候选留在 `evolve/` 供人工查看应用，受管记录不动。

这取代了曾计划的「evolve 只写快照、`promote` 独占 canonical 写回」迁移（旧决策 B，§8），该迁移已**否决**：evolve 自身已用 bootstrap 显著性门把关，再让胜者走一遍 `promote` 门是冗余的，会破坏一键化流程，还会逼用户先 `install` 才能让 evolve 更新源。

### `promote`

`promote` 把受管 skill 的当前版本按证据门禁「接受」为当前受管版本,并往记录里追加一条带证据指针的人工决定。它是**人工接受关卡**，不是源文件的独占写入者 —— `evolve` 和人工编辑也会写源。promote 的实质是带门禁的*决定* + 生命周期跃迁到 `promoted`，从不自己重写文件。

`omk promote <name>` 对 install / 人工编辑 / **evolve** 三条流一视同仁 —— 到你 promote 时被测内容本就已在源处（evolve 会写回；见 §7 `evolve`）。promote 不重写文件，实质是带证据的**接受决定** + 生命周期跃迁到 `promoted`（由 `deriveManagedState` 在当前内容带 `promote` 决定时读时推导）。evolve 跑在受管 skill 上之后，skill 已是 `measurable`、证据当前，所以 `omk promote` 直接接受即可（无漂移）—— 这就是 evolve→promote 路径，人保留最终接受权。

默认门禁（对最新一条**当前**证据判定,即 `contentHash` 与记录匹配）：

- 源未漂移 / 可达（否则盘上内容不是被测内容）。
- 存在当前证据（无证据即拦,`--force` 也无从锚定）。
- 可比性：证据的 `judgePromptHash`（若有）仍属当前评委模板（评委提示词变了 ⇒ 旧 verdict 不可比 ⇒ 拦）;缺指纹只 warn 不拦;`cliVersion` 仅展示、不硬卡（否则每次发版即全失效）。
- verdict 默认仅 `PROGRESS`;`CAUTIOUS` 需显式 `--accept-cautious`;其余一律拦。

§5 的四项 mandatory,MVP 门禁在 promote 时核三项（report id 经「存在当前证据」、verdict、可比性 marker）;**样本集覆盖**由 `eval`（§9、#221）denormalize 进证据 bundle、在此被信任——门禁不重算也不重核。（§5 的「mandatory」说的是 `eval` 必须写进 bundle 的内容,不是 promote 时另起一道核查。）一条已定但未接线的补充（§6.1）：当当前样本集可解析、其 hash 与 bundle 的 `sampleCoverage.hash` 不一致时，门禁会加一道*可越*的拦截（`--force --reason`、记 override），与内容漂移的不可越拦截分档；MVP 暂未计算这条。

`--force` 只可越过可越门的非「无证据」类拦截（源不可达 / 不可比 / verdict），在决定里记 `override.verdict`（外加 `override.overriddenBlocks` 标明被越过了哪几条判据）与必填的人工 `--reason`（不变量：override 必须显式且留痕）。若源可达但内容 hash 已不同，则不可越门：decision 仍会指向旧的 `record.contentHash`，用户必须重新跑 `omk eval` / 重新 install。对已 promote 的当前版本重跑 promote 是幂等无操作。

### `rollback`

`rollback` 是 `promote` 的反操作：撤销当前版本的 promoted 接受。决定是 append-only 事件流，故 rollback 不删除原 promote，而是追加一条 `rollback` 决定（actor、时间戳、可选理由）；`promoted` 生命周期标签再按当前内容**最近一条** promote/rollback 决定推导（`isCurrentlyPromoted`），源未漂移则回到 `measurable`，源已漂移则仍为 `stale`（rollback 不探源）。它是内容锚定、无门禁的（降级永远安全）：只看 `record.contentHash` 上的 promote/rollback 历史。

MVP 落地的是 `omk rollback <name>`：撤销**当前**内容的接受。回退一个未 promoted 的版本以非零码退出（无可撤销）；回退一个已回退的版本是幂等无操作；`promote → rollback → promote` 会恢复 `promoted`（latest-wins）。把*更早的转正版本内容*恢复写回源文件（真正的文件恢复）**超出范围——交给 git**。omk 不存版本字节、不自建版本仓库（那就成了 §1 明确不做的「更会拷文件」），也不替用户对工作树执行还原（冒犯，且是 git 的本分）。omk 该加的是本分内的一点（#236 后续，尚未实现——目前 `ManagedEvidenceRef` / `ManagedDecision` 只有 `contentHash` / `reportId`，远端源的 pinned SHA 也是记录级、非每版）：在证据旁额外记一个每版的 git 坐标（SHA）当指针，让 `list` / Studio 能展示带证据的版本历史，并对 git 来源给出现成的 `git checkout` 把你带回选定的版本。非 git、就地编辑的源没有坐标可还原——诚实的答案是用 git 把 skill 管起来，omk 不重造它。

### `observe`

`observe` 通过标记证据过期、发现线上缺口或建议新增用例来反哺管理决策。它不能静默转正或降级 artifact。

### `studio`

Studio 应让决策轨迹可检查：为什么当前是这个版本、证据是什么、还有哪些 warning，以及自上次转正后发生了什么变化。

## 8. 分阶段

### Phase 0：onboarding install

已在 #208 / PR #207 完成：

- npm 包携带 omk 官方 Agent Skill。
- `omk install omk-agent-skill` 只安装到已检测或显式指定的支持目标。
- 这不关闭证据门控管理设计。

### Phase 1：设计与只读 inventory

- 合入本文。
- 增加只读 `list` 语义，或做一个 inventory 原型：展示已发现 / 已管理 / 证据状态，但不改 artifact。
- 定义第一版证据包存储形态。

### Phase 2：转正记录与 evolve↔管理层联动

- **已落地（promote MVP）**：install / 人工编辑流的带证据**接受决定**——`omk promote <name>` 要求可比、当前、过门禁的证据（默认 `PROGRESS`）并追加一条 `promote` 决定;`deriveManagedState` 推出 `promoted` 生命周期标签。`ManagedDecision` 增了 additive 的证据指针字段（`contentHash` / `reportId` / `override`），仍 `schemaVersion 2`。
- **已落地（evolve 受管证据联动）**：`omk evolve` 跑在**受管** skill 上时把胜出记入管理层 —— 把记录 `contentHash` re-baseline 到新源内容 + 追加一条带「胜出 vs `round-0`」verdict 的 `ManagedEvidenceRef`（生命周期 → `measurable`）。evolve 默认仍把胜者写回 source（保一键化）；`--snapshot-only` 退出（候选留在 `evolve/`、记录不动）。它只记证据 —— **不**写 `promote` 决定 —— 人保留接受权。Additive `schemaVersion 2`；复用 `appendManagedEvidence` + 新增 `rebaselineManagedContentHash`。
- **已否决（旧决策 B：canonical-writer 迁移）**：让 `promote` 成为源的*唯一*写入者、剥掉 `evolve` 的写源。evolve 自身已有 bootstrap 显著性门，再来一道 `promote` 门是冗余的；还会破坏一键化、逼用户先 `install` 才能让 evolve 更新 skill。管理盲区（evolve 改源对管理层不可见）靠*记录*证据补上，而非*改道*写入。

### Phase 3：回滚与 observe 反馈

- **已落地（rollback MVP）：** `omk rollback <name>` 通过追加一条 `rollback` 决定撤销当前版本的 promoted 接受；`isCurrentlyPromoted`（当前内容最近一条 promote/rollback 决定胜出）把状态推回 `measurable`（源已漂移则 `stale` —— rollback 不探源）。`ManagedDecisionKind` 本就含 `rollback`，无 schema 变更。
- **超出范围（交给 git）：** 把*历史*版本内容恢复写回源文件（真正的文件恢复）。自建版本内容仓库会让 omk 变成 §1 明确不做的「更会拷文件」——git 本就提供持久、内容寻址的版本管理。omk 本分内的贡献（#236 后续，尚未实现）是：额外记一个每版的 git 坐标（SHA）当指针，并把带证据的版本历史 + 对 git 来源的 `git checkout` 提示展示出来（并入 Studio 决策史，§7 `studio`）。非 git 来源就直说文件版本管理是 git 的活。已发的决策级 rollback（撤销接受）仍是 omk 自己该握住的部分。
- 让 `observe` 标记证据过期并建议新增用例。
- 在 Studio 展示决策历史。

## 9. 开放问题

- **已定**：管理记录用 per-record 文件 `.omk/managed/<id>.json`（原子 tmp+rename，镜像 report-store），不用单一聚合文件。
- **已定（#214，已完成）**：artifact 内容指纹已统一、证据可绑定，口径锚在「executor 实际测到的输入」。每个目录-skill——本地**与** git——在测量前都物化成内容寻址隔离副本（`materializeIsolatedCopy`），executor 的 `cwd` 锚到副本，`references/` 资产成为真实运行时输入。`eval` 记的是与 `install` 同一套整树 `hashArtifactSource`（报告 `schemaVersion >= 3`），故所有目录-skill 的 `evidence.contentHash === record.contentHash` 落在同一空间（executor cache key 带同一指纹，改资产即令 cache 失效）。file-skill（本地或 git）哈单个 `.md` 字节，同样可绑定。隔离副本也意味着被测 agent 跑在副本上、不碰用户真实 skill 目录。`schemaVersion 2` 是过渡纪元（本地目录-skill 树哈、git 目录-skill 仅 `SKILL.md` 字节、不绑）；git 目录-skill 的 v2 哈与 v3 不可比。`schemaVersion < 2` 的旧报告携带旧「SKILL.md 正文」文本哈，被漂移 / lineage 消费方视为不可比（请重跑 `eval`）。
- **已定（#221，已完成）**：`eval` 已能写入证据。跑完后，对每个能匹配到被测变体的**已纳管**记录，追加一条 `ManagedEvidenceRef`（`src/managed/evidence.ts`），经 `deriveManagedState` 把 skill 从 `installed` 推到 `measurable`。三条已定取舍：(a)**触发**——eval 完成自动写，但只写已存在的记录（`install` 是 opt-in，从未安装的 skill 不会被凭空建记录），`--no-evidence` 可关；(b)**多对一**——append-only + 按 `(reportId, contentHash)` 去重、保留全部历史，当前有效性仍由读时 contentHash 匹配裁定（旧内容证据留存供回滚，却不让新内容显得已测）；(c)**跨源身份**——install 与 eval 对同一 skill 命名不一致（记录名是短名 `review`，而报告 variant 键可能是整串表达式 `git:HEAD:skills/review`、eval.yaml 别名 `candidate`、blind 标签 `A`），故用三级消歧匹配：显式同名 variant → 结构化源匹配（`variantConfigs[].locator/ref` 对齐 `record.source`）→ 纯 contentHash 回退**仅在该哈于受管记录中唯一时**才用。唯一性闸门挡住「只测了一条、却把同内容的另一条也写进证据并推成 measurable」的越权。`applyBlindMode` 盲化 `variants` 但不动 `artifactHashes` / `variantConfigs`，故三级在 blind 下照常工作。bundle 把 §5 mandatory 四项（report id、样本集覆盖、verdict、可比性 marker）denormalize 进记录，使其自解释、可 grep、不必回读 report。不改 Report schema、不动任何可比性不变量；受管记录保持 `schemaVersion 2`（additive optional 证据字段）。`promote`（MVP）现已据这些 bundle 门控——见 §7。
- **已定（#237）**：漂移是对源的**当前解析**做内容寻址判定，而你安装的 ref 本身就是「快照 vs 活指针」的选择。不可变 ref（commit SHA）天然解析到恒定内容 —— 永不漂移；远端钉死的 SHA 直接短路、不重取，本地 SHA 仍从仓库对象库重物化、只是哈值相同。**本地** moving ref（`git:main:…` / `HEAD` / tag）是*活指针*：每次漂移检查重新物化该 ref、重哈 skill 树，故记录恰在 skill 内容随该 ref 移动时变 content-`stale` —— 绝不冻结到安装时 SHA，因为在已移动的分支上挂绿色状态会藏住漂移（§3）。**远端** install 钉死到安装时解析出的 SHA（记 SHA、不记分支）：这是有意的可复现 + 离线取舍 —— 分发出去的版本应是一个冻结、可重取的快照，且漂移检查不应依赖网络可达。所以本地 / 远端的区分是**有意的、按 persona 划分**（本地=在工作分支上迭代；远端=分发已验版本），不是疏忽；要让远端钉死的记录前进就 reinstall（重新 pin + re-baseline）。见 §6.1 内容轴。
- **已决：** `evolve` 默认仍把胜者写回源（无需 deprecation）；`--snapshot-only` 是只产候选时的退出开关（快照留在 `evolve/`）。受管 skill 上 evolve 记证据 + re-baseline 记录（→ `measurable`），而不是把写入改道经 `promote` —— 旧决策 B（promote 独占 canonical 写）已否决；见 §7 `evolve` 与 §8。
- **已决（promote MVP）**：默认可接受 verdict 只 `PROGRESS`（omk default-strict——影响「值得 ship」判定的默认必须严格）;`CAUTIOUS` 需显式 `--accept-cautious`;其余需 `--force`（记为 override）。
- **已定（#237）**：过期按轴分别判、各自对当前上下文判定 —— 完整模型见 §6.1。**内容**漂移（**可达**的源、hash 不同——artifact 身份）是唯一会把生命周期翻成 `stale` 并硬拦 promote（不可越）的轴；源**不可达**是另一回事——现有的「未核」态，保留按证据推出的标签、仍可 `--force --reason` 放行，绝不静默 `stale`。**样本集**漂移（artifact 没变；当前用例集与证据 `sampleCoverage.hash` 不一致，仅当当前样本集可解析时才判）暴露读时 `sampleDrift` marker，且是**可越的 promote 硬拦**（`--force --reason`、记 override），不改生命周期。**运行时**漂移分两支：评委身份变了（`judgePromptHash` 已不属当前）走现有 `incomparable` 硬拦（可越），而 `cliVersion` / `debiasMode` 偏移只展示、永不门控。不新增持久生命周期 enum、不动 Report / record schema —— marker 都是读时派生。把 `sampleDrift` 接进 promote 门禁与 `list` / Studio 是后续实现项（也反哺 §7 `observe` 的「线上缺口→补用例」那条路径）；策略在此已定。
- 人类 override 应该允许在 CLI、Studio，还是两者都允许？
- `omk init` 何时演进为 `omk eval init`，兼容 alias 策略怎么定？

## 10. 当前决策

把证据门控管理视为 omk 的真实方向，但不要急着做宽泛 CRUD 命令。

下一步实现更适合从小型、证据感知的 inventory / prototype 开始，而不是通用 skill registry。这样 omk 的身份仍然锚定在测量上：只有当证据能跟 artifact 一起走时，管理才成立。
