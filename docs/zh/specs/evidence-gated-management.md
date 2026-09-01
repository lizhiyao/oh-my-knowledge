# 证据门控的知识输入管理

> **状态**：#203 的已实现设计，并已按 Evaluation Core 生产切换更新。managed 记录使用 schema v3，只接受通过认证的 Core evidence projection。schema v2 记录与旧 evaluation report 会被拒绝，不提供迁移。本文不修改冻结的评分类 prompt、评分语义或可比性公式。

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

- 转正决策必须指向通过认证且 `decision-ready` 的 Core run，或明确记录对可越门判据的人工 override。
- 回滚决策必须显式且留痕；MVP 只撤销当前版本的接受。恢复历史内容完全交给源仓库。受管证据用 digest 标识被测内容，不臆造源码管理坐标。
- 线上观测必须展示归因可信度，不能静默覆盖 eval 证据。
- 证据过期、不完整或仅供测量时必须对用户可见，不能藏在绿色状态后面。

因此，omk 管理宁可「因为证据无效而阻塞」，也不应该「因为文件存在就安装 / 转正」。

## 4. 术语

- **知识输入**：用户可见的总称，指 LLM 接收到的 prompt、skill、RAG / corpus 输入、agent context 或 workflow 指令。
- **Artifact**：omk eval 模型里真正被测量的对象。见 [术语规范](./terminology-spec.md)。
- **Artifact kind**：具体的 `Artifact.kind` 值，例如 `skill`、`prompt`、`agent`、`workflow`。产品语义里的 `kind` 应保留给这个含义。
- **候选版本**：尚未落到 source of record 的 artifact 版本 —— `evolve --snapshot-only` 写在 evolve 工作目录里的快照，或人工正在编辑的改动。（默认 `evolve` 会把胜者*写回*源，所以默认 evolve 产出不是候选，而是一个被测过的当前版本。）
- **转正版本**：由人通过 `promote` 接受的当前 source-of-record 版本，附带证据。内容由产出它的一方写入（`evolve`、人工编辑或 `install`）；`promote` 记录接受，不写文件。
- **证据包**：解释一次管理决策所需的最小证据集合。

## 5. 证据包

一次管理决策保存由单个 Evaluation Core run 认证后得到的 denormalized projection：

- Artifact 身份：名称、kind、来源路径或来源 URI、内容 hash、版本 / ref。
- Core 身份：`runId`、report id / digest、target id、artifact digest 与 artifact content hash。
- 可比性身份：run contract、dataset revision、execution plan、evaluation plan、analysis plan 与 decision plan digest。
- 决策投影：evidence readiness、有决定时的 verdict、稳定 reason code 与样本覆盖。
- 用例设计 caveat：construct 分布、provenance 分布、覆盖薄弱 capability 和明确 warning。
- 线上观测链接：trace 时间窗、归因可信度、知识缺口信号，以及这些信号是否已转成 eval 用例。
- 人类决策：转正 / 拒绝 / 回滚 / override、操作者、时间和原因。

managed 层不根据报告行重新推导这些结论。Core downstream projection 只有在 manifest、digest、lineage 与内容引用全部通过认证后才会产生。身份缺失或 projection 不是 `decision-ready` 时一律失败关闭。`promote` 仍要求证据绑定当前内容且 verdict 可接受；`--force --reason` 可以越过可越门的决策阻断，但不能凭空生成缺失证据，也不能接受已经确认变更的内容。

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

一条记录的证据证明的是*某一个 artifact 版本，在某个 dataset revision 下，依照一份 sealed Core contract 得到的结果*。证据时效因此由内容身份与通过认证的 Core readiness / comparability projection 共同决定。

| 轴 | 漂移判据 | 生命周期影响 | promote 门禁后果 |
|---|---|---|---|
| **内容**（artifact 身份） | 源可达且 `currentContentHash !== record.contentHash` | → `stale` | 不可越门；重新运行 `eval` 或 reinstall。 |
| **源可达性** | 当前内容无法验证 | 保留证据推导的标签，并显示未核 marker | 只有存在当前 Core 证据时才可越门。 |
| **Dataset**（覆盖） | `sampleCoverage.hash` 标识 sealed dataset revision | 无 | 只作为认证 projection 的一部分被信任；managed 层不重新构造。 |
| **Core 决策就绪度** | `evidenceReadiness !== decision-ready`，或不存在已决定 verdict | 无 | 可越门的决策阻断，必须记录 override。 |

这种不对称是有意的：已知内容变化意味着 OMK 测的是另一个 artifact，不允许 override；源不可达只是未知，而不是已知不同，因此可由可归属的人进行 override。Core plan 与 dataset 身份直接以 digest 持久化在 evidence 上，不再根据 CLI 版本或 prompt hash 事后猜测。

第四个读时 marker，由 `observe` 而非证据时效喂入（#235）：**生产盲区** marker。前三轴问的是*证据*还当不当前；这一个问的是*线上流量*里 skill 有没有在失败（知识盲区、含糊回避、反复失败）。它**版本无关**：`observe` 量的是线上**部署版**的行为，而记录里没有可靠的「源码版 ↔ 部署版」时间锚（`evolve` 只把 `contentHash` 重锚、不重新分发，线上跑的还是旧副本）——所以这个 marker **不按源码版归因、也没有版本闸门**。加闸门只会给假精度，还会在源码 bump 后错误压掉仍然有效的真盲区。取**最新一条**观测（按被观测窗口结束时刻）：**绝不翻 `stale` 生命周期**（只有内容漂移会），也**绝不门控 `promote`** —— `observe` 是信号源、不是受控 eval（§2）。红且统计够力的观测读作盲区；`underpowered` 的是 `unknown`（线上段数太少不可判 —— 暴露但不当盲区）。marker 反映的是部署副本、可能滞后于当前源码版。见 §7 `observe`。

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

`evolve` 跑 Core-native 改进循环，默认把胜出版本写回 source-of-record，每轮候选同时保留在 `evolve/` 下。每个候选都作为显式 Core control/treatment 对比进行测量，接受结果直接来自通过认证的 Core decision projection，authoring 层不重新实现统计判定。对受管 skill，evolve 会先确认胜出 target 的 sealed artifact digest 与已写回的源内容一致，再 re-baseline `contentHash` 并追加该条 Core 证据；digest 匹配有歧义时 fail-closed。它不写 `promote` 决定，生产接受仍由人显式执行 `omk promote`。`--snapshot-only` 不改源文件，也不改受管记录。

这取代了曾计划的「evolve 只写快照、`promote` 独占 canonical 写回」迁移（旧决策 B，§8）。该方案已否决：evolve 已经通过 Core decision 接受候选，而 promote 是独立的人工生产接受决定。让 promote 兼任写入者会破坏一键 authoring 流程，还会强迫用户先 `install` 才能让 evolve 更新源。

### `promote`

`promote` 把受管 skill 的当前版本按证据门禁「接受」为当前受管版本,并往记录里追加一条带证据指针的人工决定。它是**人工接受关卡**，不是源文件的独占写入者 —— `evolve` 和人工编辑也会写源。promote 的实质是带门禁的*决定* + 生命周期跃迁到 `promoted`，从不自己重写文件。

`omk promote <name>` 对 install / 人工编辑 / **evolve** 三条流一视同仁 —— 到你 promote 时被测内容本就已在源处（evolve 会写回；见 §7 `evolve`）。promote 不重写文件，实质是带证据的**接受决定** + 生命周期跃迁到 `promoted`（由 `deriveManagedState` 在当前内容带 `promote` 决定时读时推导）。evolve 跑在受管 skill 上之后，skill 已是 `measurable`、证据当前，所以 `omk promote` 直接接受即可（无漂移）—— 这就是 evolve→promote 路径，人保留最终接受权。

默认门禁（对最新一条**当前**证据判定,即 `contentHash` 与记录匹配）：

- 源未漂移 / 可达（否则盘上内容不是被测内容）。
- 存在当前证据（无证据即拦,`--force` 也无从锚定）。
- 通过认证的 Core projection 必须为 `decision-ready`。
- verdict 默认仅 `PROGRESS`;`CAUTIOUS` 需显式 `--accept-cautious`;其余一律拦。

门禁信任通过认证的 projection 中 sealed dataset 与 plan digest，不会重新读取报告或复现 Core 认证。即使包含分数，`measurement-only` 或 `insufficient` projection 也会被阻断。

`--force` 只可越过可越门的非「无证据」类拦截（源不可达 / 不可比 / verdict），在决定里记 `override.verdict`（外加 `override.overriddenBlocks` 标明被越过了哪几条判据）与必填的人工 `--reason`（不变量：override 必须显式且留痕）。若源可达但内容 hash 已不同，则不可越门：decision 仍会指向旧的 `record.contentHash`，用户必须重新跑 `omk eval` / 重新 install。对已 promote 的当前版本重跑 promote 是幂等无操作。

### `rollback`

`rollback` 是 `promote` 的反操作：撤销当前版本的 promoted 接受。决定是 append-only 事件流，故 rollback 不删除原 promote，而是追加一条 `rollback` 决定（actor、时间戳、可选理由）；`promoted` 生命周期标签再按当前内容**最近一条** promote/rollback 决定推导（`isCurrentlyPromoted`），源未漂移则回到 `measurable`，源已漂移则仍为 `stale`（rollback 不探源）。它是内容锚定、无门禁的（降级永远安全）：只看 `record.contentHash` 上的 promote/rollback 历史。

MVP 落地的是 `omk rollback <name>`：撤销**当前**内容的接受。回退未 promoted 的版本以非零码退出；重复回退是幂等无操作；`promote → rollback → promote` 因 latest-wins 恢复 `promoted`。把更早内容恢复回源文件超出范围。Core 证据只携带通过认证的内容与 plan digest，不猜测工作树 ref，也不生成 checkout 命令。用户通过自己的源仓库恢复字节，然后重跑 Evaluation Core，为恢复后的内容建立新证据。

### `observe`

`observe` 反哺管理支柱，但绝不静默转正或降级 artifact（它是信号源、不是受控 eval —— §2）。跑完后，对每个**已纳管**、名字匹配上某个被观测 skill 的 `skill` 记录，追加一条 denormalized `ManagedObservation`（生产盲区率、严重度加权率、统计功效、盲区类型计数）。匹配按 **name + kind** —— `observe` 的 trace 不带 `contentHash`，只有调用名，约定上等于 install 名；skill 的 frontmatter `name:` 与 install 目录名不一致时则什么都不记（fail-safe）。记录据此得到一个读时**生产盲区** marker（§6.1），CLI 打印该补哪些盲区区域的用例。它**不**改样本集（只建议）、不翻 `stale` 生命周期（盲区是 marker、不是内容漂移）、不升降级。`--no-feedback` 关闭写入；未纳管的 skill 绝不被凭空建记录（与 `eval` 写证据的 opt-in 一致）。

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

- **已落地（promote）**：`omk promote <name>` 要求当前且通过认证的 Core evidence（默认 verdict 为 `PROGRESS`），并追加带 `contentHash`、Core `runId` 与显式 override 的 `promote` 决定。`deriveManagedState` 推导 `promoted` 生命周期标签。
- **已落地（evolve 受管证据联动）**：`omk evolve` 在受管 skill 上 re-baseline 胜出内容并记录通过认证的 Core evidence projection，使记录进入 `measurable`；它不代替人写 `promote` 决定。`--snapshot-only` 不修改 managed 记录。
- **已否决（旧决策 B：canonical-writer 迁移）**：让 `promote` 成为源的*唯一*写入者、剥掉 `evolve` 的写源。evolve 已经通过 Core decision 接受候选，promote 是独立的人工生产接受决定。管理盲区靠记录通过认证的证据补上，而非改道写入。

### Phase 3：回滚与 observe 反馈

- **已落地（rollback MVP）：** `omk rollback <name>` 通过追加一条 `rollback` 决定撤销当前版本的 promoted 接受；`isCurrentlyPromoted`（当前内容最近一条 promote/rollback 决定胜出）把状态推回 `measurable`（源已漂移则 `stale` —— rollback 不探源）。`ManagedDecisionKind` 本就含 `rollback`，无 schema 变更。
- **超出范围（交给源码管理）：** 恢复历史字节。Core 以通过认证的 digest 标识被测 artifact，不合成 git ref，也不修改工作树。omk 自己负责的仍是已发的决策级 rollback（撤销接受）。
- **已落地（#235）：** `observe` 在匹配到的受管 skill 上记一条生产健康观测（`ManagedObservation`，append-only）、surface 读时生产盲区 marker、打印补样本建议。不翻生命周期（盲区是 marker、不是 `stale` —— §6.1），不改样本集。
- 在 Studio 展示决策历史。

## 9. 已定决策

- managed 记录使用 per-record 文件 `.omk/managed/<id>.json` 与原子写入，不使用单一聚合文件。
- schema v3 是干净的 Core-only 边界。schema v2 记录不迁移；用户需要 reinstall 并重新运行 Core 评测。
- Artifact 内容身份锚定 executor 实际测量的输入。目录 skill 使用隔离的整树内容寻址副本，文件 skill 对文件字节做 hash。
- `eval` 只向已纳管记录追加通过认证的 Core projection。匹配优先使用精确 target name，其次只在 content hash 在所有 managed 记录中唯一时回退。证据保持 append-only，并按 Core run / report 身份与内容去重。
- **已定（#237）**：漂移是对源的**当前解析**做内容寻址判定，而你安装的 ref 本身就是「快照 vs 活指针」的选择。不可变 ref（commit SHA）天然解析到恒定内容 —— 永不漂移；远端钉死的 SHA 直接短路、不重取，本地 SHA 仍从仓库对象库重物化、只是哈值相同。**本地** moving ref（`git:main:…` / `HEAD` / tag）是*活指针*：每次漂移检查重新物化该 ref、重哈 skill 树，故记录恰在 skill 内容随该 ref 移动时变 content-`stale` —— 绝不冻结到安装时 SHA，因为在已移动的分支上挂绿色状态会藏住漂移（§3）。**远端** install 钉死到安装时解析出的 SHA（记 SHA、不记分支）：这是有意的可复现 + 离线取舍 —— 分发出去的版本应是一个冻结、可重取的快照，且漂移检查不应依赖网络可达。所以本地 / 远端的区分是**有意的、按 persona 划分**（本地=在工作分支上迭代；远端=分发已验版本），不是疏忽；要让远端钉死的记录前进就 reinstall（重新 pin + re-baseline）。见 §6.1 内容轴。
- **已决：** `evolve` 默认仍把胜者写回源（无需 deprecation）；`--snapshot-only` 是只产候选时的退出开关（快照留在 `evolve/`）。受管 skill 上 evolve 记证据 + re-baseline 记录（→ `measurable`），而不是把写入改道经 `promote` —— 旧决策 B（promote 独占 canonical 写）已否决；见 §7 `evolve` 与 §8。
- **已决（promote MVP）**：默认可接受 verdict 只 `PROGRESS`（omk default-strict——影响「值得 ship」判定的默认必须严格）;`CAUTIOUS` 需显式 `--accept-cautious`;其余需 `--force`（记为 override）。
- 内容漂移是唯一进入 `stale` 的生命周期变化；已知字节变化不可越门。源不可达可由可归属的人越门；Core readiness / verdict 阻断可越门；缺少当前证据永远不可越门。
- `observe` 保持独立、版本无关的生产信号。它可以增加生产盲区 marker，但绝不能冒充受控 Core 证据，也不能自行改变生命周期。
- **已定（#238）**：人工 override **仅限 CLI**——`promote --force --reason`，决定的 `actor` 由 `--actor` / git / env 记录，被绕过的门可审计。Studio 保持**只读**：把 override 摆出来供审计（`/managed/<id>` 决策时间线渲染被绕过的门，`/managed` 列表对「当前版本是越门采用的」打标），但自己绝不执行 override。override 绕过测量门禁、必须可归属到人；本地 Studio 网页没有账号体系、omk 也不引入，记不下可信 actor——把写留在 CLI 同时保住审计链与 Studio 的只读姿态。

## 10. 当前决策

把证据门控管理视为 omk 的真实方向，但不要急着做宽泛 CRUD 命令。

下一步实现更适合从小型、证据感知的 inventory / prototype 开始，而不是通用 skill registry。这样 omk 的身份仍然锚定在测量上：只有当证据能跟 artifact 一起走时，管理才成立。
