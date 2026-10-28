# OMK

[![Beta @next](https://img.shields.io/npm/v/oh-my-knowledge/next.svg?label=Beta)](https://www.npmjs.com/package/oh-my-knowledge?activeTab=versions)
[![CI](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml/badge.svg)](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[English](./README.md) | **简体中文**

**Observe. Measure. Know.**

OMK 帮助人和 Agent 沉淀、维护并复用有价值的知识：将真实工作与协作中形成的认识、方法和判断依据，整理为可读、可追溯、可持续修订的知识，供人和不同 Agent 在后续任务中使用。

面向 Agent 使用者和 AI 应用开发者，从选定工作记录中提炼候选，核对来源与适用条件，持续积累和修订，再按任务选择知识或生成 skill、prompt 等载体。需要判断具体改动的效果时，可以独立开展受控版本比较；各项能力的版本与接入边界见下方指南。

## 从本地工作记录开始

需要 **Node.js ≥22**。本页的知识库、载体生成与变化核对需要 **1.0.0-beta.14 或更新版本**，使用 **`@next` 通道**；npm 的 `latest` 是另一条稳定通道。Beta.13 不包含这里的维护界面。严格结构化提炼、原生结果归档、有界重试、模型辅助的跨窗口关联复核与研究复核属于后续 main 能力，不能仅凭 Beta.14 版本号视为可用；对应发行与源码能力见[能力分档](docs/zh/guides/knowledge/extract-knowledge.md#availability)。旧版用户先阅读[迁移指南](docs/zh/guides/maintenance/v1-preview-migration.md)。

```bash
npm i -g oh-my-knowledge@next
omk --version
omk studio
```

打开命令返回的本地地址，从已有 Codex 对话核对任务与原始记录。这一步不调用模型；没有对话时，Studio 提供来源与采集入口。其他日志来源按[观测指南](docs/zh/guides/observe/observe-production.md)接入。

接下来，在“知识 → 候选核对”选择会话和轮次，核对发送范围后提炼候选。**提炼会调用模型**，需先准备[已认证的运行时](docs/zh/reference/integration/executors.md#前置要求)。在知识库关联来源、修订过时内容，再明确生成和保存载体；载体详情可核对知识变化和新旧引用。完整步骤见[知识维护动线](docs/zh/guides/knowledge/extract-knowledge.md)。

## 知识变化，载体也需要核对

![Studio 中 SDK 历史载体的知识变化核对阅读区](./docs/public/sdk-maintenance-review.png)

在已有 SDK 维护案例中，旧说法限定为历史场景，一条不再适用的知识被舍弃，另一条补充了静态观察的范围。v4 保留三条旧引用并提示两项变化；v5 明确选择两条当前保留知识，旧版本正文与引用继续保留。[查看案例、来源和核对步骤](docs/zh/guides/knowledge/sdk-maintenance-case.md)。

这证明维护与引用链路可核对，没有验证 SDK 动态效果、节省时间或跨 Agent 复用收益。保留知识、保存载体、实际使用和验证效果分别记录；完整跨 Agent 自动管理与复用仍在建设中。

## 按当前任务继续

- **直接比较两版载体**：从[评测快速上手](docs/zh/guides/evaluation/quickstart-skill-eval.md)预览计划，配置运行时后再调用模型。固定模型与用例，记录运行条件，核对判定、不确定性和失败证据。
- **嵌入自己的服务**：从[离线 Node 示例](docs/zh/guides/integration/eval-runtime.md)开始，完成第一轮可回查的比较，再按需选择模型与配置。
- **在 Agent 或 DSH 中使用**：[安装官方 Skill](docs/zh/guides/evaluation/quickstart-skill-eval.md#在-agent-中使用)、[MCP 主动反馈](docs/zh/guides/integration/mcp-integration.md)和[DSH 宿主插件](docs/zh/reference/integration/executors.md#deepseek-harness-优先使用宿主插件)各有独立入口。
- **验收 Agent 修改的文件**：使用[本地任务验收](docs/zh/guides/evaluation/local-tasks.md)的独立检查；用[迭代改进](docs/zh/guides/evaluation/auto-improve-skills.md)筛选候选版本。

入门用例只检查流程，`UNDERPOWERED` 符合预期。真实发布判断需要自己的领域用例和独立证据；观测信号不能证明因果，一次评测通过也不等于载体已经生效或版本已发布。

## 查阅与升级

[文档入口](docs/zh/README.md) · [官网](https://oh-my-knowledge.pages.dev/zh/) · [CLI](docs/zh/reference/cli.md) · [运行时与执行器](docs/zh/reference/integration/executors.md) · [配置与环境变量](docs/zh/reference/shared/settings.md) · [示例](examples/README.zh.md)

Beta 接口和存储契约仍可能变化。知识在显式选定的工作区维护；运行证据与机器偏好各有自己的存储范围。升级前备份，再按迁移指南建立新证据。

## 安全说明

用于本地可信环境。任务、验收程序和自定义断言会执行本地代码，应先审查；工作区副本不是安全沙箱。调用模型前核对发送范围，原始记录与产物可能含敏感内容。本地报告服务没有身份认证，不应暴露到公网。

发布说明见 [GitHub Releases](https://github.com/lizhiyao/oh-my-knowledge/releases)。贡献流程见 [CONTRIBUTING](./CONTRIBUTING.md)。
