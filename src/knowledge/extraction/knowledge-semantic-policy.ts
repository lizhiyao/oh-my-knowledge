/** Original production knowledge semantics. Refactoring these bytes must not silently retune a task. */

export const KNOWLEDGE_RECORD_SCOPE_POLICY = `工程协作中的 Issue、PR 等概念可在来源独立讨论其含义、规则或流程时识别为实体；某条 Issue、某个 PR 等具体工作记录只保留为来源或案例上下文，即使来源重点讨论该记录，也不为其编号、链接、标题、合并状态另建实体。不能把“PR #23”截成“PR”或把记录标题改成抽象概念；概念实体须有独立的来源依据。这条范围边界不排除普通具体物品、文件、组件、版本、部署实例或实际活动，仍按各自指代依据判断。`;

export const KNOWLEDGE_RECORD_CONTEXT_POLICY = `提炼工作记录中的知识时，用来源确实讨论的主题对象作陈述主体，编号、链接、标题、状态及其适用范围进入相关陈述的 context，并用 citations 直接引用相应原文；记录信息不能只藏在 description，也不能把来源说法写成已核实结果。只保留来源实际提供的标识和链接。`;

export const KNOWLEDGE_SOURCE_AND_TIME_POLICY = `事实、案例、方法是组织形式，不是可信度等级。区分直接观测、来源说法与推断；一次成功不能证明方法普遍有效。
每条陈述独立保留场景、条件、例外及未知信息；occurredDuring 表示该命题所述事实发生的时间，validDuring 表示其适用时间，不是这条来源何时发出、记录、采集或被提取。excerpt.timestamp 只提供来源记录时间，不能仅凭它把状态、既有能力、未完成验收、规则或未来要求填为精确事实时点，也不能当作适用区间的起止。source_assertion、context 中的归因或 validDuring 为 unknown 都不能抵消 occurredDuring 的无据精度。
已知事实时间必须由支持该命题的原文或明确事件证据提供，保留来源支持的精度、时区和条件；来源未给事实时间或无法无歧义推导时使用 unknown，不用消息时间、当前时间、默认午夜或猜测补齐。未来规范要求不表示执行已经发生；其执行时间与适用时间分别判断。原文明示的事件时刻应保留，即使恰好与 excerpt.timestamp 相同也不因此丢弃；相同或不同都不是时间有效性的判据。只给日期或相对时间时，不能补造毫秒、时区或无限适用性；不确定的发生时间和适用时间各自明确为 unknown。
不要把原文中的具体结论缩成泛泛定义：影响结论成立的前提、反例、限制和未验证环节必须进入对应陈述的 context，而不只放在 reuseRationale。
后续明确纠正或收窄前文时，按该纠正重新判断相关指代与当前说法，并引用纠正依据；保留仍影响复用的被否定做法和失败边界。不同说话者的矛盾不按最后时间自动裁决；无法确定时保留冲突与来源。纠正身份不证明关于该对象的结果真实。窗口未包含最终结果时保留未知，不从窗口外补结论。
助手自述测试成功、已修复或已发布属于来源说法；没有对应工具证据时不能提升为直接观测，合并、发布与线上验证分别陈述。`;

export const KNOWLEDGE_MODALITY_POLICY = `relation 与 polarity 一起表达命题，先判断否定作用于行动、必要性还是禁止状态，再选择 modality；否定只表达一次。“不应修改 SDK”是负向规范：normative、relation 为“修改”、polarity 为 negative；不能写“不应修改”又加 negative。负向要求不等于描述性事实。否定必要性或禁止状态时，relation 必须保留被否定的模态谓词，不能一律退化为行动本身：“无需修改 SDK”描述本场景没有修改必要性，可写 descriptive、relation 为“需要修改”、polarity 为 negative；不能写 normative／negative 的“修改”，也不表示 SDK 未被修改。“未禁止修改 SDK”描述禁止状态不存在，可写 descriptive、relation 为“修改受到禁止”、polarity 为 negative；不能推导为要求修改、明确允许修改或已经修改。只有来源明确授权才写 permission／positive 的“修改”，明确禁止才写 permission／negative 的“修改”；“不应”表达 normative／negative。这些是语义示例，不是按关键词分类：技术上无法修改属于 capability／negative，不能当禁令。“尚未失败”保留来源在该范围内的未失败主张，不能改成只有“没有失败证据”，也不能改写为“成功”。转述的规范仍保留 normative 或 permission 语气，在 context 记录说话者、条件、时间和适用范围，证据 basis 为 source_assertion，不因转述就把要求改成已执行的事实。context 不能挽救已强化或否定范围错误的 relation／modality／polarity；无法无歧义表达时保留未知或不提炼该陈述。`;

export const KNOWLEDGE_ATOMIC_STATEMENT_POLICY = `一条 statement 只表达一个具有统一 modality 和 polarity 的命题。并列的肯定／否定、规范／事实须拆成不同 statementId，分别保留端点、条件和支持证据；不能用 context 解释“negative 只否定 relation 的后半句”。例如“Session 总数应按初始化记录计算，状态更新不应增加分母”拆为两条 normative 陈述：Session 的“总数按初始化记录计算”为 positive；Session 的“状态更新增加分母”为 negative，relation 不再含“不应”。条件、例外和一个谓词的组合对象不机械拆分；“A 与 B 一起完成验证”是一个集体活动，不能拆成各自完成。证据链接可以支持多条陈述，但须逐条引用，拆分不补造来源没有的事实。`;

export const KNOWLEDGE_CITATION_POLICY = `多个陈述分别引用支持它们的来源，不以背景引用冒充支持。对已提炼知识，逐项核对会改变判断或复用方式的目的、条件、约束、例外、纠正和未验证限制；对应陈述的证据关联须有 citations 直接选中承载这些依据的连续原文。依据分散在不同位置时分别引用，不能只引用同一消息中的背景、对象的早期名称，或用 rationale／description 代替关键依据；也不能只给整条消息引用让用户自行查找。引文保留理解依据所需的上下文，不把关键词孤立成支持。`;

/** Shared source-supported referent levels, not a semantic classifier. */
export const ENTITY_REFERENT_KIND_POLICY = `- object：普通事物、文件、工具、字段、规则、接口、抽象概念及一般操作概念等所指。抽象性质或概念可以是 object，不因它不是具体物品就排除；它可能有实例或多个部分，也不自动成为 collection。已知对象但缺少更具体类型依据时可用 object、identityStatus=proposed，并在 uncertainties 写明不足，不能用 object 回避来源已经明确的层次。
- component：来源支持其持续系统／模块职责的对象；明确的库维护、升级或类的继承与覆写职责可以提供依据，不要求逐字出现“模块”。只有名称、一次调用、故障、某个函数或部署环境不足以证明 component。
- instance：来源明确指认的部署或运行实例。测试／生产等条件变化本身不创建实例；同一实例的状态改变不自动变成新身份，明确的替换、复制或不同实例须分开。
- version：来源独立指向、比较、测试或归档的具体版本对象或固定代码／制品状态。不要求一定有提交号，但未知标识、发布状态与复现范围须保留。持续移动的分支或持续迭代的规范不是仅凭名称就成为固定版本；版本字符串作为条件时不机械另建对象。
- collection：来源共同指代或整体计量的明确有界组。集合主体身份与成员完整性分别判断；类别的可能实例、复数形式、数目或单一制品的多个部分不自动形成集合。
- plan：来源独立讨论的计划对象；计划、它要求的行为与对应执行分别判断，计划身份不证明已经执行。
- activity：来源独立指认的一次实际或计划中的执行活动；不同执行不因同名共享身份，计划中的活动不表示已经发生。一般方法或可重复的操作概念不因此成为一次 activity。
这是所指层次，不新增水果、公司、软件等类别字段。没有充分类型依据时保留不足；没有语义对应依据时不能靠换一个类型消除身份歧义。`;
