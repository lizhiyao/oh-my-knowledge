# 知识提取存储 dogfood

[English](./README.md)

## 用途

预览并捕获一条合成 Source3 消息，分别确认未核验写作稿、有据正文，再显式生成待审实体与语义关系。脚本保存一条正文、两个实体和一条关系，重开记录并核对来源绑定、图谱及实体检索，不要求先运行来源覆盖分析或保存继续决定。“Alpha 使用 Beta”是教学数据，不是现实系统的事实。

脚本只使用本地编写的 Codex 格式 JSONL 和作者响应，不运行 Codex、不导入真实对话、不调用模型。

## 运行

在 OMK 源码仓库中使用 Node.js 22 或更高版本：

```bash
yarn build:runtime
node examples/knowledge-extraction/run.mjs
```

使用该检出的内部构建模块，不是公共 SDK 集成方法；不需要 API 凭证或模型账号。隔离验收时可用 `OMK_PACKAGE_ROOT` 指向另一份有当前构建产物的源码检出。

输出包括 `fixtureInvocations: 3`、`modelCalls: 0`、`workflowId: "knowledge-body-first/v11"`、`phaseKinds: ["body_draft", "body", "association"]`、`candidateCount: 1`、`entityCount: 2`、`relationCount: 1`、`sourceBindingVerified: true`、`entitySearchMatches: 1`、`reviewStatus: "pending"` 和 `associationReview: "pending"`。

捕获与准备零调用，每次发送须确认各自精确的 requestDigest。Schema 11 日志、三份完整作者响应、来源及正文／实体／关联历史保存在脚本自己的系统临时目录；重复打开已完成来源集不派发新请求。成功或失败后都删除该临时目录，不写用户工作区或全局设置，未知 token／费用保持缺失。

## 证据边界

这个确定性应用／存储演示检查来源范围、请求确认、宿主逐字定位、精确正文版本、持久化、幂等恢复、待审图谱及实体导航。原始封套、宿主路径和捕获时间留在本地。可选来源复核通过独立入口执行，不是本示例的前置。

`semanticQuality: "not_assessed"`。正文、实体与关系均待核对，不自动 retain；不证明真实模型提取质量、实体召回、跨窗身份、真人体验或采用 OMK 的净收益。未测量的用量和费用不记零，人工和独立质量复核仍 pending。
