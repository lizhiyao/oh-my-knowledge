# 实体提取：证据与限制

实体组织知识所描述的对象；识别出实体不代表知识主张已被证实。概念定义先读 [OMK 如何理解知识](../../explanation/knowledge.md)。本页汇总现行规范及其能力限制。

## 先读当前边界

| 问题 | 阅读入口 |
|---|---|
| 实体、知识和载体分别是什么？ | [概念定义](../../explanation/knowledge.md) |
| 提取如何变成可维护知识与载体证据？ | [端到端设计与行业决策](../knowledge/knowledge-domain-model.md) |
| 如何处理身份、粒度和歧义？ | [实体身份](./entity-identity.md) |
| 已实现什么，支持哪些格式？ | [实体提取](./entity-extraction.md) |
| 如何核对、纠正、保留和复用知识？ | [知识指南](../../guides/knowledge/extract-knowledge.md) · [实体知识库](../knowledge/knowledge-library.md) |
| 跨窗口提案、人工决定和恢复如何连接？ | [实体复核日志](./entity-links.md) |
| 标注、检查与参考标注准备度如何定义？ | [实体提取评测协议](./entity-extraction-evaluation.md) |
| 生成输出如何逐项语义复核并保守裁决？ | [输出语义复核](./entity-extraction-semantic-review.md) |
| 真实来源研究如何冻结、执行并依据生产证据比较？ | [真实提取研究](./entity-extraction-study.md) |
| 实体关联三判别如何评测与复核？ | [实体关联评测协议](./entity-link-evaluation.md) |
| 原始真实 v14 输出能否不发新请求地回放？ | [历史外部基线](./entity-extraction-real-v14-baseline.md) |

评测协议维护被测质量范围与复核状态。结构接纳、已有输出的动线验收、人工组织决定和保留知识，与提取准确率、真实性、稳定性及复用收益分别判断。
