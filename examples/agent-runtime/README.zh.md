# Agent runtime 上下文

[English](./README.md)

## 用途

这个示例用于评测只有检查项目目录才能完成的任务。每条用例设置 `cwd: "./workspace"`，treatment skill 会要求 agent 在回答前检查该 workspace。

这种模式适合 coding agent、仓库助手，以及证据保存在本地文件中的运维 runbook。

## 运行

先预览封存后的任务计划，不调用模型：

```bash
omk eval --control repo-answerer --treatment repo-navigator --dry-run
```

配置能够读取用例工作目录的 agent executor 后，再运行真实对比：

```bash
omk eval --control repo-answerer --treatment repo-navigator
```

## 证据边界

显式 control 只提供通用回答指导，treatment 则要求检查文件并引用证据，从而避免把 runtime 的环境知识误当成可信的空白 baseline。仓库内置的两条用例只能证明 OMK 会传递用例级工作目录，并能评测基于文件的回答。它们不能证明生产级仓库 agent 的质量，也没有足够的统计功效支撑发布决策。
