# 知识建设领域模型（设计草案）

状态：待真实案例推演。本文确定讨论用的概念与边界，不表示相关能力已实现；字段、存储格式、命令和迁移方案尚未定案。

## 1. 目标与范围

依据[术语规范](./terminology-spec.md)，知识是能被未来任务复用的事实、案例或方法；每条知识应保留适用范围、来源证据和当前验证状态。

本设计回答：怎样从工作日志中形成可复核、可修订的知识，并把知识落实为可测量的载体改动。成功标准是任一候选都能说明它主张什么、适用于哪里、依据何在、经过什么复核，以及哪些具体改动已有评测证据。

覆盖成功经验、失败暴露的缺口与已有知识的修正。首轮只设计领域模型，不实现自动采集、知识库、检索服务或自动发布；不增加生产评分、实时告警，不改变 Evaluation Core、评分口径、冻结 prompt 或现有持久化契约。真实案例推演是下一阶段，本稿不将假设示例作为验证证据。

## 2. 对象与职责

以下名称是概念标签，不是拟发布的类型、字段或枚举。

| 对象 | 职责 | 关键内容与边界 |
|---|---|---|
| 实体 | 表示知识陈述涉及的事物 | 稳定身份与描述；主体／对象只是陈述中的角色 |
| 证据 | 保留可追溯的来源事实 | 来源身份、原始位置、时间、可见片段及覆盖范围；证据存在不代表提炼出的解释正确 |
| 观测 | 表达从证据中识别的现象 | 现象描述、关联证据、识别方式与不确定性；可以是成功、失败、纠正或冲突，不直接断言根因 |
| 知识条目 | 表达可复用的事实、案例或方法 | 稳定身份、不可变修订、内容、适用范围、支持与反对证据；候选是状态，不另建一种对象 |
| 知识载体 | 承载用于未来任务的知识 | 复用 artifact 概念及现有版本身份；skill、prompt、项目规则等通过现有载体或 runtime context 契约表达 |
| 知识改动 | 将一个或多个知识修订落实到具体载体 | 改动理由、目标载体、基线与候选版本、内容差异、所引用的知识修订及评测关联 |

另有两类关联记录：**复核记录**记录谁在何时依据什么，对哪个知识修订作出了什么判断；**评测关联**引用既有 run／report／Decision，并指明被测改动与实验条件。它们不替代已有观测复核或评测报告。

关系如下：

- 一条观测引用一份或多份证据；同一份证据可被多条观测引用。
- 一个知识修订可以综合多条观测；一条观测也可以支持多条知识。显式提供的规范或要求也可直接作为来源证据，不强制制造问题型 inbox 条目。
- 一次知识改动引用一个或多个明确的知识修订，并作用于一个或多个载体版本。
- 同一知识可以出现在多个载体中；同一载体可以包含多条知识。关联到路径或段落不自动证明其语义完整一致。
- 一次评测可以比较多项改动形成的候选版本；其整体效果不能自动拆分为每条知识的独立贡献。

### 2.1 实体、关系与上下文

实体与知识的定义、表达骨架和角色说明统一见[OMK 如何理解知识](../explanation/knowledge.md)。本设计据此约定：

- `Entity` 提供稳定身份，`subject`／`object` 引用实体，同一身份可跨陈述复用；名称相同不自动构成同一实体。
- 关系可以表达联系、行为或无对象的状态。对象可选，且不等同于被评测对象 artifact。
- 每条陈述独立保留上下文、主张性质与证据。发生时间、适用时间和记录时间分开，防止跨步骤套用条件或从事件直接推出规律、规范与授权。

这只是领域表达方式，不预设图数据库、统一关系本体或自动推理引擎。

## 3. 知识条目的内容与身份

每个修订至少表达以下信息：

| 信息 | 设计要求 |
|---|---|
| 形式与内容 | 事实是有范围的主张；案例包含情境、行动与观测结果；方法包含条件、步骤或判断依据及例外 |
| 适用范围 | 任务类型、项目或主体、环境、版本、时效及已知例外；未知项显式保留未知，不将省略解释为普遍适用 |
| 来源 | 能回到来源记录，区分来源原话、观测事实与提炼解释；保留证据不足、截断或不可用状态 |
| 证据关系 | 区分支持、反对与背景；多次转述同一来源不能计为独立佐证 |
| 修订关系 | 可追溯前一修订，以及替代、拆分、合并的关系与理由 |
| 当前状态 | 根据该修订的复核与争议记录投影；效果评测单独展示，并保留实验范围 |

知识身份不以文件路径、标题或内容 hash 代替。路径变化不应产生新知识；内容相似也不应自动合并不同项目或适用范围的知识。

同一主张的澄清、条件修正和证据补充产生新修订。新修订默认重新等待复核，旧复核只属于原修订。若拆分为不同主张，或将案例抽象为新的通用方法，应建立新条目并保留派生关系。合并条目必须保留来源和旧身份的可追溯关系，不静默删除历史。

未知或冲突的主张可作为候选保留。明确的偏好、要求应记录提出者及作用范围；权威声明、执行事实和模型推断不能混为同一种证据强度。

### 3.1 TypeScript 逻辑结构草案

以下结构用于下一阶段案例推演，不是可直接发布的 API 或持久化 Schema。`KnowledgeItem` 聚合某个明确修订下可直接理解和使用的完整知识视图；历史修订和完整复核记录通过引用关联，底层存储如何拆分留待后续决定。字段不代表现有代码已实现。

```typescript
type NonEmpty<T> = readonly [T, ...T[]];
type Timestamp = string;

interface KnowledgeRevisionRef {
  knowledgeId: string;
  revisionId: string;
}

type KnowledgeActor =
  | { actorKind: 'human'; actorId: string }
  | { actorKind: 'agent'; actorId: string; executionRef: string };

interface KnowledgeItem {
  knowledgeId: string;
  revisionId: string;
  parentRevision?: KnowledgeRevisionRef;

  title: string;
  content: KnowledgeContent;
  entities: NonEmpty<Entity>;
  evidence: NonEmpty<KnowledgeEvidenceLink>;
  observationRefs: readonly string[];
  derivations: readonly KnowledgeDerivation[];
  review: KnowledgeReviewView;

  createdAt: Timestamp;
  createdBy: KnowledgeActor;
  revisedAt: Timestamp;
  revisedBy: KnowledgeActor;
  revisionReason: string;
}

interface Entity {
  entityId: string;
  label: string;
  description: string;
}

interface EntityRef {
  entityId: string;
}

type KnowledgeTime =
  | { timeKind: 'unknown' }
  | { timeKind: 'instant'; at: Timestamp }
  | { timeKind: 'interval'; start: Timestamp | null; end: Timestamp | null };

interface KnowledgeContext {
  scenario: string;
  conditions: readonly string[];
  exceptions: readonly string[];
  unknowns: readonly string[];
  occurredDuring: KnowledgeTime;
  validDuring: KnowledgeTime;
}

interface KnowledgeStatement {
  statementId: string;
  subject: EntityRef;
  relation: string;
  object?: EntityRef;
  modality: 'observed' | 'asserted' | 'generalized' | 'normative'
    | 'capability' | 'permission';
  polarity: 'positive' | 'negative';
  context: KnowledgeContext;
  evidenceRefs: NonEmpty<string>;
}

type KnowledgeContent =
  | { knowledgeKind: 'fact'; statement: KnowledgeStatement }
  | {
      knowledgeKind: 'case';
      situation: string;
      actions: NonEmpty<KnowledgeStatement>;
      observedOutcomes: NonEmpty<KnowledgeStatement>;
    }
  | {
      knowledgeKind: 'method';
      purpose: string;
      instructions: NonEmpty<KnowledgeStatement>;
    };

interface KnowledgeEvidenceLink {
  evidenceRef: string;
  relation: 'supports' | 'opposes' | 'background';
  interpretation: string;
}

interface KnowledgeDerivation {
  relation: 'derived_from' | 'split_from' | 'merged_from' | 'replaces';
  source: KnowledgeRevisionRef;
  reason: string;
}

type KnowledgeReviewVerdict =
  | 'needs_more_context'
  | 'supported'
  | 'unsupported'
  | 'disputed';

interface KnowledgeReviewRecord {
  reviewId: string;
  target: KnowledgeRevisionRef;
  reviewedAt: Timestamp;
  reviewedBy: KnowledgeActor;
  verdict: KnowledgeReviewVerdict;
  rationale: string;
  evidenceRefs: NonEmpty<string>;
  supersedesReviewIds: readonly string[];
}

interface KnowledgeReviewView {
  target: KnowledgeRevisionRef;
  reviewStatus: 'pending' | KnowledgeReviewVerdict;
  reviewRefs: readonly string[];
  unresolvedReasons: readonly string[];
}
```

### 3.2 字段语义与约束

- `KnowledgeItem` 是某条知识在明确修订下的完整视图，包含身份、标题、内容、适用范围、证据关系和当前复核状态。`knowledgeId` 跨修订稳定，`revisionId` 固定本次内容；二者共同标识被引用的修订。本稿不增加可被误当成已接纳版本的 `latest` 指针。读取时必须明确修订或使用后续确定的选择策略。
- 原始日志、全部历史修订和完整复核记录不内嵌到条目中，分别通过证据引用、修订引用和 `reviewRefs` 获取。载体改动及其效果评测通过关联查询获取，不把多次实验压成一个条目级结论。完整视图不要求底层存成一张表或一份重复的文档。
- `entities` 保留本修订所引用实体的描述快照，让完整条目可直接阅读。`subject`／`object` 必须引用该集合中唯一的 `entityId`；同一实体在不同知识中复用身份，不按名称相同自动合并，也不因角色交换创建新实体。无法确认身份时保留独立实体及不确定性，待复核后建立对应关系。
- 实体快照不成为新的全局事实来源。更新实体名称或描述不能回写旧知识修订；改变实体指代、关系或上下文需要新修订。实体与 artifact 的映射仍需明确绑定，不能凭名称推断。
- `knowledgeKind` 区分内容组织形式：事实含一条陈述，案例包含行动及观测结果，方法包含步骤或判断陈述。`situation`／`purpose` 用于阅读说明，不另外引入与结构化陈述冲突的主张。多条独立事实应拆成条目；案例和方法可保留有顺序的多条陈述。
- `KnowledgeStatement` 表达实体之间的关系或行为，`relation` 暂用明确文本；`polarity` 区分肯定与否定。`object` 缺省表示该陈述不需要对象；若行为确有对象但身份未知，应保留一个描述明确的局部实体并在 `unknowns` 中标明，不能把未知误作不存在。
- `modality` 表达主张性质，不表示可信度。`observed` 为观测到的事件，`asserted` 为来源声明，`generalized` 为归纳规律，`normative` 为应当或禁止，`capability` 为能力，`permission` 为授权；否定形式由 `polarity` 表达。「不能」必须区分没有能力与没有许可。案例的行动和结果只用 `observed`，未知结果不编造终态，应描述最后可观测状态并记录缺口。规范仍需保留提出者和权限来源。
- 每条陈述独立持有 `context`，包含场景、条件、例外、未知项及发生／适用时间。空条件仅表示未记录附加条件，不表示普遍适用；未知范围写入 `unknowns`。版本等非日历限制先在条件文本中表达，暂不设计可执行匹配语言。
- `KnowledgeTime` 中 `unknown` 表示未确定或不适用，并在 `unknowns` 中说明；`instant` 表示一个时点；`interval` 采用起点包含、终点不包含的区间，`null` 仅表示明确无界，不代表未知。已知一侧但另一侧未知时先使用 `unknown` 并在上下文保留已知信息。记录时间使用条目的创建／修订字段，不能充当事件发生或知识有效时间。
- `statementId` 在同一修订内唯一；引用陈述必须同时携带知识修订身份。每条陈述的 `evidenceRefs` 是条目证据引用的非空子集，避免把一条陈述的依据自动分配给其它陈述。实体引用一致性、案例的主张性质及时间区间合法性都需要运行时校验。
- `evidenceRef` 是指向既有证据记录或其适配层的逻辑引用，不是任意文件路径。解析后必须保留来源身份、定位信息及覆盖限制；不可用或不完整时显式呈现，不能凭引用存在就判定有据支持。`interpretation` 是作者对证据关系的解释，不覆盖原始记录。
- `evidence` 非空保证候选有来源，但背景证据也允许形成尚待验证的候选，不要求提炼时已有支持结论。`observationRefs` 可为空，以容纳直接来自显式规范或要求的知识。证据去重与独立性依据来源身份，不依据引用数量。
- `parentRevision` 只用于同一条目的前一修订；首个修订无此字段。新主张、拆分、合并和案例抽象通过 `derivations` 关联具体旧修订，保留理由。引用必须可解析且无修订环；并发分叉的接纳策略待案例推演后确定。
- `createdAt`／`createdBy` 记录条目首次创建时间与创建者，跨修订不变；`revisedAt`／`revisedBy` 记录当前修订的时间与作者。首个修订的两组值相同，`revisionReason` 说明本次新建或修订原因。`reviewedBy` 记录复核者；这些身份不等于原始主张的提出者。提出者由来源证据保留，偏好或要求还须在内容与范围中明确主体。Agent 的 `executionRef` 应能关联本次调用的可用模型及运行信息，不能只写一个模型名称充当复核身份。
- 复核记录必须引用目标修订中实际复核的证据，`evidenceRefs` 是该修订证据引用的非空子集。发现新证据时先形成新修订，再复核。`supersedesReviewIds` 仅允许显式更正同一目标修订的旧判断，必须说明理由并保留旧记录；谁有权更正由后续复核权限策略决定。
- `KnowledgeItem.review` 中的 `KnowledgeReviewView` 是派生视图，不是第二份判断事实来源；其 `target` 必须与外层 `knowledgeId`／`revisionId` 一致。新增复核可以更新视图而不改变知识修订，内容、范围和证据关系仍不可原地修改。没有复核时为 `pending`；未解决的相反判断显示为 `disputed`，不能按时间戳覆盖。新修订不继承旧复核；来源缺失、Agent 判断的采信权限等进入 `unresolvedReasons`，不得静默提升为 `supported`。完整投影和权限规则须在实现前确定。
- 被替代、过期或停止推荐属于单独的生命周期记录，本节不把它们混入证据复核状态。效果评测继续经由具体知识改动关联既有报告，不增加 `validated: true` 或永久的条目级收益分数。

这里的 `Timestamp`、字符串 ID 和引用只是逻辑占位。正式 Schema 必须校验时间格式、非空文本、唯一身份、引用归属和上述跨记录约束；TypeScript 类型本身不承担运行时验证。存储布局、Schema 版本、生命周期记录和并发更新协议留待真实案例推演后细化。

## 4. 状态与生命周期

### 4.1 证据复核

复核针对知识的具体修订，而非标题或最新版本。建议的判断包括：待复核、需要更多上下文、有据支持、不支持、存在争议。名称尚非最终枚举。

「有据支持」只表示在所列范围与可见证据内支持这项内容，不是普遍真理认证。出现反证后应重新复核；互相冲突的判断保留为争议，不能按最后写入者静默覆盖。模型提出的解释与人工判断都要记录来源，模型自报置信度不是验证结论。

旧修订保持可追溯，另行标记其被替代或停止推荐的状态。拒绝、过期和被替代的原因不同，不合并成一个「无效」状态。复用记录可以触发复核，但复用次数本身不改变验证结论。

### 4.2 载体改动与效果

知识改动经历提议、复核、形成候选、关联评测和采纳或拒绝；是否已评测、是否已写入、是否已发布分别记录，不能用一条线性状态强迫所有场景先后顺序一致。

效果属于被测的基线与候选版本及其条件：模型、数据集、运行环境和决策设计均由既有评测证据约束。关联必须匹配实际被测版本；修改候选后，旧报告只能解释旧版本，不能自动证明新版本。

展示应区分未评测、已有可用评测证据与证据不能用于当前改动，并保留既有 Decision 的原始含义，不新增另一套通过标准。知识有据支持不代表改动有效；改动有效也不证明其中所有主张都真实。仅有生产观测时不产生改动收益或发布结论。

### 4.3 形成与维护流程

1. 在授权范围内读取日志或接受显式反馈，保留来源及覆盖限制。
2. 识别现象，提炼候选事实、案例或方法，与已有条目对照。
3. 复核内容与适用范围，保留不足和争议，决定修订已有知识还是新建条目。
4. 按需提出载体改动；不是每条知识都必须转成指令或写入 skill。
5. 在需要验证效果时，对具体载体版本做受控评测，按现有治理契约决定接纳和发布。
6. 后续使用暴露新证据或反例时，回到复核与修订，保留历史。

从同一案例提炼知识再用该案例验证，只能说明已覆盖该案例；不能称为独立泛化验证。用于改动选择的案例与用于发布判断的独立验证证据应明确区分。

## 5. 与现有领域契约衔接

| 现有能力 | 衔接方式与待补边界 |
|---|---|
| Trace IR、证据引用与原始记录归档 | 复用来源、时间及关联身份；归档缺失或部分可见必须继续显式呈现，不能因提炼成功而变为完整证据 |
| `ObservationInboxItem` | 目前偏向疑似问题，并绑定 skill 归因；保留其语义。成功经验及尚未归因到载体的知识如何进入候选流程，需要单独设计，不能伪装成失败信号 |
| `ObservationReviewState` | `real_issue` 表示问题复核，不等于知识修订有据支持，也不等于载体改动有效；不能复用该值承担三种判断 |
| Artifact 与 runtime context | 继续使用现有载体分类和身份；知识的事实／案例／方法分类不扩展 `ArtifactKind`。项目规则不能为了关联知识而擅自新增载体种类 |
| Sample 草稿 | 可承接已确认缺口的用例编写；知识条目不自动变成正式用例，更不能自动进入独立验证集 |
| Report、Decision 与治理 | 以引用衔接既有报告和接纳流程，不复制评分、制造新 verdict 或绕过发布授权 |

知识挖掘与提炼属于观测及后续 authoring／治理的协作边界，不能给 `eval-core` 增加日志读取、模型调用或知识存储依赖。具体模块归属待案例推演后决定。

本设计不执行字段改名、旧数据迁移或新 Schema 发布。实施前必须明确存储与版本契约；任何持久化或公开身份变化另行评审，不把旧 observation 静默解释为新知识模型。

## 6. 必须保护的不变量

- 证据、解释、知识主张和效果结论保持可区分，不能相互冒充。
- 复核绑定知识修订；效果关联绑定实际被测版本与条件，不随最新内容漂移。
- 失败后恢复、成功完成、重复出现均不能单独证明知识的因果贡献。
- 保留不同来源身份、冲突和覆盖缺口，不推断隐藏推理。
- 日志读取、证据持久化、发送模型及对外发布遵守各自授权边界；提炼授权不扩大原有数据访问或发布权限。只保留所需证据，来源不可用时显式降级。
- 存储、归档、删除及保留周期的具体策略必须在实现前确定，引用设计不能成为无限保留原始对话的理由。

## 7. 下一阶段：真实案例推演

本稿先提交讨论，随后选择经授权的真实工作片段，依次推演新方法、已有事实修正、可复用案例三个场景。每个场景都要回答：

1. 哪些内容是原始证据，哪些只是解释？是否缺少决定适用范围的上下文？
2. 产出是事实、案例还是方法？应新建条目还是修订已有条目？
3. 复核依据和反证是什么？遇到争议、拆分或过期时能否保留身份与历史？
4. 值得进入哪个载体，还是只保留为案例？是否能提出可审查的具体改动？
5. 现有观测与评测契约能承接多少？有没有被迫伪造状态或混淆来源？
6. 哪些案例用于形成改动，哪些证据能独立验证效果？

推演后再决定最小存储模型、复核权限及冲突解决策略、成功经验入口、载体片段关联方式和首个实现切片。以真实案例暴露的缺口修订本稿，不先扩展为通用知识平台。
