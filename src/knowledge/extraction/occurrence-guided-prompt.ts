import { createHash } from 'node:crypto';
import { ENTITY_ONLY_EXTRACTION_PROMPT } from './entity-only-prompt.js';
import type { ExtractionPromptProfile } from './generation.js';

export const OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION = 'knowledge-extraction-v37' as const;

/** Explicit research task: E36 semantics with a deterministic, source-derived position aid. */
export const OCCURRENCE_GUIDED_EXTRACTION_PROMPT = ENTITY_ONLY_EXTRACTION_PROMPT + `
八、使用原文定位目录核对重复引文。
输入额外提供 occurrenceGuide，guideKind=knowledge-body-occurrence-guide/v1。它只从 github_issue_body 与 github_issue_comment_body 原文生成重复 ASCII 词形的定位辅助，不是实体候选、身份依据、参考答案或额外事实。全部 excerpts 与 limitations 仍完整保留；没有收录的词形、中文、复合提及、代词、唯一引文及其它来源仍须按前述规则独立分析，不因未进目录而排除实体或提及。
每个 group 绑定原来的 evidenceRef 与 eventKind；panels 中的 start/end/text 是同一选段的逐字 UTF-16 原文切片。为共享上下文，重叠或相邻区间会合并，面板不代表一条提及的专属语境。terms 的每行是 [quote, positions]，positions 的每项为 [occurrence, start, end]；occurrence 从零开始，在整个对应选段内按原文出现顺序计数，跨面板连续，包含重叠匹配与其它标识内部的同形子串。位置和面板只辅助返回原文核对，出现于其它标识内部不自动构成该对象的提及。
为每条实际提及选择有语义依据的原文 quote，并依据该处语境解释 rationale。若选用目录中的重复 quote，可据它的全选段序号核对 occurrence，再回完整原文确认；改选了更长或不同的 quote 时必须按新 quote 重新计数，不能沿用另一词形的序号。没有收录的引文同样按原文精确定位。selection 仍只输出 evidenceRef、quote、occurrence，唯一匹配用 null；不返回面板、start/end、目录字段或额外报告。定位成功不证明实体资格、身份、类型或语义正确，proposals 仍必须为 []。
`;

export const OCCURRENCE_GUIDED_EXTRACTION_SYSTEM_DIGEST = 'sha256:06568758fa41d4763c7c5f819c93cc5859f8a70aa661f3b4bd38499d52feba79' as const;
if (Buffer.from(OCCURRENCE_GUIDED_EXTRACTION_PROMPT, 'utf8').toString('utf8') !== OCCURRENCE_GUIDED_EXTRACTION_PROMPT
  || `sha256:${createHash('sha256').update(OCCURRENCE_GUIDED_EXTRACTION_PROMPT, 'utf8').digest('hex')}` !== OCCURRENCE_GUIDED_EXTRACTION_SYSTEM_DIGEST) {
  throw new Error('Occurrence-guided extraction prompt differs from its frozen raw UTF-8 identity.');
}

export const OCCURRENCE_GUIDED_EXTRACTION_PROFILE = Object.freeze({
  profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
  promptVersion: OCCURRENCE_GUIDED_EXTRACTION_PROMPT_VERSION,
  system: OCCURRENCE_GUIDED_EXTRACTION_PROMPT,
}) satisfies Readonly<ExtractionPromptProfile>;
