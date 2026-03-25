/**
 * Mixed grading: deterministic assertions + LLM judge + multi-dimensional scoring.
 */

import { resolve } from 'node:path';
import Ajv from 'ajv';

// Async assertion types that need LLM or dynamic imports
const ASYNC_ASSERTION_TYPES = new Set(['semantic_similarity', 'custom']);

// Score scale: maps pass ratio (0.0~1.0) to score (SCORE_MIN~SCORE_MAX)
const SCORE_MIN = 1;
const SCORE_MAX = 5;
const SCORE_RANGE = SCORE_MAX - SCORE_MIN;

// Custom assertion timeout (ms)
const CUSTOM_ASSERTION_TIMEOUT_MS = 30_000;

function ratioToScore(ratio) {
  return Number((SCORE_MIN + ratio * SCORE_RANGE).toFixed(2));
}

/**
 * Grade a model output against a sample's criteria.
 *
 * @param {object} opts
 * @param {string} opts.output - Model output text
 * @param {object} opts.sample - Sample definition (rubric, assertions, dimensions)
 * @param {Function} opts.executor - Executor function for LLM judge calls
 * @param {string} opts.judgeModel - Model name for LLM judge
 * @param {object} [opts.execMetrics] - Execution metrics { costUSD, durationMs }
 * @param {string} [opts.samplesDir] - Directory of samples file (for resolving custom assertion paths)
 * @returns {Promise<{compositeScore, assertions?, llmScore?, llmReason?, dimensions?}>}
 */
export async function grade({ output, sample, executor, judgeModel, execMetrics = {}, samplesDir = '.' }) {
  const results = {};

  // 1. Deterministic assertions (pure, no LLM)
  const allAssertions = sample.assertions || [];
  const syncAssertions = allAssertions.filter((a) => !ASYNC_ASSERTION_TYPES.has(a.type));
  const asyncAssertions = allAssertions.filter((a) => ASYNC_ASSERTION_TYPES.has(a.type));

  if (syncAssertions.length > 0) {
    results.assertions = runAssertions(output, syncAssertions, execMetrics);
  }

  // 1b. Async assertions (custom JS, semantic_similarity)
  if (asyncAssertions.length > 0 && executor) {
    const asyncResults = await runAsyncAssertions(output, asyncAssertions, {
      executor, judgeModel, sample, samplesDir,
    });
    if (results.assertions) {
      // Merge async results into sync results
      results.assertions.details.push(...asyncResults.details);
      results.assertions.total += asyncResults.total;
      results.assertions.passed += asyncResults.passed;
      // Recompute score from merged details
      const allDetails = results.assertions.details;
      const totalWeight = allDetails.reduce((s, d) => s + d.weight, 0);
      const passedWeight = allDetails.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
      const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
      results.assertions.score = ratioToScore(ratio);
    } else {
      results.assertions = asyncResults;
    }
    // Accumulate async assertion judge cost
    if (asyncResults.judgeCostUSD > 0) {
      results.judgeCostUSD = (results.judgeCostUSD || 0) + asyncResults.judgeCostUSD;
    }
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
    const dimValues = Object.values(results.dimensions);
    const dimScores = dimValues.map((d) => d.score).filter((s) => s > 0);
    if (dimScores.length > 0) {
      results.llmScore = Number((dimScores.reduce((a, b) => a + b, 0) / dimScores.length).toFixed(2));
    }
    // Accumulate judge cost from all dimensions (add to any existing async assertion cost)
    const dimCost = dimValues.reduce((s, d) => s + (d.judgeCostUSD || 0), 0);
    if (dimCost > 0) results.judgeCostUSD = (results.judgeCostUSD || 0) + dimCost;
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
    results.judgeCostUSD = (results.judgeCostUSD || 0) + (judge.judgeCostUSD || 0);
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
 * @param {object} [context] - Execution metrics { costUSD, durationMs }
 * @returns {{passed, total, score, details}}
 */
export function runAssertions(output, assertions, context = {}) {
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
      case 'json_valid':
        try { JSON.parse(output); passed = true; } catch { passed = false; }
        break;
      case 'json_schema':
        try {
          const data = JSON.parse(output);
          passed = validateJsonSchema(data, assertion.schema);
        } catch { passed = false; }
        break;
      case 'starts_with':
        passed = outputLower.startsWith(String(assertion.value).toLowerCase());
        break;
      case 'ends_with':
        passed = outputLower.endsWith(String(assertion.value).toLowerCase());
        break;
      case 'equals':
        passed = output.trim() === String(assertion.value).trim();
        break;
      case 'not_equals':
        passed = output.trim() !== String(assertion.value).trim();
        break;
      case 'word_count_min':
        passed = output.split(/\s+/).filter(Boolean).length >= assertion.value;
        break;
      case 'word_count_max':
        passed = output.split(/\s+/).filter(Boolean).length <= assertion.value;
        break;
      case 'contains_all':
        passed = (assertion.values || []).every((v) => outputLower.includes(String(v).toLowerCase()));
        break;
      case 'contains_any':
        passed = (assertion.values || []).some((v) => outputLower.includes(String(v).toLowerCase()));
        break;
      case 'cost_max':
        passed = (context.costUSD ?? Infinity) <= assertion.value;
        break;
      case 'latency_max':
        passed = (context.durationMs ?? Infinity) <= assertion.value;
        break;
      default:
        passed = false;
    }

    details.push({
      type: assertion.type,
      value: assertion.value ?? assertion.pattern ?? assertion.values?.join(', ') ?? '',
      weight,
      passed,
    });
  }

  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  const passedCount = details.filter((d) => d.passed).length;

  // Normalize to 1-5 scale
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const score = ratioToScore(ratio);

  return {
    passed: passedCount,
    total: details.length,
    score,
    details,
  };
}

/**
 * Validate data against a JSON Schema using ajv.
 */
const ajv = new Ajv();

export function validateJsonSchema(data, schema) {
  if (!schema || typeof schema !== 'object') return true;
  try {
    const validate = ajv.compile(schema);
    return validate(data);
  } catch {
    return false;
  }
}

/**
 * Run async assertions (custom JS functions, semantic_similarity).
 */
async function runAsyncAssertions(output, assertions, { executor, judgeModel, sample, samplesDir }) {
  const details = [];
  let asyncCostUSD = 0;

  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1;
    let passed = false;
    let message = '';

    if (assertion.type === 'semantic_similarity') {
      const reference = assertion.reference || '';
      const judgePrompt = [
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

      const result = await executor({
        model: judgeModel,
        system: '你是语义相似度评审员。只返回 JSON，不要其他内容。',
        prompt: judgePrompt,
      });

      asyncCostUSD += result.costUSD || 0;
      if (result.ok) {
        try {
          const jsonMatch = result.output.trim().match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const score = Number(parsed.score) || 0;
            const threshold = assertion.threshold ?? 3;
            passed = score >= threshold;
            message = parsed.reason || '';
          } else {
            process.stderr.write(`[omk] semantic_similarity judge returned non-JSON: ${result.output.slice(0, 100)}\n`);
          }
        } catch (parseErr) {
          process.stderr.write(`[omk] semantic_similarity judge parse error: ${parseErr.message}\n`);
        }
      }
    } else if (assertion.type === 'custom') {
      try {
        const fnPath = resolve(samplesDir, assertion.fn);
        const mod = await import(fnPath);
        const fn = mod.default || mod.check;
        // Timeout custom assertion at 30 seconds
        const result = await Promise.race([
          fn(output, { sample, assertion }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`custom assertion timed out (${CUSTOM_ASSERTION_TIMEOUT_MS / 1000}s)`)), CUSTOM_ASSERTION_TIMEOUT_MS)),
        ]);
        passed = Boolean(result.pass);
        message = result.message || '';
      } catch (err) {
        passed = false;
        message = `custom assertion error: ${err.message}`;
      }
    }

    details.push({
      type: assertion.type,
      value: assertion.reference || assertion.fn || '',
      weight,
      passed,
      ...(message && { message }),
    });
  }

  const totalWeight = details.reduce((s, d) => s + d.weight, 0);
  const passedWeight = details.filter((d) => d.passed).reduce((s, d) => s + d.weight, 0);
  const passedCount = details.filter((d) => d.passed).length;
  const ratio = totalWeight > 0 ? passedWeight / totalWeight : 0;
  const score = ratioToScore(ratio);

  return { passed: passedCount, total: details.length, score, details, judgeCostUSD: asyncCostUSD };
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
    if (!jsonMatch) {
      process.stderr.write(`[omk] LLM judge returned non-JSON: ${text.slice(0, 100)}\n`);
      return { score: 0, reason: 'judge returned non-JSON', judgeCostUSD: result.costUSD };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Number(parsed.score) || 0,
      reason: String(parsed.reason || ''),
      judgeCostUSD: result.costUSD,
    };
  } catch (parseErr) {
    process.stderr.write(`[omk] LLM judge parse error: ${parseErr.message}\n`);
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
