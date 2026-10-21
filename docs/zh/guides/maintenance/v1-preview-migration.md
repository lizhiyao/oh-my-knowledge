# 从 0.54 迁移到 1.0 预览版

本文面向从 `0.54` 或较早的 1.0 Beta 升级到当前预览版的用户。Beta 使用 npm 的 `next` 标签，仍会继续迭代；本文说明当前迁移边界，不代表接口冻结或 RC 发布计划。

```bash
npm install --global oh-my-knowledge@next
omk --version
```

请先在一次性项目中试用，或备份项目 `.omk/` 与 `~/.oh-my-knowledge/` 后再安装预览版。需要回到稳定渠道时，运行 `npm install --global oh-my-knowledge@latest`。

## 从 Beta.13 升级到 Beta.14

知识库、载体生成、持续修订与变化核对需要 **1.0.0-beta.14 或更新版本**。官网 SDK 截图来自 main 源码验收，不是 Beta.13 的界面。安装后用 `omk --version` 核对版本，再按[知识维护动线](../knowledge/extract-knowledge.md)开始；本地阅读不调用模型。

本次发行包含 Beta.13 之后已合并的 `BREAKING-CLI`、`BREAKING-SCHEMA` 与 `BREAKING-COMPARABILITY` 改动：

1. **先备份**显式选定的知识目录、项目 `.omk/` 与机器 `~/.oh-my-knowledge/`。知识目录可能在这两个位置之外，不能只备份全局目录。
2. **删除退场命令／字段**：`list`、`promote`、`rollback`、`eval --no-evidence`、`observe --feedback`／`--no-feedback`；现有受管记录不改写，但新版本不读取。具体边界见本文末节。
3. **不要把旧提炼产物当成当前结构**：Beta.14 的实体历史为 v2、提炼运行为 v4；旧实体历史 v1、运行 v3 等旧格式不读取、不恢复、不迁移。旧知识 v2 正文仍可读，但所绑定的旧实体分析会显示不可用。选择新的空知识目录，从原始日志重新提炼并人工核对；这会调用模型，需先确认发送范围与运行时。原始文件保留，新实体不会自动接管旧知识绑定。完整边界见[实体提炼契约](../../specs/entities/entity-extraction.md)。
4. **新测量另建身份**：Beta.14 的提炼提示词为 `knowledge-extraction-v14`；提示词字节、接纳语义与运行身份发生过变化，历史报告与分数不重算，不能把不兼容的新旧结果合并成同一比较。复现旧结果须使用冻结基线；现有质量报告不等于新版本整体质量已获验证。

新维护链路支持来源、精确修订和历史保留，不自动证明 SDK 动态效果、节省时间或跨 Agent 复用收益。

**Gold 限制：** `omk eval gold init` 仍生成通用脚手架，真实 sample ID 需要人工对齐。Gold compare 提供人工标注与评委的一致性及事后可靠性评估，不改变已有 run 的发布判定。具体选择器见下方 CLI 迁移说明。

上面的 Beta.14 身份描述该次已发布版本。当前 main 另有后续提炼与复核能力，其身份和存储边界不同；使用当前 main 命令前，先核对[能力分档](../knowledge/extract-knowledge.md#availability)与[当前生成契约](../../reference/shared/knowledge-contract.md)。合并 main 不等于发版，上述历史步骤也不提供后续格式的迁移。

## 一、重新建立证据历史

预览版使用领域化的存储布局 v2，不读取、搬动、删除或转换旧布局。原数据仍留在磁盘上，但新读侧不可见。

- 新的项目记录分别进入 `.omk/eval/`、`.omk/doctor/`、`.omk/observe/`、`.omk/backups/` 与 `.omk/state/`。
- 机器级数据在 `~/.oh-my-knowledge/` 下采用相同领域。
- Evaluation run 是以 `runId` 定位、经过认证的 Core bundle，`report.json` 是 canonical report。
- `0.54` 生成的报告不能被新版本 resume、不能在新 Studio 打开、不能做 Gold 对比，也不能交给 `omk evolve`。如需查看，请单独保留 `0.54`。
- 观测 inbox 容器仍使用 schema v2，但其中的 `observe-experience` 体验报告必须使用 schema v3。体验报告 v2 不再自动转换；inbox 读取器会跳过包含旧体验报告的文件，保留原文件不变。请使用 `omk observe ingest <trace-dir>` 重新导入原始轨迹，生成当前报告。

不要把旧报告的分数复制到新布局。重新运行评测，让 sealed plan、lineage、Runtime identity 与 decision evidence 一起生成。完整边界见 [Core 持久化契约](../../specs/evaluation/evaluation-artifact-persistence.md)与[存储布局 v2](../../specs/shared/storage-layout-spec.md)。

## 二、新建评测用例文档

预览版只使用严格的 `omk.eval-sample-set/v3` 契约，不读取或转换更早的用例文档。请通过 `omk init` 或 `omk sample` 生成新文档，并在作为证据使用前复核准则与权重。

每条 rubric 是独立判定维度的映射。每个维度包含一条 `criterion` 与一个正 `weight`，同一 sample 的权重和必须为 1。每个自动发现作用域只保留一份 canonical `eval-samples.json` 或 `eval-samples.yaml`。

付费运行前先验证：

```bash
omk eval --dry-run --samples eval-samples.yaml \
  --control code-review-v1 --treatment code-review-v2
```

完整 v3 协议见[评测用例格式](../../reference/evaluation/eval-sample-format.md)及随包发布的 JSON Schema。

## 三、重新检查外部 URL 输入

用例 `prompt` 或 `context` 中的真实 URL 现在会在执行前解析，解析后的字节会封存进 Evaluation Definition。解析失败会直接阻断评测，不再静默把 URL 当字面文本使用。

- 私网或认证文档应配置 MCP resolver。
- HTTP 解析只接受标准协议端口，以及受约束的文本型 UTF-8 内容。
- `urlPatterns` 只接受精确 hostname 或 `*.hostname` 通配，不再按 path 或 query 子串匹配。
- 文档中有意保留的字面 URL 应使用 RFC 示例域名。

旧运行若实际测量的是 URL 字面量，就不能与新版本测量的解析后内容直接比较。迁移后应新开一组 comparison series。

## 四、更新 CLI 自动化

请从命令中删除 `--no-cache`，从 `eval.yaml` 中删除 `noCache`。产品评测本就禁用执行与评分缓存；无需替代选项，旧配置字段会报错并提示删除。既有 `--resume` 续跑契约不变。

- `omk init` 仍默认生成 3 条低成本起步用例；较完整的官方起步集使用 `omk init --samples 20`。把它当发布证据前必须人工复核或替换。
- `omk init` 不再覆盖已有脚手架文件，除非显式传入 `--force`。
- `omk eval --resume` 接受 Core `runId`，不再接受报告路径。
- `omk eval gold compare` 接受 Core `runId`，并要求显式提供 `--target`、`--evaluator` 与 `--metric`。只有领域已经选定可靠性阈值时才传入可选的 `--minimum-alpha`；事后 assessment 使用置信区间下界，绝不会改变 release verdict。
- `omk evolve` 不再接受旧的 diagnostic、sample repair、report reuse、holdout、significance 与 test split 开关。候选接受和源文件写回由 Core decision 管理；独立发布验证集应放在 authoring loop 外运行。

更新脚本时请以当前 [CLI 参考](../../reference/cli.md)为准，不要沿用 `0.54` 的 flag。

## 五、更新嵌入式 Node.js 宿主

公开 API 仅支持 ESM，要求 Node.js 22 或更高版本。import 必须经过 package export map，`oh-my-knowledge/dist/*` 属于私有路径。

- 移除 `oh-my-knowledge/package.json` 导出，不提供替代的 `version` 导出。请删除该元数据 import，改由包管理器或锁文件记录依赖版本；CLI 诊断仍可使用 `omk --version`。
- 普通 `evaluate()` 与 `checkExecutor()` façade、Runtime 装配、builder 与生命周期 SPI 均从 `oh-my-knowledge` 导入。
- 将固定的 `{ executor, control, treatment, evaluator }` 调用改为 `{ dataset, variants, evaluators, comparisons, analyses, experiment, policy }`。执行器与配置绑定在 `variant.execution` 下，抽样设计位于 `experiment.sampling`；每项统计请求放在 `analyses[]`，可选 `decision` 通过 `analysisId` 选择分析结果。运行选项如 `runId`、`signal`、`onEvent` 放在第二个参数；旧结构不再读取。
- 原包根 Core import 迁移到 `oh-my-knowledge/eval-core`；Engine 构造、分阶段执行、admission、verification、comparability、Series 与 Core JSON Schema 均从该子路径导入。
- `createEvaluationEngine` 只从 `oh-my-knowledge/eval-core` 导入。已装配输入只需一次标准完整运行时，从 `oh-my-knowledge` 使用 `runEvaluation`。
- MCP 与 DSH 集成分别使用 `oh-my-knowledge/mcp` 与 `oh-my-knowledge/dsh-plugin`。
- 同步 `require()` 改为 ESM import 或动态 `import()`。
- Engine Runtime 装配改用 binding resolver，一次返回 resolution 与配置好的 port。
- Series Analysis 与 Decision Runtime 通过 `openRun()` 打开 run-scoped session，并用 `dispose()` 释放；Series run 必须提供 `runId`，结果是带 terminal status 的 union。

普通服务接入以 [Runtime API 参考](../../reference/integration/eval-runtime-api.md)为准；高级分阶段接入查[底层 Core API](../../reference/integration/embedded-api.md)。

## 测量边界

本次迁移保持冻结的评分类 prompt、五层评分、比较家族 Bootstrap CI 公式、Krippendorff alpha 点估计公式与 length-debias toggle 语义不变。一致性区间 v2 有意改用 Krippendorff 的固定期望分歧可靠性 bootstrap；v1 只为精确重放保留。它不保持 artifact schema、存储路径、digest、Runtime identity，也不保持未解析外部 URL 的解释方式。只比较新 Core 判断为 compatible 的 run；不要手工拼接新旧分数历史。

## 受管生命周期退出（BREAKING-CLI）

`list`、`promote`、`rollback` 命令，`eval` 的 `--no-evidence` 选项，以及 `observe` 的 `--feedback`／`--no-feedback` 选项已移除，不提供别名或兼容入口。脚本应删除这些调用，直接使用 `doctor`、`eval` 的结果与报告决定后续动作；文件恢复与部署由用户自己的版本控制和发布流程处理。`omk install` 只负责安装，不再登记生命周期。Studio 的受管决策史页面与 `/api/managed` 同时退出。

已有 `.omk/governance/managed/` 或 `OMK_HOME/governance/managed/` 文件原样留在磁盘上，新版本不读取、改写、迁移或自动删除它们。需要归档时可自行保存这些原始 JSON；无需重新安装已有 skill。Core 评测产物、内容身份与测量口径不变。

## 安装命令面收窄（BREAKING-CLI）

`omk install` 只安装 skill。省略 `--kind` 或使用 `--kind skill`；`prompt`、`agent`、`workflow` 会在源解析和安装前以退出码 2 拒绝，内置 `omk-agent-skill` 也遵守同一规则。

将 `--to all` 替换为 `--to codex`。目标值仅保留 `auto`（默认，检测 Codex/AGENTS 目录）和 `codex`（无需提前检测，直接安装）。逗号分隔的目标列表也以退出码 2 拒绝。自定义 skill 根目录使用 `--dest <dir>`，不为 `all` 或目标列表保留别名。

已有 skill 和历史元数据原样保留，无需重新安装。显式安装仍遵守原有 `--force`、`--dry-run` 和源目标重叠保护。本次只改变 CLI 校验，不改变载体格式和测量口径。
