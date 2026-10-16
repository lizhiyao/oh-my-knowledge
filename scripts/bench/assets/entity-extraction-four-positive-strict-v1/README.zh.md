# 四正例 strict-wire 候选资产

[English](./README.md)

这份未激活的实验资产为 Issue #1236 P2-A 保存四个新编合成**提示词示例**。不改变生产 prompt、中央 registry、collector、存量 run 或默认行为。尚未运行模型实验；作者／人工复核和独立人工复核均待完成，没有 Gold 或质量结论。这四例不是评测 split，名称也不等于已经覆盖坏 sibling 或部分接纳失败路径。

## 冻结数据与对照

| 实验臂 | 原始 UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| `v14-derived-strict` | 31884 | `d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d` |
| `v15-candidate-strict` | 41017 | `7bf5c9fbf5e181346c76f84963911adf5b25a52db954d1e80495327b476f0dd6` |

对照臂**派生**自原 v14；原始 v14 的 raw hash 为 `e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399`。两臂共用其规则前缀、同一 strict-wire 说明、最终输出规则和 wire Schema。唯一字节差异为四个完整 input→wire-output 示例及一个 LF，共 9133 bytes。这不是原 prompt-only v14 与 strict-wire 的协议对照，也没有测量 token 开销。

`manifest.json` 绑定六份数据文件。`source-manifest.json` 是原临时目录 29 文件 bundle 的未改来源索引，摘要为 `sha256:4179285127f38cd561cfe1169ec3e7cf4970b41f3a88249ed1c2660351faeaef`，并非要求此处凑齐 29 文件的执行入口。重复的 raw-v14／raw-v15 快照、逐例拆分文件和绑定本机路径的 preparer 未复制入仓；组合示例与原索引保留预期输入、wire 输出和 domain 输出摘要。

冻结 wire ID 为 `sha256:9a9985e1806f0ab2225fb6e86b944382fcb3f47624a35d1211f4d6973679859a`，wire Schema raw digest 为 `sha256:a11c474841b5f73a681794e25725ba77d35e2570fc9939757206d366f0d71b69`。领域 Schema 为 v4，Zod 4.6.5、Ajv 8.20.0。仅 Schema 字节相同，不等于 wire identity 相同。仅两处缺省的 statement `object` 用 null 表示；已有整数 occurrence（包括 0 和 2）和具有领域语义的 null 均不改变。

## 复跑离线作者检查

使用已经构建 runtime 的检出；`dist` 缺失或过期时，先按仓库流程构建一次，本 verifier 不自动构建。在仓库根运行：

```sh
node scripts/bench/assets/entity-extraction-four-positive-strict-v1/verify.mjs
node scripts/bench/assets/entity-extraction-four-positive-strict-v1/verify.mjs \
  --out /tmp/new-four-positive-verification.json
```

runtime 固定为仓库相对路径的 `dist`，不依赖当前工作目录。模块使用字面量 import，输入 manifest 或参数不能选择加载代码；使用另一 runtime 时，在另一份检出中放置同一资产。命令只读本目录资产、固定的确定性生产 wire／domain／checker／prompt 模块、validator 元数据和 Node 字节，不导入执行器、benchmark corpus、held-out 或真实来源。默认不写文件；可选输出必须是检出外操作系统临时目录下的新文件，不覆盖既有报告。

verifier 检查每份冻结数据摘要和精确字节插入，再调用真实生产 decoder、领域 Schema、接纳 checker 和 KnowledgeDraftSchema。映射后的领域输出必须保持原作者序列化摘要；当前 checker 计数必须匹配四例作者预期，合计 7 实体、9 提及、2 个接纳 draft、零拒绝。这是结构／位置／引用证据，不是独立语义复核。validator 或 wire identity 漂移时直接失败；保留本 bundle，另建明确审阅的新身份，不静默改基线。

输出的 `verificationId` 绑定资产 manifest、verifier、实际 wire identity、Zod／Ajv 版本、Node 二进制／版本及列出的八个编译模块。它是离线验证身份，**不是**完整模型测量身份或所有传递依赖的字节闭包。生产 v14 只读，registry 不触碰。

## 现有 collector 能复放什么

现有 collector 支持 `v14-derived`／`v15-candidate`、`json-schema` 和精确 `--wire-schema`，见[采集工具](../../README.zh.md)。它不能把本 bundle manifest 作为 `--source` 或 `--review-bundle` 读取；此处既不是 `omk-entity-capture-source/v1`，也不是冻结 review corpus／measurement bundle。

不能把四个示例反过来作为质量评测用例，因为候选 prompt 已含它们的答案。其 `frost-1`／`cup-1`／`heron-*`／`beacon-1` 引用也不满足 collector 的 `caseId:recordIndex` 要求，三个输入的 limitations 为空，而 capture-source/v1 要求非空列表。不要为通过接纳而改写冻结输入；变换后的来源会拥有新身份，而且仍是示例回灌，不是未见验证。

后续实验需要另行编写、复核且未进入 prompt 的 development 输入，满足 capture-source/v1，明确 case／group 隔离、受支持的精确模型／endpoint／预算 profile，并创建外部新计划。满足后才可使用现有**零请求**准备入口绑定两份 prompt，例如：

```sh
node dist-scripts/bench/entity-extraction-capture.js prepare \
  --source /absolute/unseen-development-source.json \
  --prompt scripts/bench/assets/entity-extraction-four-positive-strict-v1/v14-derived-strict.prompt.txt \
  --wire-schema scripts/bench/assets/entity-extraction-four-positive-strict-v1/wire-schema.json \
  --config /absolute/reviewed-control-config.json --out /tmp/new-control-plan
```

另一臂使用候选 prompt 和 `promptVariant: "v15-candidate"`；对照臂必须标为 `"v14-derived"`，不能叫 `"v14-original"`。除此以外，两份配置的来源／用例／split、repeats、executor／model／endpoint／profile、`outputMode: "json-schema"`、schemaName、timeout、输出上限、调用／token 上限和重试策略必须相同。生成的各自 `planId` 重新绑定输入／请求字节和实际 host／checker／collector／依赖／指南／validator／Node 身份，不能用本资产 manifest 冒充。prepare 不授予发送许可。

`check`、`replay`、`compare` 也发送零请求。空计划或条件匹配不等于完成实验；实际执行另需用户授权和针对各计划的人审 grant，本 bundle 均不提供。当前比较明确不认证配对顺序，语义／人工复核仍 pending；平衡顺序、缓存／先后控制、双臂总预算、独立裁决及决策规则仍需补齐。原 prompt-only v14 的旧结果和这四例都不能证明 few-shot 提升、泛化、精确率／召回率或可发布。
