# 四正例 strict-wire 候选资产：修订 2

[English](./README.md)

Issue #1236 P2-A 的未激活提示词示例。AI 作者逐项审阅后修正两处来源边界；完整记录见 `author-review.json`。真人及独立真人复核仍待完成，Gold 为 none，模型质量未评测，生产 prompt 和 registry 不变。

## 本次修订

- 容量示例改为“原文称容量”与“来源陈述的容量值”，不再暗示实际测量已经发生。
- 发布门禁保留原禁令引用，另加“该窗口没有发布执行记录。”的精确引用，直接定位陈述中的未知限制。
- 两个修改的 exampleId 升为 v2；四份输入及另两例输出不变。

[修订 1](../entity-extraction-four-positive-strict-v1/README.zh.md) 全部文件保留原字节。`manifest.json` 绑定旧 manifest／示例／候选摘要和七份新数据；`source-manifest.json` 仍是原 29 文件临时 bundle 的历史索引，不能当作新输出摘要。新逐例 input／wire-output／domain-output 摘要由本修订 manifest 记录。

## 冻结对照

| 实验臂 | 原始 UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| `v14-derived-strict` | 31884 | `d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d` |
| `v15-candidate-strict` | 41158 | `097bf49208e596afdd8df67c1d4091dfeb730ad92d00f30e880df64463913254` |

两臂共用原规则前缀、strict-wire 说明、最终输出规则及 Schema；唯一差异仍为四个完整示例与一个 LF，现为 9274 bytes。没有测量 token 开销。仓库 runtime 使用 Zod 4.6.5／Ajv 8.20.0，wire ID 为 `sha256:9a9985e1806f0ab2225fb6e86b944382fcb3f47624a35d1211f4d6973679859a`。修订没有改变 wire 身份。

## 复跑离线检查

先按仓库流程保证 `dist` 为当前构建，再运行：

```sh
node scripts/bench/assets/entity-extraction-four-positive-strict-v2/verify.mjs
node scripts/bench/assets/entity-extraction-four-positive-strict-v2/verify.mjs \
  --out /tmp/new-four-positive-v2-verification.json
```

verifier 使用固定的仓库相对路径，校验旧冻结绑定、新数据摘要、作者记录闭包及示例块的精确字节，再调用真实生产 decoder、领域接纳与 KnowledgeDraftSchema。合计仍应为 7 实体、9 提及、2 个接纳 draft、零拒绝。新引用的精确位置由宿主计算；结构通过不证明语义正确。

命令不导入执行器、不读真实来源或评测 split、零模型请求；默认不写文件。可选报告须为检出外系统临时目录的新文件。`verificationId` 绑定新 manifest、verifier、实际 validator／wire、Node 与列出的编译模块，范围不是完整模型测量或所有传递依赖。validator／wire 漂移会拒绝，不能静默重置基线。

## 后续实验边界

这些是答案已进入 prompt 的 demonstrations，不是未见评测，不能回灌为质量用例。AI 作者审阅 completed 不代表独立真人通过、Gold 或 few-shot 效果提升。

候选 prompt 的字节已改变，相对修订 1 属于 **BREAKING-COMPARABILITY**。旧计划、许可和结果仍属于原身份，不能转用于本修订。后续使用[采集工具](../../README.zh.md)时须另行冻结来源、当前 runtime／wire、两臂请求和预算，生成新的计划并取得相应执行许可；本资产不提供许可，也未运行实验。仓库 runtime 与隔离安装版 runtime 的 validator 身份必须分别记录，不能用一个的离线报告证明另一个。
