/** 执行与评测共用的尝试状态到预算账本结果的投影。 */
export function expectedBudgetOutcome(attempt:
  | { readonly attemptStatus: 'completed' }
  | { readonly attemptStatus: 'cancelled' }
  | { readonly attemptStatus: 'failed'; readonly error: { readonly code: string } },
): 'completed' | 'failed' | 'cancelled' | 'attempt-timeout' {
  if (attempt.attemptStatus === 'completed') return 'completed';
  if (attempt.attemptStatus === 'cancelled') return 'cancelled';
  return attempt.error.code === 'timeout' ? 'attempt-timeout' : 'failed';
}
