# test/fixtures

测试专用 fixture，由测试拥有、为测试而设——与 `examples/`（面向用户的学习材料）解耦。改这里的内容前，先看下面每个 fixture 的「load-bearing 值」：很多数字/结构被测试断言 pin 死，盲改会让测试失败且原因不明显。

## 通用约定

- **样本断言合规**：所有 `*.eval-samples.json` 的 `contains` / `not_contains` / `contains_any` 值都是单个 ASCII token（长度 2–40、无内部空白），语义判断交给 `rubric` 或 `regex`（`regex` 不受 token 规则约束）。这样 `loadSamples` 在 lenient 模式下不会对这些 fixture 报警告。新增样本请沿用此约定。
- 这些 fixture 故意保持**最小**：样本数、变体数、断言形态都按消费它的测试需要来定，不是示例展示。要更丰富的真实示例去看 `examples/`。

## code-review/

最基础的 A/B fixture：`skills/v1.md`（单行最小审查 prompt）vs `skills/v2.md`（多维审查 prompt），都是扁平 `.md`。

消费方与 load-bearing 值：
- `test/runner.test.ts`：dry-run 断言 `totalTasks === 10`（**5 样本 × 2 变体**）+ 一条**逐条列出 5 个 sample_id 的 interleaved 调度顺序** deepEqual。增删样本会同时打破这两处。
- `test/cli.test.ts` 的 `eval --dry-run`：依赖 **N=5 落在「N 5–19 中度欠检验力（非 exploration-only）」这一档**的功率警告文案（`只能识别很大的效果`）。**样本数降到 5 以下会跨进「N<5 仅探索」档、改变警告文案**——所以 5 条是刻意保留的，不是冗余。
- `test/runner.test.ts` 的 `git:` 系列：`loadSkills` 用 `git:v1` / `git:HEAD:v1` 从 **HEAD** 读 `v1.md`，所以这些文件必须已 commit 才过。
- `test/inputs/skill-loader.test.ts` / `test/doctor/*` / `test/cli/{effort-flag,reports-output-dir,judge-models-validation,doctor,doctor-eval-embed,strict-unknown-options}.test.ts`：用它当可解析的 skill-dir（`v1` / `v2` / `baseline`）。
- `test/inputs/yaml-parser.test.ts`：只校验 JSON 结构（数组、非空、有 `sample_id`），不 pin 计数/断言值。

## agent-eval/

agent / 工具调用 + 控制实验 fixture。`skills/v1.md`、`skills/v2.md` + `control-experiments/` 下三份样本。

消费方与 load-bearing 值（`test/runner.test.ts` dry-run）：
- `env-isolation.eval-samples.json`：2 样本 → 配 3 变体断言 `totalTasks === 6`。
- `artifact-injection.eval-samples.json`：2 样本 → 配 2 变体断言 `totalTasks === 4`、`experimentType === 'artifact-injection'`。
- `assertion-discrimination.eval-samples.json`：2 样本 → 配 3 变体断言 `totalTasks === 6`、每个 task `hasAssertions`。
- 样本里的 `tool_output_contains: Read:OMK_RUNTIME_CODE_REVIEW_7F3D` 等是控制实验断言形态，改动需同步看上述断言。

## custom-executor/

离线执行器 fixture：`fixture-executor.sh` 从 stdin 消费请求并返回固定 JSON 输出。`skills/v1.md` + 2 样本。脚本只负责为 runner / CLI 集成测试提供确定性结果；自定义 executor 的输入透传与协议解析由 `test/executor.test.ts` 单独覆盖。

load-bearing 值：
- `test/runner.test.ts` 的「no-judge 确定性断言分」：断言 `results[0]`（即 `s001`）`assertions.total === 1`、`passed === 0`、`score === 1`。**s001 必须恰好 1 条断言，且该断言对固定输出 `fixture output` 不通过**。改断言时要保持这个关系。
- `test/cli.test.ts`：用 echo 跑 **非 dry-run** eval / batch（`--no-judge`），靠整体低分得出 verdict → 退出码 1；不 pin 具体分数。

## multi-skills/

批量评测 fixture（`omk eval --batch`）。`skills/` 下的 `summarizer/`、`translator/`、`classifier/` 均采用目录 skill，并将私有用例放在 `.omk/eval-samples.json`，锁定 batch 的 canonical 发现路径。

load-bearing 值：
- `test/runner.test.ts`：`discoverVariants` 断言能发现 `classifier`；batch dry-run 按 `sampleCount × 2` 算 `taskCount`。
- `test/cli.test.ts` 的 batch 测试：断言「批量评测结论：未通过」+ `UNDERPOWERED:`（依赖每个 skill 的小样本量）。三个 skill 都得在、各自样本量小，别删。
- `classifier` 保留 2 条样本以覆盖 batch 的 `UNDERPOWERED` 分支；其余 skill 只保留 1 条。这些夹具验证 batch 发现、任务规划和聚合门禁，不验证领域用例多样性；增加样本会按「skill × 样本 × 2 variants」放大子进程数量。
- `src/doctor/messages.ts` 的 frontmatter 报错文案指向 `examples/skill-map-showcase/skills/release-readiness`，不要改回已删除的 examples 旧路径。
