# omk 能力迭代路线图 · v0.16 起

> 起草：2026-04-18
> 基线：v0.15.0
> 策略：深化独家壁垒优先，依次做，不并排
> 配套：[omk-industry-research-report](../../Obsidian/00%20-%20工作/02%20-%20AI%20研发范式/知识工程/omk-industry-research-report.md)（不版本化）· [knowledge-gap-signal-spec.md](./knowledge-gap-signal-spec.md)（版本化）

---

## 一、核心判断

v0.15 omk 的四件独家事已立：**控制变量 / 统计严谨 / 缺口信号 / evolve**。问题是每一件都还没做到"经得起追问"——控制组靠工具猜测、t 检验用合成分、缺口信号只做被动收集、evolve 是单目标。

v0.16-v0.18 专注把这四件事做扎实，不分心到支线二（叙事闭环补齐）和支线三（生态扩展）。支线二 v0.19 起，支线三 v0.20 起，探索支线 v0.21+。

**策略判断**：依次做而不是并排。每版一个主题，外部叙事清晰，也给期间发现的问题留调整余地。

---

## 二、版本节奏总览

**v0.16 · 统计严谨性收尾** — 控制组显式 + 三层独立 t 检验 + compositeScore 降级。把"统计严谨"这个招牌从"能防守"做到"经得起任何追问"。

**v0.17 · 知识缺口信号 v0.2** — 主动探测（competency questions）+ 降级措辞 LLM 辅助识别 + 严重度加权。从被动收集走到主动探测 + 分级。

**v0.18 · evolve 多目标优化** — 帕累托前沿（质量 × 效率 × 成本）+ 样本驯化检测 + 过短输入病态行为修复。让 evolve 从"单方向最优"走到"多维度可选"。

**v0.19 · 支线二启动** — 人工评分层（`human-review`）+ 趋势可视化。补齐核心叙事闭环。

**v0.20 · 支线三启动** — 断言体系补齐（`not_` 前缀 / 确定性相似度 / assert-set）+ GitHub Action 模板 + insiop 以外 2-3 个 case study。

**v0.21+ · 探索支线** — Agent as Judge / 精调评委模型 POC / 合成对话生成 / 多模态评测。择一开始，待前三条支线跑完再决策。

每版预计 4-5 周。v0.18 完成约在 2026-06 末，支线二完成约在 2026-09。

---

## 三、v0.16 详细计划（统计严谨性收尾）

### 工作项 A｜CLI 入口重构：experiment role 显式 + config 文件（2 周）

**现状**：对照组由 `Artifact.kind === 'baseline'` 反推，v1-vs-v2 场景两组都是 skill 时 omk 无法判断谁是对照。`--variants` 一个参数承担"列出 variant + 声明 artifact 源 + 绑定 cwd"三个职责，语义混乱。

**目标**：

- 废除 `--variants`（直接 breaking，无 deprecation warning）——omk 仍是 v0.15，清理窗口在现在，错过这个窗口以后迁移成本会显著增加
- 新增 `--control <expr>` / `--treatment <v1,v2,...>`，按 experiment role 声明 variant
- 新增 `--config eval.yaml`，确立 "evaluation as code" 理念作为长期主入口
- 术语已写入 `docs/terminology-spec.md`：experiment role 采用统计学标准 `control` / `treatment`，不用 `baseline` / `experiment`（`baseline` 留给 artifact kind）

**eval.yaml 格式 v0.1**：

```yaml
samples: ./samples.json
executor: claude-sdk
model: sonnet-4.6
variants:
  - name: v1
    role: control
    artifact: ./skill-v1.md
  - name: v2
    role: treatment
    artifact: ./skill-v2.md
  - name: v3
    role: treatment
    artifact: git:my-skill
    cwd: ./project
```

config 文件与 CLI 参数共存：config 定义基础配置，CLI 参数可覆盖（如临时换 `--model`）。复杂场景推 config 文件，简单场景继续 CLI。

**验收标准**：

- variant 名字完全自由，不再要求带 "baseline" 关键字
- `--control` 和 `--treatment` 至少声明一个；同一 variant 不能同时出现在两者（error）
- v1-vs-v2 两个 skill 对比场景能正确标注 control/treatment
- `omk bench run --config eval.yaml` 端到端跑通
- `bench run --dry-run` 输出每个 variant 的 `experimentRole`
- 旧命令 `--variants baseline,v1` 直接 error，error message 引导迁移到新语法

**影响面**：

- `src/types.ts` — `VariantConfig` 加 `experimentRole`，新增 `EvalConfig` 类型（10 行）
- `src/cli.ts` — 移除 `--variants`，新增 `--control` / `--treatment` / `--config`，改 help（40 行）
- `src/inputs/eval-config.ts` — 新文件，YAML 解析 + schema 校验（60 行）
- `src/eval-workflows/evaluation-preparation.ts` — 接收 role 入参，注入 VariantConfig（30 行）
- `src/eval-core/execution-strategy.ts` — `buildVariantConfig` 支持 role（10 行）
- `src/eval-workflows/each-evaluation-workflow.ts` — 正确填 `experimentRole`（15 行）
- `src/renderer/html-renderer.ts` — 主读 `experimentRole`（20 行）
- `src/renderer/summary.ts` — CLI 输出显示 role 标签（10 行）

合计约 200 行 + 测试。

**测试**：

- 单测：YAML config 解析 / role 校验（同一 variant 冲突 / 至少一个 role）/ config 与 CLI 参数合并优先级
- 集成测：v1-vs-v2 双 skill 显式 role 端到端
- 集成测：`--config eval.yaml` 端到端
- 迁移测：老 `--variants` 直接 error，error message 清晰

### 工作项 B｜PR-2 三层独立 t 检验（2 周）

**现状**：t 检验用的是 compositeScore（fact/behavior/quality 加权合成）。结构性差异（质量层 +0.8、事实层 +0.1）被合成分稀释。

**目标**：`VarianceComparison.byMetric.quality` 下嵌套 `byLayer: { fact, behavior, quality }`，每层独立计算 t / df / p / Cohen's d / 95% CI。

**实现路径**：
- `buildVarianceData` 为每个 variant 采集三层的 per-run 序列（`avgFactScore` / `avgBehaviorScore` / `avgJudgeScore` 已在 `VariantSummary`）
- 独立跑三次 Welch's t-test，合成分的 t 检验保留但标为 legacy
- 渲染器默认只展示合成层，点开分层（避免表格爆炸：2 variants × 3 metrics × 3 layers = 最多 9 行 per 对比对）

**验收标准**：
- 三层各自给出 `t, df, p, d, significant`
- HTML 报告默认折叠三层独立显著性，`--layered-stats` 传入时 `<details>` 默认展开

### 工作项 C｜PR-3 compositeScore 语义降级（1 周）

**前置**：B 做完。先保证用户有替代品（三层独立）再撤掉旧主分。

**目标**：compositeScore 从"主分"降为"参考分值"。报告主视图展示三层独立结果，合成分放次要位置。

**改动面**：
- HTML 报告主视图：三层并列展示（六列平铺：事实 / 行为 / LLM 评价 / 成本 / 效率 / 稳定性），composite 合成分不再占 UI 主位
- 回归阈值 / CI 门禁：`--threshold` 改为三层 all-pass（any layer < threshold → FAIL），避免 composite 均化掩盖结构性差异
- 文案全面重写：引导读者看分层而非合成分

**主动不做（0-1 窗口期原则）**：

- ~~`--legacy-composite` 兼容开关恢复旧行为~~：不做。0-1 阶段不留回退通道，用户迁移一次到位。合成分在 JSON 数据层保留（report.meta + VarianceComparison flat fields），外部脚本仍可读 `avgCompositeScore`，但 CLI 不再用它做主视觉或门禁
- ~~断言判定：`score_min` 这类断言要明确作用于哪一层~~：当前代码并无 `score_min` / `score_max` 断言类型（roadmap 起草时假设有，实际不存在）；未来若新增此类断言，默认作用于 composite 层作向后兼容方便，并同时提供 `layer: fact | behavior | judge` 参数显式指定。

**验收标准**：用户能一眼看出"质量改进但成本涨了"这类混合信号；compositeScore 不在任何主视图独占 C 位。

### v0.16 里程碑

- Week 1-2：A（CLI 入口重构 + eval.yaml）— terminology-spec 术语先行、CLI 重构、YAML 解析、role 注入、测试
- Week 3-4：B（三层独立检验）实现 + 报告渲染器改造
- Week 5：C（compositeScore 降级）+ 文档/报告文案统改
- Week 5 末：发 v0.16，同步两篇短博客——《为什么 omk 废了 --variants：谈 evaluation as code》+《为什么 omk 把 compositeScore 挪到次要位置》

### v0.16 不做的

- 不做人工评分层（v0.19）
- 不做趋势可视化（v0.19）
- 不碰 evolve 任何逻辑（v0.18）
- 不扩充断言类型（v0.20）
- 不做报告 UI 大改版（穿插进渲染器改造即可）

---

## 四、v0.17 计划骨架（知识缺口信号 v0.2）

[spec 已立](./knowledge-gap-signal-spec.md)。v0.17 做三件事：

**主动探测（competency questions）**：LLM 读知识库结构（文件名 / 目录 / SKILL.md 声明的能力）自动生成测试问题，补 v0.1 被动信号的盲点。从"agent 撞墙才记录"走到"主动问能不能答"。

**降级措辞 LLM 辅助识别**：v0.1 对"不确定 / 可能 / 大概"这类措辞用规则匹配（高假阳率，用户会吐槽）。v0.2 加 LLM 辅助识别，降低噪声。

**严重度加权**：失败搜索（强）/ 显式标记（弱）/ 降级措辞（中）/ 工具连续失败（强）四类信号，按严重度加权聚合为 gap rate，不再等权平均。

详细计划 v0.16 中期补齐。

---

## 五、v0.18 计划骨架（evolve 多目标优化）

**帕累托前沿**：当前 evolve 单目标优化质量分，容易把成本 / 效率搞坏。改成 `qualityScore × efficiencyScore × costScore` 三维空间，evolve 产出多个帕累托前沿上的候选，用户选（而不是工具定）。

**样本驯化检测**：连续 3 次评测 gap rate ≤ 10% 时自动提示扩样本（已在 gap-signal-spec 里）。evolve 循环里内嵌这一提示，避免"分数刷到 100 其实是过拟合样本"。

**过短输入病态行为修复**：insiop 事故暴露——evolve 以 6 行污染版为起点，第一轮产出 2 行空壳导致分数暴跌 -1.8。加输入体检：过短 / 缺关键字段 / SKILL.md 格式异常时拒绝进入 evolve，报错提示用户先补全起点。

详细计划 v0.17 中期补齐。

---

## 六、主动不做（v0.16-v0.18 内）

- **红队安全** — Promptfoo 主场，不进他地盘打
- **生产监控** — Langfuse / Braintrust 重基建战场，omk 是上线前工具
- **断言数量追齐 50+** — 广度不是 omk 战场
- **多模态评测** — 知识载体场景短期用不到，v0.21+ 再考虑
- **人工评分层** — v0.19 支线二做，不穿插进 v0.16-v0.18
- **趋势可视化** — 同上，v0.19
- **GitHub Action 模板** — v0.20 支线三

---

## 七、成功标准（v0.18 发布时）

omk 的四件独家事每一件都能对外讲清楚：

**控制变量** — 实验设计语义清晰（控制组 CLI 显式）+ 环境隔离（2026-04-04 三组控制实验已校准通过）。任何用户跑 omk 都能说清"谁是对照、谁是实验、变量是什么"。

**统计严谨** — 三层独立 t 检验 + compositeScore 正确使用。"质量改进但成本涨了"这类混合信号一眼可见，不被合成分掩盖。

**缺口信号** — 主动探测 + 被动收集 + 严重度分级。风险敞口真正"敞"给用户，不是"撞了才记"的被动日志。

**evolve** — 多目标帕累托，用户看到的是可选改进方向而非一个"最优"。过短输入不再产出空壳。

当有人问"omk 的独家做到什么程度"，能给出具体证据——不是承诺，是可跑可验证的功能。

---

## 八、执行原则

**依次做，不并排**：每版专注一个支线的一个子项。并排切多分支会让上下文切换成本吃掉深度。

**0-1 阶段窗口期内直接 breaking**：omk 仍处于 0-1 阶段，用户规模小，破坏性调整现在做成本最低。需要移除的命名/参数（如 `--variants`）直接移除，不挂兼容别名、不打 deprecation warning——保留旧行为会让歧义继续影响新用户。错过这个窗口后每一次调整都要付迁移成本。

**evaluation as code 为长期主入口**：严肃实验配置的复杂度已超出 CLI 参数所能承载的上限（samples、artifacts、MCP、URL、断言、rubric、多维评分、experiment role）。未来所有新增实验配置项先加入 eval.yaml schema，再考虑是否需要 CLI 快捷方式。CLI 只保留"简单场景一条命令跑通"的最小集。

**spec 先行**：功能改动前先更 spec（`terminology-spec.md` / `knowledge-gap-signal-spec.md` 这类）。代码和 spec 有分歧先更 spec，不让实现悄悄偏离规范。

**case study 跟随版本**：每版发布附一篇短博客/case study（《为什么废了 --variants》《为什么把 compositeScore 挪走》《主动探测 vs 被动收集的 insiop 实证》这类），让外部用户跟得上心智变化。

**CHANGELOG 随 commit 同步**：`CHANGELOG.md` 的 `[Unreleased]` section 要和功能 commit 同步更新——功能合入即追加对应条目（Added / Changed / Removed-BREAKING / Fixed）。发版时把 `[Unreleased]` 改成 `[x.y.z] - YYYY-MM-DD` 并新建空的 `[Unreleased]`。断章追记比 commit 时写累计。

---

*最后更新：2026-04-19*
