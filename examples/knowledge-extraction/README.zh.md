# 知识提取存储 dogfood

[English](./README.md)

## 用途

通过显式可信宿主绑定预览并捕获一条合成 Source3 消息，分别准备和确认作者编写的四阶段响应：来源清单、正文、来源覆盖核对、实体关联。覆盖核对后、准备关联前，由实际示例运行器 Agent 单独记录有限决定。脚本保存一条完整正文和两个关联实体，再重开原始记录，核对来源绑定与实体检索。“Alpha 使用 Beta”是教学数据，不是关于真实系统的事实。

脚本在本地编写 Codex 格式的 JSONL fixture，不会运行 Codex、导入真实对话或取得模型生成的质量结论。格式归因不是执行证据。

## 运行

在 OMK 源码仓库中使用 Node.js 22 或更高版本：

```bash
yarn build:runtime
node examples/knowledge-extraction/run.mjs
```

脚本使用该检出的内部构建模块，不是公共 SDK 入口；安装 npm 包后复制此文件不是受支持的集成方法。示例不需要 API 凭证、Codex 或模型账号，也不会选择 provider 执行器。

命令输出一行 JSON，其中包含 `fixtureInvocations: 4`、`modelCalls: 0`、`workflowId: "knowledge-body-first/v4"`、`phaseKinds: ["source_ledger", "body", "source_coverage", "association"]`、`runStatus: "completed"`、`candidateCount: 1`、`entityCount: 2`、`sourceBindingVerified: true`、`entitySearchMatches: 1`、`reviewStatus: "pending"` 和 `associationReview: "pending"`。`sourceCoverageDecision: "proceed_with_limits"` 与 `sourceReviewActorKind: "agent"` 表示示例运行器明确记录的演示范围意见；`semanticQuality: "not_assessed"` 保持独立。

捕获和准备不调用 fixture。每阶段都需要自己精确的已准备 `requestDigest`，脚本也核对缺少确认时会拒绝发送。覆盖响应逐项记录全部已交付元数据／原文单位、清单项／facet 和已保存段落，保留无法判断状态；事实时间未知仍是未知。运行器只为本次作者演示明确接受这些可见限制，随后再单独准备和确认关联。模型分析或保存成功不会自动产生决定。

Source3 快照、Schema 4 journal、四份完整作者响应原件、来源清单／覆盖历史、正文和实体／关联历史均位于一处由脚本创建的系统临时目录。重开已完成来源集不会再次调用 fixture。成功或失败后都会删除临时目录，不写入示例本身、`.omk`、用户知识目录或全局设置。未测量的 provider token／成本字段保持缺失。

仓内隔离验证时，可用 `OMK_PACKAGE_ROOT` 选择另一份已有当前构建产物的源码检出。此覆盖选项不把内部模块路径变成公共 API。

## 证据边界

这个确定性的应用／存储演示检查有界来源选择、本地预览／捕获、分别确认请求、完整来源单位清单、宿主逐字定位、精确决定引用、actor 归因、持久化、幂等重开和来源绑定的实体检索。元数据引文定位的是宿主交付的元数据，不冒充原文片段；原始封套、宿主路径和捕获时间留在本地。

实际 Agent 决定明确限于运行本次作者示例，不是人工复核、Gold、事实认证或语义质量通过。正文与关联候选仍待核对，不会自动 retain 正文。示例不测量实体召回、身份语义、模型质量、provider 解码、重试、成本或跨窗口消解。人工及独立质量复核仍 pending，已保存候选不会升级为已验证事实，也不改变 `goldReady`。
