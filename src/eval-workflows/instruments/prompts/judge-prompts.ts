import { createHash } from 'node:crypto';
import { RAG_LENGTH_DEBIAS, RAG_PRESENTATION_NEUTRALITY } from './debias-instructions.js';
export {
  buildJudgePrompt,
  getJudgePromptHash,
  JUDGE_SYSTEM_PROMPT,
} from '../../../eval-runtime/judges/rubric-prompt.js';

// 评分类 prompt 稳定 façade。公共 rubric 主评委的单一来源位于 eval-runtime；
// RAG 与语义相似度等 OMK 产品工作流 prompt 仍由本模块拥有。
// 这些是测量学不变量:文本字节决定可比性,改动须配合 prompt-registry 的冻结 hash bump
// (BREAKING-COMPARABILITY)。执行器调用 / JSON 解析逻辑位于 Evaluation Core runtime adapter。

// ===========================================================================
// Rubric 主评委 prompt
// ===========================================================================

/**
 * Judge prompt template version.
 *
 * The version string encodes WHICH debias / context features the judge sees, so sealed
 * evaluation plans carrying the same prompt hash use the same instrument. A mismatched
 * hash means "we changed how we ask the judge to think". Bump it (and the
 * frozen hashes in `test/measurement-governance/prompt-registry-freeze.test.ts`) whenever the template's bytes
 * change — that change is BREAKING-COMPARABILITY.
 *
 * Naming: a single main version (`v5`) + a `-feature` suffix per debias/context capability.
 * The only asymmetry between the two strings is the `-len` suffix, gated by the
 * `--no-debias-length` toggle; every other feature is always-on and appears in both.
 */
// 版本演进(内嵌"评委看到什么 / 被要求忽略什么"的语义):
//   v2-cot               : 仅看 output + rubric + 工具名分布(早期 buildTraceSummary)
//   v3-cot-length        : 加 length-debias 指令
//   v3-cot-toolargs(off) / v4-cot-len-args(on)
//                        : 加 tool input 预览(让评委识别 wrapper-style skill 在 Bash 命令里的
//                          真实语义调用,如 `Bash: mcporter --tool X`,否则误判"只调了 Bash")
//   v5-cot-toolargs-fmt(off) / v5-cot-toolargs-fmt-len(on)
//                        : 加排版 / 语气中性化指令(始终开启,不给开关)。研究表明 LLM 评委除了
//                          偏向更长的回答,还隐性偏向排版精致(标题 / 列表 / 加粗)与语气自信 / 自我
//                          表扬(谄媚 / 权威偏置)的回答;显式指令要求评委只对照评分标准核内容。
//                          同时借此把命名统一成单一主序号(v5)+ feature 后缀,`-len` 仍是开关那条。
// ===========================================================================
// 语义相似度评委 prompt（semantic_similarity 断言）
// ===========================================================================

export const SEMANTIC_SIMILARITY_SYSTEM = '你是语义相似度评审员。只返回 JSON，不要其他内容。';

export function buildSemanticSimilarityPrompt(reference: string, output: string): string {
  return [
    '请判断以下两段文本的语义相似度。',
    '',
    '## 参考文本',
    reference,
    '',
    '## 待评估文本',
    output,
    '',
    '请返回 JSON（不要包含 markdown 代码块标记）：',
    '{"score": <1-5的整数>, "reason": "<简短理由>"}',
    '',
    '评分：1=完全无关, 2=略有关联, 3=部分相似, 4=大致相同, 5=高度一致',
  ].join('\n');
}

// ===========================================================================
// RAG 评委 prompt（faithfulness / answer_relevancy / context_recall 断言）
// ===========================================================================

export type RagJudgeType = 'faithfulness' | 'answer_relevancy' | 'context_recall';

export interface RagJudgeFields {
  output: string;
  /** faithfulness: 参考 context。 */
  context?: string;
  /** answer_relevancy: 用户问题(sample.prompt)。 */
  question?: string;
  /** context_recall: 参考 gold。 */
  reference?: string;
}

/** RAG 评委 system + 用户 prompt。缺字段的早退 / 解析逻辑留在 assertions.ts。 */
export function buildRagJudgePrompt(type: RagJudgeType, fields: RagJudgeFields): { system: string; prompt: string } {
  if (type === 'faithfulness') {
    return {
      system: '你是 RAG 评审员,专注判断输出是否被参考 context 支持。只返回 JSON。',
      prompt: [
        '请判断"待评估输出"中的事实性陈述是否被"参考 context"支持。',
        '',
        '## 参考 context',
        fields.context ?? '',
        '',
        '## 待评估输出',
        fields.output,
        '',
        RAG_LENGTH_DEBIAS,
        RAG_PRESENTATION_NEUTRALITY,
        '',
        '## 评分流程',
        '1. 列出待评估输出中所有事实性陈述',
        '2. 逐条判断是否能在 context 中找到支持',
        '3. 给出 1-5 分:',
        '   5 = 全部陈述都有 context 支持,无编造',
        '   4 = 多数有支持,有 1-2 处不重要的编造',
        '   3 = 一半有支持',
        '   2 = 多数无支持',
        '   1 = 完全编造或与 context 矛盾',
        '',
        '请返回 JSON(不要 markdown 代码块):',
        '{"score": <1-5的整数>, "reason": "<简短理由>"}',
      ].join('\n'),
    };
  }
  if (type === 'answer_relevancy') {
    return {
      system: '你是答题切题度评审员。只返回 JSON。',
      prompt: [
        '请判断"AI 输出"是否直接、切题地回答了"用户问题"。',
        '',
        '## 用户问题',
        fields.question ?? '',
        '',
        '## AI 输出',
        fields.output,
        '',
        RAG_LENGTH_DEBIAS,
        RAG_PRESENTATION_NEUTRALITY,
        '',
        '## 评分',
        '5 = 完整切题回答,无冗余无遗漏',
        '4 = 切题但有少量冗余或小遗漏',
        '3 = 部分切题,部分跑题或避而不答',
        '2 = 大部分跑题',
        '1 = 完全跑题或拒答',
        '',
        '请返回 JSON(不要 markdown 代码块):',
        '{"score": <1-5的整数>, "reason": "<简短理由>"}',
      ].join('\n'),
    };
  }
  // context_recall
  return {
    system: '你是 context 覆盖率评审员。只返回 JSON。',
    prompt: [
      '请判断"参考 gold"中的关键事实在"AI 输出"中被覆盖的程度。',
      '',
      '## 参考 gold',
      fields.reference ?? '',
      '',
      '## AI 输出',
      fields.output,
      '',
      RAG_LENGTH_DEBIAS,
      RAG_PRESENTATION_NEUTRALITY,
      '',
      '## 评分流程',
      '1. 列出参考中的关键事实(忽略修饰性内容)',
      '2. 检查每条是否在输出中被提及/使用',
      '3. 给出 1-5 分:',
      '   5 = 全部关键事实被覆盖',
      '   4 = 大部分覆盖,缺 1-2 条次要事实',
      '   3 = 一半覆盖',
      '   2 = 仅覆盖少量',
      '   1 = 完全未覆盖',
      '',
      '请返回 JSON(不要 markdown 代码块):',
      '{"score": <1-5的整数>, "reason": "<简短理由>"}',
    ].join('\n'),
  };
}

/** 评分类断言 prompt 的 drift-detection hash(占位符输入,12 位,仅供 prompt-registry 冻结)。 */
function hashPromptSample(label: string, system: string, prompt: string): string {
  return createHash('sha256').update(`${label}\n${system}\n${prompt}`).digest('hex').slice(0, 12);
}

export function getSemanticPromptHash(): string {
  return hashPromptSample('semantic_similarity', SEMANTIC_SIMILARITY_SYSTEM, buildSemanticSimilarityPrompt('<R>', '<O>'));
}

export function getRagJudgePromptHash(type: RagJudgeType): string {
  const fields: RagJudgeFields = { output: '<O>', context: '<C>', question: '<Q>', reference: '<R>' };
  const { system, prompt } = buildRagJudgePrompt(type, fields);
  return hashPromptSample(`rag:${type}`, system, prompt);
}
