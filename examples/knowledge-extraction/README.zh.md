# 知识提取存储 dogfood

[English](./README.md)

## 用途

通过显式可信 Source3 绑定预览并捕获一条合成来源消息，分别准备和确认每阶段的完整生成请求，让两次作者编写的响应经过生产正文优先应用，先保存一条完整知识正文，再独立保存含两个实体的派生关联，再从磁盘重新打开，核对原始来源绑定与实体检索。来源中的“Alpha 使用 Beta”只是教学数据，不是关于真实系统的事实。

脚本在本地编写 Codex 格式的 JSONL 教学 fixture，不会运行 Codex 或导入真实对话。格式归因不代表执行证据。

## 运行

在 OMK 源码仓库中使用 Node.js 22 或更高版本：

```bash
yarn build:runtime
node examples/knowledge-extraction/run.mjs
```

脚本使用该检出构建出的内部应用模块。它们不是公共 SDK 入口；安装 npm 包后复制此文件不是受支持的集成方法。示例不需要 API 凭证、Codex 或模型账号，也不会选择 provider 执行器。

命令输出一行 JSON，其中包含 `fixtureInvocations: 2`、`modelCalls: 0`、`workflowId: "knowledge-body-first/v3"`、`phaseKinds: ["body", "association"]`、`runStatus: "completed"`、`candidateCount: 1`、`entityCount: 2`、`sourceBindingVerified: true`、`entitySearchMatches: 1`、`reviewStatus: "pending"` 和 `associationReview: "pending"`。它还核对捕获和准备不会调用 fixture、未确认请求不能派发任一阶段、重新打开同一来源集合不会再次调用 fixture，以及检索结果能关联已保存知识。没有测量的 provider token／成本字段保持缺失。

来源、Source3 快照、含两份独立作者响应原件的 Schema 3 双阶段 generation journal、实体分析、正文历史及独立关联历史均写入一处由脚本创建的系统临时目录。预览不保存快照，捕获不授予发送许可；每阶段都需要精确的已准备 `requestDigest`，正文生成只会准备关联请求。成功或失败后都会删除临时目录，不写入示例目录、`.omk`、用户知识目录或全局设置。

仓内隔离验证时，可用 `OMK_PACKAGE_ROOT` 显式选择另一份已有当前构建产物的源码检出。此覆盖选项不把内部模块路径变成公共 API。

## 证据边界

这是使用作者响应的确定性应用／存储 dogfood，检查有界来源选择、本地预览、捕获、逐阶段请求确认、逐字引文、宿主分配的身份关联、幂等重开、持久化、来源溯源及实体检索。模型输入使用可移植的 Source3 来源集合及选定片段，原始记录封套、宿主路径和捕获时间留在本地。正文段包含完整叙述与内联精确证据；实体关联是独立派生候选，不能补全或改写正文。它不测量实体召回、身份语义、模型质量、provider 约束解码、重试、成本或跨窗口消解。人工及独立复核仍 pending，保存的候选不会升级为已验证事实。Fixture 既不是真实模型 capture，也不是 Gold 标注，不会改变 `goldReady`。
