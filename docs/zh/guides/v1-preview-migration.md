# 从 0.54 迁移到 1.0 预览版

`1.0.0-beta.0` 是 OMK 新 Evaluation Core 架构的首个公开预览版。它发布到 npm 的 `next` 标签；预览期间，`latest` 继续保持在 `0.54.0`。

```bash
npm install --global oh-my-knowledge@next
omk --version
```

请先在一次性项目中试用，或备份项目 `.omk/` 与 `~/.oh-my-knowledge/` 后再安装预览版。需要回到稳定渠道时，运行 `npm install --global oh-my-knowledge@latest`。

这是 beta，不代表 1.0 契约已经冻结。当前仍有一项重要限制：`omk eval gold init` 只创建通用标注脚手架，还不能从真实 Core run 自动带入 sample ID，因此 Gold authoring 仍需人工对齐。显式 Gold compare 会报告 Krippendorff alpha，但这份事后结果不会自动门控该 run 的 release verdict。[Issue #283](https://github.com/lizhiyao/oh-my-knowledge/issues/283)继续跟踪 RC 前需要补齐的 Gold 引导入口与校准决策闭环。

## 一、重新建立证据历史

预览版使用领域化的存储布局 v2，不读取、搬动、删除或转换旧布局。原数据仍留在磁盘上，但新读侧不可见。

- 新的项目记录分别进入 `.omk/eval/`、`.omk/doctor/`、`.omk/observe/`、`.omk/governance/`、`.omk/backups/` 与 `.omk/state/`。
- 机器级数据在 `~/.oh-my-knowledge/` 下采用相同领域。
- Evaluation run 是以 `runId` 定位、经过认证的 Core bundle，`report.json` 是 canonical report。
- `0.54` 生成的报告不能被新版本 resume、不能在新 Studio 打开、不能做 Gold 对比，也不能交给 `omk evolve`。如需查看，请单独保留 `0.54`。
- 受管记录升级为 schema v3。请重新安装 artifact，并重新评测以建立当前证据。

不要把旧报告的分数复制到新布局。重新运行评测，让 sealed plan、lineage、Runtime identity 与 decision evidence 一起生成。完整边界见 [Evaluation Core 生产切换](./eval-core-cutover.md)与[存储布局 v2](../specs/storage-layout-spec.md)。

## 二、升级评测用例协议

每份用例文件现在都必须是严格、带版本号的文档。把旧的顶层数组包装为：

```json
{
  "schemaVersion": "omk.eval-sample-set/v1",
  "samples": [
    {
      "sample_id": "case-1",
      "prompt": "..."
    }
  ]
}
```

然后完成这些迁移：

- 把项目级 `eval-samples.yml` 改名为 `eval-samples.yaml`。
- 把目录 skill 的 `.omk/samples.json` 或 `.omk/samples.yaml` 改名为 `.omk/eval-samples.json` 或 `.omk/eval-samples.yaml`。
- 每个自动发现作用域只保留一份 canonical JSON 或 YAML。扁平 skill sidecar 与分片目录不再自动发现；自定义文件或分片目录仍可用 `--samples` 显式传入。
- 删除 `expectedTools`，改用 assertion 与 `allowedTools` 表达工具行为约束。
- 删除未知字段。根文档、sample、assertion、mock 与嵌套 contract 都是封闭 schema。
- 未声明 `mocksStrict` 时按 `true` 处理。只有明确允许未命中调用进入真实 Runtime 时才设为 `false`。
- 每条 mock 必须且只能声明 `return`、`return_file`、`return_seq` 之一。

付费运行前先验证：

```bash
omk eval --dry-run --samples eval-samples.yaml \
  --control code-review-v1 --treatment code-review-v2
```

完整协议见[评测用例格式](../reference/eval-sample-format.md)及随包发布的 JSON Schema。

## 三、重新检查外部 URL 输入

用例 `prompt` 或 `context` 中的真实 URL 现在会在执行前解析，解析后的字节会封存进 Evaluation Definition。解析失败会直接阻断评测，不再静默把 URL 当字面文本使用。

- 私网或认证文档应配置 MCP resolver。
- HTTP 解析只接受标准协议端口，以及受约束的文本型 UTF-8 内容。
- `urlPatterns` 只接受精确 hostname 或 `*.hostname` 通配，不再按 path 或 query 子串匹配。
- 文档中有意保留的字面 URL 应使用 RFC 示例域名。

旧运行若实际测量的是 URL 字面量，就不能与新版本测量的解析后内容直接比较。迁移后应新开一组 comparison series。

## 四、更新 CLI 自动化

- `omk init` 仍默认生成 3 条低成本起步用例；较完整的官方起步集使用 `omk init --samples 20`。把它当发布证据前必须人工复核或替换。
- `omk init` 不再覆盖已有脚手架文件，除非显式传入 `--force`。
- `omk eval --resume` 接受 Core `runId`，不再接受报告路径。
- `omk eval gold compare` 接受 Core `runId`，并要求显式提供 `--target`、`--evaluator` 与 `--metric`。
- `omk evolve` 不再接受旧的 diagnostic、sample repair、report reuse、holdout、significance 与 test split 开关。候选接受和源文件写回由 Core decision 管理；独立发布验证集应放在 authoring loop 外运行。

更新脚本时请以当前 [CLI 参考](../reference/cli.md)为准，不要沿用 `0.54` 的 flag。

## 五、更新嵌入式 Node.js 宿主

公开 API 仅支持 ESM，要求 Node.js 22 或更高版本。import 必须经过 package export map，`oh-my-knowledge/dist/*` 属于私有路径。

- 普通 `evaluate()` 与 `checkExecutor()` façade 从 `oh-my-knowledge` 导入；显式子路径 `oh-my-knowledge/eval-runtime` 与其等价。
- 原包根 Core import 迁移到 `oh-my-knowledge/eval-core`；Engine 构造、分阶段执行、admission、verification、comparability、Series 与 Core JSON Schema 均从该子路径导入。
- eval-samples、projection、Studio、MCP 与 DSH 集成分别使用 `oh-my-knowledge/eval-samples`、`oh-my-knowledge/projections`、`oh-my-knowledge/studio`、`oh-my-knowledge/mcp` 与 `oh-my-knowledge/dsh-plugin`。
- 同步 `require()` 改为 ESM import 或动态 `import()`。
- Engine Runtime 装配改用 binding resolver，一次返回 resolution 与配置好的 port。
- Series Analysis 与 Decision Runtime 通过 `openRun()` 打开 run-scoped session，并用 `dispose()` 释放；Series run 必须提供 `runId`，结果是带 terminal status 的 union。

[嵌入式 API 参考](../reference/embedded-api.md)是 canonical contract，并提供完整的独立宿主 fixture。

## 测量边界

本次迁移保持冻结的评分类 prompt、五层评分、Bootstrap CI 公式、Krippendorff alpha 公式与 length-debias toggle 语义不变。它不保持 artifact schema、存储路径、digest、Runtime identity，也不保持未解析外部 URL 的解释方式。只比较新 Core 判断为 compatible 的 run；不要手工拼接新旧分数历史。
