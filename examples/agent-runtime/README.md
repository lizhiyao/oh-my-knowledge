# Agent runtime context

这个示例用于演示「artifact 必须进入项目目录才能完成任务」的评测。

样本使用 `cwd: "./workspace"`，让 executor 看到一个小型仓库目录。treatment skill 会要求 agent 回答前先检查目录内容。

先预览任务计划，不调用模型：

```bash
omk eval --control baseline --treatment repo-navigator --dry-run
```

配置好执行器后，再跑真实对比：

```bash
omk eval --control baseline --treatment repo-navigator
```

这个示例适合评测 coding agent、仓库助手，或依赖本地文件的运维 runbook。
