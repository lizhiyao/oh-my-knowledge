import type { Artifact, ExecutorFn } from '../types/index.js';

export type SmokeFailureKind = 'timeout' | 'auth' | 'empty' | 'error';

export interface SmokeResult {
  ok: boolean;
  output: string | null;
  error?: string;
  durationMs: number;
  /** 仅 ok=false 时有值。决定 doctor rule 应该用哪条 hint 消息。 */
  failureKind?: SmokeFailureKind;
}

const SMOKE_PROMPT = 'Acknowledge in one short sentence.';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 用 artifact.content 当 system prompt + 一句极短任务 prompt 跑一次 executor,
 * 验证 skill + executor 组合可工作(对应 SE 工具栈的 smoke test)。
 *
 * 不开 cache、不消耗 evaluation cache slot。失败时分类型返回 failureKind,
 * 让 rule renderer 选择对应的可操作 hint。
 */
export async function runExecutorSmoke(
  artifact: Artifact,
  executor: ExecutorFn,
  model: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SmokeResult> {
  const startedAt = Date.now();
  try {
    const result = await executor({
      model,
      system: artifact.content ?? '',
      prompt: SMOKE_PROMPT,
      cwd,
      timeoutMs,
      // doctor 不依赖任何 SDK 自动发现的 skill,显式 [] 隔离
      allowedSkills: artifact.allowedSkills ?? [],
    });
    const durationMs = Date.now() - startedAt;

    if (!result.ok) {
      const errMsg = (result.error ?? '').toLowerCase();
      let failureKind: SmokeFailureKind = 'error';
      if (errMsg.includes('timeout') || errMsg.includes('timed out')) {
        failureKind = 'timeout';
      } else if (
        errMsg.includes('api key')
        || errMsg.includes('401')
        || errMsg.includes('unauthorized')
        || errMsg.includes('auth')
        || errMsg.includes('403')
      ) {
        failureKind = 'auth';
      }
      return { ok: false, output: result.output, error: result.error, durationMs, failureKind };
    }

    const output = result.output ?? '';
    if (output.trim().length === 0) {
      return { ok: false, output, error: 'empty output', durationMs, failureKind: 'empty' };
    }

    return { ok: true, output, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    let failureKind: SmokeFailureKind = 'error';
    if (lower.includes('timeout') || lower.includes('timed out')) {
      failureKind = 'timeout';
    } else if (lower.includes('api key') || lower.includes('401') || lower.includes('auth')) {
      failureKind = 'auth';
    }
    return { ok: false, output: null, error: message, durationMs, failureKind };
  }
}
