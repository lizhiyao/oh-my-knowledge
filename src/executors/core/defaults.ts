// 系统默认任务执行模型。用 alias 'sonnet' — 性价比最优，eval/sample/evolve 统一默认。
// 需要更高质量时显式传 --model opus。report.meta.executorRuntime 记录实际模型 ID。
export const DEFAULT_MODEL = 'sonnet';
export const JUDGE_MODEL = 'haiku';
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_BUFFER = 10 * 1024 * 1024;
