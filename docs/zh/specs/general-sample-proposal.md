# 通用 sample 规范草案（#842）

> 历史研究记录（#842／#863）。后续实施已采用 v3-only：不读取 v2、不提供迁移工具，不改写用户旧文件或报告。本文的迁移工具与兼容窗口建议已被该决定取代。当前可用契约和实际支持范围以[样本格式](../reference/eval-sample-format.md)为准。

当前生产链路验收：`yarn vitest run test/eval-workflows/sample-v3-production.test.ts`。旧原型已由该验收替代，不在当前测试树重复保留。

状态：设计评审草案，包含离线可行性证据；尚未批准公共契约实现。本文不发布新的 sample Schema，不改变 `omk.eval-sample-set/v2`、prompt 字节、评分或持久化身份。关联：[需求 #842](https://github.com/lizhiyao/oh-my-knowledge/issues/842)。

## 1. 研究依据与设计取舍

研究日期：2026-09-13。以下来自官方文档和一手工程经验；它们体现共同设计原则，不意味着存在统一的行业 sample 标准。

| 来源 | 可借鉴的实践 | OMK 的取舍 |
| --- | --- | --- |
| [LangSmith evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts) | 应用输入和评估用参考输出分离，实验关联数据集、输出与轨迹 | 沿用 Core 的输入／预期／评测依据边界，不能把整个 sample 传给执行器 |
| [Inspect datasets](https://inspect.aisi.org.uk/datasets.html) | 文本或消息输入，与 target、sandbox、files、setup 分离；支持数据映射 | 用户输入与环境资源分别声明；环境描述不等于实际物化，不引入任意 setup 脚本入口 |
| [Ragas evaluation schema](https://docs.ragas.io/en/latest/references/evaluation_schema/) | 区分实际检索上下文和参考上下文、ID；多轮样例保留消息及参考工具调用 | 检索结果属于执行证据，相关性标注属于预期；不能把二者合并成一个 context |
| [Anthropic agent evaluation practice](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 区分轨迹与环境中的实际结果，组合多类评分方式 | “已完成”的回复不能证明数据库或工作流状态已改变；优先检查实际状态证据 |
| [LangSmith trajectory evaluation](https://docs.langchain.com/langsmith/trajectory-evals) | 针对轨迹独立评估 | 最终结果和路径约束独立计分；仅在业务要求时约束严格工具顺序 |
| [Promptfoo test cases](https://www.promptfoo.dev/docs/configuration/test-cases/) | 输入变量与断言分别配置，数据集不绑定单个提示模板 | 支持结构化入参，渲染由显式、版本化的 adapter 负责 |

不采用按 prompt、RAG、agent、workflow 分裂的四套 sample 协议。也不以一个无约束 JSON 袋子替代用户契约：公共封套保持稳定，输入和证据的解释依赖已注册且有版本的能力描述。多轮历史、可交互会话、内部多步执行是不同能力，不能因出现 messages 字段就视为等价。

## 2. 当前代码事实

基线：`03eb64d1954a510b3931434ed232d79f4421ea2d`。

- `src/eval-workflows/inputs/contracts/sample.ts` 的 v2 用户 Sample 要求字符串 `prompt`；`context` 是字符串，`environment` 明确为 prompt-only 题设，不物化文件。
- `src/eval-workflows/orchestration/measurement-design.ts` 的 `renderedPrompt` 将 context 放入代码围栏，并拼接环境段；生成的 Core sample.input 是字符串。任意调整拼接格式都会改变被测输入。
- `src/eval-core/contracts/definition.ts` 的 `EvaluationSampleSchema` 已提供 JSON `input`、`executionContext`、`expected`、`evaluationContext`，以及独立分析和注释信息。
- `src/eval-workflows/hosts/adapters/custom/executor.ts` 的执行请求只含 input、executionContext 和执行控制等必要内容，不含 expected／evaluationContext；其输出和 trace 均可为 JSON。该 adapter 只声明 invoke 协议，不能据此声称支持交互 session。
- `test/eval-core/conformance/targets.test.ts` 覆盖 prepare → execute → evaluate → analyze → decide → report，并检查执行上下文不含金标。它是合约测试，不等于真实 prompt、检索、会话或工作流能力验收。

基线命令：`yarn vitest run test/eval-core/conformance/targets.test.ts test/eval-workflows/hosts/adapters/custom/executor.test.ts test/eval-workflows/input-compilation/compile.test.ts`。2026-09-13 在独立工作树运行，3 个文件、68 项通过。没有调用模型。代表场景证据见下一节。

## 3. 代表场景与支持矩阵

| 场景 | 输入与执行环境 | 预期与评测依据 | 必须验证的缺口 |
| --- | --- | --- | --- |
| prompt：工单分类 | JSON 工单标题、正文、允许的类别；固定离线分类规则 | 正确类别，独立评分 | v2 字符串渲染、结构化类型保真、参考答案不泄露 |
| RAG：政策查询 | 问题、固定离线语料快照、检索参数 | 相关文档 ID／相关性等级、回答引用依据 | 实际排名、引用与参考标注分离，缺失检索证据不能当成零分或成功 |
| agent：两轮澄清后查库存 | 带角色和关联 ID 的消息历史、隔离库存 fixture | 正确查询参数和答复，必要的工具约束 | 历史重放与交互用户模拟区分；工具结果必须对应真实离线调用 |
| workflow：订单校验与审批 | 订单 JSON、初始状态、确定性节点图 | 最终状态和必要节点后置条件 | 真实状态转换、拒绝路径、终态与“完成”文本不一致的负例 |

第一轮原型已通过 [historical probe at d7088ca7](https://github.com/lizhiyao/oh-my-knowledge/blob/d7088ca73574ee18ef85e71250d77d93b231646a/test/eval-workflows/general-sample-proposal.test.ts)（8 项）；`yarn typecheck` 对应的 `tsc --noEmit` 通过。原型复用真实 Core 生命周期和评分／报告校验，离线逻辑实际分类、排序语料、读取库存文件、落盘状态转换，且对故意损坏的结果判失败。每次试验使用独立临时目录并清理，执行上下文未含金标或评测专用标记。

这仅证明通过测试内离线 adapter 的可行性：不证明 v2 能加载新封套，不证明原生模型消息转换、不证明交互式多轮或生产 workflow 接入。原型评分使用固定 fixture 的结构化结果精确匹配，不把它称为通用 RAG 指标或 agent 质量评分。另验证了负金额拒绝、大额转人工、缺失输出保持非完整／非结论状态，以及真实 v2 加载器拒绝新封套。最终矩阵分别列用户入口、执行器、评分器、证据和报告，不允许以任一层支持推出全链路支持。

## 4. 建议封套与边界

以下是待批准的设计方向，字段和版本号尚未成为可加载格式。

| 概念 | Core 映射 | 允许的消费者 |
| --- | --- | --- |
| 稳定 sample ID | sampleId | 身份、执行、评分和报告 |
| 任务输入 | input | 指定执行器／输入 adapter |
| 运行条件和资源引用 | executionContext／既有资源租约 | 执行器；资源由宿主隔离物化 |
| 可判定的预期结果 | expected | 显式绑定的评分器 |
| 仅用于评测的依据、rubric 和标注版本 | evaluationContext | 显式绑定的评分器 |
| 来源、难度、覆盖锚点等 | annotations／analysis | 诊断或分析，默认不进入执行与评分 |

输入应区分文本、结构化任务、消息历史，使用限定名 `inputKind`。应用专属结构使用显式 schema identity；消息关联、角色、内容类型不能只靠字符串约定。用户封套不重复 Core 的执行控制和资源协议，不复制重试、缓存、隔离或评分编排。

预期只声明结果和约束，不声明固定评分结论。结果、轨迹、外部状态快照由执行层产生，并标明来源和完整性。评分器缺少所需证据时应输出缺失／不支持状态，不能把缺失证据解释成成功。多轮实时驱动、用户模拟器和第三方检索服务不是本轮自动实现的能力。

## 5. 迁移和测量可比性

1. 下一版封套必须使用新的 Schema identity；v2 文件保持原始字节，不在读取或运行时静默升级。
2. 迁移工具先给出可审查的映射预览和阻塞项，再在新文件写入用户确认的结果。具体兼容／替换窗口在实施前确认。
3. v2 prompt、context 和 environment 的迁移首先冻结旧编译后的精确输入字节。把 context 重解释成检索 gold、把环境题设变成实际 fixture 均是语义改变，禁止自动推断。
4. assertions／rubric 的内容、权重、实现身份与绑定保持可追溯；`covers` 不是节点执行预期，不能迁移成工作流断言。
5. 记录旧文件摘要、新文件摘要、映射器版本、执行输入摘要和评分绑定摘要。不要假定用户文件改名不影响下游 identity／cache；根据 Core 实际摘要覆盖范围逐项验证。
6. 仅当执行输入、环境资源、运行时、评分和采样设计等价且证据充分时，才允许讨论桥接可比性。消息角色、排序、检索语料或节点状态语义改变时建立新比较系列；不能将旧分数直接与新分数拼接。

## 6. 输入与证据的最小契约

建议版本为 `omk.eval-sample-set/v3`（尚未发布）。保留 dataset 级依赖要求，sample 使用 `sampleId`、`input`、可选 `executionContext`、`expected`、`evaluationContext`、`annotations`。样例中的 application payload 不按被测对象另建封套。

| inputKind | 必填内容 | 编译／能力要求 |
| --- | --- | --- |
| text | `text: string` | 原样文本；不得隐式 trim 或拼接参考答案 |
| json | `value: JsonValue`、应用输入 `schema` identity | 根据注册的输入 schema 验证，JSON 数值／布尔／null 保真；转文本必须记录 renderer identity |
| messages | `messages`、`interactionMode: history` | 消息顺序和角色保真；必须有显式历史输入 adapter，不能把 JSON.stringify 后的文本称为原生消息支持 |

`schema` 复用 Core 的 schemaVersion／schemaUri／schemaDigest identity，不另发明命名机制。Core input 保留完整封套还是由 adapter 投影为 value，必须由输入 adapter 版本明确规定并计入 identity；禁止同一个版本随机采用两种行为。

消息的最小字段为 `messageId`、`role`、`content`。role 限定为 system／user／assistant／tool；普通内容首版仅文本。工具请求需 `toolCallId`、工具名及 JSON arguments；tool 结果必须引用先前尚未完成的调用，同一 ID 不能重复消费。缺少引用、未知角色、错误顺序均在执行前拒绝。当前原型只验证文本历史重放，不证明这些未来校验已经实现。实时交互需单独的 session adapter／模拟器 identity、停止条件、轮数和取消契约；不能自动从历史模式升级。

RAG 的 `expected.retrieval` 最小包含 `corpusDigest`、文档 ID、非负相关性 grade；评测 context 固定 k、相关性阈值、排名平局／去重／空 gold 策略和指标实现版本。实际检索证据须给出有序文档 ID、语料身份和可引用片段；引用标注包含回答 span 与来源 ID／span。检索、引用正确性和答案质量独立计量。当前原型验证固定语料的排名和引用精确匹配；分级 nDCG、语义事实性和引用 span 评分尚未提供本轮新支持声明。

workflow 的 executionContext 指定初始状态和隔离资源；expected 指定最终状态及节点后置条件。实际证据包含节点 ID、开始／结束状态、失败码和状态快照摘要。必要先后关系采用约束，默认不要求与参考轨迹逐字一致。相同最终状态未必意味着节点约束通过；反之合法的替代路径不应仅因顺序不同被拒。节点状态必须来自执行，`covers` 只用于覆盖说明。原型验证批准、拒绝、转人工的文件状态，并以状态结果评分。

所有未来输入 adapter 都必须拒绝不支持的 inputKind／interactionMode，不允许静默转成通用字符串。错误应定位 sampleId 和字段路径。校验通过只说明表达合法，能力协商和证据消费验证仍独立执行。

## 7. 已验证支持及明确限制

“原生”表示该层已有直接契约；“适配”表示本轮测试内离线 adapter 已实际运行；“未支持／未验证”不作为完成能力宣传。

| 能力 | v2 用户入口 | Core／离线执行 | 评分与报告证据 |
| --- | --- | --- | --- |
| 文本 prompt | 原生字符串 | Core input 原生；既有编译测试通过 | 既有 conformance 链路通过 |
| JSON 工单分类 | 新结构化封套被真实 loader 拒绝；须显式编码为文本 | JSON 原生承载，离线规则分类适配 | 独立 expected 精确评分；正负结果进入验证后的报告 |
| RAG 排名与引用 | 无分级相关性／引用结构化字段；context 只是文本 | 固定语料检索适配，输出来自实际排序 | 精确排名／引用 fixture 评分可用；不是语义 RAG 指标结论 |
| 消息历史与库存查询 | 无原生消息输入字段 | 历史解释＋文件工具适配 | 实际查询参数／结果评分；并非在线多轮模拟 |
| workflow 状态 | 无节点状态期望字段；covers 非断言 | 本地文件状态转换适配 | 批准、拒绝、转人工及损坏结果评分；缺失输出不产生完整结论 |
| 金标隔离 | assertions／rubric 沿既有编译路径 | 4 类执行上下文均无 expected／evaluationContext 和金标标记 | expected 仅供评分绑定；custom-executor 请求边界另有基线测试 |
| 交互 session、多模态、生产数据库 | 不据此宣称支持 | 本轮未验证 | 需要各自适配器和真实证据，不能由 JSON Schema 推断 |

复现：[historical probe at d7088ca7](https://github.com/lizhiyao/oh-my-knowledge/blob/d7088ca73574ee18ef85e71250d77d93b231646a/test/eval-workflows/general-sample-proposal.test.ts)。四类最小样本和执行逻辑位于同一测试文件，直接可读和可运行；使用现有 Core sample，而非未发布 v3 文件。所有执行为本机离线、每 trial 隔离目录，无网络、凭证或模型。结果经真实 Core 分析与报告 materialization；有完整证据的结果再次序列化验证。测试内 runtime identity 和分析策略为 conformance fixture，不是已注册生产测量工具；不得使用 fixture 的 verdict 宣称模型改进或发布资格。

## 8. 迁移示例与实施决策

旧 v2：`prompt: "Q"`、`context: "C"`、无 environment。现有编译得到的精确字符串是 `Q\n\n` 后接三个反引号、换行、`C`、换行和三个反引号。v3 迁移预览应建议 text 模式，text 保存这段**实际编译字符串**，而不是把 context 猜成 gold。真实 JSON 示例：

```json
{
  "sampleId": "s1",
  "input": { "inputKind": "text", "text": "Q\n\n```\nC\n```" }
}
```

这是 sample 草图，不是已可运行的 v3 文档。迁移还要独立转换已有 rubric／assertions 及其绑定，不能因简例省略就丢弃评分。`environment.files_available` 迁为实际可读文件、字符串 prompt 拆成角色消息、增补检索 gold 等情况，预览必须标出语义变化并要求用户选择，不能宣称无损。

建议分两次评审：先确认本草案的共同封套、显式 adapter 和保守迁移方向；随后以单独实施 PR 发布 v3 loader、输入 adapter、能力门禁、迁移工具和真实用户入口验收。旧报告继续按其原 Schema 读取，旧缓存不冒用新 identity；v2 写入入口退役时机和支持窗口在实施 PR 明确确认。本轮只提交设计与验证，不写迁移工具、不改公共契约、不发布新版本。
