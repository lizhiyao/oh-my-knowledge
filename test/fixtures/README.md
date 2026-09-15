# test/fixtures

测试专用 fixture，由测试拥有、为测试而设——与 `examples/`（面向用户的学习材料）解耦。改这里的内容前，先看下面每个 fixture 的「load-bearing 值」：很多数字/结构被测试断言 pin 死，盲改会让测试失败且原因不明显。

## 通用约定

- **样本断言合规**：所有 `*.eval-samples.json` 的 `contains` / `not_contains` / `contains_any` 值都是单个 ASCII token（长度 2–40、无内部空白），语义判断交给 `rubric` 或 `regex`（`regex` 不受 token 规则约束）。这些 fixture 必须通过 `loadSamples` 的严格校验。新增样本请沿用此约定。
- 这些 fixture 故意保持**最小**：样本数、变体数、断言形态都按消费它的测试需要来定，不是示例展示。要更丰富的真实示例去看 `examples/`。

## code-review/

最基础的 A/B fixture：`skills/v1.md`（单行最小审查 prompt）vs `skills/v2.md`（多维审查 prompt），都是扁平 `.md`。

消费方与 load-bearing 值：
- `test/cli/{doctor,doctor-eval-embed,judge-models-validation,oclif-eval,removed-options}.test.ts` 与 `test/knowledge-artifacts/{doctor,sources}/*`：用它当可解析的 skill-dir（`v1` / `v2`）与样本文件（`eval-samples.json`，5 条样本）。
- `test/eval-workflows/inputs/yaml-parser.test.ts`：只校验 JSON 结构（数组、非空、有 `sample_id`），不 pin 计数/断言值。

## custom-executor/

离线执行器 fixture：`core-fixture-executor.sh` 从 stdin 消费请求并返回固定 JSON 输出，为 CLI 集成测试提供确定性结果；自定义 executor 的输入透传与协议解析由 `test/executor.test.ts` 单独覆盖。

消费方：`test/cli/{oclif-eval,removed-options,first-run-smoke,doctor-eval-embed}.test.ts` 与 `test/cli/lib/evaluation-application.test.ts`（样本与 skill 由各测试自建临时文件，不依赖本目录的样本/skill）。

## mcp-observation/

OMK MCP 主动知识反馈的行为契约 fixture。它覆盖显式保存、`$omk feedback` 快捷入口、间接纠正等待确认、确认后保存、假设性负例，以及未经人工复核不得生成候选样本。

消费方与 load-bearing 值：

- `test/mcp/trigger-samples.test.ts` 固定 7 条用例及关键 tool assertion，保护 consent boundary 与 review gate。
- 这组用例依赖能够暴露规范化 MCP 工具轨迹的 agent executor；普通文本 executor 无法证明工具是否被调用，因此它不是独立可运行的用户示例。
- 修改 MCP 工具名、确认字段或 review lifecycle 时，必须同步检查 `.agents/skills/omk/SKILL.md` 和中英文 MCP integration guide。

## multi-skills/

批量评测 fixture（`omk eval --batch`）。`skills/` 下的 `summarizer/`、`translator/`、`classifier/` 均采用目录 skill，并将私有用例放在 `.omk/eval-samples.json`，锁定 batch 的 canonical 发现路径。

load-bearing 值：
- `test/runner.test.ts`：`discoverVariants` 断言能发现 `classifier`；batch dry-run 按 `sampleCount × 2` 算 `taskCount`。
- `test/cli.test.ts` 的 batch 测试：断言「批量评测结论：未通过」+ `UNDERPOWERED:`（依赖每个 skill 的小样本量）。三个 skill 都得在、各自样本量小，别删。
- `classifier` 保留 2 条样本以覆盖 batch 的 `UNDERPOWERED` 分支；其余 skill 只保留 1 条。这些夹具验证 batch 发现、任务规划和聚合门禁，不验证领域用例多样性；增加样本会按「skill × 样本 × 2 variants」放大子进程数量。
- `src/knowledge-artifacts/doctor/messages.ts` 的 frontmatter 报错文案指向 `examples/skill-map-showcase/skills/release-readiness`，不要改回已删除的 examples 旧路径。
