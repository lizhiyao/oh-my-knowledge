# 验证载体改动

按当前任务选一篇，不需要先读完整文档树。

| 任务 | 阅读内容 |
|---|---|
| [设计评测用例](sample-design.md) | 写清问题、对照条件和期望证据。 |
| [检查载体](run-doctor-checks.md) | 在测量前检查结构、依赖和可测性。 |
| [评测 Agent 与项目上下文](agent-eval.md) | 选取项目运行条件与合适对照。 |
| [核对本地任务结果](local-tasks.md) | 用真实文件与独立验收检查结果。 |
| [迭代候选载体](auto-improve-skills.md) | 已有可靠用例后再生成和比较候选。 |

返回[文档首页](../../README.md)。

第一次运行见[评测快速上手](quickstart-skill-eval.md)；结果解释见[统计严谨性](../../explanation/statistical-rigor.md)。

`eval`、`sample`、`evolve` 和 `doctor` 长调用中，第一次 Ctrl+C 请求取消并清理。第二次 SIGINT 会安排在 750 毫秒后以退出码 130 强退，先给子进程终止留出宽限期。此兜底要求 Node 事件循环仍能响应，可能留下不完整证据；强退不能算作完成测量。
