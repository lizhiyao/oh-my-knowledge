# 实体提取：证据与限制

实体组织知识所描述的对象；识别出实体不代表知识主张已被证实。概念定义先读 [OMK 如何理解知识](../../explanation/knowledge.md)。本页把当前阅读入口与历史提取报告分开。

## 先读当前边界

| 问题 | 阅读入口 |
|---|---|
| 实体、知识和载体分别是什么？ | [概念定义](../../explanation/knowledge.md) |
| 如何处理身份、粒度和歧义？ | [实体身份](./entity-identity.md) |
| 已实现什么，支持哪些格式？ | [实体提取](./entity-extraction.md) |
| 如何核对、纠正、保留和复用知识？ | [知识指南](../../guides/extract-knowledge.md) · [实体知识库](../knowledge/knowledge-library.md) |
| 标注、检查与质量验收如何定义？ | [实体提取评测协议](./entity-extraction-evaluation.md) |

当前规范记录了用户确认的 beta 范围，以及 prompt v14 在一个已查看开发窗口上的回归和作者逐项自审。独立复核与整体质量验收仍未完成。结构接纳、已有输出的动线验收和保留知识，与提取准确率、真实性、稳定性及复用收益分别判断，精确限制以当前规范和协议为准。

## 如何阅读历史记录

以下 15 篇报告集中放在 `history/`。其中的表述对应记录时的批次和日期，不代表今天的实现。文件名可能指不同版本轴：v12 两场景补验使用语料 v12、prompt v11，与 prompt v12 定向回归是两份不同证据。

各批次保留各自输入、prompt、语料、标注指南、检查器、运行产物和复核范围。不同测量身份的结果不是进步排行榜，也不构成新旧版本的因果比较。后续标注、人工纠正或界面修复不把旧失败改判为通过。公开合成证据与真实窗口的脱敏汇总也有不同的复现边界。

### 质量基线与重复运行

| 记录 | 证据边界 |
|---|---|
| [v2／v3 对照](./history/entity-extraction-quality.md) | 最初的 12 窗口合成对照，范围有限的作者自审，不是发布质量认证。 |
| [v3 两轮验收](./history/entity-extraction-repeat-quality.md) | 按冻结标准保留重复出现的提及与身份失败。 |
| [v4 两轮结果](./history/entity-extraction-v4-repeat-quality.md) | 输出可接纳，但冻结回归门槛未通过。 |

### 合成场景诊断

| 记录 | 证据边界 |
|---|---|
| [v6 十一窗口诊断](./history/entity-extraction-v6-diagnostic.md) | 广域对象与提及边界，仅覆盖选定诊断范围。 |
| [v7 六场景诊断](./history/entity-extraction-v7-diagnostic.md) | 概念／属性区分、歧义及肯定／否定主张。 |
| [v8 五窗口诊断](./history/entity-extraction-v8-diagnostic.md) | 粒度与选定信息保留，局部检查通过不等于整体质量通过。 |
| [v10 五场景诊断](./history/entity-extraction-v10-diagnostic.md) | 知识保留与提及边界，严格回归仍未通过。 |
| [v11 边界诊断](./history/entity-extraction-v11-boundary-diagnostic.md) | 因标注覆盖问题在首例后停止，后两例未调用。 |
| [语料 v12 两场景补验](./history/entity-extraction-v12-followup-diagnostic.md) | prompt 保持 v11，选定检查与知识自审不构成整体质量认证。 |

### 真实窗口与应用动线

| 记录 | 证据边界 |
|---|---|
| [v6 真实会话诊断](./history/entity-extraction-v6-real-pilot.md) | 七窗口，结构接纳不消除语义失败。 |
| [v8 已有输出动线](./history/entity-extraction-v8-workflow.md) | 存储、检索、来源追溯、纠正及知识绑定，新增模型调用为零。 |
| [v8 真实会话诊断](./history/entity-extraction-v8-real-pilot.md) | 三窗口，找到预期对象不等于总体召回率。 |
| [v11 两窗口真实回归](./history/entity-extraction-v11-real-regression.md) | 知识目标与实体／来源绑定错误分别核对。 |
| [prompt v12 定向回归](./history/entity-extraction-v12-target-regression.md) | 真实窗口提及遗漏后停止，合成对照未执行。 |

### 标注覆盖审核

| 记录 | 证据边界 |
|---|---|
| [完整名称覆盖审核](./history/entity-name-annotation-coverage.md) | 基于来源修订语料 v12 标注，模型调用为零，不形成新的提取质量分数。 |

## 来源与复现

各报告链接原始证据包、冻结身份、复核范围及不可公开材料。引用结果时保留这些记录；真实来源正文与完整输出可能只留本地。[知识指南](../../guides/extract-knowledge.md#复现提取质量检查)说明历史 v3 工具的边界，当前检查以实体提取评测协议为准。

英文与中文报告逐项镜像。仓库引用采用整理后的来源路径，文档站保留原有 `/explanation/entity-…` 报告 URL 和锚点。移动报告不改变测量结果；现行标注指南修复引用会改变字节摘要，新复核包因此保留自己的测量身份，冻结指南与公开证据保持原样。
