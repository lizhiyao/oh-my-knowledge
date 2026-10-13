# 设计规范索引

规范按领域组织。实体、知识、上下文与知识载体的定义先读 [OMK 如何理解知识](../explanation/knowledge.md)；本索引整理对应契约与设计，不另行定义概念。实际使用动线见[知识提炼指南](../guides/extract-knowledge.md)或[评测快速上手](../quickstart-skill-eval.md)。

## 阅读顺序

1. 先读概念定义，再读 **shared** 的术语与存储边界。
2. 知识建设按 **entities → knowledge** 阅读：识别来源对象、核对候选、组织已保留知识，再维护知识与载体。实体身份负责组织入口，不裁决知识主张的真假。
3. 受控比较按 **evaluation** 阅读：Core → 输入编译 → Runtime → 持久化与 Studio 投影，再读评分与用例设计。
4. **observe** 解释真实工作记录中的观测信号。信号可以帮助准备下一次比较，但不证明知识完整性或因果收益。

## 状态与权威边界

- **现行契约**描述正文明确的已实现边界。历史 RFC 标题或阶段清单可能保留，不代表其中所有旧提案都是现行能力。
- **部分交付的设计**同时包含已批准、已实现章节及未完成的质量或产品目标。实际实现以对应规范和明确限制为准。
- **设计草案**记录拟议模型或算法，收录到这里不代表已实现或验收通过。
- **历史提案**保留已被替代的讨论，当前契约以其链接的现行参考文档为准。

状态标签概括已有正文，不新增实现验收结论。历史输出、分数、冻结指南及测量身份保持原样。现行标注指南修复链接会改变字节摘要；新复核包记录自己的身份，不能沿用旧身份。

## 共享边界 · `shared/`

| 文档 | 职责与状态 |
|---|---|
| [术语规范](shared/terminology-spec.md) | 现行命名约定与维护者决策归档；具体名称仍以实现为准。 |
| [存储布局](shared/storage-layout-spec.md) | 现行项目、本机及显式知识工作区存储摘要；领域格式与恢复边界以实体提取和知识库规范为准。 |

## 实体身份与提取 · `entities/`

| 文档 | 职责与状态 |
|---|---|
| [实体身份](entities/entity-identity.md) | 部分交付的设计：已批准的身份、存储及界面章节按 beta 范围交付；独立复核与整体质量门槛仍未完成。 |
| [实体提取](entities/entity-extraction.md) | 现行提取、修订、来源与绑定契约，同时保留 beta 和质量限制。 |
| [实体提取评测](entities/entity-extraction-evaluation.md) | 标注与验收协议及冻结证据边界；作者自审与离线回放不等于独立验收完成。 |

## 知识建设与维护 · `knowledge/`

| 文档 | 职责与状态 |
|---|---|
| [知识领域模型](knowledge/knowledge-domain-model.md) | 设计草案与案例推演，不作为字段、存储、命令已定稿或产品闭环已完整交付的依据。 |
| [实体知识库](knowledge/knowledge-library.md) | 现行组织与维护契约：显式工作区、人工确认来源关联、精确修订和载体选择。 |

领域模型帮助理解职责与一致性目标，知识库及实体提取规范说明已实现边界。知识正文、来源身份、组织历史及载体版本各自负责不同记录；保留知识是维护决定，不是真实性裁决。

## 受控评测 · `evaluation/`

| 文档 | 职责与状态 |
|---|---|
| [Evaluation Core vNext](evaluation/eval-core-vnext.md) | 已接受的架构 RFC，记录现行 Core 契约及历史迁移依据。 |
| [CLI 输入编译](evaluation/cli-evaluation-input-compilation.md) | 现行 Parse、Resolve、Compile 与宿主装配边界。 |
| [Evaluation Runtime Adapter](evaluation/evaluation-runtime-adapter.md) | 现行生产 binding、资源租约、执行与宿主组合边界。 |
| [产物持久化](evaluation/evaluation-artifact-persistence.md) | 现行产物持久化、catalog 与认证消费边界。 |
| [Studio 投影](evaluation/evaluation-studio-projection.md) | 现行 Core catalog、view-model、渲染与路由边界。 |
| [评分等价性](evaluation/evaluation-scoring-equivalence.md) | 已实施的评分迁移，历史阶段措辞保留为设计依据。 |
| [评分管道](evaluation/scoring.md) | 现行证据图、评分层次与 Decision 边界。 |
| [RAG 指标](evaluation/rag-metrics-spec.md) | RAG 指标定义与评委仪器，结合评分等价性阅读。 |
| [用例设计](evaluation/sample-design-spec.md) | 现行 v3 封套与测量设计指南；完整 Schema 及 adapter 契约以[用例格式](../reference/eval-sample-format.md)为准。 |
| [通用用例提案](evaluation/general-sample-proposal.md) | 历史提案，兼容窗口与迁移工具建议已被当前只支持 v3 的契约替代。 |

## 观测信号 · `observe/`

| 文档 | 职责与状态 |
|---|---|
| [知识缺口信号](observe/knowledge-gap-signal-spec.md) | gap 信号与聚合的 v0.1 设计草案；当前用户动线和限制见[观测指南](../guides/observe-production.md)。 |

## 路径与引用

英文与中文来源目录在 `docs/specs/` 和 `docs/zh/specs/` 下逐项镜像，每篇规范每种语言只维护一份。领域目录用于仓库阅读；文档站通过路由映射保留已有 `/specs/<name>` 和 `/zh/specs/<name>` URL 及锚点。现行仓库链接改为新来源路径；冻结提交或证据包中的路径描述原始快照，保持不变。
