# 嵌入 Evaluation Runtime

[English](./README.md)

## 用途

这个最小 Node.js ESM 宿主通过 `oh-my-knowledge` 包根入口注入内存中的业务调用函数，对比两个服务部署，检查实际输出是否与标准答案完全一致，并生成评测报告。它不会加载 CLI，也不会读取用户配置。

## 运行

在本仓库中使用 Node.js 22 或更高版本运行：

```bash
yarn build
node examples/eval-runtime/run.mjs
```

命令输出一行 JSON：`runStatus: "completed"` 表示运行完成；`estimate: 0.3333333333333333` 表示候选版本的完全匹配率比对照版本高约 33.3 个百分点；`verdict: "NOISE"` 表示这三条用例尚不足以确认进步，不能据此发布。输出还包含报告 ID。

在独立服务中使用时，先运行 `npm install oh-my-knowledge zod`，再复制 `run.mjs`，并用自己的服务调用替换 `executor.execute()`，同时更新 schema、版本与真实能力声明。首次接入见[使用指南](../../docs/zh/guides/eval-runtime.md)。凭证、租户鉴权、队列与存储仍由宿主持有。

## 证据边界

该示例证明只使用公共 `eval-runtime` 的 consumer 可以在无 provider、无文件系统配置的条件下完成内存 control／treatment 测量。三条确定性教学用例不具备代表性或充分统计功效，不能作为发布证据；模拟调用也不能验证生产模型网关的超时、重试、隐私或成本行为。

## 混合召回与弃答

这个单文件示例同时评估正确召回、正确空返回、误弃答和禁用 ID 命中，无需外部凭证。

```bash
yarn build
node examples/eval-runtime/retrieval-abstention.mjs
```

原样运行会排除 1 条待标注样本，执行 2 条已标注样本；正确弃答为 `1`，误弃答与禁用命中为 `0`。独立项目复制 `retrieval-abstention.mjs`，并安装包含该能力的 OMK 版本与 Zod。尚未发版的能力先使用对应源码检出运行。

接入自己的系统时，先替换 `source`，再修改 `executor.execute()`，最后核对各项 `coverage`。完整的数据规则、返回格式、能力声明和结果解释见[四步使用指南](../../docs/zh/guides/eval-runtime.md#retrieval-abstention)。
