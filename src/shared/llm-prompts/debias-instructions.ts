// 评委 prompt 的共享去偏 / 中性化指令 —— 单一来源。
//
// 此前这几段在 grading/judge.ts(rubric 评委)与 grading/assertions.ts(RAG 评委)各写一份,
// 改一处漏一处(J3 即如此)。统一收口于此,两侧 import。
//
// 两套变体是有意的、不要强并成一条:
//   - 全版(LENGTH_DEBIAS_INSTRUCTION / PRESENTATION_NEUTRALITY_INSTRUCTION):给 rubric 评委,
//     带研究依据句;rubric prompt 较短,容得下。被 getJudgePromptHash 冻结,改字节 = BREAKING-COMPARABILITY。
//   - 短版(RAG_LENGTH_DEBIAS / RAG_PRESENTATION_NEUTRALITY):给 RAG 评委,RAG prompt 本就长,精简表述。
// 改任一段先想另一段是否同步;改全版还要走冻结 hash 的 bump 流程。

export const LENGTH_DEBIAS_INSTRUCTION = [
  '## 重要：长度不是质量信号',
  '评分时聚焦内容实质与正确性。回答的篇幅、行文丰富度、结构复杂度本身不是质量指标 ——',
  '简洁正确的回答不应因短而扣分；冗长但偏题或重复的回答不应因长而加分。',
  '研究显示 LLM 评委容易隐性偏向更长的回答，请在打分前先警觉这一点。',
].join('\n');

// 始终开启(不给开关):排版与语气都不是质量信号。措辞严格对称 —— 既不奖励精致 / 自信,也不
// 因朴素 / 含糊而扣分,避免"抗偏置"本身过度矫正成反向偏置。研究表明 LLM 评委除长度外,还隐性
// 偏向排版精致(format / markdown bias)与语气自信、自我表扬的回答(谄媚 / 权威偏置)。
export const PRESENTATION_NEUTRALITY_INSTRUCTION = [
  '## 重要：排版与语气不是质量信号',
  '评分只看内容是否对照评分标准、是否正确。Markdown 排版、标题、列表、加粗、表格等呈现形式',
  '本身不是质量指标 —— 朴素但正确的回答不应因没有排版而扣分；排版精致但偏题或错误的回答不应',
  '因好看而加分。',
  '同样，回答的语气、自信程度、是否自我表扬（如「这是最优方案」）也不是质量信号 —— 不要被笃定',
  '的口吻或自我评价带跑：自信但错误的回答不应高于含糊但正确的回答，一切结论都要回到评分标准',
  '逐条核实。',
  '研究显示 LLM 评委容易隐性偏向排版精致、语气自信的回答，请在打分前先警觉这两点。',
].join('\n');

// RAG 指标(faithfulness / answer_relevancy / context_recall)的去偏**恒开**,
// 按 default-strict 不提供关闭开关:`--no-debias-length` 只作用于 rubric 评委 prompt 的长度去偏,
// 不下探到 RAG —— RAG 评的是内容保真 / 切题 / 召回,放任长度 / 排版 / 语气偏置只会污染这些指标,
// 没有「关掉它」的正当用例。故 runRagJudge 不收 lengthDebias 参数,两段恒注入。
export const RAG_LENGTH_DEBIAS = [
  '## 重要：长度不是质量信号',
  '评分时聚焦内容实质，不要因输出更长就给更高分。',
  '简洁正确的回答与冗长正确的回答应得相同分数。',
].join('\n');

// 排版 / 语气中性化(format / sycophancy bias),与 RAG_LENGTH_DEBIAS 同 footprint 恒开。
export const RAG_PRESENTATION_NEUTRALITY = [
  '## 重要：排版与语气不是质量信号',
  '评分只看内容是否符合上述标准。排版是否精致、语气是否自信、有无自我表扬都不是质量信号 ——',
  '不要被笃定的口吻带跑：自信但错误的回答不应高于含糊但正确的回答。',
].join('\n');
