# 证据门控的知识输入管理

> **状态**：#203 的设计说明。管理支柱的入口 —— `omk install` 登记受管记录、`omk list` 展示证据状态与生命周期、`omk promote`（证据门禁的接受决定，MVP）—— 已落地（#211/#212/#224 + promote MVP）；`rollback` 与 `promote` 对 evolve 候选 canonical 写回源文件仍是设计。本文定义产品边界；不修改 Report schema、评委提示词、评分管道或可比性规则。

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
- 回滚决策必须指向历史版本，以及当时支撑它的证据。
- 线上观测必须展示归因可信度，不能静默覆盖 eval 证据。
- 证据过期或不可比时必须对用户可见，不能藏在绿色状态后面。

因此，omk 管理宁可「因为证据无效而阻塞」，也不应该「因为文件存在就安装 / 转正」。

## 4. 术语

- **知识输入**：用户可见的总称，指 LLM 接收到的 prompt、skill、RAG / corpus 输入、agent context 或 workflow 指令。
- **Artifact**：omk eval 模型里真正被测量的对象。见 [术语规范](./terminology-spec.md)。
- **Artifact kind**：具体的 `Artifact.kind` 值，例如 `skill`、`prompt`、`agent`、`workflow`。产品语义里的 `kind` 应保留给这个含义。
- **候选版本**：由 `evolve`（只写到 evolve 自己的工作目录快照里）或人工编辑提出的 artifact 版本，尚未写入 source of record。
- **转正版本**：由 `promote` 写回 source-of-record artifact 文件、并被接受为当前版本的版本，附带证据。
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
| `measurable` | doctor 和 samples 足以支持受控 eval | `eval → measurable`；`evolve → candidate` |
| `candidate` | 存在一个候选版本（`evolve` 快照或人工编辑），尚未写入 source of record | `eval → candidate`；`promote → promoted`（或拒绝，不动源文件） |
| `promoted` | 当前被接受版本，由 `promote` 写回源文件，附带证据 | `observe → promoted` / `stale`；`rollback → rolled-back`；`evolve → candidate` |
| `stale` | 证据不再匹配 artifact / runtime / sample context | `doctor` / `sample` → `measurable` |
| `rolled-back` | 由 `rollback` 恢复的、有证据的历史转正版本 | `observe`；`evolve → candidate` |

这些状态先作为产品概念存在，不一定第一天就落成新的持久化 enum。`reject` 是 `promote` 决策的否定结果（记进证据包，不动源文件），不是单独的命令。

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

`evolve` 产出候选版本。它只把候选写到自己的工作目录快照里（例如 `evolve/`），不写 source-of-record artifact 文件。对源 artifact 的 canonical 写入由 `promote` 独占。这是对 `evolve` 当前行为的变更——现在 evolve 会在跑完后把胜出候选自动写回源文件，迁移见 §8 Phase 2。

### `promote`

`promote` 把受管 skill 的当前版本按证据门禁「接受」为当前受管版本,并往记录里追加一条带证据指针的人工决定。对 source-of-record artifact 文件的 canonical 写入由它独占。

MVP（`omk promote <name>`）覆盖 install / 人工编辑流：被测内容本就在源处,promote 不重写源文件,实质是带证据的**接受决定** + 生命周期跃迁到 `promoted`（由 `deriveManagedState` 在当前内容带 `promote` 决定时读时推导）。候选还不在源处时的 canonical 写回（evolve 流）随 §8 Phase 2 的 evolve 迁移推迟——在 evolve 停止把胜者自动写回源之前,promote 在那条流里没有东西可写。

默认门禁（对最新一条**当前**证据判定,即 `contentHash` 与记录匹配）：

- 源未漂移 / 可达（否则盘上内容不是被测内容）。
- 存在当前证据（无证据即拦,`--force` 也无从锚定）。
- 可比性：证据的 `judgePromptHash`（若有）仍属当前评委模板（评委提示词变了 ⇒ 旧 verdict 不可比 ⇒ 拦）;缺指纹只 warn 不拦;`cliVersion` 仅展示、不硬卡（否则每次发版即全失效）。
- verdict 默认仅 `PROGRESS`;`CAUTIOUS` 需显式 `--accept-cautious`;其余一律拦。

`--force` 可越过非「无证据」类拦截（drift / 不可比 / verdict），在决定里记 `override.verdict` 与人工 `--reason`（不变量：override 必须显式且留痕）。对已 promote 的当前版本重跑 promote 是幂等无操作。

### `rollback`

`rollback` 恢复到历史转正版本，并指向它的证据包。它不应该是盲目的文件恢复。

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

### Phase 2：转正记录与 canonical writer 迁移

- **已落地（promote MVP）**：install / 人工编辑流的带证据**接受决定**——`omk promote <name>` 要求可比、当前、过门禁的证据（默认 `PROGRESS`）并追加一条 `promote` 决定;`deriveManagedState` 推出 `promoted` 生命周期标签。`ManagedDecision` 增了 additive 的证据指针字段（`contentHash` / `reportId` / `override`），仍 `schemaVersion 2`。
- **待办（evolve canonical-writer 迁移）**：evolve 今天会在跑完后把胜出候选自动写回源 artifact 文件，于是 `promote` 在 **evolve 流**里没有东西可守。决策 (B)：让 `promote` 独占对源 artifact 的 canonical 写入；把 `evolve` 改成只把候选写到自己的工作目录快照里、不再改动源文件。这是对 evolve 当前默认行为的变更，必须排在 `promote` 能把 evolve 候选写回源之前落地，并随 changelog / deprecation note 一起发布。
- 让 `evolve` 产出的候选可由 `promote` 带证据写回。

### Phase 3：回滚与 observe 反馈

- 增加回滚到有证据历史版本。
- 让 `observe` 标记证据过期并建议新增用例。
- 在 Studio 展示决策历史。

## 9. 开放问题

- **已定**：管理记录用 per-record 文件 `.omk/managed/<id>.json`（原子 tmp+rename，镜像 report-store），不用单一聚合文件。
- **已定（#214，已完成）**：artifact 内容指纹已统一、证据可绑定，口径锚在「executor 实际测到的输入」。每个目录-skill——本地**与** git——在测量前都物化成内容寻址隔离副本（`materializeIsolatedCopy`），executor 的 `cwd` 锚到副本，`references/` 资产成为真实运行时输入。`eval` 记的是与 `install` 同一套整树 `hashArtifactSource`（报告 `schemaVersion >= 3`），故所有目录-skill 的 `evidence.contentHash === record.contentHash` 落在同一空间（executor cache key 带同一指纹，改资产即令 cache 失效）。file-skill（本地或 git）哈单个 `.md` 字节，同样可绑定。隔离副本也意味着被测 agent 跑在副本上、不碰用户真实 skill 目录。`schemaVersion 2` 是过渡纪元（本地目录-skill 树哈、git 目录-skill 仅 `SKILL.md` 字节、不绑）；git 目录-skill 的 v2 哈与 v3 不可比。`schemaVersion < 2` 的旧报告携带旧「SKILL.md 正文」文本哈，被漂移 / lineage 消费方视为不可比（请重跑 `eval`）。
- **已定（#221，已完成）**：`eval` 已能写入证据。跑完后，对每个能匹配到被测变体的**已纳管**记录，追加一条 `ManagedEvidenceRef`（`src/managed/evidence.ts`），经 `deriveManagedState` 把 skill 从 `installed` 推到 `measurable`。三条已定取舍：(a)**触发**——eval 完成自动写，但只写已存在的记录（`install` 是 opt-in，从未安装的 skill 不会被凭空建记录），`--no-evidence` 可关；(b)**多对一**——append-only + 按 `(reportId, contentHash)` 去重、保留全部历史，当前有效性仍由读时 contentHash 匹配裁定（旧内容证据留存供回滚，却不让新内容显得已测）；(c)**跨源身份**——install 与 eval 对同一 skill 命名不一致（记录名是短名 `review`，而报告 variant 键可能是整串表达式 `git:HEAD:skills/review`、eval.yaml 别名 `candidate`、blind 标签 `A`），故用三级消歧匹配：显式同名 variant → 结构化源匹配（`variantConfigs[].locator/ref` 对齐 `record.source`）→ 纯 contentHash 回退**仅在该哈于受管记录中唯一时**才用。唯一性闸门挡住「只测了一条、却把同内容的另一条也写进证据并推成 measurable」的越权。`applyBlindMode` 盲化 `variants` 但不动 `artifactHashes` / `variantConfigs`，故三级在 blind 下照常工作。bundle 把 §5 mandatory 四项（report id、样本集覆盖、verdict、可比性 marker）denormalize 进记录，使其自解释、可 grep、不必回读 report。不改 Report schema、不动任何可比性不变量；受管记录保持 `schemaVersion 2`（additive optional 证据字段）。`promote`（MVP）现已据这些 bundle 门控——见 §7。
- git ref 与 omk 证据记录如何协作（漂移检查时,分支 ref 重物化 vs 固定 SHA）？
- `evolve` 的工作目录快照该用什么布局？对当前依赖「evolve 把胜出版本写回源文件」的用户，deprecation 路径是什么？（决策 B 的迁移机制）
- **已决（promote MVP）**：默认可接受 verdict 只 `PROGRESS`（omk default-strict——影响「值得 ship」判定的默认必须严格）;`CAUTIOUS` 需显式 `--accept-cautious`;其余需 `--force`（记为 override）。
- 当只有 sample、runtime context 或 artifact 内容变化时，证据过期策略分别是什么？
- 人类 override 应该允许在 CLI、Studio，还是两者都允许？
- `omk init` 何时演进为 `omk eval init`，兼容 alias 策略怎么定？

## 10. 当前决策

把证据门控管理视为 omk 的真实方向，但不要急着做宽泛 CRUD 命令。

下一步实现更适合从小型、证据感知的 inventory / prototype 开始，而不是通用 skill registry。这样 omk 的身份仍然锚定在测量上：只有当证据能跟 artifact 一起走时，管理才成立。
