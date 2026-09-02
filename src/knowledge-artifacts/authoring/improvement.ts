export interface ImprovementWeakSample {
  readonly sample_id: string;
  readonly compositeScore: number;
  readonly llmReason: string | null;
  readonly failedAssertions: readonly string[];
  readonly dimensions: Readonly<Record<string, number>> | null;
}

export interface EditDelta {
  readonly ratio: number;
  readonly changedLines: number;
  readonly summary: string;
}

/** Computes an order-insensitive, line-level edit budget for a candidate. */
export function computeEditDelta(
  before: string,
  after: string,
  maxSummaryLines = 12,
): EditDelta {
  const beforeLines = before.split('\n').map((line) => line.trim()).filter(Boolean);
  const afterLines = after.split('\n').map((line) => line.trim()).filter(Boolean);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const added = [...afterSet].filter((line) => !beforeSet.has(line));
  const removed = [...beforeSet].filter((line) => !afterSet.has(line));
  const changedLines = added.length + removed.length;
  const parts: string[] = [];
  for (const line of added.slice(0, maxSummaryLines)) parts.push(`+ ${line}`);
  if (added.length > maxSummaryLines) {
    parts.push(`+ …(其余 +${added.length - maxSummaryLines} 行)`);
  }
  for (const line of removed.slice(0, maxSummaryLines)) parts.push(`- ${line}`);
  if (removed.length > maxSummaryLines) {
    parts.push(`- …(其余 -${removed.length - maxSummaryLines} 行)`);
  }
  return {
    ratio: changedLines / Math.max(beforeLines.length, 1),
    changedLines,
    summary: parts.join('\n') || '(无文本差异)',
  };
}

export function buildImprovementPrompt(
  skillContent: string,
  score: number,
  weakSamples: readonly ImprovementWeakSample[],
  rejectedEdits?: readonly string[],
): string {
  const weakDetails = weakSamples.map((sample) => {
    const parts = [`### ${sample.sample_id}（${sample.compositeScore}/5.0）`];
    if (sample.llmReason) parts.push(`评委反馈：${sample.llmReason}`);
    if (sample.failedAssertions.length > 0) {
      parts.push(`失败断言：${sample.failedAssertions.join('，')}`);
    }
    if (sample.dimensions) {
      parts.push(`维度分数：${Object.entries(sample.dimensions)
        .map(([name, value]) => `${name}: ${value}`)
        .join('，')}`);
    }
    return parts.join('\n');
  }).join('\n\n');
  const rejectedSection = rejectedEdits && rejectedEdits.length > 0
    ? `\n\n## 已试过且未带来显著提升的改法（不要重复）\n\n${rejectedEdits.join('\n\n')}`
    : '';
  return `## 当前 Skill（平均分：${score.toFixed(2)}/5.0）

${skillContent}

## 低分用例分析

${weakDetails || '（无低分用例）'}${rejectedSection}`;
}
