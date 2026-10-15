import { z } from 'zod';
import { extractJsonObject } from '../../shared/llm-json.js';

export const SKILL_EDIT_SYSTEM_PROMPT = `版本：omk.skill-edits/v1
你是 skill 最小编辑助手。只针对给定原文与修复目标生成编辑，不调用工具或直接写文件。
只输出合法 JSON：{"summary":"一句话说明","edits":[{"oldText":"原文片段","newText":"替换片段"}]}。
每个 oldText 必须非空，并在应用前面编辑后的文本中恰好出现一次。省略不需要的编辑；无须修改时 edits 为 []。
保留有效内容、核心约束和无关段落的原始字节，不重排结构，不写真实 token、账号或工号。`;

const ResponseSchema = z.object({
  summary: z.string().max(1_000),
  edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() }).strict()).max(100),
}).strict();

export function applySkillTextEdits(source: string, response: string): Readonly<{
  content: string;
  summary: string;
  editCount: number;
}> {
  const parsed = ResponseSchema.parse(extractJsonObject(response));
  let content = source;
  let editCount = 0;
  for (const { oldText, newText } of parsed.edits) {
    const index = content.indexOf(oldText);
    if (index < 0 || content.indexOf(oldText, index + 1) !== -1) {
      throw new Error('Skill edit must match exactly one source fragment.');
    }
    if (oldText === newText) continue;
    content = content.slice(0, index) + newText + content.slice(index + oldText.length);
    editCount += 1;
  }
  return Object.freeze({
    content,
    summary: parsed.summary.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '),
    editCount,
  });
}
