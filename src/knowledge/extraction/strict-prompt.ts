import { EXTRACTION_PROMPT } from './prompt.js';
import { WINDOW_EXTRACTION_WIRE_SCHEMA_JSON } from './model-wire.js';
import { STRICT_EXTRACTION_FEWSHOT_BLOCK } from './strict-fewshot.js';

/** Scope rules and few-shot rendering have their own identity; historical assets retain their frozen bytes. */
export const STRICT_EXTRACTION_PROMPT_VERSION = 'knowledge-extraction-v32' as const;
const finalOutputRule = '输出纯 JSON 对象，responseKind 为 knowledge-extraction，schemaVersion 为 4，不要 Markdown 围栏。整个响应严格遵守以下 JSON Schema：\n';
const boundary = EXTRACTION_PROMPT.indexOf(finalOutputRule);
if (boundary < 0 || EXTRACTION_PROMPT.lastIndexOf(finalOutputRule) !== boundary) throw new Error('Extraction prompt final output rule changed; re-audit strict prompt rendering.');

// Share the current semantic rules and strict transport instructions. Demonstrations
// ship as production literals, without a runtime dependency on benchmark assets.
const wireInstructions = `
以下仅适配 strict-wire 传输，不改变前述实体识别、知识提炼、原文定位和引用闭合规则。输出仍为 knowledge-extraction／Schema v4，并遵守末尾的唯一 wire JSON Schema。
wire Schema 将原领域中非 nullable 的 optional 字段表示为 required＋nullable：原领域字段确实缺省时，使用 null 占位。没有二元对象的 statement 使用 "object":null；selection 中原本缺省的 occurrence 使用 "occurrence":null。已有 occurrence 整数（包括 0）或 object 引用原样保留，不能为了填字段虚构对象或把重复引文的精确序号换成 null。
宿主只移除这两类原非 nullable optional 字段的 null 占位，再执行原领域检查；componentRef、collection 等原本允许 null 的领域字段仍保留其原值。结构符合 wire 不替代前述语义、逐字定位和证据检查。
`;
// The plain v29 task and historical strict versions keep their own measurement identities.
const selectionAnchor = '再提炼少量值得未来复用的事实、案例或方法。';
const semantics = EXTRACTION_PROMPT.slice(0, boundary);
if (semantics.split(selectionAnchor).length !== 2) throw new Error('Extraction selection rule changed; re-audit strict prompt rendering.');
const knowledgeSelection = `
按来源中的复用意义选择知识，不以少量或已解决为目标压缩内容。一次技术讨论中的问题也可构成可复用案例或来源主张；只有完成状态、编号或无复用意义的背景仍可不提炼，不要求为每段话、每个实体或每次操作生成候选，proposals 仍允许为空。
逐项保留会改变后续判断的原始问题与实际／预期差别、方案的适用条件和未解决异议、试探性提议及针对它的反驳、纠正与明确的否定支持边界。不能因为后文给出一个解释、绕行或替代建议，就省略尚未解决的问题、被收窄的方案或不支持的范围；不同说话者的分歧仍保留来源，不按最后一条自动裁决。
来源用不同环境、配置、代码位置或运行阶段／时点对照同一问题时，保留各自的条件、所报告表现和仍未解释的差异，不能让后来的原因解释覆盖先前的对照或反例。这些内容进入相关 statement 或 context.conditions／exceptions，并分别引用直接来源，不能只留下环境名称或总结结论。某个条件下的结果仅在未选图片／内容中，或来源未说清时，保留该对照条件和结果未知，不推断图片内容或补造相同／不同结果。
这些内容须进入实际 statements 及各自的 evidence／citations，不能只留实体名称、description、qualifiers、组织描述、gaps、reuseRationale 或引用后就视为已提炼。一个候选可包含多条有独立肯否和语气的陈述；必要时分别组织候选，不为节省条目合并不同命题或省掉限制。
沿用 fact／case／method 组织，不为保存提议、问题或未执行要求补造案例行动和结果。fact 也可组织“某参与者报告问题、提出方案或反驳”的描述性来源主张，不代表该说法已核实。试探性、请求与建议保留原语气、说话者和条件，不能提升为可用配置、已实现、已接受、已发布或已验证方法；实现、性能、有效时间和最终结果没有来源依据时保持未知。
输出前在本次响应内回看所选主题：上述会影响判断的信息是否确实由 statements 表达并有直接原文支持，是否把提议当实现、把绕行当支持或把无证据当否定事实。只修正本响应，不增加调用、不返回清单或复核结论，也不声称语义完整性已获验证。
`;
export const STRICT_EXTRACTION_PROMPT = semantics.replace(selectionAnchor, '再提炼值得未来复用的事实、案例或方法。') + knowledgeSelection + wireInstructions
  + STRICT_EXTRACTION_FEWSHOT_BLOCK + '\n' + finalOutputRule + WINDOW_EXTRACTION_WIRE_SCHEMA_JSON;
