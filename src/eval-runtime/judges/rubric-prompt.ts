import { createHash } from 'node:crypto';

// These bytes are a measurement invariant. Any edit requires an explicit
// BREAKING-COMPARABILITY version and frozen prompt-registry update.
export const RUBRIC_LENGTH_DEBIAS_INSTRUCTION = [
  '## 重要：长度不是质量信号',
  '评分时聚焦内容实质与正确性。回答的篇幅、行文丰富度、结构复杂度本身不是质量指标 ——',
  '简洁正确的回答不应因短而扣分；冗长但偏题或重复的回答不应因长而加分。',
  '研究显示 LLM 评委容易隐性偏向更长的回答，请在打分前先警觉这一点。',
].join('\n');

export const RUBRIC_PRESENTATION_NEUTRALITY_INSTRUCTION = [
  '## 重要：排版与语气不是质量信号',
  '评分只看内容是否对照评分标准、是否正确。Markdown 排版、标题、列表、加粗、表格等呈现形式',
  '本身不是质量指标 —— 朴素但正确的回答不应因没有排版而扣分；排版精致但偏题或错误的回答不应',
  '因好看而加分。',
  '同样，回答的语气、自信程度、是否自我表扬（如「这是最优方案」）也不是质量信号 —— 不要被笃定',
  '的口吻或自我评价带跑：自信但错误的回答不应高于含糊但正确的回答，一切结论都要回到评分标准',
  '逐条核实。',
  '研究显示 LLM 评委容易隐性偏向排版精致、语气自信的回答，请在打分前先警觉这两点。',
].join('\n');

const JUDGE_PROMPT_VERSION_DEBIAS_OFF = 'v5-cot-toolargs-fmt';
const JUDGE_PROMPT_VERSION_DEBIAS_ON = 'v5-cot-toolargs-fmt-len';

export const JUDGE_SYSTEM_PROMPT = '你是一个严格的 AI 输出质量评审员。先逐条对照评分标准做推理，再给最终分数。只返回 JSON，不要其他内容。';

export function buildJudgePrompt(
  prompt: string,
  rubric: string,
  output: string,
  traceSummary: string | null,
  lengthDebias = true,
): string {
  const version = lengthDebias ? JUDGE_PROMPT_VERSION_DEBIAS_ON : JUDGE_PROMPT_VERSION_DEBIAS_OFF;
  const traceSection = traceSummary
    ? ['', '## Agent 执行过程', traceSummary, '', '请同时考虑执行过程的合理性（工具选择、步骤效率、错误恢复）。']
    : [];
  const neutralitySection = ['', RUBRIC_PRESENTATION_NEUTRALITY_INSTRUCTION];
  const debiasSection = lengthDebias ? ['', RUBRIC_LENGTH_DEBIAS_INSTRUCTION] : [];

  return [
    `请对以下 AI 输出进行质量评分（template ${version}）。`,
    '',
    '## 原始任务',
    prompt,
    '',
    '## 评分标准',
    rubric,
    '',
    '## AI 输出',
    output,
    ...traceSection,
    ...neutralitySection,
    ...debiasSection,
    '',
    '## 评分流程',
    '1. 逐条对照评分标准，先做推理（reasoning）：列出 AI 输出哪些点对应哪条标准，哪些缺失，哪些有歧义。',
    '2. 基于推理给出最终分数（1-5 的整数）和简短理由。',
    '',
    '请返回 JSON（不要包含 markdown 代码块标记）：',
    '{"reasoning": "<对照标准的逐条推理>", "score": <1-5的整数>, "reason": "<最终结论的简短理由>"}',
    '',
    '评分标准：1=完全不达标, 2=部分涉及, 3=基本达标, 4=较好, 5=优秀',
  ].join('\n');
}

export function getJudgePromptHash(lengthDebias = true): string {
  const version = lengthDebias ? JUDGE_PROMPT_VERSION_DEBIAS_ON : JUDGE_PROMPT_VERSION_DEBIAS_OFF;
  const sample = buildJudgePrompt('<P>', '<R>', '<O>', '<T>', lengthDebias);
  return createHash('sha256').update(version + '\n' + sample).digest('hex').slice(0, 12);
}
