import type { ToolCallInfo, TurnInfo } from '../../executors/contracts/trace.js';

/** Source-neutral trace projection consumed by observe coverage and gap analysis. */
export interface AnalysisVariantResult {
  ok: boolean;
  toolCalls?: ToolCallInfo[];
  turns?: TurnInfo[];
  fullOutput?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  tokenUsageReportedByExecutor?: boolean;
  numTurns?: number;
  numToolCalls?: number;
  numToolFailures?: number;
  numToolCancelled?: number;
  numToolUnknown?: number;
  toolSuccessRate?: number;
  toolNames?: string[];
  toolDistribution?: Record<string, number>;
}

export interface AnalysisEntry {
  sampleId: string;
  variants: Record<string, AnalysisVariantResult>;
}

export interface HedgingVerdict {
  isUncertainty: boolean;
  confidence: number;
  reason: string;
}

export interface GapSignalRef {
  sampleId: string;
  type: 'failed_search' | 'explicit_marker' | 'hedging' | 'repeated_failure';
  turn?: number;
  context: string;
  evidence?: Record<string, unknown>;
  weight: number;
  classifierVerdict?: HedgingVerdict;
}

export interface GapReport {
  variant: string;
  sampleCount: number;
  samplesWithGap: number;
  gapRate: number;
  weightedGapRate: number;
  testSetPath?: string | null;
  testSetHash?: string | null;
  signals: GapSignalRef[];
  byType: {
    failed_search: number;
    explicit_marker: number;
    hedging: number;
    repeated_failure: number;
  };
}
