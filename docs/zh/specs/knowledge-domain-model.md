# 知识建设领域模型（设计草案）

状态：已完成 [CR 反馈](#cr-case)、[事实修正](#fact-correction)与[成功经验](#successful-experience)的文档级推演，实现边界仍待验证。本文确定讨论用的概念与边界，不表示相关能力已实现；字段、存储格式、命令和迁移方案尚未定案。

## 1. 目标与范围

依据[术语规范](./terminology-spec.md)，知识是能被未来任务复用的事实、案例或方法；每条知识应保留适用范围、来源证据和当前验证状态。

本设计回答：怎样从工作日志中形成可复核、可修订的知识，并把知识落实为可测量的载体改动。成功标准是任一候选都能说明它主张什么、适用于哪里、依据何在、经过什么复核，以及哪些具体改动已有评测证据。

覆盖成功经验、失败暴露的缺口与已有知识的修正。首轮只设计领域模型，不实现自动采集、知识库、检索服务或自动发布；不增加生产评分、实时告警，不改变 Evaluation Core、评分口径、冻结 prompt 或现有持久化契约。真实案例推演进度见 §7；假设示例不作为验证证据。

### 1.1 设计依据与决策层次

[OMK 如何理解知识](../explanation/knowledge.md) 是概念定义的唯一来源；本文负责把它落实为领域职责、数据结构和一致性约束。发生冲突时先修正本设计，不能让字段反过来改写定义。

| 层次 | 本稿确定什么 | 如何演进 |
|---|---|---|
| 概念约束 | 实体与角色分离；陈述携带上下文；知识可关联多个实体；知识与载体分离；观测供证，评测检验载体改动 | 修改须先讨论并更新概念定义 |
| 领域决策 | 知识身份与修订分离；陈述集合与内容组织分离；证据定位陈述；复核和效果分别关联明确版本 | 以案例检验；调整时说明语义和历史影响 |
| 工作设计 | 字段命名、枚举、案例组织形式、时间边界类型和状态投影 | 可以改进，不视为已发布契约 |
| 实现选择 | 数据库、索引、接口、采集调度和 Schema 版本 | 首个实现切片确定，不由本稿提前锁定 |

本轮仅完善设计文档，风险集中在概念误表达和未来契约歧义，不修改运行时代码、公开 Schema 或测量行为。长期稳定性的目标是保留语义和可追溯性，允许存储、提炼策略和载体形式独立演进。

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

### 2.2 聚合边界与依赖方向

`KnowledgeItem` 是完整读取视图；写入一致性边界是单个知识修订，不是实体、日志、所有复核和评测报告组成的巨型事务。职责与引用方向如下：

| 边界 | 拥有的数据与决策 | 通过引用协作 |
|---|---|---|
| 证据与观测 | 来源快照、覆盖限制、观测现象 | 不依赖知识条目才能保存来源；知识引用其稳定身份 |
| 知识内容 | 修订、陈述、上下文、实体描述快照和证据关联 | 引用来源与派生修订；不执行模型调用或日志读取 |
| 实体身份 | 身份分配及有据可查的身份对应 | 不拥有知识内容；按实体发现知识依靠可重建索引 |
| 复核与生命周期 | 复核记录、采信策略、推荐或停用决定 | 引用不可变修订，不回写历史内容 |
| 载体改动与评测关联 | 引用哪些知识、如何改变哪个版本、实验与采纳记录 | 复用 Artifact、Report、Decision，不反向改变知识真伪 |

这些是逻辑职责，不要求分别建服务、包或数据库。纯校验与确定性投影不依赖宿主；来源读取、提炼模型调用和持久化通过 adapter 协作，不能加入 `eval-core`。读视图需暴露引用不可解析或投影不完整的状态，不把暂时缺失解释成不存在。

### 2.3 载体关联契约

一个知识修订可以落实到多个载体，一个载体版本也可以承载多条知识。知识改动至少应能解析出：明确的知识修订集合、目标 artifact 身份、基线与候选版本、差异及改动理由。段落位置是定位辅助，不能代替内容版本身份；版本变化后须重新确认关联。

评测关联引用既有报告及其实际被测的整组版本与实验条件，不给每条关联知识分摊整体收益。部分写入、多载体改动失败、尚未评测、已采纳但未发布分别保留状态。首次实现前应明确这些关联的引用类型和失败恢复规则；本稿不另造 Artifact 或 Report 的平行 Schema。

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

以下结构用于案例推演，不是可直接发布的 API 或持久化 Schema。`KnowledgeItem` 聚合某个明确修订下可直接理解和使用的完整知识视图；历史修订和完整复核记录通过引用关联，底层存储如何拆分留待后续决定。字段不代表现有代码已实现。

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

type KnowledgeTimeBound =
  | { boundKind: 'known'; at: Timestamp }
  | { boundKind: 'unbounded' }
  | { boundKind: 'unknown'; reason: string };

type KnowledgeTime =
  | { timeKind: 'unknown'; reason: string }
  | { timeKind: 'not_applicable'; reason: string }
  | { timeKind: 'instant'; at: Timestamp }
  | {
      timeKind: 'interval';
      start: KnowledgeTimeBound;
      end: KnowledgeTimeBound;
    };

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
  modality: 'descriptive' | 'normative' | 'capability' | 'permission';
  polarity: 'positive' | 'negative';
  context: KnowledgeContext;
}

interface KnowledgeContent {
  statements: NonEmpty<KnowledgeStatement>;
  organization: KnowledgeOrganization;
}

type KnowledgeOrganization =
  | { knowledgeKind: 'fact' }
  | {
      knowledgeKind: 'case';
      situation: string;
      actionStatementIds: readonly string[];
      outcomeStatementIds: readonly string[];
      gaps: readonly string[];
    }
  | {
      knowledgeKind: 'method';
      purpose: string;
      instructionStatementIds: NonEmpty<string>;
    };

interface KnowledgeEvidenceLink {
  evidenceLinkId: string;
  evidenceRef: string;
  statementIds: NonEmpty<string>;
  relation: 'supports' | 'opposes' | 'background';
  basis: 'direct_observation' | 'source_assertion' | 'inference';
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
  statementIds: NonEmpty<string>;
  reviewedAt: Timestamp;
  reviewedBy: KnowledgeActor;
  verdict: KnowledgeReviewVerdict;
  rationale: string;
  evidenceLinkIds: NonEmpty<string>;
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

#### 内容、组织与适用范围

- `KnowledgeItem` 是明确修订下的完整知识视图。`content.statements` 是内容的唯一陈述集合，`organization` 说明如何阅读和复用这些陈述；不在案例、方法或证据中重复维护另一份陈述。事实可以由一条或多条紧密相关的陈述构成；按能否共同复用和独立维护决定条目边界，不按句子数量拆分。
- `statementId` 在修订内唯一。案例的行动、结果与方法的步骤引用本修订的 `statementId`。引用必须存在、组内不重复；数组表示叙述或步骤顺序，不自动表示因果、精确发生顺序或可执行控制流。未列入这些角色的陈述可补充背景或判断依据。`situation`／`purpose` 是阅读摘要；影响结论的内容必须进入陈述与上下文。
- 案例至少包含一条行动或结果陈述；缺少行动记录、结果尚未出现或来源不可见时，在 `gaps` 中说明，不能为了满足类型编造陈述。案例可以依据日志，也可以依据参与者的事后报告，二者由证据关系区分。推测的后果不能标作案例的已发生结果；由案例归纳出的通用方法另建条目并保留派生关系。
- 方法至少有一条指令或判断陈述，允许包含解释其依据的描述性陈述。事实可以描述状态、关系、能力或许可；案例的行动／结果使用 `descriptive`；「用户提出某项要求」是描述性事实，要求本身则是规范性内容，可作为方法的指令或判断依据。事实、案例、方法是复用组织方式，不是可信度等级，也不增加 `ArtifactKind`。
- `KnowledgeStatement` 表达状态、关系或行为。`relation` 暂用明确文本，例如「处于维护中」「依赖」「执行」；无对象的状态不必制造对象实体。`object` 缺省表示不需要对象；对象存在但身份未知时保留局部实体，并在 `unknowns` 标明身份缺口。数值、单位等状态细节暂保留在明确文本中，不强迫所有值成为实体，也不承诺结构化数值查询。
- `modality` 区分描述、规范、能力与许可，`polarity` 表达肯定或否定。「不能」必须区分没有能力与没有许可。这组枚举是工作设计，后续案例可以修订；它不混入来源方式或可信度。观测、转述、推断属于证据关系的 `basis`，同一陈述可以同时拥有不同方式取得的证据。
- 每条陈述持有自己的 `context`，适用范围由其中的时间、场景、条件及例外表达，不再维护条目级第二份范围。空条件仅表示未记录附加条件，不代表普遍适用；未知范围进入 `unknowns`。版本、环境等先用条件文本表达，不预设可执行匹配语言。多步骤方法的共同前提必须在相关步骤上下文中明确；未来如提取共享上下文，应定义展开规则并保持展开后的语义不变。
- 发生时间 `occurredDuring`、适用时间 `validDuring` 和条目记录时间分别建模。未知与不适用有不同类型并附原因；时间区间为起点包含、终点不包含，已知边界需满足起点早于终点。单侧未知不丢弃另一侧已知信息；无界必须明确声明。日期精度、时区和自然语言时间的转换规则须在正式 Schema 中确定，不能把模糊时间伪造为精确时点。

#### 实体与身份

- `entities` 是本修订所引用实体的描述快照。主体与对象使用同一 `EntityRef`，每个引用必须在集合中唯一解析；角色交换不创建新实体，同一实体可跨知识条目复用身份。实体索引必须从全部陈述的主体及对象构建，支持从任一参与实体发现知识；它是可重建读模型，不是另一份事实来源。
- 实体身份应在明确的身份命名空间内唯一，不能按名称、路径或相似描述自动合并。尚不能确认同一身份的实体保留独立 ID 与不确定性。未来的合并／别名裁决需要来源和历史记录；撤销裁决不能损坏旧修订。实体名称和描述只是识别提示，实质性知识应作为陈述保留。
- 实体身份与载体版本身份不同。一个 skill 可以同时是被描述的实体和承载其它知识的载体；二者显式映射，不能因名称相同推断绑定。名称更新不能回写旧快照，改变陈述指代或上下文必须创建知识修订。

#### 证据与复核

- `evidence` 中每条关联都有本修订内唯一的 `evidenceLinkId`，明确指向一份来源及一组陈述。相同来源对不同陈述可以分别支持、反对或提供背景；关系不同必须分开记录。`basis` 描述本次解释如何使用来源，不代表来源可靠性，也不是证据记录本身的永久属性。`interpretation` 不能覆盖原文。
- `evidenceRef` 是既有证据记录或适配层的逻辑引用；解析结果须保留来源身份、版本或快照标识、原始位置、提出者及覆盖限制。来源变更不能静默改变旧修订的证据含义。来源不可用时保留逻辑引用和不可用原因，不承诺无限保留原始日志。
- 每条陈述至少有一条证据关联；只有背景来源的推断也可以成为待复核候选，不能因此显示为有据支持。尚无任何可引用来源的想法留在提炼工作区，不伪造证据塞入条目。`observationRefs` 可以为空，显式规范或用户要求可直接提供来源。重复转述不构成独立佐证，去重按原始来源身份进行。
- 复核记录必须绑定具体修订及实际检查的陈述集合。所引用的证据关联必须属于该修订、覆盖被检查陈述，且至少为每条被检查陈述提供一条关联。结论适用于列出的全部陈述；结论不同时拆开记录。审查者应处理该范围内已知反证，并说明未采用证据的理由，不能只选择支持来源。
- `KnowledgeReviewView` 是复核记录的派生汇总，其目标必须与外层修订一致。局部复核不能提升整个条目：没有复核为 `pending`，部分覆盖且其余尚无判断时为 `needs_more_context`；只有全部陈述均获有权限采信的支持、且无未解决反证与覆盖缺口，才允许汇总为 `supported`。冲突判为 `disputed`，其余不足或不支持的原因必须可追溯到具体陈述。状态只是摘要，消费方仍需读取明细。
- 新修订默认重新等待复核。`supersedesReviewIds` 只更正同一修订、同一陈述集合的旧判断，必须解释原因并保留历史；不能按最后时间戳静默覆盖。复核者身份不等于来源提出者，Agent 复核还需可解析的执行身份。首版权限、状态组合优先级与投影规则见 §9.2，不由数据库写入顺序决定。

#### 修订与完整视图

- `knowledgeId` 稳定标识共同维护和复用的知识单元，`revisionId` 固定其内容、实体快照、上下文及证据关联；二者不以标题、路径或内容 hash 替代。外部引用陈述时还必须携带知识修订身份。陈述 ID 可在语义连续的修订间保留，但不能据此继承旧复核。
- `parentRevision` 只指同一条目的前一修订。条件修正或新增证据形成新修订；独立结论、拆分、合并和由案例提炼方法通过 `derivations` 关联其它条目的具体修订。前驱及派生图不得成环；派生不等于证据支持或效果证明，替代关系也不自动停用旧条目。来源版本变化时，应区分修正旧内容错误与更新当前适用版本；新版本的不同描述不自动反驳旧范围内成立的事实。
- `createdAt`／`createdBy` 跨修订不变，`revisedAt`／`revisedBy` 记录当前修订，首个修订两组值相同；`revisionReason` 说明变化。完整日志、历史修订、复核记录、载体改动及评测报告通过引用获取，完整视图不要求把全部历史装入一个对象。
- 新复核可以更新派生视图，不修改知识内容修订。被替代、过期、停止推荐属于独立生命周期记录；已有证据支持与当前是否推荐复用是不同判断。效果仍经具体载体改动关联报告，不增加永久的 `validated: true` 或条目收益分数。

字符串 ID 与 `Timestamp` 是逻辑占位；正式 Schema 应校验非空文本、身份唯一、引用归属、时间合法性及跨记录约束。TypeScript 不提供运行时校验，本文也不指定数据库、序列化格式或通用查询语言。

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

知识挖掘与提炼属于观测及后续 authoring／治理的协作边界，不能给 `eval-core` 增加日志读取、模型调用或知识存储依赖。具体模块归属与依赖方向见 §10。

本设计不执行字段改名、旧数据迁移或新 Schema 发布。实施前必须明确存储与版本契约；任何持久化或公开身份变化另行评审，不把旧 observation 静默解释为新知识模型。

## 6. 必须保护的不变量

- 证据、解释、知识主张和效果结论保持可区分，不能相互冒充。
- 复核绑定知识修订；效果关联绑定实际被测版本与条件，不随最新内容漂移。
- 失败后恢复、成功完成、重复出现均不能单独证明知识的因果贡献。
- 保留不同来源身份、冲突和覆盖缺口，不推断隐藏推理。
- 日志读取、证据持久化、发送模型及对外发布遵守各自授权边界；提炼授权不扩大原有数据访问或发布权限。只保留所需证据，来源不可用时显式降级。
- 存储、归档、删除及保留周期的具体策略必须在实现前确定，引用设计不能成为无限保留原始对话的理由。

## 7. 真实案例推演与待决事项

[首例 CR 流程反馈推演](#cr-case)已填写案例与方法候选，确认来源不足时无需伪造结果或效果结论，尚未要求新增字段。[事实修正推演](#fact-correction)进一步检查版本范围与局部复核；[成功经验推演](#successful-experience)检查单次成功与方法提炼的区别。这些推演验证文档表达，未替代运行时验证。每个场景都要回答：

1. 哪些内容是原始证据，哪些只是解释？是否缺少决定适用范围的上下文？
2. 产出是事实、案例还是方法？应新建条目还是修订已有条目？
3. 复核依据和反证是什么？遇到争议、拆分或过期时能否保留身份与历史？
4. 值得进入哪个载体，还是只保留为案例？是否能提出可审查的具体改动？
5. 现有观测与评测契约能承接多少？有没有被迫伪造状态或混淆来源？
6. 哪些案例用于形成改动，哪些证据能独立验证效果？

首轮三例未要求新增字段。来源解析、复核投影及最小持久化协议已在 §9 收敛为首版决策；实现切片见 §9.5。角色交换、同源反证、删除和并发等边界应进入后续实现验收，不把文档推演成功当作运行时已验证。

## 8. 演进约束与实现入口

- **先保证写入一致，再构建索引。** 单个修订的内容、实体引用和证据关联应一并校验、原子写入；复核追加前校验目标修订。首个写入协议需具备幂等键和预期前驱检查，重复提炼不能静默创建重复修订，并发修改不能相互覆盖。跨边界操作保留可重试记录，不要求跨所有对象的事务。
- **历史解释保持稳定。** Schema 版本、提炼器版本与复核策略版本各有职责，不混作 `revisionId`。正式持久化必须显式标识 Schema 版本；改变语义的迁移保留旧版本可解释性，不能把旧状态按新规则静默升级。派生视图应携带其策略版本和输入记录标识，支持重算与解释。
- **读取不等于接纳。** 查得某条知识、某个新修订或某个实体别名，不表示该内容已获推荐。检索返回明确修订、适用范围、来源可用性及复核与生命周期状态。需要自动复用时，调用方使用显式选择策略；不把排序第一或最新写入当作默认授权。
- **删除与纠正可追溯。** 证据保留策略独立于知识修订；删除原始材料后允许保留合规的最小定位信息和不可用原因，并使当前可用性视图降级。旧复核保留其当时依据，不伪称当前仍可重验；若需要删除条目内容，引用解析须返回明确的删除状态，不能复用其身份指向另一条知识。
- **按真实需求扩展表达能力。** 多方行为可先用事件实体连接参与者；只有多方角色、数值比较或分支方法成为真实需求时，再设计限定角色、类型化值或步骤图。增加结构必须说明可验证的查询或复用收益，不能仅为收集更多字段引入通用属性袋。

下一步产出应是一组可核对来源的真实案例及模型修订结论。以下是推演验收条件，不是已经完成的验证：

| 场景 | 模型必须能保留什么 |
|---|---|
| 同一实体在两条知识中交换主体／对象 | 身份相同，角色局部；任一实体都可定位相关条目 |
| 状态事实包含两条相关陈述 | 不制造对象、不按句数强拆；每条陈述各有范围和证据 |
| 一份日志支持行动事实但反对成功结果 | 同一来源、不同证据关联；结果争议不能污染行动事实的判断 |
| 案例仅有参与者报告，结果未知 | 来源声明的依据、已知行动与结果缺口，不伪造直接观测 |
| 从案例提炼方法并修改 skill | 新方法的派生关系、待验证状态、明确载体版本及独立效果证据 |
| 事实更正、部分复核和并发修订 | 旧身份与旧结论可解释；未复核部分不被整条支持状态掩盖 |

首个产品切片闭合「真实工作日志 → 候选知识 → 逐条回看来源」。用真实任务检查候选是否有复用价值、条件是否遗漏、推测是否被误当事实。校验与复核状态为这个闭环提供必要支撑；完整存储、实体索引和载体改动关联按实际需要接入。通用图推理与自动发布不作为首个切片的前置条件。

## 9. 首个实现的最小契约

本节收敛 §7 的待决事项，作为支撑能力实现时的验收依据，不要求先完成全部基础设施再验证日志挖掘价值。§3.1 继续描述领域内容；这里补充读取和写入边界，不把存储元数据塞进知识陈述。选择本地文件 adapter 作为首个实现，不新增数据库依赖，本节不规定 CLI／MCP 或公共 Schema，不修改现有 observation 数据；首个产品入口及其接纳边界见 §10。

### 9.1 来源解析

首个入口接受显式登记的来源片段与已有 observation 归档引用。提炼者必须先登记 `KnowledgeEvidenceBinding`，再引用 `evidenceRef`；同一引用只能对应一个不可变的来源版本和选择范围。登记相同绑定可重试，变更绑定必须使用新引用。登记后尚未被知识使用的来源不自动删除，也不自动获取无限保留授权。

| 结果 | 精确含义 | 消费方式 |
|---|---|---|
| `available` | 身份与版本匹配，所选片段完整可读 | 可以检查片段；不表示整份会话完整或解释正确 |
| `partial` | 身份与版本匹配，但所选片段截断或缺失一部分 | 返回可见部分和具体限制，不把缺失内容补成事实 |
| `unavailable` | 未登记、来源缺失、已删除、无权限、版本不符或无法解析 | 返回原因；不能改读最新文件、相邻片段或其它同名来源 |

`sourceId` 表达同一来源身份，`sourceVersion` 固定其内容版本；`selector` 是由 adapter 解释的有界定位信息，不是允许任意读取的路径。导入显式片段时保留来源自述、采集者、记录时间及缺失的原始消息身份；对片段内容生成稳定版本标识，不能因缺少平台消息 ID 就伪造一个。源码证据可使用固定提交及位置，归档证据需固定归档内容身份及记录范围。

复用 `ExperienceEvidenceRef` 的 trace、消息或调用定位信息，以及 `loadObservationSourceRecordArchive` 的可用性与覆盖限制；已有引用不总是包含内容版本，需要 adapter 补足绑定，不能仅凭路径或 `snippet` 假定历史内容未变。解析必须在已授权的来源根内进行，保留既有路径和体积限制。首版不主动联网补来源、不从知识文字中自动执行来源地址。

可用性相对于登记的选择范围判断：完整读到一个片段，不等于片段之外的上下文没有缺口。`limitations` 保留这些限制；若复核需要扩大选择范围，应登记新来源并创建知识修订。读取对本次目标修订引用的每个不同 `evidenceRef` 返回且仅返回一个结果，遗漏、重复或绑定身份不符属于解析协议错误；结果由调用方传入纯投影函数；投影函数不读取文件或时钟。

### 9.2 复核投影策略 v1

输入为一个明确知识修订、该修订全部复核记录、本次来源解析结果，以及带不可变 `policyRevision` 的采信策略。策略明确列出有权被采信的实际操作身份；默认列表为空，不自动信任「human」标签或 Agent 自报身份。宿主根据实际调用身份赋值和检查权限，不能从来源文本提取一个身份就允许写入或更正复核。

Agent 记录可以保存为待采信意见；只有被策略显式纳入的操作身份才影响支持、不支持和争议判断。未采信记录及原因进入 `excludedReviews`，不能静默丢失。引用不存在、字段非法或跨修订的记录是数据错误，读取返回明确错误，不伪装成尚未复核。策略缺失或版本不可识别也返回明确投影错误，不选择隐式默认策略。

处理顺序固定如下：

1. 校验修订、证据关联和复核范围，确定有权限采信的记录。首版只允许同一实际复核者、更正同一修订和同一陈述集合的旧记录；被更正记录必须已经存在，禁止自引用和循环。授权管理员替他人更正不是首版能力。
2. 在已采信记录中处理 `supersedesReviewIds`，保留全部历史。未采信更正不能隐藏已采信旧记录；两个并发更正都保留，互相矛盾时形成争议。
3. 按陈述汇总仍有效的判断，采用下表。来源内容不被自动当作复核 verdict，也不依赖时间戳先后选择赢家。
4. 检查当前来源覆盖。如果某条陈述本会是 `supported`，但其支持判断实际引用的任一来源为 `partial`／`unavailable`，或对应证据关联只有 `background`／`opposes`，则降为 `needs_more_context` 并列出原因。首版保守要求被采信的支持判断对该陈述至少引用一条 `supports` 关联；原复核记录保持不变。
5. 汇总条目状态，返回逐陈述明细、输入记录 ID、排除原因、来源状态及策略版本。`projectedAt` 由宿主提供；同一组输入产生同一输出，排序按稳定 ID，不按到达顺序。

| 有效判断组合 | 陈述状态 |
|---|---|
| 存在 `disputed`，或同时存在 `supported` 与 `unsupported` | `disputed` |
| 无上述冲突，存在 `unsupported` | `unsupported` |
| 无上述情况，存在 `needs_more_context` | `needs_more_context` |
| 仅有 `supported` | 先为 `supported`，再执行来源覆盖检查 |
| 没有可采信判断 | `pending`，保留未采信原因 |

条目汇总优先级为：任一陈述 `disputed` → `disputed`；否则任一 `unsupported` → `unsupported`；否则全部 `supported` → `supported`；否则全部 `pending` → `pending`；其余 → `needs_more_context`。因此只检查了一部分内容不能让整条通过；任一不支持表示整条不能作为全部受支持内容使用，不把其它已支持陈述改写成错误。

已知反证是否已经得到解释属于复核职责，不能靠 `opposes` 计数自动裁决真伪；有效复核必须在理由中处理其范围内的反证。v1 能强制检查引用与覆盖，不能机械验证理由是否充分，这一点必须显示为人工或被授权评委承担的边界。来源后来不可用时保留历史判断，但当前支持视图按上述规则降级，不再声称当前可复验。复核视图始终不等于复用授权或载体效果结论。

### 9.3 修订存储与写入协议

首版采用**每条知识一份有版本的历史文件**：保存不可变修订、追加的复核记录、写入回执与内部写入头；`KnowledgeItem` 仍只返回指定修订的完整视图，不把整个历史交给每个调用方。文件内容通过 `KnowledgeStoreEnvelope` 表达，新增派生复核视图无需改写旧修订。数据量增大后可以更换 adapter，领域身份和读取结果保持兼容。

宿主必须显式提供知识存储根；首版没有隐式用户目录写入或默认扫描。文件名由 `[namespace, knowledgeId]` 的下述确定性 JSON 与 SHA-256 摘要生成，并验证文件内命名空间与知识身份，不直接把输入 ID 拼成路径。索引从已提交文件重建，不作为事实来源。来源绑定由独立来源 adapter 在显式来源根下持久保存；首版显式片段使用单个不可变记录保存绑定、片段和采集来源信息，记录 ID 重复时比较完整内容，不能覆盖，读取按版本核验。已有归档通过注册描述引用而不复制全部日志，先完成登记再写知识；单条知识事务不包含来源采集、模型调用或所有其它条目的更新。

写入操作只有 `append_revision` 与 `append_review`，不提供原地修改修订或覆盖复核。首个修订要求不存在旧文件、`expectedGeneration = 0` 且预期头为 `null`；后续修订的父修订必须等于当前写入头。复核可以指向本条目任一已保存修订，不强制复核最新内容。`writeHeadRevisionId` 仅用于编辑并发控制，不能作为已接纳知识的默认读取指针。

每次调用（包括幂等重试）先由宿主核验实际操作身份及目标知识的访问／写入权限；无权限时不读取或返回历史回执。新修订的 `revisedBy`、新复核的 `reviewedBy` 必须匹配已核验身份；首个修订同时核对 `createdBy`，后续修订则保留原 `createdBy`，允许其它获授权作者修订。不能接受载荷中的冒名身份。在同一知识的文件锁内，顺序执行：

1. 读取并完整校验旧文件。文件损坏或 Schema 不识别时拒绝写入，不能当空库覆盖。
2. 检查 `requestId` 回执。同一 ID、同一命令摘要返回原回执，优先于检查已变化的 generation；同一 ID 不同命令返回 `idempotency_conflict`。幂等范围为同一知识，重试必须携带原 ID、时间和内容。
3. 检查 `expectedGeneration` 与预期写入头；不匹配返回 `conflict`，不自动覆盖、合并或重放到新头。调用方读取新状态后作出新决定，使用新请求 ID。
4. 校验不可变身份、引用、时间、修订关系与复核更正规则。追加内容、递增 `generation` 并同时写入回执；首版 generation 为安全整数，溢出时拒绝写入。
5. 将完整新 envelope 写到同目录唯一临时文件，完成后原子替换目标文件，再释放锁。更新派生索引失败不会撤销已提交事实，读取可以扫描重建。无提交回执的失败不得声称成功；提交后响应丢失可以用同一请求查回执。

命令摘要使用确定性 JSON：对象键排序、数组顺序保留、UTF-8 编码；输入必须是 JSON 值，拒绝 `undefined`、非有限数值及其它非 JSON 类型。首版固定为 `canonical-json-v1` 加 SHA-256：键按 Unicode UTF-16 码元排序，数值与字符串按 JSON 序列化，无多余空白。摘要包括已核验的稳定操作身份（身份命名空间、actorKind、actorId）、命令类型、目标、预期版本和完整载荷，不包括宿主生成的响应时间；重试可来自同一身份的新调用，命令中的原 `executionRef` 保持不变，不把重试调用的新执行 ID 加入摘要；后续修改规范化规则须升级版本，不重新解释旧回执。

优先复用 `withFileLock` 与 `writeJsonFileAtomic`，但仍需验证此事务的并发与中断路径。现有原子写通过 rename 防止读到半份 JSON，不包含文件和父目录的持久化同步，首版只承诺进程中断后的原子可见性，不承诺突然断电后最后一次提交必然保留。锁超时、无法确认归属的残留锁或存储故障应明确失败；不得为继续运行而无条件抢锁。现有锁辅助函数包含过期锁恢复逻辑，复用前须确认恢复竞态与归属校验符合本契约，必要时补充保守模式，不能仅凭存在辅助函数就认定并发验收通过。

首版每个 envelope 的 UTF-8 序列化大小上限为 16 MiB；超限返回 `capacity_exceeded`，不截断历史、证据引用或幂等回执。这是本地 adapter 的初始限制，不是知识条目的语义约束。压缩历史、更换存储和保留策略变更必须显式迁移；首版不提供知识条目删除与跨条目合并事务。来源快照删除使用独立的可用性契约，见 §10.5。

### 9.4 内部接口形状

下面是上述决策的逻辑接口，不是已发布的序列化契约。三个附录保留各自编写时的来源和复核记录；其中「策略未确定」描述当时的推演状态，不覆盖本节新确定的首版策略。`schemaVersion: 1` 仅属于新知识存储，不能用于读取旧 observation 文件。来源绑定先登记，写入只引用已有逻辑身份；读取明确指定 `KnowledgeRevisionRef`，目标不存在、数据损坏或投影无法完成时返回对应错误，不返回伪造的空知识。

```typescript
// Logical contracts for the first internal implementation; not published Schemas.
type KnowledgeRevisionData = Omit<KnowledgeItem, 'review'>;

interface KnowledgeEvidenceBinding {
  evidenceRef: string;
  adapterId: string;
  sourceId: string;
  sourceVersion: string;
  selector: string;
}

type KnowledgeEvidenceResolution = {
  evidenceRef: string;
  checkedAt: Timestamp;
} & (
  | {
      resolutionStatus: 'available' | 'partial';
      binding: KnowledgeEvidenceBinding;
      excerpt: string;
      limitations: readonly string[];
    }
  | {
      resolutionStatus: 'unavailable';
      reason: 'unregistered' | 'missing' | 'deleted' | 'access_denied'
        | 'version_mismatch' | 'invalid_source' | 'unsupported_adapter' | 'read_failed';
      detail: string;
    }
);

interface KnowledgeStatementReviewView {
  statementId: string;
  reviewStatus: KnowledgeReviewView['reviewStatus'];
  activeReviewRefs: readonly string[];
  unresolvedReasons: readonly string[];
}

interface KnowledgeReadView {
  item: KnowledgeItem;
  statementReviews: NonEmpty<KnowledgeStatementReviewView>;
  evidenceResolutions: NonEmpty<KnowledgeEvidenceResolution>;
  projection: {
    policyId: 'knowledge-review-v1';
    policyRevision: string;
    storeGeneration: number;
    inputReviewRefs: readonly string[];
    excludedReviews: readonly { reviewId: string; reason: string }[];
    projectedAt: Timestamp;
  };
}

interface KnowledgeWriteReceipt {
  requestId: string;
  commandDigest: string;
  committedGeneration: number;
  target: KnowledgeRevisionRef;
  reviewId?: string;
}

interface KnowledgeStoreEnvelope {
  storeKind: 'knowledge-item-history';
  schemaVersion: 1;
  namespace: string;
  knowledgeId: string;
  generation: number;
  writeHeadRevisionId: string;
  revisions: NonEmpty<KnowledgeRevisionData>;
  reviews: readonly KnowledgeReviewRecord[];
  receipts: NonEmpty<KnowledgeWriteReceipt>;
}

type KnowledgeWriteCommand = {
  requestId: string;
  expectedGeneration: number;
} & (
  | {
      commandKind: 'append_revision';
      expectedHeadRevisionId: string | null;
      revision: KnowledgeRevisionData;
    }
  | { commandKind: 'append_review'; review: KnowledgeReviewRecord }
);

type KnowledgeWriteResult =
  | { resultKind: 'committed' | 'replayed'; receipt: KnowledgeWriteReceipt }
  | {
      resultKind: 'rejected';
      reason: 'conflict' | 'idempotency_conflict' | 'invalid_record'
        | 'unauthorized' | 'unsupported_schema' | 'capacity_exceeded'
        | 'store_unavailable';
      detail: string;
    };
```

### 9.5 首个实现的验收范围

| 边界 | 必须通过的行为 |
|---|---|
| 来源解析 | 完整片段、截断、缺失、拒绝访问、版本不符分别可解释；版本不符不读最新内容 |
| 复核投影 | 未采信身份不产生支持；部分覆盖不提升整条；冲突、更正、失效来源及输入乱序有确定结果 |
| 写入一致性 | 同请求重试返回原回执；不同请求竞争同一 generation 只有一个提交；失败不会覆盖旧内容 |
| 历史与读取 | 明确修订可读；新复核不改修订；写入头不等于已接纳版本；索引缺失可以重建 |
| 容量与中断 | 超限或损坏时拒绝，不截断；临时文件和锁的异常路径不会留下可被误读为已提交的数据 |
| 宿主边界 | 纯校验／投影不依赖 fs、网络、CLI 或模型；所有测试使用显式临时根 |

实现优先围绕一段真实工作日志形成候选知识，并让使用者逐条核对来源。先接入这个闭环所需的来源定位、候选生成及结构检查；以有用性、适用条件完整性和来源忠实性检查结果。复核投影和文件事务按使用需要逐步落地，不把完整基础设施作为首个产品切片的前置条件。首个 CLI 入口的职责见 §10；实体检索、载体改动及效果评测接入仍按实际需要推进。三个附录提供种子样例；支撑能力落地时仍须覆盖本节权限、并发和异常验收。

## 10. 工作日志知识提炼的架构决策

本节将首个产品切片收敛为「选择日志 → 识别实体提及 → 提炼候选 → 核对来源 → 人工处理」，确定职责、依赖和接纳边界。它是实施设计，不表示下述模块或入口已经交付。§3 是知识内容模型，§9 是支撑契约；本节不另造一种持久化候选知识模型。

### 10.1 领域所有权与依赖

| 所有者 | 负责 | 不负责 |
|---|---|---|
| `observability/trace` 与来源 adapter | 解析不同平台记录，保留来源身份、顺序、角色、原始位置及覆盖限制 | 判断知识真伪、分配知识身份 |
| `observability` 的证据接入 | 把显式选择的原始记录或已有归档登记为不可变证据绑定，提供有界解析 | 根据模型给出的路径读取额外文件，静默追随最新来源 |
| 新的 `knowledge` 领域 | 实体与知识内容契约、修订接纳、引用约束、复核和生命周期规则 | 解析 Codex 协议、读取日志、调用 provider、渲染页面 |
| `observability/knowledge-extraction` 应用流程 | 组织证据窗口、调用注入的提炼端口、记录提炼运行、将输出交给知识接纳规则 | 持有第二套知识结构、评分、自动发布 |
| 知识存储 adapter | 实现 §9 的版本读写协议、原子性与失败恢复 | 自行决定实体合并、复核结论或当前推荐版本 |
| CLI／Studio 等宿主 | 选择来源、装配 adapter 和执行器、展示结果、传递用户操作 | 复制知识业务规则，直接改写存储文件绕过接纳 |
| `knowledge-artifacts` 与现有评测链 | 后续将选定知识修订落实到载体，并比较实际版本 | 让候选提炼依赖完整评测流程，反写知识真伪 |

`knowledge` 是新增的领域所有权，区别于已有的知识载体领域 `knowledge-artifacts`。增加它是为了让知识内容能够独立于观测来源、载体和评测存在，不是为了套用全仓分层。实施新增目录时同步更新源码领域地图与架构守卫；本设计不要求独立包、服务或数据库。

依赖方向如下，箭头表示调用或依赖：

```text
CLI / Studio composition
  → observability/knowledge-extraction
      → source-neutral evidence port ← observation source adapter
      → extraction port ← configured executor adapter
      → knowledge contracts / admission / review
      → knowledge store port ← local-file adapter

knowledge-artifacts / future carrier-change workflow
  → explicit knowledge revision references
  → existing evaluation contracts
```

图中的端口属于消费方契约，adapter 实现端口；并不要求来源 adapter 依赖提炼应用的实现。知识纯逻辑不 import `observability`、`executors`、CLI、Studio、文件系统或网络。观测已有的采集与轨迹展示也不依赖新知识模块才能工作。`evidence/storage` 可复用通用物理存储原语，但不承担知识业务决策；`eval-core` 和 `eval-runtime` 不承接该产品流程。

### 10.2 实体提及与实体身份分开

日志中的名称、代词或描述是 `EntityMention`，不是已经确认的实体身份。提及记录引用不可变证据及原文选择位置，保留显示文本、所属上下文，以及显式出现或推断的依据。`Entity` 继续使用 §3 的身份与描述，不把出现位置、提炼置信度和别名历史塞进实体描述本身。

提炼器只能提出局部实体及指代对应关系，接纳过程分配稳定身份。局部标识只在本次提炼中有效，不能直接当作已有实体的 ID。多个名称指向同一实体需要来源依据；相同名称不构成同一身份的证据。无法消解时保留分开的局部实体和歧义说明，可以先形成待复核知识，不要求先建立完整实体库。

实体识别与陈述提炼允许相互修正。它们是逻辑职责，不强制拆成两次模型调用；同一次调用可以同时返回提及、实体提议和陈述。首次只处理选定日志范围内的身份对应，跨日志合并后续以可审查的对应记录实现，不能重写历史知识修订中的实体快照。实体与知识身份不从名称、路径或内容 hash 推导。

### 10.3 证据窗口与提炼运行

提炼输入是 source-neutral 的证据窗口，不是 Codex 原始协议对象。窗口由明确的来源选择形成，包含已登记的证据引用、可见内容、角色／事件类型、记录顺序、记录时间及覆盖限制。来源 adapter 保留原始记录供核对，并给出原始位置到窗口片段的映射。已有 Trace IR 可参与投影，但不可把裁剪后的展示 snippet 当作完整原文。

接入 Codex、其它平台、显式用户反馈或导入的文档片段，改变的是来源 adapter，不改变知识模型和接纳规则。模型既不能扩大输入范围，也不能凭输出中的文件路径、URL 或记录序号触发读取。需要更多上下文时返回缺口，由宿主重新选择和登记证据；重新生成是另一条运行记录。

每次 `KnowledgeExtractionRun` 至少记录：

- 运行身份、请求身份、开始与结束状态；
- 选定来源绑定及输入窗口 digest、投影版本和覆盖限制；
- 提炼器版本、prompt 版本与 hash、实际执行器／模型配置，以及可获得的运行身份；未报告的信息明确缺失，不伪称可复现；
- 输出解析及接纳结果、候选修订引用、失败或未接纳原因。

来源版本、输入投影版本、提炼器版本、存储 Schema 版本、知识修订身份和复核策略版本分开管理。相同输入和配置的两次生成可以不同，重试不能宣称确定性重放。显式重新生成保留新运行及候选，不覆盖旧运行。模型自报运行身份不作为宿主事实。

### 10.4 从模型输出到知识修订的接纳

模型响应是未经信任的传输数据。它可以有便于生成的局部引用，但只存在于提炼边界，不作为另一份可长期维护的 `KnowledgeItem` Schema。接纳按以下顺序执行：

1. 校验响应结构与大小，拒绝非法字段、重复局部 ID 和越界集合；空候选集合是正常结果。
2. 校验实体提及、陈述、组织角色与证据引用的闭合关系。证据必须属于本次已登记窗口；原文引述必须匹配所选快照，不能仅验证记录编号存在。
3. 区分程序可证明的结构正确与需要人判断的语义忠实。引述匹配不证明它支持陈述；直接观测、来源说法及推断的归类也仍需核对。
4. 由宿主提供身份、时钟与生成者运行引用，转换为 §3 的知识修订；保留提炼运行到修订的映射，不让模型自报已复核状态或复核者身份。
5. 通过 §9 的写入协议接纳，默认 `pending`。已接纳候选、未接纳输出及原因区分展示，不把部分失败报告为全部成功。

首版对单个候选原子接纳，不要求跨全部候选、实体和来源的全局事务。请求重试使用稳定的候选写入请求身份，沿用 §9 的幂等回执；提交候选前先保存已校验的接纳意图、已分配身份与写入请求身份。进程中断后用该意图和存储回执核对已提交候选并恢复余下部分，不重复分配知识身份。恢复接纳不重新调用模型；重新生成属于新尝试，不允许不同输出复用旧候选的写入请求身份。尚未接纳的输出不出现在正式知识检索中。

### 10.5 人工处理、存储与来源保留

保留、舍弃、内容复核和发布是不同操作。保留／舍弃表达用户的维护选择，记录目标修订、操作者、时间与理由，不把 `pending` 改成 `supported`。修订内容使用预期前驱创建新修订，旧修订、来源和操作仍可追溯；新修订重新等待复核。修订实体对应关系同样不能原地改写旧知识。该维护选择作为独立记录与知识内容关联，不扩展 `KnowledgeReviewVerdict`。

CLI 与 Studio 调用同一应用接口；JSON 展示或导出不成为绕过校验直接覆盖知识存储的通道。首个入口选择 CLI，以一个显式文件及可选记录范围生成候选，并提供来源查看和人工处理；后续 Studio 复用相同读取与操作协议。具体命令名称和参数在实现中与现有命令树一起确定，不新增另一套顶层生命周期。

首版来源快照保存在用户明确选择的本地工作区内，界面说明保存和发送给执行器的具体范围。默认不扫描全局历史、不自动联网补证据，不将无限保留原始对话作为隐含前提。保留上限和删除入口是首版存储契约的一部分。删除原始快照后，来源解析返回 `unavailable`；知识仍保留允许保留的绑定与历史，但不能继续展示快照可用。舍弃候选不等同于删除来源，共享来源也不能因一个候选被舍弃而删除。

来源读取、快照保存、模型发送、候选接纳是独立失败边界。容量超限在发送前返回可操作错误，不能静默截取后标为完整；取消、超时、模型失败或解析失败均保留明确结果并清理临时资源，不污染原始日志或生效载体。模型调用使用已配置的能力边界；纯文本提炼不需要工具执行，日志中的指令不能成为宿主操作指令。

### 10.6 首版范围与架构验收

首版落地一个来源 adapter、一套知识接纳规则、一个文件存储 adapter 和一条 CLI 使用路径。必要的提炼运行、来源绑定与维护选择用普通模块和记录实现；不预建插件注册中心、通用工作流引擎、消息总线、向量库或图数据库。

| 验证方式 | 要证明的边界 |
|---|---|
| 知识纯逻辑测试与 import 守卫 | 无文件、网络、执行器与 UI 依赖；同一显式输入得到同一接纳／拒绝结果 |
| source-neutral 内存来源与 Codex adapter 的契约测试 | 来源切换不改变知识结构；原始位置、窗口范围与缺失状态准确映射 |
| 不可信提炼输出测试 | 虚构引用、错配引述、身份碰撞、未知实体、错误角色及非法状态不会进入已接纳修订 |
| 幂等、并发与故障注入测试 | 重试不重复写，修订不互相覆盖；部分提交、取消和删除后可解释且可恢复 |
| CLI 的真实入口验收 | 从选定日志生成候选、查看原文、保留／舍弃／修订后重新读取，且不修改原始日志和生效载体 |
| 既有三个真实案例的人工核对 | 有用性、适用范围与来源忠实性；单次成功不升级为通用方法已有效 |

架构守卫只保护已存在的职责和依赖，不通过登记未经分析的环或放开所有跨域 import 来使测试变绿。未来增加来源、替换提炼器或切换存储，应主要增加或替换 adapter；如果必须同时改动知识表达、复核规则与 UI 状态机，需重新检查边界是否泄漏。只有新业务语义确实需要时才演进知识模型，而不是为了适配某个平台的响应字段。

<a id="cr-case"></a>

## 附录：CR 反馈案例推演

本例用于检验模型表达，不是独立规范。来源是本次知识设计对话中的反馈「你的 cr 流程是不是有点重啊」及移除 skill 的要求。它们支持对话行为事实，不能直接证明流程客观过重或轻量审查效果更好。

| 实际遇到的问题 | 本例如何填写 | 对草案的结论 |
|---|---|---|
| 对话缺少发生时间 | `occurredDuring` 为未知，编写时间单独记录 | 保留现有时间区分，无需编造日期 |
| 知道请求但缺少结果快照 | 行动非空，结果为空，`gaps` 说明未收录范围 | 允许不完整案例是必要的；缺失不代表失败 |
| 用户判断与流程事实容易混淆 | 陈述写「提出疑问」，不写「流程过重」 | 证据关联必须解释它支持的具体内容 |
| 反馈与项目规则共同形成方法 | 一份为背景，一份为规范支持 | `basis` 与证据关系分开有效；有规范依据不等于有收益 |
| 方法不能只指向已经发生的那次 CR | 案例引用具体过程；方法引用可重复开展的活动和执行角色 | 相似名称不等于同一实体；具体事件与通用概念必须区分 |
| `executionRef` 和来源引用暂无法接入真实服务 | 在本文提供解析表和编写记录，明示缺口 | 完整视图依赖引用解析；正式实现需先定义可用、部分可用与不可用的解析结果 |
| 通用方法似乎值得写入载体，但已有同义规则 | 保留方法候选，不重复写入规则 | 形成知识不必导致载体改动；需先检查现有载体覆盖 |

填写过程中修正了将具体 CR 过程复用于通用方法的实体指代，未要求新增领域字段。主要结论是现有结构能容纳「有来源但不完整的案例」和「有规范依据但效果未知的方法」。它尚未验证真实持久化、索引、复核投影或完整的知识生命周期。

候选方法是「按风险选择审查深度」。现有项目规则已经表达这一要求，因此暂不重复增加同义载体指令；方法效果仍需绑定明确版本、固定模型并使用独立任务验证。本例不创建评测关联或收益结论。事实修正见后续附录；角色交换、同源反证与并发修订仍待检验。

<details>
<summary>展开来源片段与完整 KnowledgeItem 示例</summary>

### 1. 来源与覆盖范围

本例选取本次 OMK 知识设计对话中的用户原话，按出现顺序定位，不推断不可见的完整 trace。下面保留的片段就是本例证据快照；无平台消息 ID、原始时间戳和完整对话归档，不能据此计算耗时、调用次数或审查成本。文档中的本地 ID 为本次推演分配，不冒充平台 ID。

<a id="e1"></a>

#### E1：对流程的反馈

来源：本次对话，用户在讨论文档提交后的 CR 流程时提出：

```text
你的 cr 流程是不是有点重啊
```

它直接支持「用户质疑流程偏重」这一对话事实，不直接证明流程客观过重，也不表示所有任务都应减少审查。

<a id="e2"></a>

#### E2：移除要求与指代

来源：同一对话，用户先明确 skill 名称，随后要求移除；以下是按顺序选取的两条消息，中间还有其它交流，并非连续完整记录。

```text
为什么会启动`cr-code-review` skill？
给我移除这个 cr skill
```

前一条用于消解「这个」的指代，后一条支持移除要求。要求不等于执行完成；原会话中的移除结果不在本例的执行证据快照内，后续可补原始工具记录形成新修订，不能把「未收录」写成「未执行」。

<a id="e3"></a>

#### E3：已有项目规则

来源：本工作树 `AGENTS.md` 的「自主 CR 与完成定义」，Git blob 标识为 `c2f1c908d6ea2be0c5cc032222a5d5dc5ce49d8c`。摘录：

> 任何会改变行为、契约、打包、文档承诺或仓库规则的改动，在首次 push／交付前都必须由当前 Agent 自主完成一次 CR；不要等待用户再问「CR 了吗」。纯机械改动也要快速复核，但审查深度应与风险匹配。

这份既有规则约束候选方法，不能因与用户反馈一致而当作独立效果验证；本例也不声称该规则由这次反馈首次产生。

#### 证据解析约定

| 逻辑引用 | 本文中的快照 | 来源身份与限制 |
|---|---|---|
| `walkthrough:cr:e1` | [E1](#e1) | 用户原话；缺少原始消息 ID 与时间戳 |
| `walkthrough:cr:e2` | [E2](#e2) | 同一对话的两条消息，作为一组指代证据；不是两份独立佐证 |
| `walkthrough:cr:e3` | [E3](#e3) | 项目规则及其 blob 身份；不是执行或效果数据 |

这是文档级解析表，不是已实现的证据服务。片段今后若更正，应新增证据版本和知识修订，不能沿用旧身份静默替换；正式导入时还需补齐来源适配协议。

<a id="authoring-record"></a>

#### 编写记录

`walkthrough:cr:authoring-01` 指向本次用户确认推演后、由当前 Agent 编写本文件的活动；记录时间为 `2026-09-05T15:09:12Z`，不是上述历史消息的发生时间。执行主体为 `walkthrough:cr:author`，宿主为 Codex；未取得平台运行 ID、精确模型版本及参数，均保留为未知。此记录仅支撑文档示例的编写归属，不能冒充可重放的模型调用档案。

### 2. 完整条目

以下 TypeScript 与草案 §3.1 合并后可检查类型。两个条目均包含全部必填字段；首个修订省略 `parentRevision`。`context` 只用于减少示例的代码重复，展开后每条陈述拥有完整上下文，不引入新的领域继承规则。实体身份限定于本案例，不建立全局用户身份。

案例记录可直接看到的两项用户行为；方法单独建条目。`reviewStatus` 保持 `pending`：本文的文档审查没有冒充领域复核，也未替用户作出知识接纳决定。

```typescript
// Types are defined in section 3.1 above.
const recordedAt: Timestamp = "2026-09-05T15:09:12Z";
const author: KnowledgeActor = {
  actorKind: 'agent',
  actorId: 'walkthrough:cr:author',
  executionRef: 'walkthrough:cr:authoring-01',
};
const context: KnowledgeContext = {
  scenario: 'OMK 知识设计文档工作的 CR 流程反馈',
  conditions: ['本次对话中的文档任务与 CR 经历'],
  exceptions: [],
  unknowns: ['未归档完整执行 trace，无法计算审查耗时与成本'],
  occurredDuring: { timeKind: 'unknown', reason: '所选消息没有可核对的时间戳' },
  validDuring: {
    timeKind: 'not_applicable',
    reason: '陈述记录特定对话行为，不声称具有持续适用期',
  },
};

const crCase: KnowledgeItem = {
  knowledgeId: 'walkthrough:cr:case',
  revisionId: 'r1',
  title: '用户质疑文档审查流程偏重，随后要求移除 CR skill',
  content: {
    statements: [
      {
        statementId: 'question-process',
        subject: { entityId: 'walkthrough:cr:user' },
        relation: '以疑问方式提出流程是否偏重',
        object: { entityId: 'walkthrough:cr:process' },
        modality: 'descriptive',
        polarity: 'positive',
        context,
      },
      {
        statementId: 'request-removal',
        subject: { entityId: 'walkthrough:cr:user' },
        relation: '要求移除',
        object: { entityId: 'walkthrough:cr:skill' },
        modality: 'descriptive',
        polarity: 'positive',
        context,
      },
    ],
    organization: {
      knowledgeKind: 'case',
      situation: '记录用户对 CR 流程的反馈与随后提出的操作要求。',
      actionStatementIds: ['question-process', 'request-removal'],
      outcomeStatementIds: [],
      gaps: ['本条目选取的来源不包含移除操作的执行证据及改动后的效果数据'],
    },
  },
  entities: [
    { entityId: 'walkthrough:cr:user', label: '本次对话用户', description: '仅在本案例中识别，不推断真实身份。' },
    { entityId: 'walkthrough:cr:process', label: '本次 CR 流程', description: '被用户反馈指向的审查过程，不代表所有 CR。' },
    { entityId: 'walkthrough:cr:skill', label: 'cr-code-review', description: '由同段对话明确名称的 skill，不绑定未知的安装版本。' },
  ],
  evidence: [
    {
      evidenceLinkId: 'question-evidence',
      evidenceRef: 'walkthrough:cr:e1',
      statementIds: ['question-process'],
      relation: 'supports',
      basis: 'direct_observation',
      interpretation: '可见文字支持用户提出了这个疑问，不证明流程客观上过重。',
    },
    {
      evidenceLinkId: 'removal-evidence',
      evidenceRef: 'walkthrough:cr:e2',
      statementIds: ['request-removal'],
      relation: 'supports',
      basis: 'direct_observation',
      interpretation: '结合前文名称可识别被要求移除的 skill；要求不等于已执行。',
    },
  ],
  observationRefs: [],
  derivations: [],
  review: {
    target: { knowledgeId: 'walkthrough:cr:case', revisionId: 'r1' },
    reviewStatus: 'pending',
    reviewRefs: [],
    unresolvedReasons: ['已选取来源片段，但尚未按领域复核策略形成复核记录'],
  },
  createdAt: recordedAt,
  createdBy: author,
  revisedAt: recordedAt,
  revisedBy: author,
  revisionReason: '首次将可见对话片段整理为领域推演案例',
};

const reviewMethod: KnowledgeItem = {
  knowledgeId: 'walkthrough:cr:method',
  revisionId: 'r1',
  title: '按改动风险选择审查深度',
  content: {
    statements: [{
      statementId: 'choose-review-depth',
      subject: { entityId: 'walkthrough:cr:reviewer-role' },
      relation: '应依据改动风险选择审查深度，并完成项目要求的验证',
      object: { entityId: 'walkthrough:cr:review-activity' },
      modality: 'normative',
      polarity: 'positive',
      context: {
        scenario: 'OMK 文档改动交付前的自主审查',
        conditions: ['先检查是否涉及行为、契约、打包、生成链接或仓库规则'],
        exceptions: ['涉及高风险边界时不能仅因文件是 Markdown 就采用轻量审查'],
        unknowns: ['相对现有流程的效率和质量影响尚未受控验证'],
        occurredDuring: { timeKind: 'not_applicable', reason: '这是方法指令，不是已执行事件' },
        validDuring: { timeKind: 'unknown', reason: '候选方法的采用时间与终止时间未确定' },
      },
    }],
    organization: {
      knowledgeKind: 'method',
      purpose: '使审查投入匹配风险，同时保留项目要求的交付检查。',
      instructionStatementIds: ['choose-review-depth'],
    },
  },
  entities: [
    { entityId: 'walkthrough:cr:reviewer-role', label: 'OMK 文档审查 Agent 角色', description: '未来任务中执行该方法的角色，不等于条目编写者的执行身份。' },
    { entityId: 'walkthrough:cr:review-activity', label: 'OMK 文档审查活动', description: '可重复开展的活动概念，不等于案例中的那一次 CR。' },
  ],
  evidence: [
    {
      evidenceLinkId: 'method-motivation',
      evidenceRef: 'walkthrough:cr:e1',
      statementIds: ['choose-review-depth'],
      relation: 'background',
      basis: 'inference',
      interpretation: '用户反馈促使寻找更匹配任务的流程，不证明候选方法有效。',
    },
    {
      evidenceLinkId: 'repository-requirement',
      evidenceRef: 'walkthrough:cr:e3',
      statementIds: ['choose-review-depth'],
      relation: 'supports',
      basis: 'source_assertion',
      interpretation: '项目规则直接要求审查深度与风险匹配；支持规范依据，不证明收益。',
    },
  ],
  observationRefs: [],
  derivations: [{
    relation: 'derived_from',
    source: { knowledgeId: crCase.knowledgeId, revisionId: crCase.revisionId },
    reason: '由反馈案例提出方法候选，并以现有项目规则约束适用范围。',
  }],
  review: {
    target: { knowledgeId: 'walkthrough:cr:method', revisionId: 'r1' },
    reviewStatus: 'pending',
    reviewRefs: [],
    unresolvedReasons: ['尚未形成正式复核记录；规范来源不等于效果证据'],
  },
  createdAt: recordedAt,
  createdBy: author,
  revisedAt: recordedAt,
  revisedBy: author,
  revisionReason: '由案例形成独立的方法候选，不将其收益写成事实',
};
```

</details>

<a id="fact-correction"></a>

## 附录：事实修正与局部复核

本例使用真实的草案版本变化：提交 `7b671d85` 的事实形式只有 `statement`，当前 §3.1 改为 `statements` 集合与 `organization`。复用旧版知识回答当前草案问题，会得到过时答案。处理方式是保留知识身份、创建新修订，并更新来源版本和描述。

**旧版事实没有因此变成错误事实。** 它在原版本范围内仍然成立；新源码不是针对旧范围的反证。这里修正的是供当前任务复用的知识版本，不能删掉旧范围后宣称旧事实被推翻。

| 检验点 | 本例结果与决策 |
|---|---|
| 知识与实体的身份 | 两个修订复用同一知识 ID 和两个类型实体 ID；版本差异进入上下文与来源 |
| 哪些内容改变 | `fact-content` 的内容结构描述变化；`entity-reference` 的描述不变，但来源与范围更新 |
| 应修订还是另建条目 | 同一草案契约随版本更新，用 `parentRevision`；没有新建通用方法，不使用 `derived_from` |
| 历史记录如何保留 | `r1` 仍绑定旧提交；`r2` 引用明确的新类型快照，不把当前工作树路径当作证据版本 |
| 陈述不变是否继承复核 | 不继承；内容文字相同不能证明新范围和新来源已检查 |
| 一份证据覆盖多条陈述 | 来源关联可覆盖两条；复核记录只列一条时，只能形成局部结论 |
| 更新复核是否再建修订 | `factR2View` 只更新派生视图，内容修订仍为 `r2` |

本轮 Agent 已对 `fact-content` 做源码对照检查，示例记录这项局部判断，其余陈述没有在该记录中获得复核覆盖。整体视图为 `needs_more_context`，不表示知识已被生产策略采信。此例未新增字段，也未验证真实存储或并发协议。

<details>
<summary>展开版本证据与完整修订示例</summary>

<a id="e4"></a>

### E4：旧版类型来源

`walkthrough:revision:e4` 解析到提交 `7b671d85dc840bd5ed4d37a2f0bbf0b09dec6b18` 中的 `docs/zh/specs/knowledge-domain-model.md` §3.1。下面是非连续摘录；完整内容由 Git 提交固定，不把片段视为整份文件。

```text
type KnowledgeContent =
  | { knowledgeKind: 'fact'; statement: KnowledgeStatement }

interface EntityRef {
  entityId: string;
}

interface KnowledgeStatement {
  statementId: string;
  subject: EntityRef;
  relation: string;
  object?: EntityRef;
```

<a id="e5"></a>

### E5：当前类型快照

`walkthrough:revision:e5` 解析到本文 §3.1 的完整 TypeScript 代码块。快照 SHA-256 为 `68c170dfbd04ea468778c01fad76016fd12ba20e3f35317fe1d535a178434b59`，计算对象为代码块内的 UTF-8 文本，保留 LF 换行，不包含代码围栏及末尾换行。该指纹仅标识来源内容，不是知识身份或 Schema 版本；§3.1 日后变化时应保留这份旧快照或显式返回来源不可用，不能静默解析到新的代码块。以下为非连续摘录：

```text
interface KnowledgeContent {
  statements: NonEmpty<KnowledgeStatement>;
  organization: KnowledgeOrganization;
}

interface EntityRef {
  entityId: string;
}

interface KnowledgeStatement {
  statementId: string;
  subject: EntityRef;
  relation: string;
  object?: EntityRef;
```

### 编写与复核归属

`walkthrough:revision:authoring-01` 指本轮当前 Agent 在 Codex 中进行的源码对照与条目重建，记录时间为 `2026-09-05T15:20:00Z`；平台运行 ID、精确模型版本和参数未取得。两个知识修订均在本轮重建，不伪造旧条目当时已创建的历史。记录时间不等于源码变化或规范生效时间。

下面复用 §3.1 的类型。工厂函数仅缩短示例，展开后两个修订都有完整字段。旧版来源描述使用当前的知识模型承载，并不是声称旧源码已经实现当前 Schema。

```typescript
// Both revisions are reconstructed now from versioned sources.
const correctionRecordedAt: Timestamp = '2026-09-05T15:20:00Z';
const correctionAuthor: KnowledgeActor = {
  actorKind: 'agent', actorId: 'walkthrough:revision:author',
  executionRef: 'walkthrough:revision:authoring-01',
};
function draftFactRevision(
  revisionId: string, evidenceRef: string, sourceScope: string,
  contentDescription: string, parentRevision?: KnowledgeRevisionRef,
): KnowledgeItem {
  const scopedContext: KnowledgeContext = {
    scenario: '查询 OMK 知识领域模型草案的事实表达结构',
    conditions: [sourceScope, '仅描述讨论草案，不表示已发布 API 或运行时能力'],
    exceptions: [],
    unknowns: ['所描述设计的起止适用时间未记录，以来源版本限定范围'],
    occurredDuring: { timeKind: 'not_applicable', reason: '描述版本中的静态契约，不是执行事件' },
    validDuring: { timeKind: 'unknown', reason: '不能把编写时间充当设计生效时间' },
  };
  return {
    knowledgeId: 'walkthrough:revision:fact-contract', revisionId,
    ...(parentRevision ? { parentRevision } : {}),
    title: '知识草案的事实表达结构及实体引用',
    content: {
      statements: [
        {
          statementId: 'fact-content',
          subject: { entityId: 'walkthrough:revision:knowledge-content' },
          relation: contentDescription,
          modality: 'descriptive', polarity: 'positive', context: scopedContext,
        },
        {
          statementId: 'entity-reference',
          subject: { entityId: 'walkthrough:revision:knowledge-statement' },
          relation: '通过 EntityRef 表达主体及可选对象的实体身份',
          modality: 'descriptive', polarity: 'positive', context: scopedContext,
        },
      ],
      organization: { knowledgeKind: 'fact' },
    },
    entities: [
      { entityId: 'walkthrough:revision:knowledge-content', label: 'KnowledgeContent', description: '同一草案中跨版本演进的内容结构。' },
      { entityId: 'walkthrough:revision:knowledge-statement', label: 'KnowledgeStatement', description: '上述内容使用的陈述结构。' },
    ],
    evidence: [{
      evidenceLinkId: 'source-fragments', evidenceRef,
      statementIds: ['fact-content', 'entity-reference'],
      relation: 'supports', basis: 'direct_observation',
      interpretation: '仅依据指定版本中可见的类型声明解释草案结构。',
    }],
    observationRefs: [], derivations: [],
    review: {
      target: { knowledgeId: 'walkthrough:revision:fact-contract', revisionId },
      reviewStatus: 'pending', reviewRefs: [],
      unresolvedReasons: ['尚未对本修订记录逐陈述复核'],
    },
    createdAt: correctionRecordedAt, createdBy: correctionAuthor,
    revisedAt: correctionRecordedAt, revisedBy: correctionAuthor,
    revisionReason: parentRevision ? '更新来源版本及事实内容结构描述' : '依据旧版来源重建首个知识修订',
  };
}
const factR1 = draftFactRevision(
  'r1', 'walkthrough:revision:e4',
  '来源为提交 7b671d85 的知识领域模型草案',
  '事实形式通过 statement 字段包含一条 KnowledgeStatement',
);
const factR2 = draftFactRevision(
  'r2', 'walkthrough:revision:e5',
  '来源为本附录 E5 标识的 §3.1 类型代码快照',
  '通过非空 statements 集合保存陈述，并以 organization 区分事实等组织形式',
  { knowledgeId: factR1.knowledgeId, revisionId: factR1.revisionId },
);

// A source comparison made during this walkthrough; no production acceptance implied.
const partialRevisionCheck: KnowledgeReviewRecord = {
  reviewId: 'walkthrough:revision:check-01',
  target: { knowledgeId: factR2.knowledgeId, revisionId: factR2.revisionId },
  statementIds: ['fact-content'],
  reviewedAt: correctionRecordedAt, reviewedBy: correctionAuthor,
  verdict: 'supported',
  rationale: '本次源码对照确认 E5 的非空集合与 organization；本记录只覆盖 fact-content。',
  evidenceLinkIds: ['source-fragments'], supersedesReviewIds: [],
};
const factR2View: KnowledgeItem = {
  ...factR2,
  review: {
    target: partialRevisionCheck.target,
    reviewStatus: 'needs_more_context',
    reviewRefs: [partialRevisionCheck.reviewId],
    unresolvedReasons: [
      'entity-reference 尚无本修订的复核记录；不能沿用旧版判断',
      '本条 Agent 源码检查属于文档推演，生产采信策略尚未确定',
    ],
  },
};
```

</details>

<a id="successful-experience"></a>

## 附录：成功经验与方法提炼

本例取自上一轮事实修正文档的真实验证：校验脚本在临时目录中执行类型、引用检查和 VitePress 构建，进程退出码为 `0`。这是**一次成功执行的案例**，并不证明共享依赖比独立安装更快、更可靠，或已经满足完整安装验收。

| 检验点 | 本例结果与决策 |
|---|---|
| 成功如何进入知识建设 | 直接保留成功证据并形成案例，不伪装为失败型 inbox 信号 |
| 行动和结果如何表达 | 同一执行事件关联行动陈述与完成陈述，分别引用实际来源 |
| 能否提炼方法 | 可以新建带条件的方法候选，通过 `derived_from` 关联案例；不把成功结果升级为普遍能力 |
| 共享依赖是否等于完全隔离 | 只隔离临时输入与产物，依赖仍共享；不能声称是 clean-room 验收 |
| 来源是否足以重放 | 有调用、脚本片段和输出；缺少完整输入快照，明确无法完整重放 |
| 是否需要立即改载体 | 暂不新增 skill 或规则；先确认独立复用需求，再绑定具体载体版本 |

本例不新增字段。完成了一次执行的内容表达，不代表知识已获领域复核或方法已通过效果评测。三类推演目前覆盖了反馈案例、随版本更新的事实及成功经验提炼；来源解析、复核策略和实际存储按 §9 的首版契约实现并验收。

<details>
<summary>展开成功证据与完整条目示例</summary>

<a id="e6"></a>

### E6：执行与结果

`walkthrough:success:e6` 指向本对话上一轮运行 `python3 /private/tmp/check_revision_case.py` 的工具记录。该轮校验针对当时的工作树，不包括本附录新增内容；后续文档构建不能反过来改写此条运行记录。输出摘录：

```text
vitepress v1.6.4
✓ building client + server bundles...
✓ rendering pages...
build complete in 5.48s.
PASS: bilingual types match, local links resolve, strict TypeScript and VitePress build
```

工具返回的进程退出码为 `0`。`5.48s` 只是 VitePress 报出的构建耗时，不是全部验证耗时或相对收益。片段没有原始时间戳、完整环境清单或独立质量评分。

<a id="e7"></a>

### E7：执行方案来源

`walkthrough:success:e7` 指向执行脚本的选取片段；本轮读取的脚本 SHA-256 为 `f69637d93a77d2903c42392ff9e115dba5bb894ec805a00f1ffb6ba1346226ca`。脚本位于临时目录，不承诺长期存在；下列非连续片段作为本例的最小来源快照，不能冒充完整脚本。代码中的路径是该次执行环境的实际路径，不是产品存储契约或未来执行默认值。

```python
with tempfile.TemporaryDirectory(prefix='omk-model-check-',dir='/private/tmp') as tmp:
 deps=Path('/Users/lizhiyao/Documents/oh-my-knowledge/node_modules');(t/'node_modules').symlink_to(deps,target_is_directory=True)
 subprocess.run(['node',str(deps/'typescript/bin/tsc'),'-p',str(t/'tsconfig.json')],check=True)
 subprocess.run(['node',str(t/'model.js')],check=True)
 shutil.copytree(root/'docs',t/'docs',ignore=shutil.ignore_patterns('cache','dist','node_modules'))
 shutil.copy(root/'package.json',t/'package.json')
 subprocess.run(['node',str(deps/'vitepress/bin/vitepress.js'),'build',str(t/'docs')],cwd=t,check=True)
```

本例没有单独采集清理后的目录快照，因此只记录脚本使用临时目录上下文管理器，不另写「所有环境均清理成功」的知识陈述。

### 编写归属

`walkthrough:success:authoring-01` 指本轮 Agent 在 Codex 中整理已有执行证据的活动，记录时间为 `2026-09-05T15:23:11Z`。精确模型版本、参数及平台运行 ID 未取得；该时间不替代 E6 的发生时间。下面使用 §3.1 的类型；辅助函数只减少示例重复，展开后仍是两个完整条目。

```typescript
const successRecordedAt: Timestamp = '2026-09-05T15:23:11Z';
const successAuthor: KnowledgeActor = {
  actorKind: 'agent', actorId: 'walkthrough:success:author',
  executionRef: 'walkthrough:success:authoring-01',
};
function successItem(
  knowledgeId: string, title: string, content: KnowledgeContent,
  entities: NonEmpty<Entity>, evidence: NonEmpty<KnowledgeEvidenceLink>,
  derivations: readonly KnowledgeDerivation[] = [],
): KnowledgeItem {
  return {
    knowledgeId, revisionId: 'r1', title, content, entities, evidence,
    observationRefs: [], derivations,
    review: {
      target: { knowledgeId, revisionId: 'r1' },
      reviewStatus: 'pending', reviewRefs: [],
      unresolvedReasons: ['运行成功是来源事实，知识条目尚无领域复核记录'],
    },
    createdAt: successRecordedAt, createdBy: successAuthor,
    revisedAt: successRecordedAt, revisedBy: successAuthor,
    revisionReason: '依据真实验证记录提炼首个修订',
  };
}
const buildContext: KnowledgeContext = {
  scenario: 'OMK 知识文档在隔离临时目录中的验证',
  conditions: ['E6 所记录的一次执行', '依赖通过符号链接复用本机现有 node_modules'],
  exceptions: [],
  unknowns: ['未保存全部输入文件的不可变快照；不能完整重放该次构建'],
  occurredDuring: { timeKind: 'unknown', reason: '输出片段未记录原执行时间戳' },
  validDuring: { timeKind: 'not_applicable', reason: '只描述这一次执行结果' },
};
const successfulBuildCase = successItem(
  'walkthrough:success:case', '临时目录中的一次文档验证成功',
  {
    statements: [
      {
        statementId: 'execute-checks',
        subject: { entityId: 'walkthrough:success:run' },
        relation: '执行临时目录中的类型、引用检查及 VitePress 构建',
        modality: 'descriptive', polarity: 'positive', context: buildContext,
      },
      {
        statementId: 'checks-completed',
        subject: { entityId: 'walkthrough:success:run' },
        relation: '检查与构建完成，进程以退出码 0 结束',
        modality: 'descriptive', polarity: 'positive', context: buildContext,
      },
    ],
    organization: {
      knowledgeKind: 'case', situation: '验证文档草案与修订示例。',
      actionStatementIds: ['execute-checks'], outcomeStatementIds: ['checks-completed'],
      gaps: ['没有依赖全新安装、清理后目录快照或其它方案的对照实验'],
    },
  },
  [{ entityId: 'walkthrough:success:run', label: '本次文档验证执行', description: 'E6 对应的具体执行事件，不代表所有构建。' }],
  [
    {
      evidenceLinkId: 'execution-source', evidenceRef: 'walkthrough:success:e6',
      statementIds: ['execute-checks', 'checks-completed'], relation: 'supports',
      basis: 'direct_observation', interpretation: '工具调用、构建输出和退出码支持这次执行成功。',
    },
    {
      evidenceLinkId: 'procedure-source', evidenceRef: 'walkthrough:success:e7',
      statementIds: ['execute-checks'], relation: 'supports',
      basis: 'direct_observation', interpretation: '脚本片段说明临时目录、依赖链接与校验的组织方式。',
    },
  ],
);
const isolatedCheckMethod = successItem(
  'walkthrough:success:method', '在临时目录中复用已有依赖验证文档',
  {
    statements: [{
      statementId: 'isolate-doc-checks',
      subject: { entityId: 'walkthrough:success:reviewer-role' },
      relation: '可将文档和校验输入复制到临时目录，链接可用依赖，执行检查并清理临时产物',
      object: { entityId: 'walkthrough:success:doc-validation' },
      modality: 'normative', polarity: 'positive',
      context: {
        scenario: '已有可用依赖环境下的局部文档验证',
        conditions: ['校验器可在显式临时根运行', '已确认依赖适用于目标输入且不会被校验过程修改'],
        exceptions: ['打包、安装契约或 clean-room 验收不能用共享依赖验证替代'],
        unknowns: ['跨环境适用性、速度收益和检查覆盖程度尚未独立验证'],
        occurredDuring: { timeKind: 'not_applicable', reason: '候选操作方法，不是新的执行记录' },
        validDuring: { timeKind: 'unknown', reason: '适用版本与采用周期未定' },
      },
    }],
    organization: {
      knowledgeKind: 'method', purpose: '将文档验证的临时输入和产物放在显式临时目录中。',
      instructionStatementIds: ['isolate-doc-checks'],
    },
  },
  [
    { entityId: 'walkthrough:success:reviewer-role', label: '文档验证执行者', description: '未来执行方法的角色，不等于本次编写者。' },
    { entityId: 'walkthrough:success:doc-validation', label: '局部文档验证活动', description: '可重复执行的活动概念，不等于 E6 的执行事件。' },
  ],
  [{
    evidenceLinkId: 'method-source', evidenceRef: 'walkthrough:success:e7',
    statementIds: ['isolate-doc-checks'], relation: 'background', basis: 'inference',
    interpretation: '从这次执行方案提出候选方法；成功结果不证明可跨任务泛化。',
  }],
  [{
    relation: 'derived_from',
    source: { knowledgeId: successfulBuildCase.knowledgeId, revisionId: successfulBuildCase.revisionId },
    reason: '将具体执行方案抽象为有条件的复用方法，保留未经验证的适用性。',
  }],
);
```

</details>
