export interface AnalysisListItem {
  id: string;
  generatedAt: string;
  sessionCount: number;
  segmentCount: number;
  skillCount: number;
  healthBand: 'green' | 'yellow' | 'red';
  confidence: 'high' | 'low' | 'underpowered';
}

export interface SkillTrendPoint {
  analysisId: string;
  generatedAt: string;
  gapRate: number;
  weightedGapRate: number;
  failureRate: number | null;
  toolCallCount: number;
  toolResolvedCount: number;
  toolComparableCount: number;
  toolCancelledCount: number;
  toolOutcomeCoverage: number | null;
  coverageRate: number | null;
  /** input + output only, 计费主成本 */
  billableTokens: number;
  /** cache_read + cache_creation, 通常远大于 billable 但计费权重低 */
  cachedTokens: number;
  totalTokens: number;
  avgTokensPerSegment: number;
  tokenCoverage: number;
  durationMs: number;
  segmentCount: number;
  stability: 'stable' | 'unstable' | 'very-unstable' | 'unknown';
}

export interface SkillTrendResult {
  skillName: string;
  points: SkillTrendPoint[];
}

export interface SkillDiffRow {
  skillName: string;
  presence: 'both' | 'only-from' | 'only-to';
  fromGap?: number;
  toGap?: number;
  deltaGap?: number;
  fromFailure?: number | null;
  toFailure?: number | null;
  deltaFailure?: number;
  fromCoverage?: number | null;
  toCoverage?: number | null;
  deltaCoverage?: number | null;
  fromSegments?: number;
  toSegments?: number;
  deltaSegments?: number;
}

export interface SkillDiffResult {
  fromId: string;
  toId: string;
  fromAt: string;
  toAt: string;
  rows: SkillDiffRow[];
}

