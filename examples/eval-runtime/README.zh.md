# 嵌入 Evaluation Runtime

[English](./README.md)

## 用途

这个例子让问答服务的旧版和新版分别回答三道首都题：旧版把日本首都答成京都，新版答成东京。OMK 检查答案、比较正确率，并返回报告。两个版本都用固定回答模拟，不调用模型，也不需要账号。

## 运行

在本仓库中使用 Node.js 22 或更高版本运行：

```bash
yarn build
node examples/eval-runtime/run.mjs
```

命令输出一行 JSON：`runStatus: "completed"` 表示运行完成；`estimate: 0.3333333333333333` 表示候选版本的完全匹配率比对照版本高约 33.3 个百分点；`verdict: "NOISE"` 表示这三条用例尚不足以确认进步，不能据此发布。输出还包含报告 ID。

在独立服务中使用时，先运行 `npm install oh-my-knowledge@next zod`，再复制 `run.mjs`，并用自己的服务调用替换 `executor.execute()`，同时更新 schema、版本与真实能力声明。首次接入见[使用指南](../../docs/zh/guides/eval-runtime.md)。凭证、租户鉴权、队列与存储仍由宿主持有。

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

## 结果存储与加载信任边界

这个单文件示例基于 `node:fs` 在显式临时目录中实现宿主自有的存储端口（`ContentStore.put` / `ContentResolver.resolve`），用 `saveEvaluationResult()` 持久化一份 canonical 结果，再模拟第二个进程重新声明同一契约，用 `loadEvaluationResult()` 恢复结果，并在不重跑被测目标的情况下按修正后的 Gold 标注执行 rescore。

```bash
yarn build
node examples/eval-runtime/result-store.mjs
```

存储归宿主所有：OMK 不发现、不初始化、也不扫描宿主存储——Runtime 只调用显式注入的 `put()` / `resolve()` 端口，凭证、租户、保留策略和物理根目录都留在宿主一侧。示例同时演示恢复结果的信任边界：provenance bundle、cache 回执与 policy 执行这三组已认证 digest 来自生产时刻由宿主签名的审计回执，而不是重新解析存储的 envelope；只做校验和的 verifier 会被 fail closed 拒绝。进程内 HMAC 密钥只是替身，生产环境应接入真实签名／审计系统（KMS、透明日志、认证机构）。命令输出保存的 reference、双方一致的 plan digest，以及未新增目标调用的 rescore 摘要。

在独立服务中使用时，复制 `result-store.mjs`，把文件存储换成你的对象存储或数据库对这两个端口的实现，把回执 verifier 换成你的认证后端。只认证宿主能独立取得的 digest 集合；未认证的部分由 Runtime fail closed 拦截。

## 拆分为先执行、后评分

这个单文件示例用 `executeEvaluation()` 只跑一次被测目标，用 `saveExecutedEvaluation()` 只持久化执行 envelope，在模拟的第二个进程里通过 `loadExecutedEvaluation()` 重新接纳，再用 `scoreExecutedEvaluation()` 按两套 Gold 标注分别评分。

```bash
yarn build
node examples/eval-runtime/staged-execute-score.mjs
```

示例针对同一次执行输出三轮评分：按原标注 3 题对 2 题，按修正标注 3 题全对，而 `targetInvocations` 始终是 3。它也演示了边界：prompt 已变化的声明会在评分前以 `EVAL_RUNTIME_REUSE_INVALID` 被拒绝，clone 出的句柄同样被拒绝；只做校验和的 verifier 重新接纳的 envelope 仍能正常评分，但只能声称 `provenanceTrust: "unknown"`。当执行与评分发生在不同时间或不同机器时，复制 `staged-execute-score.mjs`，并把回执 verifier 换成你的认证后端。
