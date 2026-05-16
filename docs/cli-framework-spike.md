# CLI 框架 spike：oclif 调研结论

> **PR-A**（issue [#109](https://github.com/lizhiyao/oh-my-knowledge/issues/109)）。
> 本文是 spike 的唯一产出。原型代码在 [`spike/oclif/`](../spike/oclif)，6 项实验快照在 [`spike/oclif/experiments/`](../spike/oclif/experiments)。

## 结论先行

**Conditional GO**：oclif 适合 omk，建议进 PR-B 推动迁移。

**触发条件**（任一不满足则改走 fallback typed metadata registry）：

1. 接受 ~50 LOC 自写 error handler，把 oclif 的「unknown command」「enum 校验失败」从 exit 1 强制成 exit 2，保 omk 现有 `parse-strict.ts` invariant。装 `@oclif/plugin-not-found` 后 unknown command 会变成 exit 127（更偏 invariant），所以这个 handler 也得管 plugin 路径。
2. 接受 ~110 LOC 自写 LangAwareHelp 子类做双语 help 切换（spike 已写完，能直接拿来用）。
3. 接受 `oclif readme` / `oclif manifest` 一次只能 emit 一种语言的产出（要双语 README 就跑两次，外加少量脚本拼接）。
4. 接受 ~80 LOC polish 给 plugin / `--json` / shell completion 三个 platform-type 能力补齐 omk invariant：plugin-not-found 路径 exit code 归一、`--json` 失败路径 error message 不丢 + parse error sanitize、bash completion 给 enum 值补 compgen 列表 + `OMK_LANG=en` 时 completion hint 切英文。

**为什么是 Conditional 不是 Unconditional**：

- 「unknown command exit 2」「enum mismatch exit 2」是 omk 测量学 invariant 的延伸（CLI 入口的错误分类要稳定，否则脚本调用方对 exit code 的判定漂移）。oclif 默认行为偏离，需要 patch。
- 双语 help 在 oclif 里是「自己写 Help 子类」级别的事，不在框架自动覆盖范围内。spike 跑通了实现方案，但维护成本是 omk 自己背。
- `oclif readme` 自动生成 README CLI 段是核心吸引点（issue #109 痛点的直击）。能跑通，但单次只出一种语言，要做完整 bilingual docs codegen 还得包一层。

## 9 项验收矩阵

（原 6 项是 issue comment 2 列的核心 deal-breaker；exp-7/8/9 是 review 后补的 3 项 platform-type 能力验证。）

| # | 验收项 | 结果 | 实测数据 | 实现成本 |
|---|---|---|---|---|
| 1 | 双语 help / OMK_LANG | ⚠️ 需要自写 Help 子类 | OMK_LANG=zh\|en 切换全 OK；--lang 同效。Help 默认 formatter 不读 lang，需 override `showCommandHelp` + `formatCommand` + `formatCommands` 三个钩子，filter bilingual 字段 | ~110 LOC（[spike/oclif/src/help.ts](../spike/oclif/src/help.ts) 已落地） |
| 2 | unknown flag exit 2 | ✅ 默认行为 | `doctor --no-such-flag` exit 2，`See more help with --help` 提示自动给 | 0 LOC |
| 2b | unknown command exit 2 | ❌ 默认 exit 1 | `node bin/run.js nope` exit 1，`Error: command nope not found`，跟 omk parse-strict invariant 偏 | +30-50 LOC error handler |
| 2c | enum validation exit 2 | ❌ 默认 exit 1 | `sample skills/x --strategy bogus` exit 1，`Expected --strategy=bogus to be one of: ...` | +20 LOC（同上 handler 一份） |
| 3a | required positional | ✅ | `sample`（缺 skillPath）exit 2，错误信息含 arg 描述 | 0 LOC |
| 3b | flag default value | ✅ | `--count` default 5、`--strategy` default workflow、`--lang` default zh+env OMK_LANG，全 OK | 0 LOC |
| 3c | enum (options) 校验 | ✅（语义正确，exit code 见 2c） | `Flags.string({ options: [...] })` 自动校验 | 0 LOC |
| 3d | boolean / `--no-*` | ✅ | `Flags.boolean({ default: false })` 自然表达，CLI 写 `--no-cache` 启用 | 0 LOC |
| 3e | integer 类型校验 | ✅ | `--count abc` exit 2，`Parsing --count Expected an integer but received: abc` | 0 LOC |
| 4 | subcommand 元数据外部 walk | ✅ | `studio start` / `studio dump` 通过 `src/commands/studio/{start,dump}.ts` + `topicSeparator: " "` 自然组织；`oclif manifest` 产出 8.4KB JSON，含 4 个命令的 description / flags / args / examples 全量元数据 | 0 LOC |
| 5a | `oclif readme` 自动重写 README CLI 段 | ✅ | 装 `oclif` devDep + README 加 `<!-- commands -->` markers，跑 `npx oclif readme` 直接写入。spike 第一次跑就成功，无配置 | 0 LOC |
| 5b | `oclif manifest` 输出结构化 JSON | ✅ | `npx oclif manifest` 输出 `commands` map，给 Studio web UI / 外部脚本消费 | 0 LOC（需 `package.json` 有 `files` 字段，1 行） |
| 5c | bilingual readme | ⚠️ 一次一种语言 | `OMK_LANG=en npx oclif readme` 会把 README 整体改成 en；要双语就跑 2 次输出到 2 文件 + 1 个脚本拼接 | +30 LOC 拼接脚本（如果要单文件双语） |
| 6 | npm 打包形态 | ✅ | tarball 11.5kB（spike 含 4 命令 + dist + manifest）。`@oclif/core` 安装 940KB（一次性，跟 omk 现有 86MB node_modules 量级一比可忽略）。`bin.omk` 跟 `files: ["dist/src/"]` 字段都跟现有约定兼容 | 0 LOC，主项目 package.json 仅加 1 dep |
| 7a | plugin 接入流程 | ✅ | 1 行 `yarn add @oclif/plugin-not-found` + `package.json` `oclif.plugins` 数组 1 行即用。`plugin-warn-if-update-available` 同模式 | 0 LOC |
| 7b | plugin-not-found 行为 | ⚠️ exit 127 | unknown command 给 `Warning: doctorr is not a omk-spike command` + `Run omk-spike help`，**exit 127**（shell "command not found" 约定）。跟 omk invariant exit 2 更偏；触发条件 #1 的 handler 要管这条路径 | +20 LOC（并入 #1） |
| 7c | "did you mean..." 建议 | ❌ 默认不出 | plugin-not-found 默认不给 typo 建议，要 spawn 模式或自配置 | 不阻塞，followup |
| 7d | 自定义 plugin 脚手架 | ✅ | `oclif generate command` / `generate hook` 在框架内自带；plugin 整体走 `oclif generate plugin <path>` interactive prompts | 0 LOC，按需用 |
| 8a | `--json` 成功路径 | ✅ | `static enableJsonFlag = true` + `run()` return 结构化对象 → stdout 干净 JSON、stderr 空、this.log 被 oclif 自动压制、exit=0 | 0 LOC per command（开关一行） |
| 8b | `--json` 失败路径 | ❌ message 丢 | `this.error(msg, { exit: 1 })` 在 --json 模式下只输出 `{"error":{"oclif":{"exit":1}}}`，**msg 不进 JSON**。agent 调用方拿不到 reason 要 parse stderr | +30 LOC 自写 jsonResponse() helper |
| 8c | parse error 在 `--json` 下 | ❌ 全 Config dump | `--no-such-flag --json` 触发整个 oclif Config dump（cacheDir / configDir / dataDir / home / pjson 全文）进 error context，verbose + 信息泄漏面 | +20 LOC sanitize error formatter |
| 9a | shell completion 装配 | ✅ | `@oclif/plugin-autocomplete` 装即用，bash / zsh / powershell 三 shell 开箱 | 0 LOC |
| 9b | 命令 / flag 补全 | ✅ | 命令、子命令、flag 名都补全。zsh 还自动带 `--lang options:(zh en)`、`--strategy options:(workflow contrastive hybrid)`、`--format options:(json yaml)` enum 列表 | 0 LOC |
| 9c | bash enum 值补全 | ❌ 不带 | bash 补全函数只列命令 / flag，不含 enum 值。生产化要 `compgen -W` 加 enum list | +30 LOC per shell 适配 |
| 9d | completion description 双语 | ❌ 永远 zh | bilingual description 取 `split('\n')[0]` = zh 行，`OMK_LANG=en` 用户的 completion hint 仍中文 | +20 LOC cache 生成时 honor OMK_LANG |

**总计实现成本**：~240 LOC 自写（exit code handler + LangAwareHelp + readme 拼接 + plugin-not-found path + jsonResponse + parse error sanitize + bash enum + completion bilingual），主 package.json +1 dep（+3 plugin dep 可选）。

## 代码体量 / 迁移成本估算

### Spike 实际 LOC（3 命令 + i18n hook + 3 plugin 配置）

| 文件 | LOC |
|---|---|
| `spike/oclif/src/commands/doctor.ts` | ~120（加 enableJsonFlag + return value） |
| `spike/oclif/src/commands/sample.ts` | 96 |
| `spike/oclif/src/commands/studio/start.ts` | 67 |
| `spike/oclif/src/commands/studio/dump.ts` | 56 |
| `spike/oclif/src/i18n.ts` | 33 |
| `spike/oclif/src/help.ts` | 90 |
| `spike/oclif/bin/run.js` + `dev.js` | 14 |
| `spike/oclif/package.json` plugin config | +5 |
| **合计** | **~480** |

### 全量迁移外推

omk 生产 CLI 现状：7 顶层命令 × 平均 5 flag + `eval gold` / `observe ingest|inbox|show` 4 子命令 + RUN_OPTIONS 25 个共享 flag。spike 三命令一共覆盖 12 flag + 4 个 subcommand。

线性外推：
- 命令文件：480 LOC × (12 主命令 / 3 spike 命令) ≈ **1900 LOC**
- i18n + help：一次性，不随命令数线性增长 → **+0 LOC**
- exit code handler（含 plugin-not-found 路径）：一次性 → **+70 LOC**
- 双语 readme 拼接脚本（如需）：**+30 LOC**
- `--json` jsonResponse helper + parse error sanitize（exp-8 缺口）：**+50 LOC**
- bash enum completion + OMK_LANG completion（exp-9 缺口）：**+50 LOC**

**合计 ~2100 LOC**，加 30% buffer（omk 特有 i18n-dict 集成 / parse-strict invariant / preflight 路径 / `--config eval.yaml` 加载）= **~2730 LOC**。

对比保底方案（typed metadata registry）：META schema + 7 命令 sibling export + renderer + drift test ≈ 1500-2000 LOC + 主项目 0 dep。两种路径量级相当，但 oclif 的 470 LOC「免费」获得 `oclif readme` / `oclif manifest` 这两个 docgen artifact。

### 工期估算

- 命令迁移：3-5 个工作日（要逐 flag 把 description 双语 + default + enum 抄一份）
- exit code handler + i18n hook：0.5 天（spike 已落地，调进生产即可）
- README / SKILL / commands.md markers + `oclif readme` CI 集成：0.5-1 天
- 测试覆盖（每条命令 1 个 smoke test）：1-2 天
- review 来回 + 双语校对：1-2 天

PR-B（skeleton + 1-2 命令）≈ 1.5 天，PR-C（剩余命令全迁）≈ 3 天，PR-D（docs codegen）≈ 1 天，PR-E（CONTRIBUTING）≈ 0.3 天。**整条链路约 6-8 天。**

## 决策点：omk 是 Heroku/Salesforce 平台型 CLI 还是 Vite/Next 轻量工具？

issue comment 2 把决策范式收敛在这道二选一。给数据点：

| 维度 | 平台型证据（→ 选 oclif） | 轻量型证据（→ fallback） |
|---|---|---|
| 命令树规模 | 7 顶层 + 5 subcommand，且会继续膨胀（observe 跟 evolve 都在长） | — |
| 统一 JSON 输出 | exp-8 验证 oclif 自带 `enableJsonFlag`，成功路径开箱即用；失败路径 +50 LOC 修补 | — |
| shell completion | exp-9 验证 `@oclif/plugin-autocomplete` 三 shell 开箱，zsh 自带 enum 补全 | — |
| 插件系统 | exp-7 验证装第三方 plugin 1 行 yarn add + 1 行 plugins 数组；自定义 plugin 走 `oclif generate plugin` | — |
| 命令分组 | `eval gold`、`observe ingest/inbox/show` 已有 topic 形态 | — |
| docs / agent docs 单源 | issue #109 是核心痛点 | — |
| 当前用户量 | 个位数 — 迁移成本最低窗口 | 用户量小也意味着 over-engineering 风险 |
| 框架目录 / build / help 约束 | oclif 强约定（src/commands/*.ts pattern + bin/）能接受 | 自研 dispatcher 更灵活，但 docgen 自己背 |

**判断**：exp-7/8/9 把 JSON 输出 / completion / plugin 三项从「未来需求假设」升级为「实测可用 + 已知补丁成本」，加上原本的命令树规模 / 命令分组 / docs 单源 / 用户量窗口共 7 项平台型证据 → 平台型假设成立。oclif 当选。

## 为什么没对照 commander / clipanion / cac

issue comment 2 的决策框架是「omk 像 Heroku 还是 Vite」二选一。commander / clipanion / cac 在 docs codegen 问题上的能力上限是「能 introspect program tree，但要自己写 renderer」——这跟 issue body 的「保底方案 typed CLI metadata registry」是同一条路径的不同包装。

也就是说：

- 若 omk 走平台型 → 选 oclif（commander 数据点不影响判断）
- 若 oclif 失败 → fallback 是 typed registry（不是 commander）

commander spike 代码既不在主推路径上、也不在 fallback 上。加 0.3-0.5 天工期换不到边际信息，所以本 PR 不做。报告里这一段算明面交代，PR review 时若被怼可指回。

## 关键发现速查

1. **`oclif readme` 是真免费的 docgen**：装 devDep 即得，无配置，README markers 即插即用。这是 oclif 相对所有其它候选最大的优势。
2. **bilingual help 不在框架默认能力内**：要 ~110 LOC 自写 Help 子类，覆盖 `showCommandHelp` + `formatCommand` + `formatCommands` 三个钩子。spike 已实现，可拿走。
3. **exit code 偏 omk invariant**：unknown command + enum mismatch 默认 exit 1（plugin-not-found 装上后 unknown command 变 exit 127），需要自写 error handler 统一归 exit 2。70 LOC 内。
4. **`oclif manifest` 是 metadata SSOT**：8KB JSON 含全部命令 / flag / arg 元数据，给 Studio web UI / agent docs 等第三方消费场景一道现成接口。
5. **打包体积可忽略**：`@oclif/core` 940KB（spike 实测），相对 omk 现 86MB node_modules 量级 ≈ 1%。
6. **dev 体验对齐**：`yarn build && node bin/run.js` 跟 omk 现状几乎一致；`yarn dev` 走 tsx 不需要每次 build。
7. **plugin 生态接入零成本**：`@oclif/plugin-not-found` / `plugin-warn-if-update-available` / `plugin-autocomplete` 都是 1 行 yarn add + plugins 数组 1 行。但是「装上即用」的行为不一定符合 omk invariant，需要 case-by-case 校验。
8. **`--json` 成功路径干净，失败路径有缺口**：`enableJsonFlag = true` 一行开关后 `run()` return 自动序列化，this.log 自动压制，stdout 纯 JSON。但 `this.error` 失败路径只剩 `{"error":{"oclif":{"exit":1}}}`——message 丢，需要自写 jsonResponse helper。parse error 在 --json 下 dump 整个 Config（含路径、env），生产化必须 sanitize。
9. **shell completion 三 shell 开箱，zsh 比 bash 强**：bash/zsh/powershell 都自动生成。zsh 自带 enum 值补全（`--strategy options:(workflow contrastive hybrid)` 这种），bash 不带需自补。completion description 取 `description.split('\n')[0]`，bilingual 永远显示第一行 = zh，OMK_LANG=en 用户也看到中文 hint。两处补丁加 ~50 LOC。

## Followup（PR-A 之后）

按 issue 评论里定的节奏：

- **PR-B**：迁 CLI skeleton + 1-2 个真实命令到生产 `src/`，保留旧 dispatcher 并存，添加测试。把 spike 的 i18n hook + error handler 接入生产 i18n-dict.ts 跟 parse-strict.ts。
- **PR-C**：迁完全部 7 顶层命令 + `eval gold` / `observe ingest|inbox|show`，删旧 dispatcher。
- **PR-D**：`<!-- omk:cli -->` markers 接进 README.md / README.zh.md / `.claude/skills/omk/SKILL.md` / `.claude/skills/omk/references/commands.md`；`oclif readme` 接入 CI 做 drift check。
- **PR-E**：CONTRIBUTING.md 加「改 CLI 后跑 `yarn build:docs` 把 diff 一起 commit」流程。

**条件分支（任一触发条件不满足）**：fallback 进 typed CLI metadata registry 方案，sibling META export + drift test + 自写 renderer，PR-B/C/D 重排。

## 实验输出索引

完整原始数据见 [`spike/oclif/experiments/`](../spike/oclif/experiments)：

- [`exp-1-bilingual-help.txt`](../spike/oclif/experiments/exp-1-bilingual-help.txt) — `--lang zh|en` + `OMK_LANG` 切换 help
- [`exp-2-exit-codes.txt`](../spike/oclif/experiments/exp-2-exit-codes.txt) — 7 种 error path 的实测 exit code
- [`exp-3-flag-forms.txt`](../spike/oclif/experiments/exp-3-flag-forms.txt) — positional / default / enum / boolean / integer 类型校验
- [`exp-4-subcommand-walk.txt`](../spike/oclif/experiments/exp-4-subcommand-walk.txt) — `studio start` / `dump` 元数据外部 walk
- [`exp-5-oclif-docs.txt`](../spike/oclif/experiments/exp-5-oclif-docs.txt) — `oclif readme` + `oclif manifest` 产出
- [`exp-6-npm-pack.txt`](../spike/oclif/experiments/exp-6-npm-pack.txt) — npm 打包体积 + 主项目接 oclif 后 package.json 变化估算
- [`exp-7-plugin-system.txt`](../spike/oclif/experiments/exp-7-plugin-system.txt) — plugin-not-found / warn-if-update-available 装配与行为
- [`exp-8-json-output.txt`](../spike/oclif/experiments/exp-8-json-output.txt) — `--json` 成功 / 失败 / 校验三路径输出 schema
- [`exp-9-shell-completion.txt`](../spike/oclif/experiments/exp-9-shell-completion.txt) + [`exp-9b-completion-script.txt`](../spike/oclif/experiments/exp-9b-completion-script.txt) — bash / zsh / powershell completion 实测，含 enum 值补全分歧
