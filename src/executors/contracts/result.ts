import type { ToolCallInfo, TurnInfo } from './trace.js';

export interface ExecResult {
  ok: boolean;
  output: string | null;
  durationMs: number;
  durationApiMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Whether the token counters came from the underlying runtime.
   * `false` means the numeric fields are compatibility placeholders and must
   * not be treated as measured zero. Missing/true preserves legacy executors.
   */
  tokenUsageReportedByExecutor?: boolean;
  costUSD: number;
  /** Whether the underlying executor binary/SDK reported a USD cost figure.
   *  - undefined / true : `costUSD` is authoritative
   *  - false            : executor 不报 cost，`costUSD` 是占位 0，renderer 应显示「未报告」/「—」。 */
  costReportedByExecutor?: boolean;
  stopReason: string;
  numTurns: number;
  /** Number of executor attempts represented by this result. Missing means one.
   *  Output, token counters, and trace come from the final attempt; costUSD
   *  includes every attempt because all of them may have incurred spend. */
  attemptCount?: number;
  fullNumTurns?: number;
  numSubAgents?: number;
  error?: string;
  cached?: boolean;
  turns?: TurnInfo[];
  toolCalls?: ToolCallInfo[];
  /** Sample.mocks 命中统计。仅当 input.mocks 非空时有值。
   *  perMock 的 key 格式:`<tool>:<ordinal>`(同一工具内从 1 开始计数) */
  mockStats?: {
    hits: number;
    misses: number;
    perMock: Record<string, number>;
  };
}
