import { EXTRACTION_PROMPT } from './prompt.js';
import { WINDOW_EXTRACTION_WIRE_SCHEMA_JSON } from './model-wire.js';

/** New strict transport identity. Original v14 bytes and the four-example candidate remain separate. */
export const STRICT_EXTRACTION_PROMPT_VERSION = 'knowledge-extraction-v15' as const;
const finalOutputRule = '输出纯 JSON 对象，responseKind 为 knowledge-extraction，schemaVersion 为 4，不要 Markdown 围栏。整个响应严格遵守以下 JSON Schema：\n';
const boundary = EXTRACTION_PROMPT.indexOf(finalOutputRule);
if (boundary < 0 || EXTRACTION_PROMPT.lastIndexOf(finalOutputRule) !== boundary) throw new Error('Extraction prompt final output rule changed; re-audit strict prompt rendering.');

// Identical to the frozen v14-derived-strict control: transport instructions only,
// with no few-shot block and no runtime read of benchmark/candidate assets.
const wireInstructions = `
以下仅适配 strict-wire 传输，不改变前述实体识别、知识提炼、原文定位和引用闭合规则。输出仍为 knowledge-extraction／Schema v4，并遵守末尾的唯一 wire JSON Schema。
wire Schema 将原领域中非 nullable 的 optional 字段表示为 required＋nullable：原领域字段确实缺省时，使用 null 占位。没有二元对象的 statement 使用 "object":null；selection 中原本缺省的 occurrence 使用 "occurrence":null。已有 occurrence 整数（包括 0）或 object 引用原样保留，不能为了填字段虚构对象或把重复引文的精确序号换成 null。
宿主只移除这两类原非 nullable optional 字段的 null 占位，再执行原领域检查；componentRef、collection 等原本允许 null 的领域字段仍保留其原值。结构符合 wire 不替代前述语义、逐字定位和证据检查。
`;
export const STRICT_EXTRACTION_PROMPT = EXTRACTION_PROMPT.slice(0, boundary) + wireInstructions + finalOutputRule + WINDOW_EXTRACTION_WIRE_SCHEMA_JSON;
