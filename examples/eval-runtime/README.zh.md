# 嵌入 Evaluation Runtime

[English](./README.md)

## 用途

这个最小 Node.js ESM 宿主通过 `oh-my-knowledge` 包根入口注入内存中的业务调用函数，对比两个服务部署，执行确定性 exact-match 评分，并物化 Evaluation Report。它不会加载 CLI，也不会读取用户配置。

## 运行

在本仓库中使用 Node.js 22 或更高版本运行：

```bash
yarn build
node examples/eval-runtime/run.mjs
```

命令会输出一行 JSON，其中 `runStatus` 为 `"completed"`，treatment 改进估计值为 `0.6666666666666666`，Decision 已完成，并包含 report ID。

在独立服务中使用时，先运行 `npm install oh-my-knowledge`，再复制 `run.mjs`，并用服务的 Target 调用替换确定性的 `executor` 函数体。凭证、租户鉴权、队列与存储仍由宿主持有。

## 证据边界

该示例证明只使用公共 `eval-runtime` 的 consumer 可以在无 provider、无文件系统配置的条件下完成内存 control／treatment 测量。三条确定性教学用例不具备代表性或充分统计功效，不能作为发布证据；模拟调用也不能验证生产模型网关的超时、重试、隐私或成本行为。

## 混合召回与弃答

构建后运行 `node examples/eval-runtime/retrieval-abstention.mjs`，组合内置召回、内置弃答与独立禁用 ID 评分。数据集选择和标注审核由宿主负责。独立使用时复制 `retrieval-abstention.mjs`、`retrieval-abstention-support.mjs` 两个文件并安装 OMK。
