# 实体提取采集工具

[English](./README.md)

这些是仓内工具，须在带当前依赖的检出中执行 `yarn build:runtime` 后运行。它们不是公共 SDK export，也不增加 `omk` 命令。`entity-extraction-review.js` 继续作为既有离线复核入口；独立的 `entity-extraction-capture.js` 通过生产 `createExecutor` 执行得到明确许可的 slot。构建还依赖单独审查的 strict wire 模块。本批不改变生产 prompt、run 格式、旧 capture/v1 或合成 corpus 格式。

默认行为以及 `prepare`、`check`、`replay`、`compare` 都是零请求。只有 `execute-one` 可以发送，每次只处理显式指定的下一个 slot。在检出外创建新目录：

```sh
node dist-scripts/bench/entity-extraction-capture.js prepare \
  --source /absolute/source.json --prompt /absolute/prompt.txt \
  --config /absolute/config.json --out /absolute/new-capture-directory
node dist-scripts/bench/entity-extraction-capture.js check --plan /absolute/new-capture-directory
```

可用 `--review-bundle /absolute/frozen-review-directory` 代替 `--source`。它校验已有 manifest 的 measurement 与 corpus 摘要，再为实际选中输入和真实 provider 请求建立新绑定。旧 review measurement ID 只是来源元数据，不能证明 provider、端点或执行条件。不能用保留的 validation 内容调 prompt。真实消息须使用下面的新来源协议，并单独完成许可、最小化及复核。

未激活的[四示例候选修订 2](./assets/entity-extraction-four-positive-strict-v2/README.zh.md) 修正 AI 作者审阅发现的来源强度和限制引用缺口。修订 1 保持冻结。修订后 prompt 使用新摘要，实验须另建计划；两份修订都不是评测 split 或独立真人证据。

## 来源、配置与身份

新输入文件使用 `sourceVersion: "omk-entity-capture-source/v1"`。`provenance` 包含 `sourceKind`（`synthetic`、`public-redacted-real` 或 `private-real`）、`originDigest`（`sha256:...`）、非空 `transformation` 描述和 `toolPolicy: "excluded"`。文件同时包含 `review: {"human":"pending","independent":"pending","gold":"none"}` 和 `cases` 数组。每个 case 有唯一 kebab-case `caseId`、`split: "development"`、非空 `limitations` 和 `excerpts`。每条 excerpt 包含 `evidenceRef: "<caseId>:<recordIndex>"`、非负整数 `recordIndex`、`eventKind: "message"`、`role: "user" | "assistant"` 和精确非空 `text`。该协议不能包含 tool。来源声明只是记录声明，collector 不独立证明来源或认证脱敏效果。不能把真实文本改标为 synthetic，也不能把新编造文本标作真实来源。

官方端点配置示例（两个 slot）：

```json
{
  "executor": "openai-api",
  "model": "gpt-5.4-2026-03-05",
  "profileId": "openai-gpt54-snapshot-context/v1",
  "timeoutMs": 300000,
  "maxOutputTokens": 4096,
  "maxCalls": 2,
  "maxTokens": 2108192,
  "outputMode": "prompt-json",
  "schemaName": null,
  "promptVariant": "v14-original",
  "caseIds": ["your-selected-case"],
  "split": "development",
  "repeats": 2
}
```

plan 冻结 prompt 原始 UTF-8 字节、来源字节及 provenance、选择范围、输入引用与字节、生产请求完整 body、请求的 executor/model/endpoint/protocol、实际消费的配置、超时、输出模式及 Schema、禁止重试策略、调用与 token 预留，以及 Node binary、已构建 runtime/checker/collector、依赖锁、实际加载的 Zod／Ajv 版本与标注指南身份。凭据不会复制到证据中；每个命令冻结自身环境，将其实际产生的 endpoint/request 与 plan 核对，并在 dispatch 前检查 key 存在。provider 默认参数、账户身份、服务端报告的 model/fingerprint 和后端 revision 未获证明。host 摘要覆盖当前编译 runtime，重新构建会使 plan 失效。实际 validator 版本在所有输出模式下都参与 host 身份；它不代表全部 node_modules 的字节闭包。这些是身份核对，不是抵御恶意本地操作者的签名机制。

`v14-original` 必须匹配原 prompt 精确摘要 `sha256:e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399`。修改过的 v14 字节使用 `v14-derived`，新候选使用 `v15-candidate`。strict 模式还要求 `outputMode: "json-schema"`、合法 `schemaName` 和携带当前 wire 精确字节及摘要的 `--wire-schema`。原 v14 示例与 nullable wire 占位不兼容，该组合会被拒绝；候选须另行适配示例。本批不激活新默认版本，也不证明质量提升。

## 硬限制与明确许可

冻结的官方 profile 只接受精确 snapshot 和 `https://api.openai.com/v1/chat/completions`。每次调用预留官方完整 1,050,000-token context 容量，再加 `max_completion_tokens`，后者不能超过 128,000。这个有意保守的预留不会根据估算、实际 usage 或 cache hit 退还。[官方模型契约](https://developers.openai.com/api/docs/models/gpt-5.4)、[completion 上限](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)及 [token 记账](https://developers.openai.com/api/docs/guides/token-counting)以 2026-10-16 的引用事实冻结，不代表线上可用性、认证或报价。这是 token/调用限制，不是美元上限；模型自报不能建立上界。

实际共享 request builder 固定 `n: 1`、`stream: false`，生产 fetch 拒绝重定向。不发送 tools、prediction，也不配置重试。未知 model/endpoint/profile 组合直接拒绝。Codex 无法执行请求的输出 token 硬上限，在构造 executor 或调用 binary 前即拒绝。`loopback-test/v1` 只允许 HTTP `127.0.0.1` 上的新编测试模型，标记 `loopback-test-only`，只能证明隔离传输行为，不能认证真实服务。dispatch 后 CLI 即使面对 loopback 也把模型调用标为 `not_attested`，因为本地服务可能转发请求；只有隔离 fake-transport harness 能证明零模型调用。官方执行拒绝 Node preload/loader 注入。

`prepare` 写出的许可模板是 **pending**，生成模板不授予许可。人类须审阅冻结的数据、prompt、端点/model 和预算，再另行提供许可文件，包含 `authorizationVersion: "omk-entity-live-permission/v1"`、`authorizationStatus: "granted"`、与 plan 完全一致的 plan/data/model/endpoint/budget、`action: "send-frozen-selected-inputs-to-the-declared-model"`、非空 `authorizedBy` 以及合法的 `grantedAt` 和未来 `expiresAt` ISO 时间。没有命令会生成 grant。发送任何真实数据或模型请求仍须得到用户授权。得到明确批准后的命令为：

```sh
node dist-scripts/bench/entity-extraction-capture.js execute-one \
  --plan /absolute/new-capture-directory --permission /absolute/approved-permission.json \
  --authorize-plan sha256:THE_REVIEWED_PLAN_ID --slot your-selected-case-repeat-1
```

每次调用都须明确指定一个 slot。互斥 active lock 和持久化 reservation 在创建 factory 前写入；生产同步 dispatch gate 再次核验许可有效期及冻结资产/request/host 身份。失败、取消或 usage 未知也永久占用一次调用及完整 token 预留。未完成 reservation 或未知/非法 usage 会阻止后续执行，不能删除证据后重试。崩溃可能遗留 active lock，同样拒绝继续。应离线调查并取得新的已审 plan/permission，不自动恢复或重发。

## 证据与重放

每个 slot 将 reservation、**完整原生 `ExecResult` JSON** 和 attempt 投影分文件保存并计算摘要。native output/refusal 先保存，再解析或接纳；未知 usage 投影为 `null`，不是零。完整 native 结果不改写，保留既有四个 cache/token 桶和失败分类。生产 API 已将 provider usage 换算为这些桶。v3 会把缺失的 `prompt_tokens_details.cached_tokens` 标准化为 `cacheReadTokens: 0`，overall usage 仍可能为 reported；这不能证明 provider 实际报告了零或发生 cache miss。未保存各桶的原始字段 presence：这里不归档原始 HTTP body、provider 的额外响应字段，也不提供外部证明的传输次数。诊断沿用生产执行器脱敏；原模型 output/refusal 可能包含敏感文本，因此证据目录和文件权限为 0700/0600。未经复核不能发布。

```sh
node dist-scripts/bench/entity-extraction-capture.js replay \
  --plan /absolute/new-capture-directory --out /absolute/new-replay-report.json
node dist-scripts/bench/entity-extraction-capture.js compare \
  --left /absolute/left-directory --right /absolute/right-directory
```

重放先重新校验 host、source/input、plan、reservation 和 native 证据，再使用当前生产 checker。拒答、截断、过滤及 HTTP 失败不能因文本可解析为 JSON 就变成成功。strict wire 错误保留诊断及原生文本；条目级宿主接纳仍可保留有效 sibling，非法 envelope 则整体失败。无法按 UTF-8 往返的 native 字符串保留精确 native JSON，并在编码可能替换孤立 surrogate 前拒绝。compare 只有在输入、host/checker、executor/model/endpoint/protocol、模式/Schema、配置、重试及预算一致时才允许 prompt 字节对照。它还重放两侧 ledger，拒绝损坏的 native 证据，给出各 slot 的 outcome、native 摘要和宿主接纳 proposal 数；这些数量是检查器诊断。它不证明交错顺序、pair 顺序、语义复核或改进；语义及独立人审仍为 pending，不自动产生 Gold。

本地 fake-fetch/fake-binary 验收通过实际可执行文件及生产 factory，外部/模型请求为零。集成后构建当前 runtime/scripts，再复用既有测试入口：

```sh
yarn build:runtime
yarn test test/executors/openai-api.test.ts test/scripts/entity-extraction-review.test.ts test/architecture/dependency-graph.test.ts test/architecture/production-reachability.test.ts
```

线上 provider 可用性、发送真实输入的授权、配对调度及独立人审仍是后续独立步骤。
