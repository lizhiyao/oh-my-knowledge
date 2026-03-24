/**
 * Mixed grading: deterministic assertions + LLM judge + multi-dimensional scoring.
 */

/**
 * Grade a model output against a sample's criteria.
 *
 * @param {object} opts
 * @param {string} opts.output - Model output text
 * @param {object} opts.sample - Sample definition (rubric, assertions, dimensions)
 * @param {Function} opts.executor - Executor function for LLM judge calls
 * @param {string} opts.judgeModel - Model name for LLM judge
 * @returns {Promise<{compositeScore, assertions?, llmScore?, llmReason?, dimensions?}>}
 */
export async function grade({ output, sample, executor, judgeModel }) {
  const results = {};

  // 1. Deterministic assertions (pure, no LLM)
  if (sample.assertions?.length > 0) {
    results.assertions = runAssertions(output, sample.assertions);
  }

  // 2. LLM scoring
  if (sample.dimensions && Object.keys(sample.dimensions).length > 0) {
    // Multi-dimensional scoring
    results.dimensions = {};
    for (const [dim, rubric] of Object.entries(sample.dimensions)) {
      results.dimensions[dim] = await llmJudge({
        output,
        rubric,
        prompt: sample.prompt,
        executor,
        model: judgeModel,
      });
    }
    const dimScores = Object.values(results.dimensions)
      .map((d) => d.score)
      .filter((s) => s > 0);
    if (dimScores.length > 0) {
      results.llmScore = Number((dimScores.reduce((a, b) => a + b, 0) / dimScores.length).toFixed(2));
    }
  } else if (sample.rubric) {
    // Single rubric scoring
    const judge = await llmJudge({
      output,
      rubric: sample.rubric,
      prompt: sample.prompt,
      executor,
      model: judgeModel,
    });
    results.llmScore = judge.score;
    results.llmReason = judge.reason;
    results.judgeCostUSD = judge.judgeCostUSD;
  }

  // 3. Composite score
  results.compositeScore = computeComposite(results);

  return results;
}

/**
 * Run deterministic assertions against output text.
 * Pure function — no async, no LLM calls.
 *
 * @param {string} output - Model output
 * @param {Array} assertions - Assertion definitions
 * @returns {{passed, total, score, details}}
 */
export function runAssertions(output, assertions) {
  const outputLower = output.toLowerCase();
  const details = [];

  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    let passed = false;

    switch (assertion.type) {
      case 'contains':
        passed = outputLower.includes(String(assertion.value).toLowerCase());
        break;
      case 'not_contains':
        passed = !outputLower.includes(String(assertion.value).toLowerCase());
        break;
      case 'regex': {
        const flags = assertion.flags || 'i';
        const re = new RegExp(assertion.pattern, flags);
        passed = re.test(output);
        break;
      }
      case 'min_length':
        passed = output.length >= assertion.value;
        break;
      case 'max_length':
        passed = output.length <= assertion.value;
        break;
      default:
        passed = false;
    }

    details.push({
      type: assertion.type,
      value: assertion.value || assertion.pattern || '',
      weight,
      passed,
    });
  }

  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  const passedCount = details.filter((d) => d.passed).length;

  // Normalize to 1-5 scale
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const score = Number((1 + ratio * 4).toFixed(2)); // 1.0 ~ 5.0

  return {
    passed: passedCount,
    total: details.length,
    score,
    details,
  };
}

/**
 * LLM judge: ask a model to score output against a rubric.
 */
async function llmJudge({ output, rubric, prompt, executor, model }) {
  const judgePrompt = [
    '请对以下 AI 输出进行质量评分。',
    '',
    '## 原始任务',
    prompt,
    '',
    '## 评分标准',
    rubric,
    '',
    '## AI 输出',
    output,
    '',
    '请返回 JSON（不要包含 markdown 代码块标记）：',
    '{"score": <1-5的整数>, "reason": "<简短理由>"}',
    '',
    '评分标准：1=完全不达标, 2=部分涉及, 3=基本达标, 4=较好, 5=优秀',
  ].join('\n');

  const result = await executor({
    model,
    system: '你是一个严格的 AI 输出质量评审员。只返回 JSON，不要其他内容。',
    prompt: judgePrompt,
  });

  if (!result.ok) return { score: 0, reason: `judge error: ${result.error}`, judgeCostUSD: result.costUSD };

  try {
    const text = result.output.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { score: 0, reason: 'judge returned non-JSON', judgeCostUSD: result.costUSD };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Number(parsed.score) || 0,
      reason: String(parsed.reason || ''),
      judgeCostUSD: result.costUSD,
    };
  } catch {
    return { score: 0, reason: 'failed to parse judge response', judgeCostUSD: result.costUSD };
  }
}

/**
 * Compute composite score from assertion and LLM results.
 * If both exist, weighted average (50/50). Otherwise use whichever is available.
 */
function computeComposite(results) {
  const hasAssertions = results.assertions && results.assertions.score > 0;
  const hasLlm = typeof results.llmScore === 'number' && results.llmScore > 0;

  if (hasAssertions && hasLlm) {
    return Number(((results.assertions.score + results.llmScore) / 2).toFixed(2));
  }
  if (hasAssertions) return results.assertions.score;
  if (hasLlm) return results.llmScore;
  return 0;
}
