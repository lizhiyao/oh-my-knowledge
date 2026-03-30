/**
 * Domain model definitions for oh-my-knowledge.
 * Single source of truth for object structures used across runner, renderer, and server.
 */

/**
 * @typedef {Object} Sample
 * @property {string} sample_id - Unique identifier
 * @property {string} prompt - User prompt
 * @property {string} [context] - Additional context (code, text)
 * @property {string} [cwd] - Working directory for executor (e.g., target repo path)
 * @property {string} [rubric] - LLM judge rubric
 * @property {Array} [assertions] - Assertion definitions
 * @property {Object} [dimensions] - Multi-dimensional rubrics { dimName: rubricText }
 */

/**
 * @typedef {Object} Task
 * @property {string} sample_id
 * @property {string} variant
 * @property {string} prompt - Constructed prompt (prompt + context)
 * @property {string|null} rubric
 * @property {Array|null} assertions
 * @property {Object|null} dimensions
 * @property {string|null} skillContent - Skill content (system prompt or directory path)
 * @property {string|null} cwd - Working directory for executor
 * @property {Sample} _sample - Original sample reference
 */

/**
 * @typedef {Object} ExecResult
 * @property {boolean} ok
 * @property {string} output
 * @property {number} durationMs
 * @property {number} durationApiMs
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} costUSD
 * @property {string} stopReason
 * @property {number} numTurns
 * @property {string} [error]
 */

/**
 * @typedef {Object} VariantResult
 * @property {boolean} ok
 * @property {number} durationMs
 * @property {number} durationApiMs
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} costUSD
 * @property {number} numTurns
 * @property {string} [error]
 * @property {number} [compositeScore]
 * @property {Object} [assertions]
 * @property {number} [llmScore]
 * @property {string} [llmReason]
 * @property {Object} [dimensions]
 * @property {string|null} outputPreview
 */

/**
 * @typedef {Object} VariantSummary
 * @property {number} totalSamples
 * @property {number} successCount
 * @property {number} errorCount
 * @property {number} errorRate - Percentage (0-100)
 * @property {number} avgDurationMs
 * @property {number} avgInputTokens
 * @property {number} avgOutputTokens
 * @property {number} avgTotalTokens
 * @property {number} totalCostUSD
 * @property {number} [avgCompositeScore]
 * @property {number} [minCompositeScore]
 * @property {number} [maxCompositeScore]
 * @property {number} [avgAssertionScore]
 * @property {number} [avgLlmScore]
 * @property {number} [minLlmScore]
 * @property {number} [maxLlmScore]
 */

/**
 * @typedef {Object} ReportMeta
 * @property {string[]} variants
 * @property {string} model
 * @property {string|null} judgeModel
 * @property {string} executor
 * @property {number} sampleCount
 * @property {number} taskCount
 * @property {number} totalCostUSD
 * @property {string} timestamp - ISO 8601
 * @property {string} cliVersion
 * @property {string} nodeVersion
 * @property {Object} skillHashes - { variantName: hash12 }
 * @property {boolean} [blind]
 * @property {Object} [blindMap]
 */

/**
 * @typedef {Object} Report
 * @property {string} id
 * @property {ReportMeta} meta
 * @property {Object<string, VariantSummary>} summary
 * @property {Array<{sample_id: string, variants: Object<string, VariantResult>}>} results
 * @property {Object} [analysis]
 * @property {Object} [variance]
 */

/**
 * Build a VariantResult from execution and grading results.
 */
export function buildVariantResult(execResult, gradeResult) {
  const execCostUSD = execResult.costUSD || 0;
  const judgeCostUSD = gradeResult?.judgeCostUSD || 0;

  return {
    ok: execResult.ok,
    durationMs: execResult.durationMs,
    durationApiMs: execResult.durationApiMs,
    inputTokens: execResult.inputTokens,
    outputTokens: execResult.outputTokens,
    totalTokens: execResult.inputTokens + execResult.outputTokens,
    cacheReadTokens: execResult.cacheReadTokens,
    cacheCreationTokens: execResult.cacheCreationTokens,
    execCostUSD,
    judgeCostUSD,
    costUSD: execCostUSD + judgeCostUSD, // Total = execution + grading
    numTurns: execResult.numTurns,
    ...(execResult.error && { error: execResult.error }),
    ...(gradeResult && {
      compositeScore: gradeResult.compositeScore,
      ...(gradeResult.assertions && { assertions: gradeResult.assertions }),
      ...(gradeResult.llmScore != null && { llmScore: gradeResult.llmScore }),
      ...(gradeResult.llmReason && { llmReason: gradeResult.llmReason }),
      ...(gradeResult.dimensions && { dimensions: gradeResult.dimensions }),
    }),
    outputPreview: execResult.output ? execResult.output.slice(0, 200) : null,
  };
}

/**
 * Build a VariantSummary from an array of VariantResults.
 */
export function buildVariantSummary(entries) {
  const ok = entries.filter((e) => e.ok);
  const compositeScores = entries.filter((e) => typeof e.compositeScore === 'number' && e.compositeScore > 0).map((e) => e.compositeScore);
  const assertionScores = entries.filter((e) => e.assertions?.score > 0).map((e) => e.assertions.score);
  const llmScores = entries.filter((e) => typeof e.llmScore === 'number' && e.llmScore > 0).map((e) => e.llmScore);
  const errorCount = entries.length - ok.length;

  return {
    totalSamples: entries.length,
    successCount: ok.length,
    errorCount,
    errorRate: entries.length > 0 ? Number((errorCount / entries.length * 100).toFixed(1)) : 0,
    avgDurationMs: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.durationMs, 0) / ok.length) : 0,
    avgInputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.inputTokens, 0) / ok.length) : 0,
    avgOutputTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.outputTokens, 0) / ok.length) : 0,
    avgTotalTokens: ok.length > 0 ? Math.round(ok.reduce((s, e) => s + e.totalTokens, 0) / ok.length) : 0,
    totalCostUSD: ok.reduce((s, e) => s + (e.costUSD || 0), 0),
    avgCostPerSample: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.costUSD || 0), 0) / ok.length).toFixed(6)) : 0,
    avgNumTurns: ok.length > 0 ? Number((ok.reduce((s, e) => s + (e.numTurns || 0), 0) / ok.length).toFixed(1)) : 0,
    ...(compositeScores.length > 0 && {
      avgCompositeScore: Number((compositeScores.reduce((s, v) => s + v, 0) / compositeScores.length).toFixed(2)),
      minCompositeScore: Number(Math.min(...compositeScores).toFixed(2)),
      maxCompositeScore: Number(Math.max(...compositeScores).toFixed(2)),
      ...(compositeScores.length >= 2 && (() => {
        const mean = compositeScores.reduce((s, v) => s + v, 0) / compositeScores.length;
        const variance = compositeScores.reduce((s, v) => s + (v - mean) ** 2, 0) / compositeScores.length;
        const stddev = Math.sqrt(variance);
        const cv = mean > 0 ? stddev / mean : 0;
        return { scoreStddev: Number(stddev.toFixed(2)), scoreCV: Number(cv.toFixed(3)) };
      })()),
    }),
    ...(assertionScores.length > 0 && {
      avgAssertionScore: Number((assertionScores.reduce((s, v) => s + v, 0) / assertionScores.length).toFixed(2)),
    }),
    ...(llmScores.length > 0 && {
      avgLlmScore: Number((llmScores.reduce((s, v) => s + v, 0) / llmScores.length).toFixed(2)),
      minLlmScore: Math.min(...llmScores),
      maxLlmScore: Math.max(...llmScores),
    }),
  };
}
