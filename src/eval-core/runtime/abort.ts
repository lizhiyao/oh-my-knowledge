/** 父信号的当前及后续取消都传入子操作；调用方在 finally 中解除关联。 */
export function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => undefined;
  }
  const abort = (): void => child.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  return () => parent.removeEventListener('abort', abort);
}
