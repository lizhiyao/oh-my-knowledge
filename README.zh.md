# OMK

[![npm version](https://img.shields.io/npm/v/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![npm weekly downloads](https://img.shields.io/npm/dw/oh-my-knowledge.svg)](https://www.npmjs.com/package/oh-my-knowledge)
[![CI](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml/badge.svg)](https://github.com/lizhiyao/oh-my-knowledge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/node/v/oh-my-knowledge.svg)](https://nodejs.org)

[English](./README.md) | **简体中文**

**Observe. Measure. Know.** 让 AI 应用的知识改动有据可依。

OMK 帮助 prompt、RAG、skill 和 agent 的作者比较版本、检查证据，并从真实任务中发现知识缺口。受控比较遵循：**相同模型，相同评测用例，只改变知识载体。**

当前 1.0 仍处于 **Beta 迭代期**，接口与存储契约可能继续变化。从旧版本升级前，请先阅读[迁移指南](docs/zh/guides/v1-preview-migration.md)。

![OMK：从受控评测到真实使用反馈](./docs/public/omk-knowledge-flow-animated.gif)

## 从你的目标开始

| 想做什么 | 入口 |
|---|---|
| 比较两版 skill，获得判定、置信区间与失败用例 | [命令行快速上手](docs/zh/quickstart-skill-eval.md) |
| 在 Node.js 服务中接入评分与版本对比 | [服务接入指南](docs/zh/guides/eval-runtime.md)，含无需模型凭证的示例 |
| 看清一次任务，或从历史日志发现问题 | [观测与任务轨迹](docs/zh/guides/observe-production.md) |

## 快速开始

需要 Node.js >=22 和一个已认证的模型 runtime，详见[系统要求](#系统要求)。安装 Beta 并预览第一次比较：

```bash
npm i -g oh-my-knowledge@next
omk init demo
cd demo
omk eval --control code-review-v1 --treatment code-review-v2 --dry-run
```

检查计划和预估调用次数后，执行评测（会调用模型）：

```bash
omk eval --control code-review-v1 --treatment code-review-v2
```

脚手架包含两版 skill 和三条用例。默认小样本用于检查流程，出现 `UNDERPOWERED` 符合预期。官方起步用例标记为 `llm-generated`；即使用 `omk init demo-full --samples 20` 创建完整起步集，也只是达到默认启发式证据下限，不等于完成功效规划或具备发布证据。实际使用前应人工复核并替换为真实领域用例。

[完整教程](docs/zh/quickstart-skill-eval.md)介绍模型选择、换成自己的 skill 和结果解读；[示例画廊](examples/README.zh.md)提供更多可运行场景。

## 在 Agent 中使用

```bash
omk install omk-agent-skill
```

安装后，可以对 coding agent 说：“用 omk 比较这两版 skill。”安装目标与使用方法见[快速上手](docs/zh/quickstart-skill-eval.md#在-agent-中使用)。DeepSeek Harness 用户可直接使用[宿主插件](docs/zh/reference/executors.md#deepseek-harness优先使用宿主插件)，复用当前 profile。

[MCP 集成](docs/zh/guides/mcp-integration.md)提供用户授权的主动知识反馈入口。它仅记录提交到工具边界的部分证据，不自动监听完整对话。

## 如何使用证据

`doctor` 检查知识载体，`eval` 做受控比较，`studio` 展示结果与原始证据。证据满足条件后可以 `promote` 接受版本，或用 `evolve` 生成候选；`observe` 暴露的缺口可转成待复核用例，再进入下一轮评测。

结论受用例、评分准则和执行环境约束。观测信号不等于因果结论，生成的样本也不能直接充当独立发布验证集。原理与限制见[统计严谨性](docs/zh/explanation/statistical-rigor.md)和[三阶段工作流](docs/zh/explanation/three-stage-workflow.md)。

项目证据保存在 `.omk/`，机器级状态位于 `~/.oh-my-knowledge/`。当前版本不读取或迁移旧存储布局；升级前备份，按[迁移指南](docs/zh/guides/v1-preview-migration.md)重新建立证据。

## 文档

[完整文档与导航](docs/zh/README.md) · [在线文档](https://oh-my-knowledge.pages.dev/zh/) · [CLI 参考](docs/zh/reference/cli.md) · [用例格式](docs/zh/reference/eval-sample-format.md) · [执行器](docs/zh/reference/executors.md) · [OMK 如何理解知识](docs/zh/explanation/knowledge.md)

## 环境变量

| 变量 | 说明 |
|------|------|
| `OMK_EXECUTOR` | 默认执行器偏好，例如 `codex` / `codex-sdk` / `claude` |
| `OMK_MODEL` | 默认被测模型；Codex 未设置时读取本机 `config.toml` |
| `OMK_JUDGE_MODELS` | 默认评委列表，格式 `executor:model[,...]` |
| `CCV_PROXY_URL` | 通过 cc-viewer 代理请求，实时可视化评测流量 |
| `OMK_REPORT_PORT` | 报告服务端口（默认 7799） |

## 系统要求

- Node.js >= 22
- 至少一个已认证的模型 runtime：
  - Codex：安装并登录 Codex CLI（`npm i -g @openai/codex`）；ChatGPT desktop 的 Codex 任务会自动选择它
  - Claude：安装并登录 [Claude Code](https://claude.ai/code)
  - API / 其它执行器：按[执行器文档](docs/zh/reference/executors.md)配置
- 高级 `claude-sdk`／`codex-sdk` 执行器是可选能力，OMK 基础安装不再下载它们。仅在明确选择对应 SDK 时，才在 OMK 所在的本地项目或全局 npm prefix 安装；详见[执行器前置要求](docs/zh/reference/executors.md#前置要求)。

## 安全说明

本工具设计用于**本地可信环境**（开发机、CI 流水线）。以下功能会执行本地代码，请确保输入来源可信：

| 功能 | 风险 | 适用场景 |
|------|------|----------|
| **自定义断言**（`custom`） | 动态加载并执行用户指定的 `.mjs` 文件 | 仅使用自己编写或审查过的断言文件 |
| **eval-samples.json** | 断言配置可引用外部文件路径 | 不要使用来源不明的用例文件 |

**建议：**

- 不要将本地报告服务暴露到公网（无身份认证）
- 不使用未经审查的第三方 eval-samples
- 自定义断言有 30 秒超时，但无沙箱隔离

---

发布日志见 [GitHub Releases](https://github.com/lizhiyao/oh-my-knowledge/releases)。欢迎贡献 —— 见 [CONTRIBUTING](./CONTRIBUTING.md)。
