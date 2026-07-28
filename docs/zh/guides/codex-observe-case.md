# 复现 Codex 父子任务观测

这个案例展示从 Codex Desktop 原始 rollout 到可回读 observe inbox 报告的完整本地链路：

```text
Codex JSONL → source-neutral Trace IR → 父子任务图
            → 知识缺口信号 → 紧凑报告 → 回读
```

fixture 位于
[`examples/codex-observe-router`](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/codex-observe-router)。
它的协议结构取自真实父任务与 reviewer 子任务，所有会话 ID、路径、命令和业务文本均已替换。

## 一条命令复现

克隆仓库后，在仓库根目录运行：

```bash
npm exec --yes --package=oh-my-knowledge@0.49.0 -- \
  node examples/codex-observe-router/verify.mjs
```

预期摘要：

```json
{
  "omkVersion": "0.49.0",
  "physicalTraceFiles": 2,
  "logicalSessions": 1,
  "observedSkills": ["repo-review"],
  "sourceKind": "codex",
  "externalChildEdges": 1,
  "edgeEndpointsClosed": true,
  "routerDownstreamCompleted": 1,
  "inboxSignals": 1,
  "inboxSignalTypes": ["failed_search"],
  "compactReportRoundTrip": true
}
```

验证过程确定性执行，不调用模型。设置 `OMK_KEEP_OUTPUT=1` 可保留生成的 `.omk/observe-inbox` 报告。

## 这个案例证明什么

统计两个文件并不难。真正需要守住的边界是：omk 在保留物理 trace 来源的同时，能否还原一个逻辑会话；能否连接父子任务且不产生悬空图引用；能否保留搜索失败信号；能否让紧凑报告回读后语义不变。

verifier 会直接断言这些性质。它不会给 skill 质量评分，也不表示已经覆盖 Codex 的全部历史 rollout 版本。

## 验证本地改动

```bash
yarn build
OMK_BIN="$PWD/dist/cli/index.js" \
OMK_PACKAGE_ROOT="$PWD" \
node examples/codex-observe-router/verify.mjs
```

日常项目用法和人工复核流程见[观测生产 trace](./observe-production)。
